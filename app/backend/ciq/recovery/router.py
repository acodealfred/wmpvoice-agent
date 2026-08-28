"""Pure recommendation-router logic for the Recovery Window intake.

No DB/HTTP imports here by design (mirrors the "pure modules depend on nothing
external" convention used by ciq/reports/prompts.py) — this makes the rule set
independently testable and keeps it the single source of truth for track
selection (computed server-side only; the client/agent never picks a track by
itself, only narrates what this returns).

The safety-risk interlock itself lives in ciq.recovery.guardrails — the caller
(ciq/recovery/service.py) checks it BEFORE calling `get_recovery_recommendation`
and never calls into here at all if it trips. `get_recovery_recommendation`
re-checks it too (defense in depth: this function must never recommend a track
for a safety-risk answer, even if a future caller forgets the upstream check).

`intake` is a plain dict with these keys (snake_case, matching the wire shape
used by ciq/recovery/routes.py and ciq.recovery.intake_questions):
  sleep_hours (0-14), sleep_quality (1-5), mental_drain (1-5),
  emotional_heaviness (1-5), physical_tension (1-5),
  high_stakes_task ("yes"|"no"), high_stakes_task_window
  ("within_1_hour"|"today"|"this_week"|"none"),
  current_need ("thoughts_overloaded"|"body_tense"|"emotionally_drained"|
                "disconnected"|"unknown"|"practical_plan"),
  duration ("3_min"|"7_min"|"12_min"),
  safety ("no"|"yes"|"prefer_not_to_say")

Guardrail table (spec §5) — see ciq.recovery.guardrails module docstring for the
full copy-audit checklist; every rationale string below must comply with it.
"""
from ciq.recovery.guardrails import check_safety_interlock
from ciq.recovery.tracks import TRACK_IDS

_SLEEP_HOURS_SCALE = {  # bucketed "badness" score, higher = worse
    0: 5, 1: 5, 2: 5, 3: 5, 4: 5,
    5: 4, 6: 4,
    7: 2, 8: 1, 9: 1,
}
_HIGH_STAKES_WINDOW_SCALE = {"within_1_hour": 5, "today": 4, "this_week": 3, "none": 1}
_DURATION_MINUTES = {"3_min": 3, "7_min": 7, "12_min": 12}


def _sleep_hours_badness(sleep_hours) -> int:
    try:
        hours = int(round(float(sleep_hours)))
    except (TypeError, ValueError):
        return 3
    if hours in _SLEEP_HOURS_SCALE:
        return _SLEEP_HOURS_SCALE[hours]
    return 5 if hours < 5 else (1 if hours > 9 else 3)


def _biometric_elevated(biometric_signal: dict) -> bool:
    """True if either band signal indicates elevated arousal/stress.

    blink_band() returns strings like "Normal", "Elevated (above baseline)",
    "High (below baseline)" (see survey_loader.blink_band) — checked by
    prefix rather than exact match. pupil_band() returns a bare
    "Low"/"Medium"/"High"/"Unknown".
    """
    blink = (biometric_signal.get("blink_band") or "").strip()
    pupil = (biometric_signal.get("pupil_band") or "").strip()
    blink_elevated = blink.startswith("Elevated") or blink.startswith("High")
    pupil_elevated = pupil in ("Medium", "High")
    return blink_elevated or pupil_elevated


def _high_burnout(risk_signal: dict) -> bool:
    cbi = risk_signal.get("cbi_risk_level")
    overall = risk_signal.get("overall_risk_level")
    if cbi is not None:
        return cbi == "High"
    return overall == "High"


def _alternatives(track: str) -> list[str]:
    return [t for t in TRACK_IDS if t != track]


def _recommend(track: str, rationale: str, duration: str | None) -> dict:
    return {
        "status": "recommended",
        "track": track,
        "rationale": rationale,
        "alternatives": _alternatives(track),
        "session_length_minutes": _DURATION_MINUTES.get(duration, 7),
    }


def _append_safety_process_note(result: dict, intake: dict, risk_signal: dict) -> dict:
    """If a high-stakes task is imminent and the person's recovery signal is critically
    low, append (never replace) a rationale clause per the Guardrail table — this must
    never say "unfit," only offer the org's safety process as an option.
    """
    window = intake.get("high_stakes_task_window")
    critically_low = (
        _high_burnout(risk_signal)
        and intake.get("physical_tension", 1) >= 4
        and intake.get("mental_drain", 1) >= 4
    )
    if window == "within_1_hour" and critically_low:
        result["rationale"] += (
            " Given what's coming up very soon and how you're describing today, consider "
            "pausing or escalating according to your organisation's safety process — that's "
            "always a reasonable option, not a judgment on you."
        )
    return result


def get_preliminary_recovery_recommendation(risk_signal: dict, biometric_signal: dict) -> dict:
    """A track suggested from score+biometrics ALONE, before any intake question is
    asked — narrated by the agent at the very start of the flow (spec's step 4, which
    precedes step 5's intake). Always framed by the caller as preliminary, never final.
    """
    high_burnout = _high_burnout(risk_signal)
    biometric_elevated = _biometric_elevated(biometric_signal)

    if high_burnout and not biometric_elevated:
        return _recommend(
            "practical_recovery_plan",
            "Your responses suggest elevated work-related burnout risk, and your physiological "
            "signals during the assessment did not show acute arousal — a structured, practical "
            "plan is usually the best starting point here.",
            duration=None,
        )
    if biometric_elevated:
        return _recommend(
            "mindfulness_downshift",
            "Your pattern shows some elevated strain compared with your baseline — a short, "
            "grounding reset can be a good place to start.",
            duration=None,
        )
    return _recommend(
        "practical_recovery_plan",
        "Based on your recent pattern and the closest evidence-informed options available, a "
        "practical recovery plan is a solid, general starting point.",
        duration=None,
    )


def get_recovery_recommendation(intake: dict, risk_signal: dict, biometric_signal: dict) -> dict:
    """Return either a safety-interlock result or a FINAL recommended track (post-intake).

    `current_need` — the user's own direct, self-articulated signal — is evaluated
    first, ahead of any proxy Likert math, per the spec's recommendation-logic
    pattern table (§8). Only when it's "unknown" do the score-based branches run.
    """
    interlock = check_safety_interlock(intake)
    if interlock is not None:
        return {"status": interlock.mode, "crisis_message": interlock.message}

    high_burnout = _high_burnout(risk_signal)
    biometric_elevated = _biometric_elevated(biometric_signal)
    biometric_low_or_normal = not biometric_elevated

    physical_tension = intake["physical_tension"]
    mental_drain = intake["mental_drain"]
    emotional_heaviness = intake["emotional_heaviness"]
    sleep_quality = intake["sleep_quality"]
    sleep_hours = intake["sleep_hours"]
    duration = intake.get("duration")
    current_need = intake.get("current_need", "unknown")

    tension_score = physical_tension
    drain_score = mental_drain
    sleep_score = max(6 - sleep_quality, _sleep_hours_badness(sleep_hours))

    result: dict | None = None

    if current_need == "thoughts_overloaded":
        result = _recommend(
            "cbt_reframe_reset",
            "You told us your thoughts feel overloaded right now — a short reframing exercise "
            "can help interrupt that kind of mental looping.",
            duration,
        )
    elif current_need == "body_tense":
        rationale = (
            "You told us your body feels tense right now"
            + (
                ", and that lines up with what was observed during your assessment"
                if biometric_elevated else ""
            )
            + " — a grounding, body-focused practice fits well here."
        )
        result = _recommend("mindfulness_downshift", rationale, duration)
    elif current_need in ("emotionally_drained", "disconnected"):
        result = _recommend(
            "act_values_recalibration",
            "You told us today feels emotionally heavy or disconnected — reconnecting with "
            "what matters to you tends to help more here than a quick reset.",
            duration,
        )
    elif current_need == "practical_plan":
        result = _recommend(
            "practical_recovery_plan",
            "You told us a practical plan is what would help most right now — let's build one "
            "together.",
            duration,
        )

    if result is None:
        # current_need == "unknown" (or unrecognized): fall back to score-based rules.
        if high_burnout and biometric_low_or_normal:
            result = _recommend(
                "practical_recovery_plan",
                "Your self-reported burnout is elevated, but your physiological signals during "
                "the assessment were not — a structured, practical plan fits better right now "
                "than an emotion-regulation technique.",
                duration,
            )
        elif emotional_heaviness >= 4 and drain_score >= 3.5:
            result = _recommend(
                "act_values_recalibration",
                "Your signals point to steady, ongoing drain and emotional heaviness rather than "
                "one acute spike — reconnecting with what matters to you tends to help more here "
                "than a quick reset.",
                duration,
            )
        elif tension_score >= 4 and biometric_elevated:
            result = _recommend(
                "mindfulness_downshift",
                "Your physical tension is running high, and that lines up with what was observed "
                "during your assessment — a grounding, body-focused practice fits well here.",
                duration,
            )
        elif drain_score >= 4 and sleep_score >= 4:
            result = _recommend(
                "cbt_reframe_reset",
                "You're carrying a heavy mental load along with poor sleep and rest — a short "
                "reframing exercise can help interrupt that cycle.",
                duration,
            )
        else:
            result = _recommend(
                "practical_recovery_plan",
                "Your signals were mixed or moderate across the board — a practical, structured "
                "plan is a safe general starting point.",
                duration,
            )

    return _append_safety_process_note(result, intake, risk_signal)
