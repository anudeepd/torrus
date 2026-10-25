import json
from importlib.util import module_from_spec, spec_from_file_location
from pathlib import Path

import pytest

spec = spec_from_file_location("release_version", Path(__file__).parents[1] / "scripts/release_version.py")
assert spec is not None
assert spec.loader is not None
release_version = module_from_spec(spec)
spec.loader.exec_module(release_version)
current_version = release_version.current_version
next_version = release_version.next_version
set_version = release_version.set_version


def release_root(tmp_path: Path) -> Path:
    (tmp_path / "src/torrus").mkdir(parents=True)
    (tmp_path / "frontend").mkdir()
    (tmp_path / "pyproject.toml").write_text('[project]\nname = "torrus"\nversion = "0.2.58"\n')
    (tmp_path / "src/torrus/__init__.py").write_text('__version__ = "0.2.58"\n')
    (tmp_path / "uv.lock").write_text(
        'version = 1\n\n[[package]]\nname = "torrus"\nversion = "0.2.58"\n'
    )
    frontend = {"name": "torrus-frontend", "version": "0.2.58"}
    package_lock = {
        "name": "torrus-frontend",
        "version": "0.2.58",
        "packages": {"": {"name": "torrus-frontend", "version": "0.2.58"}},
    }
    (tmp_path / "frontend/package.json").write_text(json.dumps(frontend))
    (tmp_path / "frontend/package-lock.json").write_text(json.dumps(package_lock))
    return tmp_path


def test_next_version_applies_patch_minor_and_major_bumps(tmp_path: Path) -> None:
    root = release_root(tmp_path)

    assert next_version(root, "patch") == "0.2.59"
    assert next_version(root, "minor") == "0.3.0"
    assert next_version(root, "major") == "1.0.0"


def test_set_version_synchronizes_all_release_manifests(tmp_path: Path) -> None:
    root = release_root(tmp_path)
    set_version(root, "0.3.0")

    assert current_version(root) == "0.3.0"
    assert 'version = "0.3.0"' in (root / "pyproject.toml").read_text()
    assert '__version__ = "0.3.0"' in (root / "src/torrus/__init__.py").read_text()
    assert 'version = "0.3.0"' in (root / "uv.lock").read_text()
    assert json.loads((root / "frontend/package.json").read_text())["version"] == "0.3.0"
    lock = json.loads((root / "frontend/package-lock.json").read_text())
    assert lock["version"] == lock["packages"][""]["version"] == "0.3.0"


def test_current_version_rejects_unsynchronized_manifests(tmp_path: Path) -> None:
    root = release_root(tmp_path)
    (root / "src/torrus/__init__.py").write_text('__version__ = "0.2.57"\n')

    with pytest.raises(SystemExit, match="not synchronized"):
        current_version(root)


def test_set_version_rejects_non_semver_without_mutating_files(tmp_path: Path) -> None:
    root = release_root(tmp_path)
    before = (root / "pyproject.toml").read_text()

    with pytest.raises(SystemExit, match=r"stable MAJOR\.MINOR\.PATCH"):
        set_version(root, "0.3.0-rc1")

    assert (root / "pyproject.toml").read_text() == before
