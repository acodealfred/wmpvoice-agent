"""Backend entrypoint shim.

The backend has been decomposed into the ``ciq`` package (see ``docs/refactoring.md``).
This module preserves the historical ``app:create_app`` entrypoint used by gunicorn
(``app/Dockerfile``) and ``python app/backend/app.py`` (``scripts/start.sh``).
"""
from ciq.server import create_app

__all__ = ["create_app"]


if __name__ == "__main__":
    from aiohttp import web

    host = "localhost"
    port = 8765
    web.run_app(create_app(), host=host, port=port)
