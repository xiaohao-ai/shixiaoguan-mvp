from __future__ import annotations

import os
from collections.abc import Iterator
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

os.environ["MODEL_MODE"] = "replay"
os.environ["DATABASE_URL"] = "sqlite://"

from shixiaoguan_api.main import create_app


@pytest.fixture
def client(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Iterator[TestClient]:
    monkeypatch.setenv("MODEL_MODE", "replay")
    monkeypatch.setenv("UPLOAD_DIR", str(tmp_path / "uploads"))
    app = create_app("sqlite://")
    with TestClient(app, raise_server_exceptions=True) as test_client:
        yield test_client


@pytest.fixture
def idem() -> Iterator[dict[str, str]]:
    counter = 0

    def headers() -> dict[str, str]:
        nonlocal counter
        counter += 1
        return {"Idempotency-Key": f"pytest-{counter}"}

    yield headers  # type: ignore[misc]
