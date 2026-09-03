#!/usr/bin/env python3
"""Fail CI when repository files contain common credential material."""

from __future__ import annotations

import re
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
EXCLUDED_PARTS = {
    ".git",
    ".next",
    ".venv",
    "node_modules",
    "playwright-report",
    "test-results",
    "tmp",
    "var",
}
PATTERNS = {
    "OpenAI-compatible API key (including DeepSeek)": re.compile(
        r"\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b"
    ),
    "GitHub token": re.compile(r"\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}\b"),
    "GitHub fine-grained token": re.compile(r"\bgithub_pat_[A-Za-z0-9_]{30,}\b"),
    "AWS access key": re.compile(r"\b(?:AKIA|ASIA)[A-Z0-9]{16}\b"),
    "private key": re.compile(r"-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----"),
}


def candidate_files() -> list[Path]:
    files: list[Path] = []
    for path in ROOT.rglob("*"):
        if not path.is_file() or any(part in EXCLUDED_PARTS for part in path.parts):
            continue
        try:
            if path.stat().st_size <= 2 * 1024 * 1024:
                files.append(path)
        except OSError:
            continue
    return files


def main() -> int:
    findings: list[str] = []
    for path in candidate_files():
        try:
            text = path.read_text(encoding="utf-8")
        except (OSError, UnicodeDecodeError):
            continue
        for label, pattern in PATTERNS.items():
            for match in pattern.finditer(text):
                line = text.count("\n", 0, match.start()) + 1
                findings.append(f"{path.relative_to(ROOT)}:{line}: possible {label}")
    if findings:
        print("Credential scan failed:", file=sys.stderr)
        print("\n".join(findings), file=sys.stderr)
        return 1
    print("Credential scan passed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
