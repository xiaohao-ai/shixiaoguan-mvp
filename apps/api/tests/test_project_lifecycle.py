from __future__ import annotations

from collections.abc import Callable

from fastapi.testclient import TestClient
from sqlalchemy import func, select

from shixiaoguan_api.database import ApprovalRecord, DatasetRecord, ObjectVersionRecord
from shixiaoguan_api.enums import DemoScenarioId
from shixiaoguan_api.seed import SCENARIOS, make_brief


def _create_scenario(
    client: TestClient,
    idem: Callable[[], dict[str, str]],
    scenario: str = "GO",
) -> dict[str, object]:
    response = client.post(
        f"/api/v1/demo/scenarios/{scenario}/projects",
        headers=idem(),
    )
    assert response.status_code == 201, response.text
    return response.json()


def _approve_plan(
    client: TestClient,
    idem: Callable[[], dict[str, str]],
    project: dict[str, object],
) -> dict[str, object]:
    plan = project["experiment_plan"]
    assert isinstance(plan, dict)
    response = client.post(
        f"/api/v1/experiment-plans/{plan['id']}/approvals",
        headers=idem(),
        json={
            "gate": "EXPERIMENT_PLAN",
            "decision": "APPROVE",
            "object_version": plan["version"],
            "actor": "lifecycle-test",
        },
    )
    assert response.status_code == 200, response.text
    return plan


def _reach_approved_decision(
    client: TestClient,
    idem: Callable[[], dict[str, str]],
) -> tuple[dict[str, object], dict[str, object]]:
    project = _create_scenario(client, idem)
    project_id = str(project["id"])
    plan = _approve_plan(client, idem, project)
    completed = client.post(
        f"/api/v1/simulation-runs/{project_id}:complete",
        headers=idem(),
    )
    assert completed.status_code == 200, completed.text
    analyzed = client.post(
        f"/api/v1/experiments/{plan['id']}:analyze",
        headers=idem(),
    )
    assert analyzed.status_code == 200, analyzed.text
    decision = analyzed.json()["decision"]
    approved = client.post(
        f"/api/v1/decision-cards/{decision['id']}/approvals",
        headers=idem(),
        json={
            "gate": "DECISION",
            "decision": "APPROVE",
            "object_version": decision["version"],
            "actor": "lifecycle-test",
        },
    )
    assert approved.status_code == 200, approved.text
    return project, decision


def _reach_handoff(
    client: TestClient,
    idem: Callable[[], dict[str, str]],
) -> dict[str, object]:
    project, decision = _reach_approved_decision(client, idem)
    project_id = str(project["id"])
    confirmed = client.post(
        f"/api/v1/projects/{project_id}/first-order-assumptions/approvals",
        headers=idem(),
        json={
            "gate": "FIRST_ORDER_ASSUMPTIONS",
            "decision": "APPROVE",
            "object_version": project["brief_version"],
            "actor": "lifecycle-test",
            "comment": "确认合成演示的首单情景假设。",
        },
    )
    assert confirmed.status_code == 200, confirmed.text
    handoff = client.post(
        f"/api/v1/decision-cards/{decision['id']}/handoff-pack:generate",
        headers=idem(),
    )
    assert handoff.status_code == 200, handoff.text
    return client.get(f"/api/v1/projects/{project_id}").json()


def test_incomplete_project_is_draft_until_user_completes_brief(
    client: TestClient,
    idem: Callable[[], dict[str, str]],
) -> None:
    created = client.post(
        "/api/v1/projects",
        headers=idem(),
        json={"name": "未完成的男鞋试销", "brief": {"product_name": "轻量休闲鞋"}},
    )
    assert created.status_code == 201, created.text
    draft = created.json()
    assert draft["status"] == "DRAFT"
    assert draft["brief"]["product_name"] == "轻量休闲鞋"
    assert {"target_audience", "variants", "target_price_fen"} <= set(
        draft["brief_missing_fields"]
    )
    assert draft["created_at"].endswith(("Z", "+00:00"))

    normalize = client.post(
        f"/api/v1/projects/{draft['id']}/brief/normalize",
        headers=idem(),
    )
    assert normalize.status_code == 409

    complete_brief = make_brief(SCENARIOS[DemoScenarioId.GO]).model_dump(mode="json")
    ready = client.put(
        f"/api/v1/projects/{draft['id']}/brief-versions",
        headers={**idem(), "If-Match-Version": str(draft["brief_version"])},
        json=complete_brief,
    )
    assert ready.status_code == 200, ready.text
    assert ready.json()["status"] == "BRIEF_READY"
    assert ready.json()["brief_missing_fields"] == []
    assert ready.json()["brief_version"] == 2

    audits = client.get(f"/api/v1/projects/{draft['id']}/audit-events").json()
    assert all(item["created_at"].endswith(("Z", "+00:00")) for item in audits)


def test_approved_plan_can_reopen_brief_and_requires_plan_v2_reapproval(
    client: TestClient,
    idem: Callable[[], dict[str, str]],
) -> None:
    project = _create_scenario(client, idem)
    project_id = str(project["id"])
    old_plan = _approve_plan(client, idem, project)
    before = client.get(f"/api/v1/projects/{project_id}").json()
    assert before["status"] == "SIMULATION_READY"

    reopened = client.put(
        f"/api/v1/projects/{project_id}/brief-versions",
        headers={**idem(), "If-Match-Version": str(before["brief_version"])},
        json=before["brief"],
    )
    assert reopened.status_code == 200, reopened.text
    assert reopened.json()["status"] == "BRIEF_READY"
    assert reopened.json()["experiment_plan"] is None
    assert reopened.json()["brief_version"] == 2

    stale = client.post(
        f"/api/v1/experiment-plans/{old_plan['id']}/approvals",
        headers=idem(),
        json={
            "gate": "EXPERIMENT_PLAN",
            "decision": "APPROVE",
            "object_version": old_plan["version"],
            "actor": "stale-approver",
        },
    )
    assert stale.status_code in {404, 409}

    normalized = client.post(
        f"/api/v1/projects/{project_id}/brief/normalize",
        headers=idem(),
    )
    assert normalized.status_code == 200, normalized.text
    generated = client.post(
        f"/api/v1/projects/{project_id}/experiment-plans:generate",
        headers=idem(),
    )
    assert generated.status_code == 200, generated.text
    assert generated.json()["experiment_plan"]["version"] == 2
    _approve_plan(client, idem, generated.json())

    database = client.app.state.database
    with database.session() as session:
        approval_count = session.scalar(
            select(func.count())
            .select_from(ApprovalRecord)
            .where(ApprovalRecord.project_id == project_id)
        )
    assert approval_count == 2


def test_policy_can_reopen_approved_plan_and_requires_new_plan_approval(
    client: TestClient,
    idem: Callable[[], dict[str, str]],
) -> None:
    project = _create_scenario(client, idem)
    project_id = str(project["id"])
    _approve_plan(client, idem, project)
    policy = client.get(f"/api/v1/projects/{project_id}/policy").json()
    policy["min_exposure_per_arm"] = 320

    reopened = client.put(
        f"/api/v1/projects/{project_id}/policy",
        headers=idem(),
        json=policy,
    )
    assert reopened.status_code == 200, reopened.text
    body = reopened.json()
    assert body["status"] == "BRIEF_READY"
    assert body["policy_revision"] == 2
    assert body["experiment_plan"] is None

    regenerated = client.post(
        f"/api/v1/projects/{project_id}/experiment-plans:generate",
        headers=idem(),
    )
    assert regenerated.status_code == 200, regenerated.text
    plan = regenerated.json()["experiment_plan"]
    assert plan["version"] == 2
    assert plan["min_exposure_per_arm"] == 320
    _approve_plan(client, idem, regenerated.json())


def test_handoff_reopen_invalidates_projection_but_retains_history(
    client: TestClient,
    idem: Callable[[], dict[str, str]],
) -> None:
    handoff_project = _reach_handoff(client, idem)
    project_id = str(handoff_project["id"])
    assert handoff_project["status"] == "HANDOFF_DRAFT_READY"
    handoff_id = handoff_project["artifacts"]["handoff"]["id"]

    reopened = client.put(
        f"/api/v1/projects/{project_id}/brief-versions",
        headers={
            **idem(),
            "If-Match-Version": str(handoff_project["brief_version"]),
        },
        json=handoff_project["brief"],
    )
    assert reopened.status_code == 200, reopened.text
    detail = reopened.json()
    assert detail["status"] == "BRIEF_READY"
    assert detail["experiment_plan"] is None
    assert detail["artifacts"]["handoff"] is None
    assert all(not dataset["active"] for dataset in detail["datasets"])

    versions = client.get(f"/api/v1/projects/{project_id}/object-versions").json()
    retained_handoffs = [
        row for row in versions if row["object_type"] == "HandoffPackage"
    ]
    assert retained_handoffs[0]["payload"]["id"] == handoff_id
    audit = client.get(f"/api/v1/projects/{project_id}/audit-events").json()
    reopen_event = next(row for row in audit if row["action"] == "BRIEF_VERSION_CREATED")
    assert reopen_event["summary"]["invalidated_handoff_id"] == handoff_id


def test_archive_accepts_terminal_or_explicit_cancel_and_blocks_mutation(
    client: TestClient,
    idem: Callable[[], dict[str, str]],
) -> None:
    draft = client.post(
        "/api/v1/projects",
        headers=idem(),
        json={"name": "待取消草稿"},
    ).json()
    refused = client.post(
        f"/api/v1/projects/{draft['id']}:archive",
        headers=idem(),
        json={"actor": "owner", "reason": "尚未明确取消"},
    )
    assert refused.status_code == 409
    cancelled = client.post(
        f"/api/v1/projects/{draft['id']}:archive",
        headers=idem(),
        json={
            "actor": "owner",
            "reason": "人工取消未完成实验",
            "cancel_active_work": True,
        },
    )
    assert cancelled.status_code == 200, cancelled.text
    assert cancelled.json()["status"] == "ARCHIVED"

    blocked_brief = client.put(
        f"/api/v1/projects/{draft['id']}/brief-versions",
        headers={**idem(), "If-Match-Version": "1"},
        json=draft["brief"],
    )
    assert blocked_brief.status_code == 409
    blocked_policy = client.put(
        f"/api/v1/projects/{draft['id']}/policy",
        headers=idem(),
        json=cancelled.json()["current_policy"],
    )
    assert blocked_policy.status_code == 409
    blocked_attachment = client.post(
        f"/api/v1/projects/{draft['id']}/attachments",
        headers=idem(),
        files={"file": ("draft.png", b"not-written", "image/png")},
        data={"rights_declaration": "测试权属"},
    )
    assert blocked_attachment.status_code == 409
    audit = client.get(f"/api/v1/projects/{draft['id']}/audit-events").json()
    assert audit[-1]["action"] == "PROJECT_CANCELLED_AND_ARCHIVED"

    terminal_project, _ = _reach_approved_decision(client, idem)
    archived = client.post(
        f"/api/v1/projects/{terminal_project['id']}:archive",
        headers=idem(),
        json={"actor": "owner", "reason": "决策流程已结束"},
    )
    assert archived.status_code == 200, archived.text
    assert archived.json()["status"] == "ARCHIVED"
    blocked_simulation = client.post(
        f"/api/v1/simulation-runs/{terminal_project['id']}:complete",
        headers=idem(),
    )
    assert blocked_simulation.status_code == 409
    assert "archived projects are immutable" in blocked_simulation.json()["detail"]
    second = client.post(
        f"/api/v1/projects/{terminal_project['id']}:archive",
        headers=idem(),
        json={"actor": "owner", "reason": "重复归档"},
    )
    assert second.status_code == 409

    database = client.app.state.database
    with database.session() as session:
        assert session.scalar(
            select(func.count())
            .select_from(ObjectVersionRecord)
            .where(ObjectVersionRecord.project_id == terminal_project["id"])
        )
        # Archival is a state transition, never a dataset/object delete.
        assert session.scalar(
            select(func.count())
            .select_from(DatasetRecord)
            .where(DatasetRecord.project_id == terminal_project["id"])
        ) == 1
