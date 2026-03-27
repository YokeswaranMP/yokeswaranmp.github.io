---
title: "Mapping Offers to Audiences in Adobe Experience Platform — A Python Data Engineering Approach"
date: 2026-03-27
description: "A complete Python pipeline that maps AEP Offers, Decision Rules, and Audiences from CSV exports into a structured Excel report — with human-readable rule expressions and actionable flag columns."
tags: ["adobe-aep", "python", "data-engineering", "decisioning", "audience", "offer-mapping"]
category: "Adobe AEP"
draft: false
---

## The Problem

If you have worked with Adobe Experience Platform's Offer Decisioning, you already know the pain. Offers are built, Decision Rules are configured, and Audiences are defined — all in separate parts of the UI, with no single view that ties them together.

When something breaks in production, the question is always the same: *which audience is this offer actually targeting?* For database-driven offers, that answer usually means tracking down a development SME, waiting, and hoping they remember the configuration. That is a dependency you do not want during an incident.

There is also a harder operational constraint sitting in the background: **Adobe limits you to only 2 manual audience refreshes**. With no clear visibility into which audiences are active, unexpired, and have valid profile counts, there is a real risk of burning those refresh slots on audiences that are orphaned, expired, or have zero members.

This post walks through a Python solution I built to solve exactly that — a complete, reusable data mapping pipeline that connects Offers, Decision Rules, and Audiences from AEP CSV exports into a single structured Excel report.

---

## What We Are Working With

Adobe Experience Platform allows you to export data from three key entities as CSV files:

- **Offers** (`adobe_offer_items.csv`) — the treatment content items, each with a lifecycle status, calendar constraints, and an eligibility rule reference
- **Decision Rules** (`adobe_decision_rules.csv`) — the eligibility logic that gates who qualifies for an offer, expressed as a nested JSON segment model
- **Audiences** (`adobe_audiences.csv`) — the profile segments that decision rules reference, each with a qualification expression and a total profile count

The relationship between them looks like this:
```
Offer
  └── eligibilityRule (ID reference)
        └── Decision Rule
              └── profileAttributesContainer.items (nested JSON)
                    └── audienceId
                          └── Audience
```

The challenge is that each layer is a different data shape. The offer points to a rule by ID. The rule contains deeply nested JSON where audience IDs are embedded inside `segmentRule` nodes, sometimes nested inside `segmentContainer` groups, sometimes inside `multiValueParentContainer` array blocks — at arbitrary depth.

---

## The Pipeline

The solution is a single Python script with six clearly separated sections.

### Step 1 — Parse the Nested Decision Rule JSON

The hardest part of this problem is extracting audience IDs from the decision rule's `segmentModel.expression.profileAttributesContainer.items` column. Adobe exports this as a Python-literal string (single quotes, `True`/`False`/`None`) rather than valid JSON, so a standard `json.loads()` will fail.

The `safe_parse()` function handles this by trying `ast.literal_eval()` first, then normalising to JSON as a fallback:
```python
def safe_parse(value):
    if pd.isna(value) or str(value).strip() in ("", "[]", "{}"):
        return None
    try:
        return ast.literal_eval(str(value))
    except Exception:
        pass
    text = str(value).replace("'", '"').replace("True", "true") \
                     .replace("False", "false").replace("None", "null")
    try:
        return json.loads(text)
    except Exception:
        return None
```

Once parsed, a recursive walker collects every `audienceId` it finds regardless of nesting depth:
```python
def _extract_audience_ids_from_items(items_value) -> list:
    parsed = safe_parse(items_value)
    audience_ids = []

    def _walk(node):
        if isinstance(node, dict):
            if "audienceId" in node:
                audience_ids.append(str(node["audienceId"]))
            if isinstance(node.get("value"), dict) and "audienceId" in node["value"]:
                audience_ids.append(str(node["value"]["audienceId"]))
            for v in node.values():
                if isinstance(v, (list, dict)):
                    _walk(v)
        elif isinstance(node, list):
            for item in node:
                _walk(item)

    _walk(parsed)
    return list(dict.fromkeys(audience_ids))
```

### Step 2 — Build the Human-Readable Audience Rule Expression

Each audience in AEP has its own qualification logic stored in `ansibleDataModel.dataModel.expression.profileAttributesContainer.items`. The parser handles every node type observed across the full dataset:

| Node Type | Example Output |
|---|---|
| `segmentRule` — plain attribute | `LOB equals F` |
| `segmentRule` — multi-value | `LOB equals (R or W)` |
| `segmentRule` — audience membership | `ACC_EMPLOYEE_ECID is not in audience` |
| `segmentRule` — temporal (in-last) | `offer_refresh_date is within the last 7 days` |
| `segmentRule` — temporal (after date) | `offer_refresh_date is after 2026-03-11` |
| `segmentRule` — referenced-date | `INIT_ACTIVATION_DATE is before 1 days of referenced date of EVENT_TRIGGER_DATETIME` |
| `segmentRule` — null check | `RogersECID does not exist` |
| `multiValueParentContainer` — simple | `Include at least 1 instance(s) of WRL_SUBSCRIPTION where (...)` |
| `multiValueParentContainer` — aggregate | `Include the count equals 9 of mm_2x where (...)` |
| `segmentContainer` — sub-group | `NOT (...)` or `(... OR ...)` |

### Step 3 — Join Everything

The main mapping uses pandas left joins starting from the offers dataframe:
```python
merged = offers.merge(rule_audience, left_on=OFFER_RULE_COL, right_on="rule_id", how="left")
merged = merged.merge(audiences_renamed, on="audience_id", how="left")
```

Audiences that are never referenced by any decision rule are appended as dedicated rows at the bottom of the sheet with blank offer and rule fields.

### Step 4 — Add the Two Flags

**`Offer Status`** — normalised to `Approved` or `Draft` from `_experience.decisioning.offeritem.lifecycleStatus`.

**`Audience Used`** — computed before the join by checking whether each audience ID appears in the `rule_audience` map. Computed pre-join intentionally — a post-join check would miss the audiences that never make it into the joined table at all.

### Step 5 — Add the Two New Fields

**`Offer End Date`** — stripped from ISO timestamp to clean `YYYY-MM-DD` date.

**`Audience Total Profiles`** — sourced from `metrics.data.totalProfiles` and cast to a nullable integer. Critical for validating a manual audience refresh — if count is zero, the refresh will have no effect.

---

## The Output

The final Excel workbook has two sheets.

**Sheet 1 — Offer-Audience Mapping** contains 12 columns:

| Column | Description |
|---|---|
| Offer ID | Full AEP offer ID |
| Offer Name | Human-readable offer name |
| Offer Status | `Approved` or `Draft` |
| Offer End Date | `YYYY-MM-DD` or blank |
| Decision Rule ID | Linked eligibility rule |
| Rule Name | Decision rule name |
| Audience ID | Linked audience ID |
| Audience Name | Audience name |
| Audience Description | Audience description |
| Audience Total Profiles | Profile count as integer |
| Audience Used | `Yes` or `No` |
| Audience Rule Expression | Human-readable qualification logic |

**Sheet 2 — Summary** gives headline counts including Approved/Draft split, offers with/without end dates, and audience Used/Not Used breakdown.

---

## What the Data Revealed

Running the pipeline surfaces four categories of offers needing attention:

**Approved offers with no Decision Rule** — Live offers with no eligibility logic. May be served to every profile entering the activity.

**Approved offers with a Rule but no resolved Audience** — The rule exists but contains no audience membership condition.

**Already-expired Approved offers** — End date has passed but status is still `Approved`. No longer eligible to serve but remain in the catalogue.

**Audiences with `Audience Used = No`** — Exist in AEP but not referenced by any active decision rule. Wasted manual refresh capacity if included in a refresh run.

---

## Practical Value

**1. Smarter Manual Audience Refreshes**

Filter the sheet to `Offer Status = Approved`, `Audience Used = Yes`, and `Audience Total Profiles > 0`. The resulting list is exactly the set of audiences worth refreshing. Given Adobe's limit of 2 manual refreshes, this filter alone justifies the tool.

**2. Self-Service Incident Investigation**

When a database-driven offer behaves unexpectedly in production, filter by offer name, read the full rule expression in plain English, and understand the targeting without opening the AEP UI or waiting for a development SME.

---

## Running the Script
```bash
pip install pandas openpyxl

python offer_audience_mapping.py \
    --offers     adobe_offer_items.csv \
    --rules      adobe_decision_rules.csv \
    --audiences  adobe_audiences.csv \
    --output     offer_audience_mapping.xlsx
```

All four arguments have sensible defaults so you can run it with no flags if the CSVs are in the same directory.

---

## Source Code

The full Python script is available on GitHub:

**[github.com/yokeswaranmp/aep-offer-audience-mapping](https://github.com/YokeswaranMP/aep-offer-audience-mapping)**

---

## What's Next

- **Scheduled automation** — wrapping the script in an Azure Function or GitHub Actions workflow so the report regenerates automatically
- **AI Insights layer** — passing summary statistics to Azure OpenAI or Groq to generate a plain-English anomaly report as a third sheet
- **Schema drift detection** — comparing two consecutive exports to surface column changes before they silently break the pipeline
- **Event rule parsing** — extending the parser to cover `xEventAttributesContainer` for event-based audience logic

---

*If you found this useful or have worked through a similar problem in AEP, feel free to connect on [LinkedIn](https://linkedin.com/in/yokeswaranmp) or explore the rest of my work at [yokeswaranmp.github.io](https://yokeswaranmp.github.io).*
```