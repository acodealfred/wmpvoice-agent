# Manager dashboard — data model & semantics

How the manager dashboard's numbers are computed, and the rules that keep the
cards consistent. Backed by `db.get_manager_overview` / `get_manager_analytics`
/ `get_manager_score_trend`; rendered by `manager-landing.tsx` /
`manager-analytics.tsx` / `manager-score-trend.tsx`.

## The population: active employees

The assessed staff have role **`employee`** (renamed from the former `guest`).
The `users` table has an **`active`** boolean (default 1); a departed/deactivated
person is `active = 0`.

- **Total Staff** and every participation/eligibility denominator count
  **active employees only** (`role='employee' AND active=1`).
- Admins and managers are never counted as staff.
- Inactive employees (and their assessments) are excluded everywhere on the
  dashboard.

## The golden rule: distribution cards count *people*, trends count *assessments*

A person takes many assessments over time and their band drifts
(Low→Moderate→High). So we distinguish two kinds of number:

**Headcount / distribution → one vote per person, from their _latest_ scored
assessment:**
- Risk Distribution (High/Moderate/Low bars, "N assessed")
- "Where to Focus" ("N people are in the High band")
- Org Snapshot → At-Risk Share
- Per-department risk mix, at-risk %, dominant risk (→ 3D campus building
  colour), average score
- Assessment Analytics grouped bars + ranking (`totalAssessed` = employees)

**Time series → assessment-based (every assessment is an event):**
- Monthly Burnout Score line chart (average score per month)
- Assessment Analytics' internal weekly at-risk% trend

This split is deliberate — a headcount answers "how many people are at risk?"
(one person = one vote), while a trend answers "how did the signal move over
time?" (every check-in counts).

## Consistency invariants

After these rules, the cards agree:

```
sum(riskCounts)  ==  participants  ==  analytics.totalAssessed
```

i.e. the number of distinct active employees with a completed (scored)
assessment. "Completed" requires `technical_report IS NOT NULL` — a
started-but-unscored run does not count as participation.

`surveysCompleted` is the exception: it is the **total number of assessment
runs** (each person's whole history), labelled "Total assessment runs" — not a
headcount.

## Per-department figures

For each department: `eligible` = active employees in it; `completed` = those
with ≥1 scored assessment; `participationPct = completed / eligible`. Risk mix
and dominant risk come from each completed person's latest assessment. A
department can therefore have eligible staff who haven't been assessed (they
lower participation but don't appear in the risk mix).

## Demo data

`demo_data.seed_demo_data` creates 64 employees across 6 departments, each
completed one carrying a randomised **monthly history** (8–24 months) so trends
and every filter/period combination have real date spread. **Four** employees
(`_INACTIVE_EMP_INDICES`) are flagged `active = 0` so the active-vs-headcount
distinction is visible. Seed employees `guest1/2/3` (`db_init.SEED_USERS`) are
active and placed in Emergency/ICU/Surgery.

## Migration

`db_init.init_db` adds the `active` column (existing rows default to active) and
runs `UPDATE users SET role='employee' WHERE role='guest'`, so an existing
database migrates in place on the next boot — no manual re-seed required.
