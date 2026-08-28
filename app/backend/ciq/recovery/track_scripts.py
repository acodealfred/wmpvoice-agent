"""Guided-track scripts — what the voice agent speaks step by step once a track is
selected (spec §6 "Agent guides" + §11 sample prompts, expanded into a full,
Ethos-worded, non-diagnostic step sequence per track).

No LLM generation — every step is static, pre-written text. The agent speaks each
step's `text` verbatim (natural delivery, meaning unchanged — see
`ciq.prompts.builder.recovery_track_instructions`), then waits for the user's
acknowledgment before calling `advance_recovery_track_step` to move on. Copy
convention: "guided recovery track", never "treatment" or "therapy".

Duration variants (spec §7's 3/7/12-minute intake preference): every step is
tagged `"length": "core"` or `"length": "extended"`, and each track has one
appended `"deepen"`-length step. `get_track_script(track_id, duration)` filters:
  "3_min"              -> "core" steps only (the minimal complete arc).
  "7_min" / None/other -> "core" + "extended" (today's full script — the default).
  "12_min"             -> "core" + "extended" + the "deepen" step.
"""

TRACK_SCRIPTS: dict[str, list[dict]] = {
    "cbt_reframe_reset": [
        {"id": "cbt_step_1", "length": "core", "text": (
            "Let's slow the thought down for a moment. What's the main sentence your mind "
            "keeps repeating right now about the task ahead?"
        )},
        {"id": "cbt_step_2", "length": "core", "text": (
            "Thank you for sharing that. Now let's look at it gently — is that thought fully "
            "true, partly true, or more like an alarm signal from feeling overloaded?"
        )},
        {"id": "cbt_step_3", "length": "extended", "text": (
            "That's a really useful distinction. What's one piece of evidence that doesn't "
            "quite fit that thought — something that would tell a more balanced story?"
        )},
        {"id": "cbt_step_4", "length": "extended", "text": (
            "Good. Let's put that into a steadier, more balanced version of the thought — "
            "one that still takes the situation seriously but doesn't overstate it."
        )},
        {"id": "cbt_step_5", "length": "core", "text": (
            "Last step — what's one small, doable next action you could take, holding onto "
            "that more balanced thought rather than the original one?"
        )},
        {"id": "cbt_step_deepen", "length": "deepen", "text": (
            "One more thing, if you have a moment — where else in your work does this same "
            "kind of thought tend to show up? Naming the pattern can make it easier to catch "
            "next time, before it builds up."
        )},
    ],
    "mindfulness_downshift": [
        {"id": "mindfulness_step_1", "length": "core", "text": (
            "Let's take a moment together. If it's available to you, place both feet flat on "
            "the floor and let your shoulders soften."
        )},
        {"id": "mindfulness_step_2", "length": "core", "text": (
            "Breathe in gently through your nose for a few seconds."
        )},
        {"id": "mindfulness_step_3", "length": "core", "text": (
            "Now breathe out slowly — a little longer than your in-breath, like you're letting "
            "something go."
        )},
        {"id": "mindfulness_step_4", "length": "extended", "text": (
            "Let's do that once more together, at your own pace — in gently, out a little "
            "slower."
        )},
        {"id": "mindfulness_step_5", "length": "extended", "text": (
            "Bring your attention briefly to any place in your body holding tension — jaw, "
            "shoulders, hands — and just notice it, without needing to fix it."
        )},
        {"id": "mindfulness_step_6", "length": "core", "text": (
            "Nicely done. As we close, what's one small, calm next step you'd like to carry "
            "forward from this?"
        )},
        {"id": "mindfulness_step_deepen", "length": "deepen", "text": (
            "Before we finish, take one more slow breath and notice how your body feels right "
            "now compared with when we started — even a small shift is worth noticing."
        )},
    ],
    "act_values_recalibration": [
        {"id": "act_step_1", "length": "core", "text": (
            "You're noticing some heaviness today, and that's worth acknowledging without "
            "judgment. Let's make a little room for it rather than pushing it away."
        )},
        {"id": "act_step_2", "length": "extended", "text": (
            "Here's something worth holding onto: you are more than this feeling. It's "
            "something you're experiencing, not something you are."
        )},
        {"id": "act_step_3", "length": "core", "text": (
            "Thinking beyond today for a moment — what's one value that matters to you in how "
            "you want to show up at work, even on a heavy day?"
        )},
        {"id": "act_step_4", "length": "core", "text": (
            "That's meaningful. What's one small action, however small, that would move you "
            "toward that value today?"
        )},
        {"id": "act_step_5", "length": "extended", "text": (
            "You don't have to feel completely settled to take that step — just aligned with "
            "what matters to you. How does that land?"
        )},
        {"id": "act_step_deepen", "length": "deepen", "text": (
            "One last thought — is this heaviness something that's been building for a while, "
            "or more of a today thing? Either way, that value you named can guide you tomorrow "
            "too, not just today."
        )},
    ],
    "practical_recovery_plan": [
        {"id": "practical_step_1", "length": "core", "text": (
            "Let's build a concrete, practical plan together. First, let's separate what's in "
            "your control from what isn't right now."
        )},
        {"id": "practical_step_2", "length": "core", "text": (
            "Of the things in your control, what's the one task that most needs to be "
            "simplified, delayed, delegated, or clarified?"
        )},
        {"id": "practical_step_3", "length": "extended", "text": (
            "Good — let's name one support action: is there someone you could loop in, ask for "
            "help from, or simply let know about your workload?"
        )},
        {"id": "practical_step_4", "length": "extended", "text": (
            "Now one recovery action — something restorative you could realistically fit in, "
            "even briefly, in the next day or two."
        )},
        {"id": "practical_step_5", "length": "core", "text": (
            "Last piece — when will you actually do the first of these? Naming a specific time "
            "makes it much more likely to happen."
        )},
        {"id": "practical_step_deepen", "length": "deepen", "text": (
            "One more useful question — if this same pressure comes up again next week, what's "
            "one thing from today's plan you'd want to reach for first?"
        )},
    ],
}

_LENGTH_RANK = {"core": 0, "extended": 1, "deepen": 2}


def get_track_script(track_id: str, duration: str | None = None) -> list[dict]:
    """Return the ordered step list for a track, filtered by duration preference.

    `duration is None` or unrecognized behaves exactly like `"7_min"` — the
    default, full "core"+"extended" script — so any caller that doesn't pass a
    duration keeps today's behavior unchanged.
    """
    steps = TRACK_SCRIPTS.get(track_id, [])
    if duration == "3_min":
        max_rank = _LENGTH_RANK["core"]
    elif duration == "12_min":
        max_rank = _LENGTH_RANK["deepen"]
    else:
        max_rank = _LENGTH_RANK["extended"]
    return [s for s in steps if _LENGTH_RANK.get(s.get("length"), 1) <= max_rank]
