from __future__ import annotations

import hashlib
from pathlib import Path, PurePosixPath

MAX_IMAGE_BYTES = 5 * 1024 * 1024


class AttachmentValidationError(ValueError):
    pass


def detect_image(data: bytes) -> tuple[str, str]:
    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png", ".png"
    if len(data) >= 12 and data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "image/webp", ".webp"
    if data.startswith(b"\xff\xd8\xff"):
        return "image/jpeg", ".jpg"
    raise AttachmentValidationError("only PNG, JPEG, and WebP image bytes are accepted")


def validate_image(data: bytes, declared_mime: str | None) -> tuple[str, str, str]:
    if not data:
        raise AttachmentValidationError("image file is empty")
    if len(data) > MAX_IMAGE_BYTES:
        raise AttachmentValidationError("image exceeds the 5 MB limit")
    mime_type, extension = detect_image(data)
    if declared_mime and declared_mime.lower() != mime_type:
        raise AttachmentValidationError("declared MIME type does not match image magic bytes")
    return mime_type, extension, hashlib.sha256(data).hexdigest()


def resolve_object_path(upload_root: Path, object_key: str) -> Path:
    key = PurePosixPath(object_key)
    if key.is_absolute() or ".." in key.parts or not key.parts:
        raise AttachmentValidationError("invalid attachment object key")
    root = upload_root.resolve()
    target = (root / Path(*key.parts)).resolve()
    if not target.is_relative_to(root):
        raise AttachmentValidationError("attachment path escapes upload root")
    return target


def persist_image(upload_root: Path, object_key: str, data: bytes) -> Path:
    target = resolve_object_path(upload_root, object_key)
    target.parent.mkdir(parents=True, exist_ok=True)
    with target.open("xb") as handle:
        handle.write(data)
    return target
