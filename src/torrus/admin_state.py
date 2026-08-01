"""Durable admin action and LDAP policy state helpers."""

from __future__ import annotations

import hashlib
import json
import os
import secrets
import shutil
import tempfile
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any


class PolicyError(RuntimeError):
    """Base class for safe LDAP policy mutation failures."""


class PolicyUnavailable(PolicyError):
    """LDAP policy path or YAML support is unavailable."""


class PolicyConflict(PolicyError):
    """The source file changed since the operator read it."""


@dataclass(frozen=True)
class PolicyMutation:
    fingerprint: str
    backup_id: str
    allowed_users: tuple[str, ...]


class LDAPPolicyStore:
    """Atomically mutate LDAP allowlist while preserving unknown YAML fields."""

    _lock = threading.Lock()

    def __init__(self, path: str | os.PathLike[str] | None):
        self.path = Path(path).expanduser() if path else None

    def _read(self) -> tuple[bytes, dict[str, Any], str]:
        if self.path is None:
            raise PolicyUnavailable("LDAP configuration path is not configured")
        if self.path.is_symlink():
            raise PolicyUnavailable("LDAP configuration symlinks are not supported")
        try:
            raw = self.path.read_bytes()
        except OSError as exc:
            raise PolicyUnavailable("LDAP configuration cannot be read") from exc
        fingerprint = hashlib.sha256(raw).hexdigest()
        try:
            import yaml

            document = yaml.safe_load(raw) or {}
        except ImportError as exc:
            raise PolicyUnavailable("PyYAML is required for LDAP policy mutation") from exc
        except Exception as exc:
            raise PolicyError("LDAP configuration is not valid YAML") from exc
        if not isinstance(document, dict) or not isinstance(document.get("ldap"), dict):
            raise PolicyError("LDAP configuration must contain a mapping at ldap")
        allowed = document["ldap"].get("allowed_users")
        if not isinstance(allowed, list):
            raise PolicyError("LDAP allowlist mutation requires ldap.allowed_users")
        return raw, document, fingerprint

    def snapshot(self) -> dict[str, Any]:
        _raw, document, fingerprint = self._read()
        allowed = tuple(str(item).strip() for item in document["ldap"].get("allowed_users", []) if str(item).strip())
        return {"fingerprint": fingerprint, "allowed_users": list(allowed)}

    def mutate(self, username: str, enabled: bool, expected_fingerprint: str | None) -> PolicyMutation:
        with self._lock:
            raw, document, current_fingerprint = self._read()
            if expected_fingerprint and expected_fingerprint != current_fingerprint:
                raise PolicyConflict("LDAP configuration changed; reload policy before retrying")
            allowed = [str(item).strip() for item in document["ldap"].get("allowed_users", []) if str(item).strip()]
            folded = username.casefold()
            if enabled:
                if not any(item.casefold() == folded for item in allowed):
                    allowed.append(username)
            else:
                allowed = [item for item in allowed if item.casefold() != folded]
            document["ldap"]["allowed_users"] = allowed
            try:
                import yaml

                rendered = yaml.safe_dump(document, sort_keys=False, allow_unicode=True).encode("utf-8")
            except ImportError as exc:
                raise PolicyUnavailable("PyYAML is required for LDAP policy mutation") from exc
            except Exception as exc:
                raise PolicyError("LDAP configuration could not be rendered") from exc
            backup_id = f"{self.path.name}.bak-{int(time.time())}-{current_fingerprint[:12]}"
            backup = self.path.with_name(backup_id)
            try:
                mode = self.path.stat().st_mode & 0o777
                shutil.copyfile(self.path, backup)
                os.chmod(backup, mode & 0o600 or 0o600)
                fd, temp_name = tempfile.mkstemp(prefix=f".{self.path.name}.", dir=self.path.parent)
                try:
                    os.fchmod(fd, mode & 0o600 or 0o600)
                    with os.fdopen(fd, "wb") as temp:
                        temp.write(rendered)
                        temp.flush()
                        os.fsync(temp.fileno())
                    os.replace(temp_name, self.path)
                finally:
                    if os.path.exists(temp_name):
                        os.unlink(temp_name)
            except OSError as exc:
                raise PolicyUnavailable("LDAP configuration could not be replaced safely") from exc
            new_fingerprint = hashlib.sha256(rendered).hexdigest()
            return PolicyMutation(new_fingerprint, backup_id, tuple(allowed))


def new_action_id() -> str:
    """Return opaque action identifier suitable for logs and clients."""
    return secrets.token_urlsafe(18)


def action_payload(value: Any) -> str:
    """Serialize action results deterministically for durable storage."""
    return json.dumps(value, sort_keys=True, separators=(",", ":"), default=str)
