"""Backward-compatible re-export shim.

``RTMiddleTier`` and its helper types moved to the ``ciq.realtime`` package during the
backend refactor (see ``docs/refactoring.md``). This module keeps the original import
path (``from rtmt import RTMiddleTier``) working for callers such as ``ragtools.py``.
"""
from ciq.realtime.middle_tier import RTMiddleTier
from ciq.realtime.session import SessionState
from ciq.realtime.tools.base import RTToolCall, Tool, ToolResult, ToolResultDirection

__all__ = [
    "RTMiddleTier",
    "SessionState",
    "Tool",
    "ToolResult",
    "ToolResultDirection",
    "RTToolCall",
]
