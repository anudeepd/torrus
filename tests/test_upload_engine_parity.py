"""Asserts the vendored copies of the shared upload engine still match xwing.

``torrus/src/torrus/upload_engine.py``,
``torrus/frontend/src/lib/upload-engine.js`` and
``torrus/frontend/src/lib/drop-entries.js`` are duplicated verbatim from the
xwing package. These tests compare the two checkouts byte for byte, so drift on
either side fails — a frozen digest could only ever notice torrus' own edits.

The sibling checkout is absent when torrus is installed on its own, so the whole
module skips there.
"""

from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[1]
XWING_ROOT = REPO_ROOT.parent / "xwing"

VENDORED_COPIES = [
    ("src/torrus/upload_engine.py", "xwing/upload_engine.py"),
    ("frontend/src/lib/upload-engine.js", "xwing/frontend/src/upload-engine.js"),
    ("frontend/src/lib/drop-entries.js", "xwing/frontend/src/drop-entries.js"),
]

pytestmark = pytest.mark.skipif(
    not XWING_ROOT.is_dir(),
    reason="the xwing sibling checkout is not present",
)


@pytest.mark.parametrize(("torrus_path", "xwing_path"), VENDORED_COPIES)
def test_vendored_copy_matches_xwing(torrus_path: str, xwing_path: str):
    ours = (REPO_ROOT / torrus_path).read_bytes()
    theirs = (XWING_ROOT / xwing_path).read_bytes()
    assert ours == theirs, (
        f"{torrus_path} drifted from xwing/{xwing_path}; "
        "update both copies together"
    )
