# 试销官 API

FastAPI MVP backend. It keeps model-generated language separate from deterministic
data validation, metric calculation, state transitions, and decision policy.

```bash
uv sync --locked --dev
MODEL_MODE=replay uv run uvicorn shixiaoguan_api.main:app --reload --port 8000
uv run pytest
uv run ruff check .
uv run mypy
```

The default database is `./shixiaoguan.db`; Alembic migrates it on startup and
SQLite runs with foreign keys and WAL enabled. Set `DATABASE_URL` to override it.
`MODEL_MODE=replay|live|auto` controls the installed OpenAI Agents SDK adapter.
Without an API key, `auto` and failed `live` calls explicitly use the audited replay.

Every `POST`, `PUT`, `PATCH`, or `DELETE` under `/api/v1` requires an
`Idempotency-Key`. The built-in scenarios are deterministic synthetic data; the
API intentionally exposes no CSV, spreadsheet, manual trial-data, or platform-data
ingestion route. Image attachments are limited to verified PNG/JPEG/WebP files of
at most 5 MB with a rights declaration, and are not sent to a vision model.
