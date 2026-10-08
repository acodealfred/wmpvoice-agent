"""Voice acoustics (pitch, loudness, pauses) from the user's live survey speech.

Measured on the backend from the same PCM16 audio the browser streams to
/realtime, analysed off the event loop, stored per second (timeline) and per
answer (item responses), and exported. Never given to the agent or the report.
See docs/voice-features.md.
"""
