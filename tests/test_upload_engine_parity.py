"""Pins the vendored copies of the shared upload engine.

``torrus/src/torrus/upload_engine.py``,
``torrus/frontend/src/lib/upload-engine.js`` and
``torrus/frontend/src/lib/drop-entries.js`` are duplicated verbatim from xwing.
When any of them changes, change both copies and update the digest here: the
digest is what keeps the two engines identical.

Recompute with:

    sha256sum src/torrus/upload_engine.py frontend/src/lib/upload-engine.js \
        frontend/src/lib/drop-entries.js
"""

import hashlib
from pathlib import Path

from torrus import upload_engine

ENGINE_SHA256 = "f158c7f8e76c13ccc421fc3e73bc0e01567d4144c2030fe7c6803688b10eb075"
CLIENT_SHA256 = "80df98fc5cc494b7213525aaaea741e19562af64890e30b9ca5e8c639c94d7a6"
DROP_ENTRIES_SHA256 = "2377c6323ad1851e2737b5e4af4552b4b260d891a3ae55bc028d3150b5498c7c"

REPO_ROOT = Path(__file__).resolve().parents[1]


def test_python_engine_matches_the_shared_digest():
    digest = hashlib.sha256(Path(upload_engine.__file__).read_bytes()).hexdigest()
    assert digest == ENGINE_SHA256, (
        "upload_engine.py drifted from the copy in xwing/xwing/upload_engine.py; "
        "update both files and this digest together"
    )


def test_client_engine_matches_the_shared_digest():
    client = REPO_ROOT / "frontend" / "src" / "lib" / "upload-engine.js"
    digest = hashlib.sha256(client.read_bytes()).hexdigest()
    assert digest == CLIENT_SHA256, (
        "frontend upload-engine.js drifted from xwing/xwing/frontend/src/upload-engine.js; "
        "update both files and this digest together"
    )


def test_drop_traversal_matches_the_shared_digest():
    traversal = REPO_ROOT / "frontend" / "src" / "lib" / "drop-entries.js"
    digest = hashlib.sha256(traversal.read_bytes()).hexdigest()
    assert digest == DROP_ENTRIES_SHA256, (
        "frontend drop-entries.js drifted from xwing/xwing/frontend/src/drop-entries.js; "
        "update both files and this digest together"
    )
