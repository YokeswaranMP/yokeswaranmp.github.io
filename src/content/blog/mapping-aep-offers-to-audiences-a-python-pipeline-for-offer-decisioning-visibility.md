---
title: "Mapping AEP Offers to Audiences: A Python Pipeline for Offer Decisioning Visibility"
date: 2026-03-27
description: "A complete Python pipeline that joins AEP Offers, Decision Rules, and Audiences from CSV exports into a single Excel report — surfacing expired offers, orphaned audiences, and wasted refresh slots."
tags: ["adobe aep", "python", "offer decisioning", "data engineering", "automation"]
category: "Adobe AEP"
draft: false
---

## The Problem

If you have worked with Adobe Experience Platform's Offer Decisioning, you already know the pain. Offers are built, Decision Rules are configured, and Audiences are defined — all in separate parts of the UI, with no single view that ties them together.

When something breaks in production, the question is always the same: *which audience is this offer actually targeting?* That answer usually means hunting across multiple AEP screens, cross-referencing IDs manually, and hoping your notes are up to date. That is a dependency you do not want during an incident.

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

The challenge is that each layer is a different data shape. The offer points to a rule by ID. The rule contains deeply nested JSON where audience IDs are embedded inside `segmentRule` nodes — sometimes nested inside `segmentContainer` groups, sometimes inside `multiValueParentContainer` array blocks — at arbitrary depth.

---

## Sample Data Structure

To illustrate how the pipeline works, here is a representative sample of what each CSV export contains.

**Offers (`adobe_offer_items.csv`):**

| Offer ID | Offer Name | Lifecycle Status | End Date | Eligibility Rule ID |
|---|---|---|---|---|
| `offer-001` | Welcome Cashback Offer | Approved | 2026-06-30 | `rule-A1` |
| `offer-002` | Premium Upgrade Promo | Approved | 2025-12-31 | `rule-B2` |
| `offer-003` | Free Trial Extension | Draft | — | `rule-C3` |
| `offer-004` | Loyalty Bonus Reward | Approved | — | — |

**Decision Rules (`adobe_decision_rules.csv`):**

| Rule ID | Rule Name | Segment Model Expression (items) |
|---|---|---|
| `rule-A1` | New Joiners — Digital | `[{'type': 'segmentRule', 'value': {'audienceId': 'aud-101'}}]` |
| `rule-B2` | High Value — Multi-Product | `[{'type': 'segmentContainer', 'logicalOperator': 'AND', 'items': [{'type': 'segmentRule', 'value': {'audienceId': 'aud-202'}}]}]` |
| `rule-C3` | Lapsed Users — Mobile | `[{'type': 'segmentRule', 'value': {'audienceId': 'aud-303'}}]` |

**Audiences (`adobe_audiences.csv`):**

| Audience ID | Audience Name | Description | Total Profiles |
|---|---|---|---|
| `aud-101` | Digital New Joiners | Customers who joined via web or app in last 90 days | 48,200 |
| `aud-202` | High Value Multi-Product | Holds 3+ products with no active churn signal | 12,750 |
| `aud-303` | Lapsed Mobile Users | Logged in less than once in 60 days via mobile | 0 |
| `aud-404` | Early Adopters Segment | Signed up during beta period | 5,430 |

Notice `aud-404` — it exists in the audiences export but is not referenced by any decision rule. And `aud-303` has zero profiles, meaning a manual refresh on it would be entirely wasted. These are exactly the cases the pipeline surfaces.

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

Using `rule-B2` from the sample above, this walker traverses the `segmentContainer` wrapper, finds the inner `segmentRule`, and returns `['aud-202']` — regardless of how many nesting levels Adobe adds.

### Step 2 — Build the Human-Readable Audience Rule Expression

Each audience in AEP has its own qualification logic stored in `ansibleDataModel.dataModel.expression.profileAttributesContainer.items`. The parser handles every node type observed across a full dataset:

| Node Type | Example Output |
|---|---|
| `segmentRule` — plain attribute | `subscription_plan equals Premium` |
| `segmentRule` — multi-value | `product_type equals (Mobile or Broadband)` |
| `segmentRule` — audience membership | `loyalty_segment is not in audience` |
| `segmentRule` — temporal (in-last) | `last_login_date is within the last 60 days` |
| `segmentRule` — temporal (after date) | `signup_date is after 2025-01-01` |
| `segmentRule` — referenced-date | `activation_date is before 7 days of referenced date of TRIGGER_EVENT_DATE` |
| `segmentRule` — null check | `email_verified does not exist` |
| `multiValueParentContainer` — simple | `Include at least 1 instance(s) of product_event where (...)` |
| `multiValueParentContainer` — aggregate | `Include the count equals 3 of login_event where (...)` |
| `segmentContainer` — sub-group | `NOT (...)` or `(... OR ...)` |

### Step 3 — Join Everything

The main mapping uses pandas left joins starting from the offers dataframe:

```python
merged = offers.merge(rule_audience, left_on=OFFER_RULE_COL, right_on="rule_id", how="left")
merged = merged.merge(audiences_renamed, on="audience_id", how="left")
```

Audiences that are never referenced by any decision rule — like `aud-404` in our sample — are appended as dedicated rows at the bottom of the sheet with blank offer and rule fields, so nothing is silently dropped.

### Step 4 — Add the Two Flags

**`Offer Status`** — normalised to `Approved` or `Draft` from `_experience.decisioning.offeritem.lifecycleStatus`.

**`Audience Used`** — computed before the join by checking whether each audience ID appears in the `rule_audience` map. Computed pre-join intentionally — a post-join check would miss audiences that never make it into the joined table at all. In the sample, `aud-404` correctly gets `Audience Used = No`.

### Step 5 — Add the Two Derived Fields

**`Offer End Date`** — stripped from ISO timestamp to a clean `YYYY-MM-DD` date. `offer-002` in our sample has an end date of `2025-12-31`, which has already passed — surfacing it as an expired-but-still-Approved offer.

**`Audience Total Profiles`** — sourced from `metrics.data.totalProfiles` and cast to a nullable integer. Critical for validating a manual audience refresh — `aud-303` has zero profiles, so refreshing it would have no effect.

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

For the sample data, the mapped output looks like this:

| Offer Name | Status | End Date | Rule Name | Audience Name | Profiles | Audience Used |
|---|---|---|---|---|---|---|
| Welcome Cashback Offer | Approved | 2026-06-30 | New Joiners — Digital | Digital New Joiners | 48,200 | Yes |
| Premium Upgrade Promo | Approved | 2025-12-31 | High Value — Multi-Product | High Value Multi-Product | 12,750 | Yes |
| Free Trial Extension | Draft | — | Lapsed Users — Mobile | Lapsed Mobile Users | 0 | Yes |
| Loyalty Bonus Reward | Approved | — | — | — | — | — |
| — | — | — | — | Early Adopters Segment | 5,430 | No |

**Sheet 2 — Summary** gives headline counts including Approved/Draft split, offers with/without end dates, and audience Used/Not Used breakdown.

---

## What the Data Reveals

Running the pipeline on the sample above immediately surfaces four categories needing attention:

**Approved offers with no Decision Rule** — `Loyalty Bonus Reward` is live with no eligibility logic. It may be served to every profile entering the activity.

**Approved offers with a Rule but no resolved Audience** — The rule exists but its `items` column is empty or malformed. The offer is live but who it targets is undefined.

**Already-expired Approved offers** — `Premium Upgrade Promo` has an end date of `2025-12-31` but its status is still `Approved`. No longer eligible to serve but still present in the catalogue.

**Audiences with `Audience Used = No`** — `Early Adopters Segment` exists in AEP but is not referenced by any active decision rule. Using a manual refresh slot on it would have zero impact on any live offer.

---

## Practical Value

### 1. Smarter Manual Audience Refreshes

Filter the sheet to `Offer Status = Approved`, `Audience Used = Yes`, and `Audience Total Profiles > 0`. The resulting list is exactly the set of audiences worth refreshing. Given Adobe's limit of 2 manual refreshes, this filter alone justifies the tool. In the sample, only `aud-101` (48,200 profiles) and `aud-202` (12,750 profiles) qualify.

### 2. Self-Service Incident Investigation

When a database-driven offer behaves unexpectedly in production, filter by offer name and read the full rule expression in plain English from the `Audience Rule Expression` column — no AEP UI required, no SME dependency.

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

- **Scheduled automation** — wrapping the script in an Azure Function or GitHub Actions workflow so the report regenerates automatically on each export
- **AI Insights layer** — passing summary statistics to an LLM to generate a plain-English anomaly report as a third sheet
- **Schema drift detection** — comparing two consecutive exports to surface column changes before they silently break the pipeline
- **Event rule parsing** — extending the parser to cover `xEventAttributesContainer` for event-based audience logic

---

*If you found this useful or have worked through a similar problem in AEP, feel free to connect on [LinkedIn](https://linkedin.com/in/yokeswaranmp) or explore the rest of my work at [yokeswaranmp.github.io](https://yokeswaranmp.github.io).*

---

> **Disclaimer:** All data, names, audience definitions, offer names, rule configurations, profile counts, and identifiers used throughout this post are entirely fictional and created solely for illustrative purposes. This content does not contain, reference, or derive from any real customer, client, or organisation data. Any resemblance to actual entities, configurations, or datasets is coincidental.