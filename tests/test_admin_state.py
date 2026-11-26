"""Coverage for the durable LDAP policy mutation helpers."""

from __future__ import annotations

import builtins
import os
import sys
from types import SimpleNamespace

import pytest

from torrus.admin_state import (
    LDAPPolicyStore,
    PolicyConflict,
    PolicyError,
    PolicyUnavailable,
    action_payload,
    new_action_id,
)


def _config(path, *, allowed=("alice",), extra=""):
    path.write_text(
        "ldap:\n"
        "  bind_password: test-password\n"
        "  allowed_users:\n"
        + "".join(f"    - {user}\n" for user in allowed)
        + extra
        + "proxy:\n  secret_key: test-secret\n"
    )
    return path


def test_policy_store_requires_a_path():
    with pytest.raises(PolicyUnavailable, match="not configured"):
        LDAPPolicyStore(None).snapshot()


def test_policy_store_refuses_symlinks(tmp_path):
    target = _config(tmp_path / "ldap.yaml")
    link = tmp_path / "link.yaml"
    link.symlink_to(target)

    with pytest.raises(PolicyUnavailable, match="symlinks"):
        LDAPPolicyStore(link).snapshot()


def test_policy_store_wraps_read_errors(tmp_path):
    with pytest.raises(PolicyUnavailable, match="cannot be read"):
        LDAPPolicyStore(tmp_path / "missing.yaml").snapshot()


def test_policy_store_requires_yaml(tmp_path, monkeypatch):
    path = _config(tmp_path / "ldap.yaml")
    real_import = builtins.__import__

    def fail_yaml(name, *args, **kwargs):
        if name == "yaml":
            raise ImportError(name)
        return real_import(name, *args, **kwargs)

    monkeypatch.setattr(builtins, "__import__", fail_yaml)
    with pytest.raises(PolicyUnavailable, match="PyYAML"):
        LDAPPolicyStore(path).snapshot()


def test_policy_store_rejects_invalid_yaml(tmp_path):
    path = tmp_path / "ldap.yaml"
    path.write_text("ldap: [\n")

    with pytest.raises(PolicyError, match="valid YAML"):
        LDAPPolicyStore(path).snapshot()


@pytest.mark.parametrize(
    "document",
    [
        "- not a mapping\n",
        "ldap: not-a-mapping\n",
        "ldap: {}\n",
    ],
)
def test_policy_store_rejects_shapes_it_cannot_mutate(tmp_path, document):
    path = tmp_path / "ldap.yaml"
    path.write_text(document)

    with pytest.raises(PolicyError):
        LDAPPolicyStore(path).snapshot()


def test_policy_snapshot_normalizes_the_allowlist(tmp_path):
    path = _config(tmp_path / "ldap.yaml", allowed=(" alice ", "", "bob"))
    snapshot = LDAPPolicyStore(path).snapshot()

    assert snapshot["allowed_users"] == ["alice", "bob"]
    assert len(snapshot["fingerprint"]) == 64


def test_policy_mutation_adds_case_insensitively_and_preserves_unknown_fields(tmp_path):
    path = _config(tmp_path / "ldap.yaml", allowed=("alice",), extra="custom:\n  keep: me\n")
    store = LDAPPolicyStore(path)

    added = store.mutate("ALICE", True, store.snapshot()["fingerprint"])
    assert added.allowed_users == ("alice",)
    assert added.backup_id.startswith("ldap.yaml.bak-")
    assert "custom:" in path.read_text()

    added = store.mutate("bob", True, "")
    assert added.allowed_users == ("alice", "bob")

    removed = store.mutate("ALICE", False, None)
    assert removed.allowed_users == ("bob",)
    assert "custom:" in path.read_text()


def test_policy_mutation_rejects_a_stale_fingerprint(tmp_path):
    path = _config(tmp_path / "ldap.yaml")

    with pytest.raises(PolicyConflict, match="changed"):
        LDAPPolicyStore(path).mutate("bob", True, "stale")


def test_policy_mutation_requires_yaml_for_rendering(tmp_path, monkeypatch):
    path = _config(tmp_path / "ldap.yaml")
    real_import = builtins.__import__
    calls = 0

    def fail_second_yaml_import(name, *args, **kwargs):
        nonlocal calls
        if name == "yaml":
            calls += 1
            if calls == 2:
                raise ImportError(name)
        return real_import(name, *args, **kwargs)

    monkeypatch.setattr(builtins, "__import__", fail_second_yaml_import)
    with pytest.raises(PolicyUnavailable, match="PyYAML"):
        LDAPPolicyStore(path).mutate("bob", True, None)


def test_policy_mutation_wraps_render_errors(tmp_path, monkeypatch):
    path = _config(tmp_path / "ldap.yaml")
    fake_yaml = SimpleNamespace(
        safe_load=lambda value: {
            "ldap": {"allowed_users": ["alice"]},
            "proxy": {"secret_key": "x"},
        },
        safe_dump=lambda *_args, **_kwargs: (_ for _ in ()).throw(
            RuntimeError("render failed")
        ),
    )
    monkeypatch.setitem(sys.modules, "yaml", fake_yaml)

    with pytest.raises(PolicyError, match="could not be rendered"):
        LDAPPolicyStore(path).mutate("bob", True, None)


def test_policy_mutation_removes_a_temporary_file_when_replace_fails(
    tmp_path, monkeypatch
):
    path = _config(tmp_path / "ldap.yaml")
    store = LDAPPolicyStore(path)

    monkeypatch.setattr(
        os, "replace", lambda *_args: (_ for _ in ()).throw(OSError("replace failed"))
    )
    with pytest.raises(PolicyUnavailable, match="replaced safely"):
        store.mutate("bob", True, None)

    assert not list(tmp_path.glob(".ldap.yaml.*"))


def test_policy_pruning_ignores_backups_that_vanish(tmp_path, monkeypatch):
    path = _config(tmp_path / "ldap.yaml")
    store = LDAPPolicyStore(path)
    backups = []
    for index in range(7):
        backup = tmp_path / f"ldap.yaml.bak-{index}"
        backup.write_text("old")
        backups.append(backup)

    real_unlink = type(backups[0]).unlink

    def flaky_unlink(self, *args, **kwargs):
        if self == backups[0]:
            raise OSError("already gone")
        return real_unlink(self, *args, **kwargs)

    monkeypatch.setattr(type(backups[0]), "unlink", flaky_unlink)
    store._prune_backups()

    assert not backups[1].exists()
    assert backups[-1].exists()


def test_action_helpers_are_deterministic_and_serializable():
    action_id = new_action_id()
    assert len(action_id) >= 20
    assert action_payload({"b": 2, "a": object()}).startswith('{"a":"')
    assert action_payload({"b": 2, "a": 1}) == '{"a":1,"b":2}'
