"""Assessment lifecycle — Start / Pause / Continue / Close for survey runs.

A run lives in ``survey_records`` with a ``status`` of active, paused, closed or
completed (see ``service`` for the transitions). While a live realtime session is
bound to a run, every scored answer and the per-second timeline are persisted as
they happen, so a paused or dropped run can be continued where the user left off.
"""
