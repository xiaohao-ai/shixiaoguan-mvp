from __future__ import annotations

import hashlib
import json
from collections.abc import Callable

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import func, select

from shixiaoguan_api.database import DatasetRecord, ObjectVersionRecord, TrialObservationRecord
from shixiaoguan_api.enums import DemoScenarioId
from shixiaoguan_api.schemas import ProductBrief, ProjectUpdate
from shixiaoguan_api.seed import SCENARIOS, make_brief
from shixiaoguan_api.services import (
    ConflictError,
    _append_object_version,
    trial_observations,
    update_project,
)


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
            "actor": "ledger-test",
        },
    )
    assert response.status_code == 200, response.text
    return plan


def _canonical_sha256(payload: dict[str, object]) -> str:
    encoded = json.dumps(
        payload,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
        allow_nan=False,
    ).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def test_initial_snapshots_are_canonical_and_read_only(
    client: TestClient,
    idem: Callable[[], dict[str, str]],
) -> None:
    project = _create_scenario(client, idem)
    project_id = str(project["id"])

    response = client.get(f"/api/v1/projects/{project_id}/object-versions")
    assert response.status_code == 200
    records = response.json()
    assert [(row["object_type"], row["object_version"]) for row in records] == [
        ("ProductBrief", 1),
        ("DemoPolicy", 1),
        ("ExperimentPlan", 1),
    ]
    assert all(row["project_id"] == project_id for row in records)
    assert all(row["sha256"] == _canonical_sha256(row["payload"]) for row in records)


def test_same_identity_and_version_is_idempotent_but_cannot_be_overwritten(
    client: TestClient,
    idem: Callable[[], dict[str, str]],
) -> None:
    project = _create_scenario(client, idem)
    project_id = str(project["id"])
    database = client.app.state.database

    with database.session() as session:
        before = session.scalar(
            select(func.count())
            .select_from(ObjectVersionRecord)
            .where(ObjectVersionRecord.project_id == project_id)
        )
        first = _append_object_version(
            session,
            project_id=project_id,
            object_type="ProductBrief",
            object_id=f"product-brief-{project_id}",
            object_version=1,
            payload=project["brief"],
        )
        replay = _append_object_version(
            session,
            project_id=project_id,
            object_type="ProductBrief",
            object_id=f"product-brief-{project_id}",
            object_version=1,
            payload=dict(reversed(list(project["brief"].items()))),
        )
        assert first.id == replay.id
        after = session.scalar(
            select(func.count())
            .select_from(ObjectVersionRecord)
            .where(ObjectVersionRecord.project_id == project_id)
        )
        assert before == after

        changed = dict(project["brief"])
        changed["business_goal"] = "attempted overwrite"
        with pytest.raises(ConflictError, match="already exists"):
            _append_object_version(
                session,
                project_id=project_id,
                object_type="ProductBrief",
                object_id=f"product-brief-{project_id}",
                object_version=1,
                payload=changed,
            )


def test_brief_replacement_preserves_history_and_plan_version_keeps_increasing(
    client: TestClient,
    idem: Callable[[], dict[str, str]],
) -> None:
    project = _create_scenario(client, idem)
    project_id = str(project["id"])
    # Move to another pre-recorded Demo Brief so strict replay remains valid.
    brief = make_brief(SCENARIOS[DemoScenarioId.PIVOT_PRICE]).model_dump(mode="json")

    updated = client.put(
        f"/api/v1/projects/{project_id}/brief-versions",
        headers={**idem(), "If-Match-Version": "1"},
        json=brief,
    )
    assert updated.status_code == 200, updated.text
    assert updated.json()["brief_version"] == 2

    normalized = client.post(
        f"/api/v1/projects/{project_id}/brief/normalize",
        headers=idem(),
    )
    assert normalized.status_code == 200, normalized.text
    regenerated = client.post(
        f"/api/v1/projects/{project_id}/experiment-plans:generate",
        headers=idem(),
    )
    assert regenerated.status_code == 200, regenerated.text
    new_plan = regenerated.json()["experiment_plan"]
    assert new_plan["version"] == 2
    assert new_plan["id"].endswith("-v2")

    records = client.get(f"/api/v1/projects/{project_id}/object-versions").json()
    brief_rows = [row for row in records if row["object_type"] == "ProductBrief"]
    plan_rows = [row for row in records if row["object_type"] == "ExperimentPlan"]
    assert [row["object_version"] for row in brief_rows] == [1, 2]
    assert [row["payload"]["target_price_fen"] for row in brief_rows] == [39900, 49900]
    assert [row["object_version"] for row in plan_rows] == [1, 2]


def test_inactive_dataset_keeps_old_observations_outside_current_business_read(
    client: TestClient,
    idem: Callable[[], dict[str, str]],
) -> None:
    project = _create_scenario(client, idem)
    project_id = str(project["id"])
    _approve_plan(client, idem, project)
    completed = client.post(
        f"/api/v1/simulation-runs/{project_id}:complete",
        headers=idem(),
    )
    assert completed.status_code == 200, completed.text
    old_dataset_id = completed.json()["dataset"]["id"]
    old_count = completed.json()["dataset"]["row_count"]
    assert old_count > 0

    brief = ProductBrief.model_validate(project["brief"])
    replacement = brief.model_copy(update={"business_goal": "新的实验周期"})
    database = client.app.state.database
    with database.session() as session:
        update_project(
            session,
            project_id,
            ProjectUpdate(brief=replacement),
        )

    with database.session() as session:
        dataset = session.get(DatasetRecord, old_dataset_id)
        assert dataset is not None
        assert dataset.active is False
        stored_count = session.scalar(
            select(func.count())
            .select_from(TrialObservationRecord)
            .where(TrialObservationRecord.dataset_id == old_dataset_id)
        )
        assert stored_count == old_count
        assert trial_observations(session, project_id) == []


def test_same_project_replay_reset_retains_history_and_reproduces_dataset(
    client: TestClient,
    idem: Callable[[], dict[str, str]],
) -> None:
    project = _create_scenario(client, idem)
    project_id = str(project["id"])
    plan = _approve_plan(client, idem, project)
    completed = client.post(
        f"/api/v1/simulation-runs/{project_id}:complete",
        headers=idem(),
    )
    assert completed.status_code == 200, completed.text
    first_dataset = completed.json()["dataset"]
    first_dataset_id = first_dataset["id"]
    first_dataset_sha256 = first_dataset["sha256"]
    first_row_count = first_dataset["row_count"]

    analyzed = client.post(
        f"/api/v1/experiments/{plan['id']}:analyze",
        headers=idem(),
    )
    assert analyzed.status_code == 200, analyzed.text
    assert analyzed.json()["decision"]["approval_status"] == "PENDING"
    versions_before_reset = client.get(
        f"/api/v1/projects/{project_id}/object-versions"
    ).json()

    reset_headers = {"Idempotency-Key": "same-project-replay-reset"}
    reset = client.post(
        f"/api/v1/projects/{project_id}/simulation/replay-reset",
        headers=reset_headers,
    )
    replayed_reset = client.post(
        f"/api/v1/projects/{project_id}/simulation/replay-reset",
        headers=reset_headers,
    )
    assert reset.status_code == replayed_reset.status_code == 200
    assert replayed_reset.headers["Idempotency-Replayed"] == "true"
    reset_project = reset.json()
    assert reset_project["workflow_state"] == "SIMULATION_READY"
    assert reset_project["current_day"] == 0
    assert reset_project["experiment_plan"]["approval_status"] == "APPROVED"
    assert reset_project["artifacts"]["quality"] is None
    assert reset_project["artifacts"]["metrics"] is None
    assert reset_project["artifacts"]["evidence"] is None
    assert reset_project["artifacts"]["decision"] is None
    assert reset_project["artifacts"]["handoff"] is None
    assert client.get(f"/api/v1/projects/{project_id}/observations").json() == []
    assert client.get(f"/api/v1/projects/{project_id}/object-versions").json() == (
        versions_before_reset
    )

    database = client.app.state.database
    with database.session() as session:
        old_dataset = session.get(DatasetRecord, first_dataset_id)
        assert old_dataset is not None
        assert old_dataset.active is False
        retained_rows = session.scalar(
            select(func.count())
            .select_from(TrialObservationRecord)
            .where(TrialObservationRecord.dataset_id == first_dataset_id)
        )
        assert retained_rows == first_row_count

    audits = client.get(f"/api/v1/projects/{project_id}/audit-events").json()
    reset_events = [
        event for event in audits if event["action"] == "SIMULATION_REPLAY_RESET"
    ]
    assert len(reset_events) == 1
    assert reset_events[0]["request_id"] == reset_headers["Idempotency-Key"]
    assert reset_events[0]["summary"]["deactivated_datasets"] == [
        {
            "dataset_id": first_dataset_id,
            "sha256": first_dataset_sha256,
            "row_count": first_row_count,
        }
    ]
    assert reset_events[0]["summary"]["historical_observations_retained"] is True
    assert reset_events[0]["summary"]["historical_object_versions_retained"] is True

    rerun = client.post(
        f"/api/v1/simulation-runs/{project_id}:complete",
        headers=idem(),
    )
    assert rerun.status_code == 200, rerun.text
    second_dataset = rerun.json()["dataset"]
    assert second_dataset["id"] != first_dataset_id
    assert second_dataset["sha256"] == first_dataset_sha256
    assert second_dataset["row_count"] == first_row_count

    second_analysis = client.post(
        f"/api/v1/experiments/{plan['id']}:analyze",
        headers=idem(),
    )
    assert second_analysis.status_code == 200, second_analysis.text
    second_decision = second_analysis.json()["decision"]
    approved = client.post(
        f"/api/v1/decision-cards/{second_decision['id']}/approvals",
        headers=idem(),
        json={
            "gate": "DECISION",
            "decision": "APPROVE",
            "object_version": second_decision["version"],
            "actor": "replay-reset-test",
        },
    )
    assert approved.status_code == 200, approved.text
    blocked_reset = client.post(
        f"/api/v1/projects/{project_id}/simulation/replay-reset",
        headers=idem(),
    )
    assert blocked_reset.status_code == 409
    assert "decision approval" in blocked_reset.json()["detail"]


def test_full_go_flow_snapshots_each_projected_business_object(
    client: TestClient,
    idem: Callable[[], dict[str, str]],
) -> None:
    project = _create_scenario(client, idem)
    project_id = str(project["id"])
    plan = _approve_plan(client, idem, project)
    completed = client.post(
        f"/api/v1/simulation-runs/{project_id}:complete",
        headers=idem(),
    )
    assert completed.status_code == 200
    dataset_id = completed.json()["dataset"]["id"]
    validated = client.post(f"/api/v1/datasets/{dataset_id}:validate", headers=idem())
    assert validated.status_code == 200
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
            "actor": "ledger-test",
        },
    )
    assert approved.status_code == 200
    confirmation = client.post(
        f"/api/v1/projects/{project_id}/first-order-assumptions/approvals",
        headers=idem(),
        json={
            "gate": "FIRST_ORDER_ASSUMPTIONS",
            "decision": "APPROVE",
            "object_version": project["brief_version"],
            "actor": "ledger-test",
        },
    )
    assert confirmation.status_code == 200, confirmation.text
    handoff = client.post(
        f"/api/v1/decision-cards/{decision['id']}/handoff-pack:generate",
        headers=idem(),
    )
    assert handoff.status_code == 200, handoff.text

    records = client.get(f"/api/v1/projects/{project_id}/object-versions").json()
    by_type: dict[str, list[dict[str, object]]] = {}
    for row in records:
        by_type.setdefault(row["object_type"], []).append(row)
    assert set(by_type) == {
        "ProductBrief",
        "DemoPolicy",
        "ExperimentPlan",
        "QualityReport",
        "MetricBundle",
        "EvidenceCard",
        "DecisionCard",
        "HandoffPackage",
    }
    assert [row["object_version"] for row in by_type["QualityReport"]] == [1, 2]
    assert by_type["DecisionCard"][0]["payload"]["approval_status"] == "PENDING"
    assert by_type["HandoffPackage"][0]["payload"] == handoff.json()
    assert all(row["sha256"] == _canonical_sha256(row["payload"]) for row in records)
