from __future__ import annotations

import base64
import os
import tempfile
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from shixiaoguan_api import agent
from shixiaoguan_api.enums import AgentMode
from shixiaoguan_api.main import create_app
from shixiaoguan_api.runtime_config import public_preview_runtime_root


def test_public_preview_forces_replay_without_reading_provider_keys(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("PUBLIC_PREVIEW_MODE", "true")
    monkeypatch.setenv("MODEL_MODE", "live")
    monkeypatch.setenv("DEEPSEEK_API_KEY", "must-not-be-read")
    monkeypatch.setenv("OPENAI_API_KEY", "must-not-be-read")
    original_getenv = os.getenv

    def guarded_getenv(key: str, default: str | None = None) -> str | None:
        if key in {"DEEPSEEK_API_KEY", "OPENAI_API_KEY"}:
            raise AssertionError(f"public preview attempted to read {key}")
        return original_getenv(key, default)

    monkeypatch.setattr(agent.os, "getenv", guarded_getenv)

    assert agent.configured_agent_mode() == AgentMode.OFFLINE_REPLAY


def test_public_preview_uses_temp_storage_and_rejects_attachment_uploads(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    runtime_root = tmp_path / "public-preview"
    outside_database = tmp_path / "persistent" / "must-not-be-used.sqlite3"
    outside_uploads = tmp_path / "persistent-uploads"
    monkeypatch.setenv("PUBLIC_PREVIEW_MODE", "1")
    monkeypatch.setenv("PUBLIC_PREVIEW_RUNTIME_DIR", str(runtime_root))
    monkeypatch.setenv("MODEL_MODE", "live")
    monkeypatch.setenv("DEEPSEEK_API_KEY", "must-not-be-used")
    monkeypatch.setenv("OPENAI_API_KEY", "must-not-be-used")
    monkeypatch.setenv("NEXT_PUBLIC_OPENAI_API_KEY", "must-not-be-used")
    monkeypatch.setenv("DEEPSEEK_FALLBACK_KEY", "must-not-be-used")
    monkeypatch.setenv("DATABASE_URL", f"sqlite:///{outside_database}")
    monkeypatch.setenv("UPLOAD_DIR", str(outside_uploads))

    app = create_app()

    assert "DEEPSEEK_API_KEY" not in os.environ
    assert "OPENAI_API_KEY" not in os.environ
    assert "NEXT_PUBLIC_OPENAI_API_KEY" not in os.environ
    assert "DEEPSEEK_FALLBACK_KEY" not in os.environ
    assert os.environ["MODEL_MODE"] == "replay"
    assert app.state.public_preview_mode is True
    assert app.state.attachment_upload_enabled is False
    assert app.state.database.url == (
        f"sqlite:///{runtime_root / 'shixiaoguan-preview.sqlite3'}"
    )
    assert app.state.upload_root == runtime_root / "uploads"
    assert not outside_database.exists()
    assert not outside_uploads.exists()

    with TestClient(app) as client:
        health = client.get("/api/v1/health")
        assert health.status_code == 200
        assert health.json()["agent_mode"] == "OFFLINE_REPLAY"
        assert health.json()["public_preview_mode"] is True
        assert health.json()["attachment_upload_enabled"] is False

        created = client.post(
            "/api/v1/demo/scenarios/GO/projects",
            headers={"Idempotency-Key": "preview-create"},
        )
        assert created.status_code == 201, created.text
        project_id = created.json()["id"]
        png = base64.b64decode(
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/"
            "x8AAusB9WlDglsAAAAASUVORK5CYII="
        )
        upload = client.post(
            f"/api/v1/projects/{project_id}/attachments",
            headers={
                "Idempotency-Key": "preview-upload",
                "Origin": "http://localhost:3000",
            },
            files={"file": ("shoe.png", png, "image/png")},
            data={"rights_declaration": "test fixture"},
        )

        assert upload.status_code == 403
        assert upload.headers["access-control-allow-origin"] == "http://localhost:3000"
        assert upload.json()["detail"] == (
            "attachment uploads are disabled in public preview mode"
        )
        assert client.get(f"/api/v1/projects/{project_id}/attachments").json() == []
        assert list((runtime_root / "uploads").iterdir()) == []


def test_public_preview_runtime_directory_cannot_escape_system_temp(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    system_temp = Path(tempfile.gettempdir()).resolve()
    outside = system_temp.parent / "not-a-preview-temp-directory"
    monkeypatch.setenv("PUBLIC_PREVIEW_MODE", "yes")
    monkeypatch.setenv("PUBLIC_PREVIEW_RUNTIME_DIR", str(outside))

    with pytest.raises(RuntimeError, match="must be a child of the system temp directory"):
        public_preview_runtime_root()


def test_invalid_public_preview_mode_fails_closed(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("PUBLIC_PREVIEW_MODE", "tru")

    with pytest.raises(RuntimeError, match="PUBLIC_PREVIEW_MODE must be one of"):
        create_app("sqlite://")
