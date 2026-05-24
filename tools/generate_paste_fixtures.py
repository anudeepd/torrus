#!/usr/bin/env python3
"""Generate large text fixtures for terminal paste testing."""

from __future__ import annotations

from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
OUT_DIR = ROOT / "testdata" / "paste-fixtures"

TARGETS = [
    ("paste-50k.txt", 50_000),
    ("paste-200k.txt", 200_000),
    ("paste-1m.txt", 1_000_000),
]


def build_payload(target_chars: int) -> str:
    lines: list[str] = []
    total = 0
    index = 1

    while total < target_chars:
        line = (
            f"{index:06d} | torrus paste stress line | "
            "abcdefghijklmnopqrstuvwxyz | 0123456789 | "
            "The quick brown fox jumps over the lazy dog.\n"
        )
        lines.append(line)
        total += len(line)
        index += 1

    payload = "".join(lines)
    return payload[:target_chars]


def main() -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)

    for filename, size in TARGETS:
        path = OUT_DIR / filename
        path.write_text(build_payload(size), encoding="utf-8")
        print(f"wrote {path.relative_to(ROOT)} ({path.stat().st_size} bytes)")


if __name__ == "__main__":
    main()
