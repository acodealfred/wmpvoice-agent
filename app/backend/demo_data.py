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
    {"name": "Night Shift", "staff": 8,  "participation": 0.50, "risk": (0.25, 0.35, 0.40)},
]

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

    for dept in DEPARTMENTS:
        weights = dept["risk"]
        completed = round(dept["staff"] * dept["participation"])
        for i in range(dept["staff"]):
            user_id = str(uuid.uuid4())
            name = f"demo_{dept['name'].lower().replace(' ', '')}_{i + 1}"
            created = (now - timedelta(days=random.randint(20, 120))).isoformat()
            user_rows.append((user_id, name, pw_hash, "guest", dept["name"], 1, created))

            # Only the "completed" share of each department has an assessment.
            if i < completed:
                risk = random.choices(["Low", "Moderate", "High"], weights=weights)[0]
                score = _score_for(risk)
                ts = (now - timedelta(days=random.randint(0, 45), hours=random.randint(0, 23))).isoformat()
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

    async with _open_db() as db:
        await db.executemany(
            """INSERT INTO users
               (user_id, name, password_hash, role, department, is_demo, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?)""",
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
