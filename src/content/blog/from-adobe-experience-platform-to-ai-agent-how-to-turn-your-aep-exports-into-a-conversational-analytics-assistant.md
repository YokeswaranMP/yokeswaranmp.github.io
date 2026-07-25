---
title: "From Adobe Experience Platform to AI Agent: How to Turn Your AEP Exports into a Conversational Analytics Assistant"
date: 2026-07-25
description: "Learn how to export AEP offers, decision rules, and audiences, join them into a single dataset, and connect an AI agent that answers plain-English questions about your entire offer decisioning landscape."
tags: ["adobe-aep", "ajo", "ai-agent", "offer-decisioning", "audience-management", "natural-language-analytics", "python"]
category: "Adobe AEP"
draft: false
---

---
title: "From Adobe Experience Platform to AI Agent: How to Turn Your AEP Exports into a Conversational Analytics Assistant"
date: 2026-03-22
description: "Learn how to export AEP offers, decision rules, and audiences, join them into a single dataset, and connect an AI agent that answers plain-English questions about your entire offer decisioning landscape."
tags: ["adobe-aep", "ajo", "ai-agent", "offer-decisioning", "audience-management", "natural-language-analytics", "python"]
category: "Adobe AEP"
draft: false
---

## The Idea in One Sentence

AEP exposes your offers, decision rules, and audiences through standard APIs. Export those three datasets, join them into a single file, and feed that file to an AI agent that answers plain-English questions about your data in seconds.

That is the entire concept. The rest of this post is about what that looks like in practice, and the range of use cases it unlocks.

---

## Why This Matters

Most AEP teams operate with fragmented visibility. You look at offers in the offer catalogue, audiences in the audience portal, and decision rules in the decisions workspace — three separate screens, no single view of how they connect.

When something breaks in production the question is always: *which audience is this offer actually targeting, and why?* Getting that answer usually means finding a development SME, waiting, and hoping they remember the configuration.

There is also a harder operational constraint sitting in the background: **Adobe limits you to only 2 manual audience refreshes**. With no clear visibility into which audiences are active, unexpired, and have valid profile counts, there is a real risk of burning those refresh slots on audiences that are orphaned, expired, or have zero members.

This architecture changes that. It puts your entire offer decisioning landscape — offers, rules, audiences, their relationships and their health — into a single queryable surface that anyone on the team can interrogate in plain English.

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

## Step One: Exporting from AEP

### Offers

The AEP Offers API returns the full offer catalogue — every offer with its ID, name, status, end date, and linked decision rule. A typical export for a mid-sized brand returns a few hundred rows covering everything from draft offers in editorial review to approved offers actively serving in production.

```
Offer ID | Offer Name | Offer Status | Offer End Date | Decision Rule ID
```

### Decision Rules

The Decision Rules API exports the eligibility logic attached to each offer — the rule name and the full audience rule expression. This is the raw targeting logic: which subscription types qualify, which brand LOBs are included, which behavioural events trigger eligibility.

```
Decision Rule ID | Rule Name | Audience Rule Expression
```

### Audiences

The Audiences API exports every audience segment in your instance — the audience ID, name, description, total profile count, and a flag indicating whether the audience is currently linked to a live offer.

```
Audience ID | Audience Name | Audience Description | Total Profiles | Audience Used
```

### Joining into One File

These three exports share key identifiers — offer IDs link to decision rules, decision rules link to audiences. Joining them produces a single flat file: one row per offer × audience × rule combination.

```
AEP Offers API
      ↓
AEP Decision Rules API  →  Join on shared IDs  →  Combined flat file
      ↓                                                   ↓
AEP Audiences API                              AI Agent upload
```

For a catalogue with 162 offers and 259 audiences this produces roughly 500 rows — a complete, queryable picture of your entire offer decisioning landscape in one place.

---

## Step Two: The Python Pipeline

The solution is a single Python script with six clearly separated sections.

### Parse the Nested Decision Rule JSON

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

### Build the Human-Readable Audience Rule Expression

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

### Join Everything

The main mapping uses pandas left joins starting from the offers dataframe:

```python
merged = offers.merge(rule_audience, left_on=OFFER_RULE_COL, right_on="rule_id", how="left")
merged = merged.merge(audiences_renamed, on="audience_id", how="left")
```

Audiences never referenced by any decision rule are appended as dedicated rows at the bottom of the sheet with blank offer and rule fields, keeping them visible and trackable.

### Add the Key Flags

**`Offer Status`** — normalised to `Approved` or `Draft` from `_experience.decisioning.offeritem.lifecycleStatus`.

**`Audience Used`** — computed before the join by checking whether each audience ID appears in the `rule_audience` map. Computed pre-join intentionally — a post-join check would miss the 70+ audiences that never make it into the joined table at all.

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

## Step Three: The AI Agent

The agent built on top of this export is not a general-purpose chatbot. It is a purpose-built analytics assistant with two distinct layers.

### Layer One — Rule Engine (Deterministic)

Before any AI call is made, a set of deterministic handlers processes the question. If someone asks "how many approved offers are there?" the agent counts rows where `Offer Status = Approved` and returns the number directly. No language model involved. No hallucination possible.

### Layer Two — AI Fallback (Analytical)

For questions that cannot be answered by counting or filtering — "what patterns exist in expired offers?", "which audiences look unusual?", "give me a business summary" — the agent retrieves the most relevant rows and sends them to an LLM with the schema as context. The model reasons over real data, not invented facts.

---

## What You Can Ask

### Offer Status and Lifecycle
```
How many approved offers are there?
How many draft offers are there?
List offers waiting for approval
Show lifecycle distribution
Compare approved vs draft offers
```

### Expiry and Timing
```
How many offers are expired?
Which offers are expiring in the next 7 days?
Show offers expiring this month
Show offers expiring next quarter
```

### Audience Size and Usage
```
Which offers have audience greater than 100,000?
How many unused audiences are there?
How many audiences have 0 to 11 profiles?
Which offers have low audience reach?
```

### Rule Expression Analysis
```
What are all the CTN-based offers?
Which HUP offers exist?
Which delinquency offers exist?
Which suspended account offers exist?
```

### Brand and LOB Distribution
```
Show Rogers offers
Show Fido offers
Brand distribution across catalogue
Compare Rogers vs Fido audience reach
```

### Province Targeting
```
Which offers target ON?
Which offers target BC?
Show all province-targeted offers
```

### Root Cause and Recommendations
```
Why do offers expire?
Why are some audiences unused?
Which offers are risky?
What should I fix first?
```

### Open-Ended Insights
```
What patterns exist in expired offers?
Summarize audience distribution
What trends do you observe?
Are there any anomalies in this dataset?
```

### AEP Platform Guidance
```
How can AEP offers be created?
What is best practice for audience eligibility rules in AJO?
How should I structure a new offer in Adobe Journey Optimizer?
```

---

## Multiple Use Cases, One Architecture

The offer-audience mapping is just one application of this export-and-query pattern. The same architecture applies across a wide range of AEP and AJO operational datasets.

### Audience Governance and Hygiene
Query for orphaned segments (built but never linked to an offer), stale segments (last evaluated more than 60 days ago), or segments with unexpectedly low profile counts given their targeting criteria.

### Offer Expiry Management
Query for offers that have passed their end date but remain in Approved status, offers expiring within the next 14 days without a replacement ready, or the proportion of the catalogue with no end date set at all.

### Decision Rule Auditing
Query for which targeting patterns appear most frequently across the catalogue, which rules reference deprecated segment definitions, and whether any rules are duplicated across multiple offer definitions without a clear reason.

### Eligibility Overlap Analysis
Join offers to audiences and query for audiences linked to more than one competing offer, or audiences that meet the eligibility criteria of offers they are not currently assigned to. Surfaces potential targeting conflicts before they reach production.

### Offer Readiness for Launch
Query for offers in Draft status that have a complete rule expression, a linked audience, and an end date set — a strong signal they are ready for approval review. Or surface Approved offers missing one of those three elements, which may indicate incomplete setup.

### Post-Campaign Retrospective
After a campaign closes, export the final offer-audience state alongside performance data and ask the agent to summarise what the offer mix looked like, which audience segments were in use, and how the portfolio compared to the previous period.

---

## What the Data Reveals

Running the pipeline surfaces four categories of offers needing attention:

**Approved offers with no Decision Rule** — Live offers with no eligibility logic. May be served to every profile entering the activity. Default and fallback offers are expected here, but any non-fallback offer in this bucket warrants a review.

**Approved offers with a Rule but no resolved Audience** — The rule exists but contains no audience membership condition. This includes intended open-eligibility offers like default actions, but also test offers that were never deactivated after QA.

**Already-expired Approved offers** — End date has passed but status is still `Approved`. No longer eligible to serve but remain in the catalogue, causing confusion during troubleshooting.

**Audiences with `Audience Used = No`** — Exist in AEP but not referenced by any active decision rule. Wasted manual refresh capacity if included in a refresh run.

---

## Practical Value

**1. Smarter Manual Audience Refreshes**

Filter the sheet to `Offer Status = Approved`, `Audience Used = Yes`, and `Audience Total Profiles > 0`. The resulting list is exactly the set of audiences worth refreshing — active, linked to a live offer, and confirmed to have members. Given Adobe's limit of 2 manual refreshes, this filter alone justifies the tool.

**2. Self-Service Incident Investigation**

When a database-driven offer behaves unexpectedly in production, filter by offer name, read the full rule expression in plain English, and understand the targeting without opening the AEP UI or waiting for a development SME.

---

## What Makes This Different from a Standard Dashboard

A dashboard answers the questions you thought to ask when you built it. An AI agent answers the questions you think to ask today.

A dashboard built around offer status distribution will show you the Approved/Draft split every time you open it. It will not tell you that 40% of your audience segments have fewer than 12 profiles, or that two brands have roughly equal offer counts but very different audience reach profiles — unless someone built those tiles explicitly.

The agent does not require pre-built tiles. Any question the data can support, it can answer — either deterministically via the rule engine or analytically via the AI fallback. And because the underlying data is refreshed with each export, the answers always reflect the current state of the catalogue.

---

## Running the Script

The script requires only `pandas` and `openpyxl` — no external dependencies.

```bash
pip install pandas openpyxl

python offer_audience_mapping.py \
    --offers     adobe_offer_items.csv \
    --rules      adobe_decision_rules.csv \
    --audiences  adobe_audiences.csv \
    --output     offer_audience_mapping.xlsx
```

All four arguments have sensible defaults so you can run it with no flags if the CSVs are in the same directory. Column names are declared as constants at the top of the file, making it straightforward to adapt if your AEP schema uses different field paths.

---

## Getting Started with the AI Agent

**Step 1 — Run the three AEP API exports** — offers, decision rules, audiences — and join them into a single flat file. This can be a manual export for initial exploration or an automated pipeline for ongoing use.

**Step 2 — Configure your AI API key.** Free-tier models (Groq, OpenRouter) work well for data queries. For platform-advisory questions, a frontier model (GPT-4o, Claude 3.5 Sonnet) gives substantially better results on AEP/AJO configuration guidance.

**Step 3 — Upload the file and start asking questions.** The agent detects your column structure automatically. No schema configuration required.

---

## Source Code

The full Python script is available on GitHub:

**[github.com/yokeswaranmp/aep-offer-audience-mapping](https://github.com/YokeswaranMP/aep-offer-audience-mapping)**

The repository includes the script, a `requirements.txt`, and a sample anonymised structure to test against.

---

## What's Next

- **Scheduled automation** — Azure Function or GitHub Actions triggering the export pipeline automatically on a weekly cadence
- **Real-time alerts** — Make.com workflow that flags offers expiring in 7 days and sends a Slack or Teams notification
- **AI Insights layer** — passing summary statistics to Azure OpenAI or Groq to generate a plain-English anomaly report appended as a third sheet in the workbook
- **Multi-dataset joins** — Adding campaign performance metrics alongside the offer-audience mapping for ROI-level analytics
- **Schema drift detection** — comparing two consecutive exports to surface column additions, removals, or format changes before they silently break the pipeline
- **Voice interface** — Connecting the agent to a speech-to-text layer so operations teams can query the dataset hands-free

---

*All data, organisation names, offer details, audience metrics, and rule expressions referenced in this article are synthetic and generated for illustrative purposes.*

*If you found this useful or have worked through a similar problem in AEP, feel free to connect on [LinkedIn](https://linkedin.com/in/yokeswaranmp) or explore the rest of my work at [yokeswaranmp.github.io](https://yokeswaranmp.github.io).*