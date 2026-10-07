"""Admin Data Validation endpoints (docs/data-validation-dashboard.md).

Read-only: both routes only SELECT, so they are safe alongside Litestream. Admin-only
via auth_middleware (every /admin/* route).
"""
import io
import json
import logging
import zipfile
from datetime import datetime, timedelta

from aiohttp import web

from ciq.api.history_routes import (
    MalformedEegError,
    build_combined_csv,
    build_timeline_csv,
)
from ciq.common.export_names import export_filename
from ciq.eeg.routes import eeg_payload
from ciq.validation.rules import build_run_view
from db import get_data_validation_runs, get_eeg_segments

logger = logging.getLogger("voicerag")


async def admin_data_validation_runs(request: web.Request) -> web.Response:
    """GET /admin/data-validation/runs?days=30 — one validation row per run, newest first.

    `days` limits to runs created in the last N days (default 30); `days=all` (or
    omitted value 0) returns every run.
    """
    days_param = request.query.get("days", "30")
    since_iso = None
    if days_param != "all":
        if not days_param.isdigit():
            return web.json_response({"error": "days must be a non-negative integer or 'all'"}, status=400)
        days = int(days_param)
        if days > 0:
            since_iso = (datetime.utcnow() - timedelta(days=days)).isoformat()

    rows = await get_data_validation_runs(since_iso)
    return web.json_response({
        "checkedAt": datetime.utcnow().isoformat(),
        "runs": [build_run_view(r) for r in rows],
    })


async def admin_data_validation_export_zip(request: web.Request) -> web.Response:
    """GET /admin/data-validation/export-zip?survey_run_id=... — every available file
    for one run in one archive (layout: spec §7). Built from the same helpers as the
    individual admin exports, so the files are byte-identical to those downloads.
    A malformed EEG recording leaves the combined CSV out with a warnings.txt
    instead of failing the whole archive.
    """
    survey_run_id = request.query.get("survey_run_id", "")
    if not survey_run_id:
        return web.json_response({"error": "survey_run_id is required"}, status=400)

    rows = await get_data_validation_runs(survey_run_id=survey_run_id)
    if not rows:
        return web.json_response({"error": "Survey run not found"}, status=404)
    view = build_run_view(rows[0])
    if not view["files"]:
        return web.json_response({"error": "No export files exist for this survey run"}, status=404)

    segments = await get_eeg_segments(survey_run_id) if view["eegSegments"] else []
    warnings: list[str] = []
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for f in view["files"]:
            kind, path = f["kind"], f["path"]
            if kind == "timeline":
                zf.writestr(path, await build_timeline_csv(survey_run_id))
            elif kind == "combined":
                try:
                    combined = await build_combined_csv(survey_run_id)
                except MalformedEegError as e:
                    warnings.append(f"{path} omitted: {e}")
                    continue
                if combined is None:
                    continue
                body, combine_warnings = combined
                zf.writestr(path, body)
                warnings.extend(f"{path}: {w}" for w in combine_warnings)
            elif kind == "eeg":
                payload = eeg_payload(survey_run_id, segments, f["segment"] if len(segments) > 1 else None)
                if payload is not None:
                    zf.writestr(path, json.dumps(payload))
        if warnings:
            zf.writestr("warnings.txt", "\n".join(warnings) + "\n")

    return web.Response(
        body=buf.getvalue(),
        headers={"Content-Disposition": f'attachment; filename="{export_filename("zip", survey_run_id, view["userId"])}"'},
        content_type="application/zip",
    )
