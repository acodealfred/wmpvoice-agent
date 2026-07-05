"""Demo / E2E data seeding for the manager dashboard.

Everything written here is tagged with ``is_demo = 1`` so it can be removed in
one shot without ever touching real users or real survey records. The admin
"Demo data" toggle calls :func:`seed_demo_data` / :func:`clear_demo_data`.
"""
import json
import logging
import random
import uuid
from datetime import datetime, timedelta

import bcrypt

from db import _open_db

logger = logging.getLogger("voicerag")

# Six departments with distinct burnout profiles so the dashboard reads as a
# realistic organisation. risk = (Low, Moderate, High) weights; participation is
# the share of staff that have completed at least one assessment.
DEPARTMENTS = [
    {"name": "Emergency",   "staff": 12, "participation": 0.70, "risk": (0.20, 0.30, 0.50)},
    {"name": "ICU",         "staff": 10, "participation": 0.80, "risk": (0.25, 0.35, 0.40)},
    {"name": "Outpatients", "staff": 14, "participation": 0.85, "risk": (0.65, 0.25, 0.10)},
    {"name": "Pediatrics",  "staff": 9,  "participation": 0.78, "risk": (0.55, 0.30, 0.15)},
    {"name": "Surgery",     "staff": 11, "participation": 0.60, "risk": (0.40, 0.35, 0.25)},
    {"name": "Critical Care", "staff": 8, "participation": 0.50, "risk": (0.25, 0.35, 0.40)},
]

# Rotating shifts assigned per staff member. Night/Evening staff skew slightly
# more burnt-out, so the High band is multiplied by the shift's risk factor —
# this makes the Shift filter tell a real story in the dashboard. Shifts are
# assigned round-robin so every shift is guaranteed to appear among the
# completed assessments (so selecting any Shift filter always returns data).
SHIFTS = ["Day", "Evening", "Night"]
_SHIFT_RISK_MULT = {"Day": 0.85, "Evening": 1.0, "Night": 1.4}

# Each completed staff member has a *monthly history* of assessments rather than
# a single one, so the trend chart and every filter/period combination has real
# date spread. History length is randomised per person within this range (in
# months, counting back from the current month), so recent months are densely
# covered by everyone while older months thin out — a realistic ramp.
_MIN_HISTORY = 8
_MAX_HISTORY = 24

# A few demo employees are flagged inactive (departed staff) so the dashboard's
# "active employees" total differs visibly from the raw headcount. Global
# employee indices (0-based, across all departments in order).
_INACTIVE_EMP_INDICES = {6, 22, 40, 58}

# Department-appropriate job titles (the Job Title filter dimension).
JOB_TITLES = {
    "Emergency":     ["ER Physician", "ER Nurse", "Paramedic", "Triage Nurse"],
    "ICU":           ["Intensivist", "ICU Nurse", "Respiratory Therapist"],
    "Outpatients":   ["Physician", "Clinic Nurse", "Medical Assistant", "Receptionist"],
    "Pediatrics":    ["Pediatrician", "Pediatric Nurse", "Child Life Specialist"],
    "Surgery":       ["Surgeon", "Anaesthetist", "Scrub Nurse", "Surgical Tech"],
    "Critical Care": ["Charge Nurse", "Critical Care Nurse", "Orderly"],
}
_DEFAULT_TITLES = ["Physician", "Nurse", "Technician", "Administrator"]

_DEMO_PASSWORD = "demo123"
_MAX_SCORE = 33  # BAT-style ceiling; Low ≤12, Moderate ≤22, High >22
_SURVEY_TYPE = "BATFULL"


def _score_for(risk: str) -> int:
    if risk == "Low":
        return random.randint(3, 12)
    if risk == "Moderate":
        return random.randint(13, 22)
    return random.randint(23, 32)


def _interp(risk: str) -> str:
    return {
        "Low": "Low burnout risk",
        "Moderate": "Moderate burnout risk",
        "High": "High burnout risk",
    }[risk]


def _month_timestamp(base: datetime, k: int) -> str:
    """ISO timestamp placed on a random day within the calendar month `k`
    months before `base`. For the current month (k=0) the day never runs past
    `base` so no assessment lands in the future."""
    y, m = base.year, base.month - k
    while m <= 0:
        m += 12
        y -= 1
    max_day = base.day if k == 0 else 28
    day = random.randint(1, max(1, min(28, max_day)))
    return datetime(y, m, day, random.randint(0, 23), random.randint(0, 59)).isoformat()


async def is_demo_seeded() -> bool:
    async with _open_db() as db:
        async with db.execute("SELECT COUNT(*) AS n FROM users WHERE is_demo = 1") as cur:
            row = await cur.fetchone()
            return bool(row and row["n"])


async def demo_data_status() -> dict:
    async with _open_db() as db:
        async with db.execute("SELECT COUNT(*) AS n FROM users WHERE is_demo = 1") as cur:
            users = (await cur.fetchone())["n"]
        async with db.execute("SELECT COUNT(*) AS n FROM survey_records WHERE is_demo = 1") as cur:
            surveys = (await cur.fetchone())["n"]
    return {"enabled": bool(users), "userCount": users, "surveyCount": surveys}


async def seed_demo_data() -> dict:
    """Create demo departments, staff and assessments. Idempotent: clears any
    existing demo rows first so a re-seed never duplicates."""
    await clear_demo_data()
    random.seed(42)  # reproducible demo runs

    pw_hash = bcrypt.hashpw(_DEMO_PASSWORD.encode(), bcrypt.gensalt()).decode()
    now = datetime.utcnow()
    user_rows: list[tuple] = []
    survey_rows: list[tuple] = []
    emp_idx = 0  # global employee counter (drives the inactive selection)

    for dept in DEPARTMENTS:
        weights = dept["risk"]
        titles = JOB_TITLES.get(dept["name"], _DEFAULT_TITLES)
        completed = round(dept["staff"] * dept["participation"])
        for i in range(dept["staff"]):
            user_id = str(uuid.uuid4())
            name = f"demo_{dept['name'].lower().replace(' ', '')}_{i + 1}"
            # Round-robin shift + job title so every option appears among the
            # completed assessments and every filter selection returns data.
            shift = SHIFTS[i % len(SHIFTS)]
            job_title = titles[i % len(titles)]

            # Only the "completed" share of each department has assessments —
            # and each such staff member carries a monthly history, so the trend
            # chart and every filter/period combination has real date spread.
            if i < completed:
                # Bias the High band by the shift's risk factor so night staff
                # read as more at-risk without changing the overall department mix much.
                w = list(weights)
                w[2] *= _SHIFT_RISK_MULT[shift]
                history = random.randint(_MIN_HISTORY, _MAX_HISTORY)
                for k in range(history):  # k = months ago; 0 = current month
                    ts = _month_timestamp(now, k)
                    risk = random.choices(["Low", "Moderate", "High"], weights=w)[0]
                    score = _score_for(risk)
                    report = {
                        "analysis": {},
                        "totalScore": score,
                        "maxScore": _MAX_SCORE,
                        "riskLevel": risk,
                        "interpretation": _interp(risk),
                        "domainTotals": {},
                    }
                    survey_rows.append((
                        str(uuid.uuid4()), user_id, None, str(uuid.uuid4()), _SURVEY_TYPE,
                        ts, ts, "{}", json.dumps(report), "{}", 1,
                    ))
                # The account is created a month before the oldest assessment.
                created = _month_timestamp(now, history)
            else:
                # Staff who have not completed an assessment yet.
                created = (now - timedelta(days=random.randint(20, 120))).isoformat()

            active = 0 if emp_idx in _INACTIVE_EMP_INDICES else 1
            emp_idx += 1
            user_rows.append((user_id, name, pw_hash, "employee", dept["name"], shift, job_title, 1, active, created))

    async with _open_db() as db:
        await db.executemany(
            """INSERT INTO users
               (user_id, name, password_hash, role, department, shift, job_title, is_demo, active, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            user_rows,
        )
        await db.executemany(
            """INSERT INTO survey_records
               (survey_run_id, user_id, session_token, session_id, survey_type,
                created_at, updated_at, survey_results, technical_report, prompt_info, is_demo)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            survey_rows,
        )
        await db.commit()

    logger.info("[DEMO] Seeded %d demo users and %d demo assessments across %d departments",
                len(user_rows), len(survey_rows), len(DEPARTMENTS))
    return await demo_data_status()


async def clear_demo_data() -> dict:
    """Delete every demo row (and only demo rows) across all tables."""
    async with _open_db() as db:
        await db.execute("DELETE FROM survey_records WHERE is_demo = 1")
        await db.execute(
            "DELETE FROM user_sessions WHERE user_id IN (SELECT user_id FROM users WHERE is_demo = 1)"
        )
        await db.execute(
            "DELETE FROM user_baselines WHERE user_id IN (SELECT user_id FROM users WHERE is_demo = 1)"
        )
        await db.execute("DELETE FROM users WHERE is_demo = 1")
        await db.commit()
    logger.info("[DEMO] Cleared all demo data")
    return {"enabled": False, "userCount": 0, "surveyCount": 0}
