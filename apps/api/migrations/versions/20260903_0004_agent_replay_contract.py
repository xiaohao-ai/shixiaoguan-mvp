"""Add auditable fixed-recording replay identity to AgentRun.

Revision ID: 20260903_0004
Revises: 20260903_0003
Create Date: 2026-09-03
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "20260903_0004"
down_revision: str | None = "20260903_0003"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "agent_runs",
        sa.Column(
            "output_schema_version",
            sa.String(length=120),
            nullable=False,
            server_default="legacy-unspecified",
        ),
    )
    op.add_column(
        "agent_runs",
        sa.Column("recording_id", sa.String(length=160), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("agent_runs", "recording_id")
    op.drop_column("agent_runs", "output_schema_version")
