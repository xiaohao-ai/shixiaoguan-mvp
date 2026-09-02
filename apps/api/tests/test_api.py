from __future__ import annotations

import base64
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from fastapi.testclient import TestClient

from shixiaoguan_api.main import create_app


def _create_scenario(
    client: TestClient, headers: Callable[[], dict[str, str]], scenario: str = "GO"
) -> dict[str, object]:
    response = client.post(f"/api/v1/demo/scenarios/{scenario}/projects", headers=headers())
    assert response.status_code == 201, response.text
    return response.json()


def _approve_plan(
    client: TestClient,
    headers: Callable[[], dict[str, str]],
    project: dict[str, object],
) -> dict[str, object]:
    plan = project["experiment_plan"]
    assert isinstance(plan, dict)
    response = client.post(
        f"/api/v1/experiment-plans/{plan['id']}/approvals",
        headers=headers(),
        json={
            "gate": "EXPERIMENT_PLAN",
            "decision": "APPROVE",
            "object_version": plan["version"],
            "actor": "pytest",
        },
    )
    assert response.status_code == 200, response.text
    assert response.json()["project_status"] == "SIMULATION_READY"
    return plan


def _confirm_first_order_assumptions(
    client: TestClient,
    headers: Callable[[], dict[str, str]],
    project_id: str,
    *,
    actor: str = "pytest-first-order-confirmant",
) -> dict[str, object]:
    detail = client.get(f"/api/v1/projects/{project_id}").json()
    response = client.post(
        f"/api/v1/projects/{project_id}/first-order-assumptions/approvals",
        headers=headers(),
        json={
            "gate": "FIRST_ORDER_ASSUMPTIONS",
            "decision": "APPROVE",
            "object_version": detail["brief_version"],
            "actor": actor,
            "comment": "已人工复核转化率、触达量与包装步长假设。",
        },
    )
    assert response.status_code == 200, response.text
    return response.json()


def test_idempotency_is_required_replayed_and_conflict_safe(
    client: TestClient,
) -> None:
    missing = client.post("/api/v1/demo/scenarios/GO/projects")
    assert missing.status_code == 400

    key = {"Idempotency-Key": "same-key"}
    first = client.post("/api/v1/demo/scenarios/GO/projects", headers=key)
    replay = client.post("/api/v1/demo/scenarios/GO/projects", headers=key)
    conflict = client.post("/api/v1/demo/scenarios/NO_GO/projects", headers=key)

    assert first.status_code == replay.status_code == 201
    assert first.json()["id"] == replay.json()["id"]
    assert replay.headers["Idempotency-Replayed"] == "true"
    assert conflict.status_code == 409


def test_concurrent_identical_idempotency_key_executes_one_mutation(
    client: TestClient,
) -> None:
    key = {"Idempotency-Key": "concurrent-same-key"}

    with ThreadPoolExecutor(max_workers=2) as pool:
        responses = list(
            pool.map(
                lambda _: client.post(
                    "/api/v1/demo/scenarios/GO/projects",
                    headers=key,
                ),
                range(2),
            )
        )

    assert [response.status_code for response in responses] == [201, 201]
    assert len({response.json()["id"] for response in responses}) == 1
    assert sorted(response.headers["Idempotency-Replayed"] for response in responses) == [
        "false",
        "true",
    ]
    assert len(client.get("/api/v1/projects").json()) == 1


def test_file_backed_sqlite_commits_route_before_idempotency_record(
    tmp_path: Path,
) -> None:
    """Regression: two pending writers used to lock every real local mutation."""
    app = create_app(f"sqlite:///{tmp_path / 'file-backed.db'}")
    with TestClient(app, raise_server_exceptions=True) as file_client:
        response = file_client.post(
            "/api/v1/demo/scenarios/GO/projects",
            headers={"Idempotency-Key": "file-backed-create"},
        )
        replay = file_client.post(
            "/api/v1/demo/scenarios/GO/projects",
            headers={"Idempotency-Key": "file-backed-create"},
        )

    assert response.status_code == replay.status_code == 201
    assert response.json()["id"] == replay.json()["id"]
    assert replay.headers["Idempotency-Replayed"] == "true"


def test_reopening_same_scenario_uses_project_unique_plan_ids(
    client: TestClient, idem: Callable[[], dict[str, str]]
) -> None:
    first = _create_scenario(client, idem, "GO")
    second = _create_scenario(client, idem, "GO")
    first_plan = first["experiment_plan"]
    second_plan = second["experiment_plan"]
    assert isinstance(first_plan, dict)
    assert isinstance(second_plan, dict)
    assert first["id"] != second["id"]
    assert first_plan["id"] != second_plan["id"]

    _approve_plan(client, idem, second)
    first_after = client.get(f"/api/v1/projects/{first['id']}").json()
    second_after = client.get(f"/api/v1/projects/{second['id']}").json()
    assert first_after["status"] == "PLAN_PROPOSED"
    assert second_after["status"] == "SIMULATION_READY"


def test_full_canonical_go_workflow_and_audit(
    client: TestClient, idem: Callable[[], dict[str, str]]
) -> None:
    project = _create_scenario(client, idem)
    project_id = str(project["id"])
    plan = _approve_plan(client, idem, project)

    run = client.post(f"/api/v1/projects/{project_id}/simulation-runs", headers=idem())
    assert run.status_code == 201
    assert run.json()["fixed_seed"] == 20260903

    completed = client.post(f"/api/v1/simulation-runs/{project_id}:complete", headers=idem())
    assert completed.status_code == 200, completed.text
    simulation = completed.json()
    assert simulation["project_status"] == "DATA_READY"
    assert len(simulation["dataset_sha256"]) == 64
    dataset_id = simulation["dataset"]["id"]

    quality = client.post(f"/api/v1/datasets/{dataset_id}:validate", headers=idem())
    assert quality.status_code == 200
    assert quality.json()["status"] == "PASS"

    analysis = client.post(f"/api/v1/experiments/{plan['id']}:analyze", headers=idem())
    assert analysis.status_code == 200, analysis.text
    bundle = analysis.json()
    assert bundle["decision"]["outcome"] == "GO"
    assert bundle["metrics"]["total_purchase_intent"] > 0
    assert any(
        "purchase_intent_count" in " ".join(claim["metric_refs"])
        for claim in bundle["evidence"]["claims"]
    )

    generated = client.post(
        f"/api/v1/experiments/{plan['id']}/decision-cards:generate",
        headers=idem(),
    )
    assert generated.status_code == 200
    decision = generated.json()
    approved = client.post(
        f"/api/v1/decision-cards/{decision['id']}/approvals",
        headers=idem(),
        json={
            "gate": "DECISION",
            "decision": "APPROVE",
            "object_version": decision["version"],
            "actor": "pytest",
        },
    )
    assert approved.status_code == 200

    before_confirmation = client.post(
        f"/api/v1/decision-cards/{decision['id']}/handoff-pack:generate",
        headers=idem(),
    )
    assert before_confirmation.status_code == 409
    assert "explicit human confirmation" in before_confirmation.json()["detail"]

    confirmation = _confirm_first_order_assumptions(client, idem, project_id)
    assert confirmation["gate"] == "FIRST_ORDER_ASSUMPTIONS"
    assert confirmation["target_type"] == "FirstOrderAssumptionsProposal"
    assert confirmation["object_version"] == project["brief_version"]
    confirmed_detail = client.get(f"/api/v1/projects/{project_id}").json()
    confirmed = confirmed_detail["first_order_assumptions_confirmation"]
    assert confirmed["actor"] == "pytest-first-order-confirmant"
    assert confirmed["brief_version"] == project["brief_version"]
    assert confirmed["proposal_source"] == "DEMO_PROPOSAL"

    handoff = client.post(
        f"/api/v1/decision-cards/{decision['id']}/handoff-pack:generate",
        headers=idem(),
    )
    assert handoff.status_code == 200, handoff.text
    package = handoff.json()
    assert package["status"] == "DRAFT_REQUIRES_SEPARATE_EXTERNAL_APPROVAL"
    assert {item["name"] for item in package["first_order_scenarios"]} == {
        "CONSERVATIVE",
        "BASE",
        "AGGRESSIVE",
    }
    assert [item["status"] for item in package["first_order_scenarios"]] == [
        "READY",
        "READY",
        "READY",
    ]
    fields = {field["name"]: field for field in package["techpack"]["fields"]}
    assert fields["鞋楦"]["value"] is None
    assert fields["鞋楦"]["status"] == "PENDING_CONFIRMATION"
    assert "防滑验收标准" in fields

    runs = client.get(f"/api/v1/projects/{project_id}/agent-runs").json()
    report = client.get(f"/api/v1/projects/{project_id}/report")
    assert report.status_code == 200
    assert "SYNTHETIC" in report.text
    assert simulation["dataset_sha256"] in report.text
    assert "Agent 运行记录" in report.text
    assert "非生产指令" in report.text
    assert all(item["input_sha256"] in report.text for item in runs)
    audits = client.get(f"/api/v1/projects/{project_id}/audit-events").json()
    assert {event["to_state"] for event in audits} >= {
        "PLAN_APPROVED",
        "SIMULATION_READY",
        "SIMULATION_RUNNING",
        "DATA_READY",
        "DATA_VALIDATED",
        "ANALYZED",
        "DECISION_PROPOSED",
        "DECISION_APPROVED",
        "HANDOFF_DRAFT_READY",
    }
    assert [item["operation"] for item in runs] == [
        "NORMALIZE_BRIEF",
        "GENERATE_EXPERIMENT_PLAN",
        "EXPLAIN_DECISION",
    ]
    assert all(item["mode"] == "OFFLINE_REPLAY" for item in runs)
    assert all(len(item["input_sha256"]) == 64 for item in runs)
    assert all(item["output_schema_version"] for item in runs)
    assert all(item["recording_id"] for item in runs)
    assert all(item["recording_id"] in report.text for item in runs)


def test_policy_versions_before_approval_and_snapshot_drives_analysis(
    client: TestClient, idem: Callable[[], dict[str, str]]
) -> None:
    project = _create_scenario(client, idem)
    project_id = str(project["id"])
    old_plan = project["experiment_plan"]
    assert isinstance(old_plan, dict)
    policy = client.get(f"/api/v1/projects/{project_id}/policy").json()
    policy["purchase_intent_rate_threshold"] = 0.04

    updated = client.put(f"/api/v1/projects/{project_id}/policy", headers=idem(), json=policy)
    assert updated.status_code == 200, updated.text
    body = updated.json()
    assert body["status"] == "BRIEF_READY"
    assert body["policy_revision"] == 2

    stale = client.post(
        f"/api/v1/experiment-plans/{old_plan['id']}/approvals",
        headers=idem(),
        json={
            "gate": "EXPERIMENT_PLAN",
            "decision": "APPROVE",
            "object_version": old_plan["version"],
            "actor": "pytest",
        },
    )
    assert stale.status_code in {404, 409}

    regenerated = client.post(
        f"/api/v1/projects/{project_id}/experiment-plans:generate", headers=idem()
    )
    assert regenerated.status_code == 200, regenerated.text
    new_project = regenerated.json()
    new_plan = _approve_plan(client, idem, new_project)
    assert new_plan["version"] == 2
    assert new_plan["policy_snapshot"]["purchase_intent_rate_threshold"] == 0.04

    simulation = client.post(
        f"/api/v1/simulation-runs/{project_id}:complete", headers=idem()
    ).json()
    analysis = client.post(f"/api/v1/experiments/{new_plan['id']}:analyze", headers=idem())
    assert simulation["plan_version"] == 2
    assert analysis.status_code == 200
    assert analysis.json()["decision"]["outcome"] != "GO"

    reopened = client.put(
        f"/api/v1/projects/{project_id}/policy",
        headers=idem(),
        json=new_project["current_policy"],
    )
    assert reopened.status_code == 200, reopened.text
    assert reopened.json()["status"] == "BRIEF_READY"
    assert reopened.json()["policy_revision"] == 3
    assert reopened.json()["experiment_plan"] is None


def test_attachment_magic_size_rights_and_safe_filename(
    client: TestClient, idem: Callable[[], dict[str, str]]
) -> None:
    project = _create_scenario(client, idem)
    project_id = str(project["id"])
    png = base64.b64decode(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9WlDglsAAAAASUVORK5CYII="
    )
    uploaded = client.post(
        f"/api/v1/projects/{project_id}/attachments",
        headers=idem(),
        files={"file": ("../unsafe.png", png, "image/png")},
        data={"rights_declaration": "用户确认拥有演示素材使用权"},
    )
    assert uploaded.status_code == 201, uploaded.text
    attachment = uploaded.json()
    assert attachment["original_filename"] == "unsafe.png"
    assert attachment["mime_type"] == "image/png"
    assert ".." not in attachment["object_key"]

    listed = client.get(f"/api/v1/projects/{project_id}/attachments")
    assert listed.json() == [attachment]
    content = client.get(f"/api/v1/projects/{project_id}/attachments/{attachment['id']}/content")
    assert content.status_code == 200
    assert content.content == png

    fake = client.post(
        f"/api/v1/projects/{project_id}/attachments",
        headers=idem(),
        files={"file": ("fake.png", b"not an image", "image/png")},
        data={"rights_declaration": "rights clear"},
    )
    assert fake.status_code == 422


def test_openapi_has_canonical_routes_and_no_dataset_upload(
    client: TestClient,
) -> None:
    paths = client.get("/openapi.json").json()["paths"]
    expected = {
        "/api/v1/projects",
        "/api/v1/projects/{project_id}:archive",
        "/api/v1/projects/{project_id}/brief-versions",
        "/api/v1/projects/{project_id}/experiment-plans:generate",
        "/api/v1/experiment-plans/{plan_id}/approvals",
        "/api/v1/projects/{project_id}/simulation-runs",
        "/api/v1/simulation-runs/{run_id}",
        "/api/v1/simulation-runs/{run_id}:complete",
        "/api/v1/datasets/{dataset_id}:validate",
        "/api/v1/experiments/{experiment_id}:analyze",
        "/api/v1/experiments/{experiment_id}/decision-cards:generate",
        "/api/v1/decision-cards/{decision_id}/approvals",
        "/api/v1/decision-cards/{decision_id}/handoff-pack:generate",
        "/api/v1/projects/{project_id}/audit-events",
        "/api/v1/projects/{project_id}/report",
    }
    assert expected <= set(paths)
    assert all("upload" not in path for path in paths if "/datasets" in path)


def test_simulation_rejects_unapproved_plan(
    client: TestClient, idem: Callable[[], dict[str, str]]
) -> None:
    project = _create_scenario(client, idem)
    response = client.post(f"/api/v1/simulation-runs/{project['id']}:complete", headers=idem())
    assert response.status_code == 409


def _analyze_scenario(
    client: TestClient,
    idem: Callable[[], dict[str, str]],
    scenario: str,
) -> tuple[dict[str, object], dict[str, object]]:
    project = _create_scenario(client, idem, scenario)
    plan = _approve_plan(client, idem, project)
    completed = client.post(f"/api/v1/simulation-runs/{project['id']}:complete", headers=idem())
    assert completed.status_code == 200
    analysis = client.post(f"/api/v1/experiments/{plan['id']}:analyze", headers=idem())
    assert analysis.status_code == 200, analysis.text
    return project, analysis.json()["decision"]


def test_first_order_assumptions_require_post_decision_exact_brief_version_confirmation(
    client: TestClient, idem: Callable[[], dict[str, str]]
) -> None:
    project, decision = _analyze_scenario(client, idem, "GO")
    project_id = str(project["id"])
    brief_version = int(project["brief_version"])

    premature = client.post(
        f"/api/v1/projects/{project_id}/first-order-assumptions/approvals",
        headers=idem(),
        json={
            "gate": "FIRST_ORDER_ASSUMPTIONS",
            "decision": "APPROVE",
            "object_version": brief_version,
            "actor": "premature-actor",
        },
    )
    assert premature.status_code == 409

    decision_approval = client.post(
        f"/api/v1/decision-cards/{decision['id']}/approvals",
        headers=idem(),
        json={
            "gate": "DECISION",
            "decision": "APPROVE",
            "object_version": decision["version"],
            "actor": "decision-owner",
        },
    )
    assert decision_approval.status_code == 200

    wrong_gate = client.post(
        f"/api/v1/projects/{project_id}/first-order-assumptions/approvals",
        headers=idem(),
        json={
            "gate": "DECISION",
            "decision": "APPROVE",
            "object_version": brief_version,
            "actor": "attacker",
        },
    )
    assert wrong_gate.status_code == 422

    stale = client.post(
        f"/api/v1/projects/{project_id}/first-order-assumptions/approvals",
        headers=idem(),
        json={
            "gate": "FIRST_ORDER_ASSUMPTIONS",
            "decision": "APPROVE",
            "object_version": brief_version + 1,
            "actor": "stale-actor",
        },
    )
    assert stale.status_code == 409

    rejected_shape = client.post(
        f"/api/v1/projects/{project_id}/first-order-assumptions/approvals",
        headers=idem(),
        json={
            "gate": "FIRST_ORDER_ASSUMPTIONS",
            "decision": "REJECT",
            "object_version": brief_version,
            "actor": "reviewer",
        },
    )
    assert rejected_shape.status_code == 422

    confirmation = _confirm_first_order_assumptions(
        client, idem, project_id, actor="named-current-operator"
    )
    assert confirmation["object_version"] == brief_version
    assert confirmation["actor"] == "named-current-operator"
    assert confirmation["created_at"]

    overwrite = client.post(
        f"/api/v1/projects/{project_id}/first-order-assumptions/approvals",
        headers=idem(),
        json={
            "gate": "FIRST_ORDER_ASSUMPTIONS",
            "decision": "APPROVE",
            "object_version": brief_version,
            "actor": "second-actor",
        },
    )
    assert overwrite.status_code == 409

    detail = client.get(f"/api/v1/projects/{project_id}").json()
    effective = detail["first_order_assumptions_confirmation"]
    assert effective["actor"] == "named-current-operator"
    assert effective["brief_version"] == brief_version
    assert effective["confirmed_at"] == confirmation["created_at"]


def test_pivot_revision_requires_exact_version_approval_before_conditional_handoff(
    client: TestClient, idem: Callable[[], dict[str, str]]
) -> None:
    project, decision = _analyze_scenario(client, idem, "PIVOT_DESIGN")
    project_id = str(project["id"])

    before_decision_approval = client.post(
        f"/api/v1/decision-cards/{decision['id']}/pivot-revisions:generate",
        headers=idem(),
    )
    assert before_decision_approval.status_code == 409

    approval = client.post(
        f"/api/v1/decision-cards/{decision['id']}/approvals",
        headers=idem(),
        json={
            "gate": "DECISION",
            "decision": "APPROVE",
            "object_version": decision["version"],
            "actor": "pytest",
        },
    )
    assert approval.status_code == 200
    _confirm_first_order_assumptions(client, idem, project_id)

    bypass = client.post(
        f"/api/v1/decision-cards/{decision['id']}/handoff-pack:generate",
        headers=idem(),
    )
    assert bypass.status_code == 409
    assert "PivotRevision" in bypass.json()["detail"]

    first_revision = client.post(
        f"/api/v1/decision-cards/{decision['id']}/pivot-revisions:generate",
        headers=idem(),
    )
    assert first_revision.status_code == 200, first_revision.text
    revision_v1 = first_revision.json()
    assert revision_v1["version"] == 1
    assert revision_v1["approval_status"] == "PENDING"
    assert revision_v1["change_variable"] == "COLOR"
    assert revision_v1["target_variant_id"] == "COLOR-IVORY"
    assert len(revision_v1["change_list"]) == 1

    second_revision = client.post(
        f"/api/v1/decision-cards/{decision['id']}/pivot-revisions:generate",
        headers=idem(),
    )
    assert second_revision.status_code == 200
    revision_v2 = second_revision.json()
    assert revision_v2["version"] == 2
    assert revision_v2["id"] != revision_v1["id"]

    stale_target = client.post(
        f"/api/v1/pivot-revisions/{revision_v1['id']}/approvals",
        headers=idem(),
        json={
            "gate": "PIVOT_REVISION",
            "decision": "APPROVE",
            "object_version": revision_v1["version"],
            "actor": "pytest",
        },
    )
    assert stale_target.status_code == 409

    stale_version = client.post(
        f"/api/v1/pivot-revisions/{revision_v2['id']}/approvals",
        headers=idem(),
        json={
            "gate": "PIVOT_REVISION",
            "decision": "APPROVE",
            "object_version": revision_v1["version"],
            "actor": "pytest",
        },
    )
    assert stale_version.status_code == 409

    revision_approval = client.post(
        f"/api/v1/pivot-revisions/{revision_v2['id']}/approvals",
        headers=idem(),
        json={
            "gate": "PIVOT_REVISION",
            "decision": "APPROVE",
            "object_version": revision_v2["version"],
            "actor": "pytest",
            "comment": "批准该精确修订版本进入改款打样草稿。",
        },
    )
    assert revision_approval.status_code == 200, revision_approval.text
    assert revision_approval.json()["target_id"] == revision_v2["id"]
    assert revision_approval.json()["object_version"] == 2

    overwrite_approval = client.post(
        f"/api/v1/pivot-revisions/{revision_v2['id']}/approvals",
        headers=idem(),
        json={
            "gate": "PIVOT_REVISION",
            "decision": "REJECT",
            "object_version": revision_v2["version"],
            "actor": "pytest",
        },
    )
    assert overwrite_approval.status_code == 409

    detail = client.get(f"/api/v1/projects/{project_id}").json()
    assert detail["workflow_state"] == detail["status"] == "DECISION_APPROVED"
    assert detail["data_origin"] == detail["data_status"] == "SYNTHETIC"
    assert detail["artifacts"]["pivot_revision"] == {
        **revision_v2,
        "approval_status": "APPROVED",
    }

    handoff = client.post(
        f"/api/v1/decision-cards/{decision['id']}/handoff-pack:generate",
        headers=idem(),
    )
    assert handoff.status_code == 200, handoff.text
    body = handoff.json()
    assert body["status"] == "CONDITIONAL_DRAFT"
    assert body["pivot_revision_id"] == revision_v2["id"]
    assert body["techpack"] is None
    assert body["sample_task"] is not None
    assert body["sample_task"]["pivot_revision_id"] == revision_v2["id"]
    assert body["sample_task"]["change_list"] == revision_v2["change_list"]
    assert "不得下单" in body["watermark"]
    assert all(
        item["status"] == "CONDITIONAL_RETEST_REQUIRED" for item in body["first_order_scenarios"]
    )

    audits = client.get(f"/api/v1/projects/{project_id}/audit-events").json()
    generated_events = [
        item for item in audits if item["action"] == "PIVOT_REVISION_GENERATED"
    ]
    assert [item["summary"]["pivot_revision_version"] for item in generated_events] == [1, 2]
    assert any(
        item["action"] == "APPROVAL_RECORDED"
        and item["summary"].get("target_id") == revision_v2["id"]
        for item in audits
    )
    first_order_events = [
        item
        for item in audits
        if item["object_type"] == "FIRST_ORDER_ASSUMPTIONS"
        and item["action"] == "APPROVAL_RECORDED"
    ]
    assert len(first_order_events) == 1
    assert first_order_events[0]["actor"] == "pytest-first-order-confirmant"
    assert first_order_events[0]["summary"]["object_version"] == project["brief_version"]


def test_no_go_and_evidence_insufficient_handoff_are_rejected(
    client: TestClient, idem: Callable[[], dict[str, str]]
) -> None:
    _, no_go = _analyze_scenario(client, idem, "NO_GO")
    approval = client.post(
        f"/api/v1/decision-cards/{no_go['id']}/approvals",
        headers=idem(),
        json={
            "gate": "DECISION",
            "decision": "APPROVE",
            "object_version": no_go["version"],
            "actor": "pytest",
        },
    )
    assert approval.status_code == 200
    rejected = client.post(
        f"/api/v1/decision-cards/{no_go['id']}/handoff-pack:generate",
        headers=idem(),
    )
    assert rejected.status_code == 409

    _, insufficient = _analyze_scenario(client, idem, "INSUFFICIENT_DATA")
    insufficient_handoff = client.post(
        f"/api/v1/decision-cards/{insufficient['id']}/handoff-pack:generate",
        headers=idem(),
    )
    assert insufficient_handoff.status_code == 409
