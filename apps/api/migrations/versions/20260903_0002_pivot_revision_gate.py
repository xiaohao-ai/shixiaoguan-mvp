"""Add versioned PivotRevision approval gate.

Revision ID: 20260903_0002
Revises: 20260903_0001
Create Date: 2026-09-03
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "20260903_0002"
down_revision: str | None = "20260903_0001"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("approvals", sa.Column("target_type", sa.String(length=80), nullable=True))
    op.add_column("approvals", sa.Column("target_id", sa.String(length=120), nullable=True))
    op.create_index("ix_approvals_target_id", "approvals", ["target_id"])
    op.create_table(
        "pivot_revisions",
        sa.Column("id", sa.String(length=120), nullable=False),
        sa.Column("project_id", sa.String(length=36), nullable=False),
        sa.Column("decision_id", sa.String(length=120), nullable=False),
        sa.Column("target_variant_id", sa.String(length=80), nullable=False),
        sa.Column("version", sa.Integer(), nullable=False),
        sa.Column("approval_status", sa.String(length=40), nullable=False),
        sa.Column("change_variable", sa.String(length=80), nullable=False),
        sa.Column("change_list_json", sa.JSON(), nullable=False),
        sa.Column("retest_plan_json", sa.JSON(), nullable=False),
        sa.Column("created_by", sa.String(length=120), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["project_id"], ["projects.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "project_id", "version", name="uq_pivot_revision_project_version"
        ),
    )
    op.create_index("ix_pivot_revisions_project_id", "pivot_revisions", ["project_id"])
    op.create_index("ix_pivot_revisions_decision_id", "pivot_revisions", ["decision_id"])


def downgrade() -> None:
    op.drop_index("ix_pivot_revisions_decision_id", table_name="pivot_revisions")
    op.drop_index("ix_pivot_revisions_project_id", table_name="pivot_revisions")
    op.drop_table("pivot_revisions")
    op.drop_index("ix_approvals_target_id", table_name="approvals")
    op.drop_column("approvals", "target_id")
    op.drop_column("approvals", "target_type")
