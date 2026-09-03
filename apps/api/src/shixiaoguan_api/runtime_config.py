from __future__ import annotations

import os
import tempfile
from pathlib import Path

_TRUTHY_VALUES = frozenset({"1", "true", "yes", "on"})
_FALSEY_VALUES = frozenset({"", "0", "false", "no", "off"})


def _is_provider_credential_name(name: str) -> bool:
    normalized = name.upper()
    return ("DEEPSEEK" in normalized or "OPENAI" in normalized) and "KEY" in normalized


def public_preview_enabled() -> bool:
    raw = (os.getenv("PUBLIC_PREVIEW_MODE") or "").strip().lower()
    if raw in _TRUTHY_VALUES:
        return True
    if raw in _FALSEY_VALUES:
        return False
    raise RuntimeError(
        "PUBLIC_PREVIEW_MODE must be one of 1/true/yes/on or 0/false/no/off"
    )


def enforce_public_preview_environment() -> None:
    if not public_preview_enabled():
        return
    for key in tuple(os.environ):
        if _is_provider_credential_name(key):
            os.environ.pop(key, None)
    os.environ["MODEL_MODE"] = "replay"
    os.environ["SHIXIAOGUAN_AGENT_MODE"] = "replay"
    if not (os.getenv("PUBLIC_PREVIEW_RUNTIME_DIR") or "").strip():
        os.environ["PUBLIC_PREVIEW_RUNTIME_DIR"] = tempfile.mkdtemp(
            prefix="shixiaoguan-preview-"
        )


def public_preview_runtime_root() -> Path:
    temporary_root = Path(tempfile.gettempdir()).resolve()
    configured = (os.getenv("PUBLIC_PREVIEW_RUNTIME_DIR") or "").strip()
    candidate = Path(configured).expanduser() if configured else temporary_root / "shixiaoguan-preview"
    if not candidate.is_absolute():
        candidate = temporary_root / candidate
    resolved = candidate.resolve()
    if resolved == temporary_root or not resolved.is_relative_to(temporary_root):
        raise RuntimeError("PUBLIC_PREVIEW_RUNTIME_DIR must be a child of the system temp directory")
    resolved.mkdir(parents=True, exist_ok=True)
    return resolved


def resolve_database_url(explicit_url: str | None, default_url: str) -> str:
    if public_preview_enabled():
        return f"sqlite:///{public_preview_runtime_root() / 'shixiaoguan-preview.sqlite3'}"
    return (
        explicit_url
        or os.getenv("DATABASE_URL")
        or os.getenv("SHIXIAOGUAN_DATABASE_URL")
        or default_url
    )


def resolve_upload_root(default_root: Path) -> Path:
    if public_preview_enabled():
        return (public_preview_runtime_root() / "uploads").resolve()
    return Path(
        os.getenv("UPLOAD_DIR")
        or os.getenv("SHIXIAOGUAN_UPLOAD_DIR")
        or default_root
    ).resolve()
