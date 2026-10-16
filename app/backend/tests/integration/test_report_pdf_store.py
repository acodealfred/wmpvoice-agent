"""POST /me/reports/{runId}/pdf (ciq/reports/pdf_store_routes.py) — the browser's
on-screen report PDF, stored once per run in report_pdfs."""
import uuid

from conftest import seed_user_id
from test_report_share import _client, _seed, share_app  # noqa: F401 — fixture reused

PDF = "/me/reports/{}/pdf"
HEADERS = {"Content-Type": "application/pdf"}


async def _upload(client, run_id, body):
    return await client.post(PDF.format(run_id), data=body, headers=HEADERS)


async def test_owner_upload_is_stored_once(share_app, initialized_db):  # noqa: F811
    from db import get_report_pdf

    run_id = str(uuid.uuid4())
    await _seed(initialized_db, await seed_user_id("emp1"), run_id)
    owner = await _client(share_app, "emp1")
    try:
        first = await _upload(owner, run_id, b"%PDF-1.4 first")
        assert first.status == 200 and (await first.json()) == {"stored": True}
        second = await _upload(owner, run_id, b"%PDF-1.4 second")
        assert second.status == 200 and (await second.json()) == {"stored": False}
        assert await get_report_pdf(run_id) == b"%PDF-1.4 first"
    finally:
        await owner.close()


async def test_someone_elses_or_unfinished_run_is_404(share_app, initialized_db):  # noqa: F811
    other_run, open_run = str(uuid.uuid4()), str(uuid.uuid4())
    await _seed(initialized_db, await seed_user_id("emp2"), other_run)
    await _seed(initialized_db, await seed_user_id("emp1"), open_run, status="in_progress")
    owner = await _client(share_app, "emp1")
    try:
        assert (await _upload(owner, other_run, b"%PDF-1.4 x")).status == 404
        assert (await _upload(owner, open_run, b"%PDF-1.4 x")).status == 404
    finally:
        await owner.close()


async def test_rejects_non_pdf_and_oversized(share_app, initialized_db):  # noqa: F811
    from ciq.reports.pdf_store_routes import MAX_PDF_BYTES
    from db import get_report_pdf

    run_id = str(uuid.uuid4())
    await _seed(initialized_db, await seed_user_id("emp1"), run_id)
    owner = await _client(share_app, "emp1")
    try:
        assert (await _upload(owner, run_id, b"<html>not a pdf</html>")).status == 400
        assert (await _upload(owner, run_id, b"%PDF-" + b"0" * MAX_PDF_BYTES)).status == 413
        assert await get_report_pdf(run_id) is None
    finally:
        await owner.close()


async def test_upload_requires_login(share_app, initialized_db):  # noqa: F811
    anon = await _client(share_app)
    try:
        assert (await _upload(anon, str(uuid.uuid4()), b"%PDF-1.4 x")).status == 401
    finally:
        await anon.close()
