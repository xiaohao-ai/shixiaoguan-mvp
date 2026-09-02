from __future__ import annotations

from pathlib import Path

from sqlalchemy import text

from shixiaoguan_api.database import Database


def test_alembic_migration_and_sqlite_pragmas(tmp_path: Path) -> None:
    database_path = tmp_path / "migration.db"
    database = Database(f"sqlite:///{database_path}")
    config = Path(__file__).resolve().parents[1] / "alembic.ini"

    database.migrate(str(config))

    with database.engine.connect() as connection:
        revision = connection.execute(text("select version_num from alembic_version")).scalar_one()
        foreign_keys = connection.exec_driver_sql("PRAGMA foreign_keys").scalar_one()
        journal_mode = connection.exec_driver_sql("PRAGMA journal_mode").scalar_one()
        tables = {
            row[0]
            for row in connection.exec_driver_sql(
                "select name from sqlite_master where type='table'"
            )
        }
        agent_run_columns = {
            row[1]
            for row in connection.exec_driver_sql("PRAGMA table_info(agent_runs)")
        }
    assert revision == "20260903_0004"
    assert foreign_keys == 1
    assert journal_mode.lower() == "wal"
    assert {
        "projects",
        "datasets",
        "attachments",
        "audit_events",
        "pivot_revisions",
        "object_versions",
    } <= tables
    assert {"output_schema_version", "recording_id"} <= agent_run_columns


def test_file_database_creates_missing_parent_directory(tmp_path: Path) -> None:
    database_path = tmp_path / "fresh-clone" / "var" / "shixiaoguan.db"
    assert not database_path.parent.exists()

    database = Database(f"sqlite:///{database_path}")
    config = Path(__file__).resolve().parents[1] / "alembic.ini"
    database.migrate(str(config))

    assert database_path.is_file()
