"""KB document metadata persistence (flat JSON file).

Survives browser refreshes and is visible from any browser/device hitting the same
container. Does NOT survive container restarts — for a POC this is sufficient. Mount
a persistent volume for true durability.
"""
import json
from pathlib import Path

# backend/data/kb_documents.json — backend root is two levels above ciq/kb/.
_KB_DOCS_FILE = Path(__file__).resolve().parents[2] / "data" / "kb_documents.json"


def load_kb_docs() -> list:
    try:
        if _KB_DOCS_FILE.exists():
            return json.loads(_KB_DOCS_FILE.read_text(encoding="utf-8"))
        return []
    except Exception:
        return []


def save_kb_docs(docs: list) -> None:
    _KB_DOCS_FILE.parent.mkdir(parents=True, exist_ok=True)
    _KB_DOCS_FILE.write_text(json.dumps(docs, indent=2), encoding="utf-8")
