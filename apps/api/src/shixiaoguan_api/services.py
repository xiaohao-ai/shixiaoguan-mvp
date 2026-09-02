from __future__ import annotations

import hashlib
import json
import uuid
from collections.abc import Sequence
from datetime import UTC, date, datetime
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from .agent import AgentAdapter, AgentExecution
from .analytics import calculate_metrics, trial_dataset_sha256, validate_trial_data
from .database import (
    AgentRunRecord,
    ApprovalRecord,
    AttachmentRecord,
    AuditEventRecord,
    DatasetRecord,
    ObjectVersionRecord,
    PivotRevisionRecord,
    ProjectRecord,
    TrialObservationRecord,
)
from .enums import (
    AgentMode,
    ApprovalDecision,
    ApprovalGate,
    ApprovalStatus,
    DataSensitivityLevel,
    DataStatus,
    DecisionOutcome,
    DemoScenarioId,
    ProjectStatus,
)
from .formatting import format_fen
from .policy import DEFAULT_POLICY, DemoPolicy, build_decision_card, build_evidence_card
from .schemas import (
    AgentBriefNormalization,
    AgentRunSummary,
    AnalysisBundle,
    ApprovalRequest,
    ApprovalResponse,
    ArtifactBundle,
    Attachment,
    AuditEvent,
    CandidateVariant,
    DatasetSummary,
    DecisionCard,
    EvidenceCard,
    ExperimentArm,
    ExperimentPlan,
    FirstOrderAssumptionsConfirmation,
    FirstOrderScenario,
    HandoffPackage,
    MetricBundle,
    ObjectVersionSummary,
    PivotRevision,
    ProductBrief,
    ProductBriefDraft,
    ProjectArchiveRequest,
    ProjectCreate,
    ProjectDetail,
    ProjectListItem,
    ProjectUpdate,
    QualityReport,
    SampleTask,
    SimulationResponse,
    SimulationRun,
    StopRule,
    TechPackField,
    TechPackLite,
    TrialObservation,
)
from .seed import (
    FIXED_SEED,
    GENERATOR_VERSION,
    SCENARIO_VERSION,
    get_scenario,
    make_brief,
    make_observations,
    make_plan,
)

SCHEMA_VERSION = "trial-observation-v1"


def utc_now() -> datetime:
    return datetime.now(UTC)


def _as_utc(value: datetime) -> datetime:
    return value if value.tzinfo is not None else value.replace(tzinfo=UTC)


def new_id() -> str:
    return str(uuid.uuid4())


class ServiceError(Exception):
    pass


class NotFoundError(ServiceError):
    pass


class ConflictError(ServiceError):
    pass


class InputError(ServiceError):
    pass


def _require_p0_synthetic_origin(brief: ProductBriefDraft) -> None:
    """The P0 simulator is the only trial-data adapter; clients cannot relabel it."""

    if brief.data_status != DataStatus.SYNTHETIC:
        raise InputError(
            "P0 only accepts SYNTHETIC trial-data origin; public, user-provided, and "
            "enterprise-authorized adapters are non-goals for this MVP"
        )


def _dump(model: Any) -> dict[str, Any]:
    return model.model_dump(mode="json")


def _canonical_snapshot(payload: dict[str, Any]) -> tuple[dict[str, Any], str]:
    """Return a JSON-native payload and its stable canonical SHA-256."""

    try:
        encoded = json.dumps(
            payload,
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
            allow_nan=False,
        ).encode("utf-8")
    except (TypeError, ValueError) as exc:  # pragma: no cover - internal model dumps are JSON-safe
        raise InputError("object version payload is not canonical JSON") from exc
    return json.loads(encoded), hashlib.sha256(encoded).hexdigest()


def _append_object_version(
    session: Session,
    *,
    project_id: str,
    object_type: str,
    object_id: str,
    object_version: int,
    payload: dict[str, Any],
) -> ObjectVersionRecord:
    """Append one immutable object snapshot, idempotently for an identical payload.

    Reusing an identity/version with different content is a domain conflict rather
    than an overwrite. Flushing here also makes duplicate calls in the same unit of
    work observe the unique identity consistently.
    """

    if object_version < 1:
        raise InputError("object_version must be at least 1")
    normalized, digest = _canonical_snapshot(payload)
    existing = session.scalar(
        select(ObjectVersionRecord).where(
            ObjectVersionRecord.project_id == project_id,
            ObjectVersionRecord.object_type == object_type,
            ObjectVersionRecord.object_id == object_id,
            ObjectVersionRecord.object_version == object_version,
        )
    )
    if existing is not None:
        if existing.sha256 != digest or existing.payload_json != normalized:
            raise ConflictError(
                f"immutable {object_type} {object_id} v{object_version} already exists"
            )
        return existing

    record = ObjectVersionRecord(
        project_id=project_id,
        object_type=object_type,
        object_id=object_id,
        object_version=object_version,
        payload_json=normalized,
        sha256=digest,
    )
    session.add(record)
    session.flush()
    return record


def _latest_object_version(
    session: Session,
    *,
    project_id: str,
    object_type: str,
    object_id: str,
) -> ObjectVersionRecord | None:
    return session.scalar(
        select(ObjectVersionRecord)
        .where(
            ObjectVersionRecord.project_id == project_id,
            ObjectVersionRecord.object_type == object_type,
            ObjectVersionRecord.object_id == object_id,
        )
        .order_by(ObjectVersionRecord.object_version.desc())
        .limit(1)
    )


def _next_object_version(
    session: Session,
    *,
    project_id: str,
    object_type: str,
    object_id: str,
) -> int:
    latest = session.scalar(
        select(func.max(ObjectVersionRecord.object_version)).where(
            ObjectVersionRecord.project_id == project_id,
            ObjectVersionRecord.object_type == object_type,
            ObjectVersionRecord.object_id == object_id,
        )
    )
    return int(latest or 0) + 1


def _append_changed_object_version(
    session: Session,
    *,
    project_id: str,
    object_type: str,
    object_id: str,
    payload: dict[str, Any],
) -> ObjectVersionRecord:
    """Append the next version unless the latest canonical snapshot is identical."""

    normalized, digest = _canonical_snapshot(payload)
    latest = _latest_object_version(
        session,
        project_id=project_id,
        object_type=object_type,
        object_id=object_id,
    )
    if latest is not None and latest.sha256 == digest and latest.payload_json == normalized:
        return latest
    return _append_object_version(
        session,
        project_id=project_id,
        object_type=object_type,
        object_id=object_id,
        object_version=(latest.object_version + 1 if latest else 1),
        payload=normalized,
    )


def _get_project_record(session: Session, project_id: str) -> ProjectRecord:
    record = session.get(ProjectRecord, project_id)
    if record is None:
        raise NotFoundError("project not found")
    return record


def _dataset_summary(record: DatasetRecord) -> DatasetSummary:
    return DatasetSummary(
        id=record.id,
        project_id=record.project_id,
        data_status=DataStatus(record.data_status),
        source_label=record.source_label,
        authorization_note=record.authorization_note,
        file_name=record.file_name,
        sha256=record.sha256,
        schema_version=record.schema_version,
        row_count=record.row_count,
        scenario_id=DemoScenarioId(record.scenario_id),
        scenario_version=record.scenario_version,
        fixed_seed=record.fixed_seed,
        generator_version=record.generator_version,
        plan_version=record.plan_version,
        active=record.active,
        imported_at=record.imported_at,
    )


def _pivot_revision_schema(record: PivotRevisionRecord) -> PivotRevision:
    return PivotRevision(
        id=record.id,
        decision_id=record.decision_id,
        target_variant_id=record.target_variant_id,
        version=record.version,
        approval_status=ApprovalStatus(record.approval_status),
        change_variable=record.change_variable,
        change_list=list(record.change_list_json),
        retest_plan=list(record.retest_plan_json),
        created_by=record.created_by,
        created_at=_as_utc(record.created_at),
    )


def _latest_pivot_revision_record(
    session: Session,
    project_id: str,
    decision_id: str | None = None,
) -> PivotRevisionRecord | None:
    statement = select(PivotRevisionRecord).where(
        PivotRevisionRecord.project_id == project_id
    )
    if decision_id is not None:
        statement = statement.where(PivotRevisionRecord.decision_id == decision_id)
    return session.scalar(statement.order_by(PivotRevisionRecord.version.desc()).limit(1))


def _first_order_assumptions_target_id(project_id: str, brief_version: int) -> str:
    return f"first-order-assumptions-{project_id}-brief-v{brief_version}"


def _first_order_assumptions_confirmation(
    session: Session,
    project: ProjectRecord,
) -> FirstOrderAssumptionsConfirmation | None:
    brief = ProductBriefDraft.model_validate(project.brief_json)
    proposal = brief.first_order_assumptions
    if proposal is None:
        return None
    target_id = _first_order_assumptions_target_id(project.id, project.brief_version)
    approval = session.scalar(
        select(ApprovalRecord).where(
            ApprovalRecord.project_id == project.id,
            ApprovalRecord.gate == ApprovalGate.FIRST_ORDER_ASSUMPTIONS.value,
            ApprovalRecord.target_id == target_id,
            ApprovalRecord.object_version == project.brief_version,
            ApprovalRecord.decision == ApprovalDecision.APPROVE.value,
        )
    )
    if approval is None:
        return None
    return FirstOrderAssumptionsConfirmation(
        target_id=target_id,
        brief_version=project.brief_version,
        intent_to_order_rate=proposal.intent_to_order_rate,
        planned_reach=proposal.planned_reach,
        packing_step=proposal.packing_step,
        proposal_source=proposal.source,
        actor=approval.actor,
        comment=approval.comment,
        confirmed_at=_as_utc(approval.created_at),
    )


def _active_datasets(session: Session, project_id: str) -> list[DatasetRecord]:
    return list(
        session.scalars(
            select(DatasetRecord)
            .where(DatasetRecord.project_id == project_id, DatasetRecord.active.is_(True))
            .order_by(DatasetRecord.imported_at.asc())
        )
    )


def _all_datasets(session: Session, project_id: str) -> list[DatasetRecord]:
    return list(
        session.scalars(
            select(DatasetRecord)
            .where(DatasetRecord.project_id == project_id)
            .order_by(DatasetRecord.imported_at.desc())
        )
    )


def _load_observations(session: Session, project_id: str) -> list[TrialObservation]:
    rows = list(
        session.scalars(
            select(TrialObservationRecord)
            .join(DatasetRecord, TrialObservationRecord.dataset_id == DatasetRecord.id)
            .where(
                TrialObservationRecord.project_id == project_id,
                DatasetRecord.active.is_(True),
            )
            .order_by(
                TrialObservationRecord.date.asc(),
                TrialObservationRecord.variant_id.asc(),
                TrialObservationRecord.id.asc(),
            )
        )
    )
    return [
        TrialObservation(
            date=date.fromisoformat(row.date),
            candidate_id=row.candidate_id,
            variant_id=row.variant_id,
            arm_id=row.arm_id,
            channel=row.channel,
            audience_segment=row.audience_segment,
            exposure=row.exposure,
            click=row.click,
            favorite=row.favorite,
            inquiry=row.inquiry,
            add_to_cart=row.add_to_cart,
            purchase_intent=row.purchase_intent,
            preorder=row.preorder,
            order=row.order,
            refund=row.refund,
            return_count=row.return_count,
            price_fen=row.price_fen,
            spend_fen=row.spend_fen,
        )
        for row in rows
    ]


def _record_audit(
    session: Session,
    project: ProjectRecord,
    action: str,
    object_type: str,
    actor: str,
    summary: dict[str, Any] | None = None,
    from_state: str | None = None,
    to_state: str | None = None,
    request_id: str | None = None,
) -> AuditEventRecord:
    event = AuditEventRecord(
        id=new_id(),
        project_id=project.id,
        action=action,
        object_type=object_type,
        from_state=from_state,
        to_state=to_state,
        actor=actor,
        request_id=request_id,
        summary_json=summary or {},
    )
    session.add(event)
    return event


def _transition(
    session: Session,
    project: ProjectRecord,
    status: ProjectStatus,
    action: str,
    object_type: str,
    actor: str = "system",
    summary: dict[str, Any] | None = None,
    request_id: str | None = None,
) -> None:
    old_status = project.status
    project.status = status.value
    project.updated_at = utc_now()
    _record_audit(
        session,
        project,
        action=action,
        object_type=object_type,
        actor=actor,
        summary=summary,
        from_state=old_status,
        to_state=status.value,
        request_id=request_id,
    )


def _clear_downstream(project: ProjectRecord, keep_plan: bool = True) -> None:
    if not keep_plan:
        project.plan_json = None
    project.quality_json = None
    project.metrics_json = None
    project.evidence_json = None
    project.decision_json = None
    project.handoff_json = None


def _brief_readiness(
    brief: ProductBriefDraft | dict[str, Any],
) -> tuple[ProductBrief | None, list[str]]:
    """Validate the user-authored draft against the executable Brief contract."""

    draft = (
        brief
        if isinstance(brief, ProductBriefDraft)
        else ProductBriefDraft.model_validate(brief)
    )
    try:
        ready = ProductBrief.model_validate(draft.model_dump(mode="json"))
    except ValueError as exc:
        errors: list[dict[str, Any]] = getattr(exc, "errors", list)()
        missing = sorted(
            {
                ".".join(str(part) for part in error.get("loc", ())) or "brief"
                for error in errors
            }
        )
        return None, missing or ["brief"]
    return ready, []


def _require_ready_brief(project: ProjectRecord) -> ProductBrief:
    ready, missing = _brief_readiness(project.brief_json)
    if ready is None:
        raise ConflictError(
            "ProductBrief is incomplete; missing or invalid fields: " + ", ".join(missing)
        )
    return ready


def _invalidation_summary(project: ProjectRecord) -> dict[str, Any]:
    """Describe current projections before they are invalidated; history stays append-only."""

    plan = ExperimentPlan.model_validate(project.plan_json) if project.plan_json else None
    handoff = HandoffPackage.model_validate(project.handoff_json) if project.handoff_json else None
    return {
        "invalidated_plan_id": plan.id if plan else None,
        "invalidated_plan_version": plan.version if plan else None,
        "invalidated_handoff_id": handoff.id if handoff else None,
        "downstream_invalidated": any(
            value is not None
            for value in (
                project.plan_json,
                project.quality_json,
                project.metrics_json,
                project.evidence_json,
                project.decision_json,
                project.handoff_json,
            )
        ),
    }


def _store_agent_run(
    session: Session,
    project: ProjectRecord,
    operation: str,
    execution: AgentExecution,
    output: Any,
) -> None:
    session.add(
        AgentRunRecord(
            id=new_id(),
            project_id=project.id,
            mode=execution.mode.value,
            operation=operation,
            model_name=execution.model_name,
            reasoning_effort=execution.reasoning_effort,
            prompt_version=execution.prompt_version,
            output_schema_version=execution.output_schema_version,
            recording_id=execution.recording_id,
            duration_ms=execution.duration_ms,
            input_sha256=execution.input_sha256,
            output_sha256=execution.output_sha256,
            input_tokens=execution.input_tokens,
            output_tokens=execution.output_tokens,
            tracing_disabled=execution.tracing_disabled,
            api_store_disabled=execution.api_store_disabled,
            success=execution.success,
            fallback_reason=execution.fallback_reason,
            output_json={"schema": type(output).__name__},
        )
    )


def _project_data_sensitivity(
    session: Session, project_id: str
) -> DataSensitivityLevel:
    attachment_id = session.scalar(
        select(AttachmentRecord.id)
        .where(AttachmentRecord.project_id == project_id)
        .limit(1)
    )
    if attachment_id is not None:
        return DataSensitivityLevel.USER_CONTENT_RESTRICTED
    return DataSensitivityLevel.SYNTHETIC_ONLY


def project_detail(session: Session, project_id: str) -> ProjectDetail:
    record = _get_project_record(session, project_id)
    brief = ProductBriefDraft.model_validate(record.brief_json)
    _, brief_missing_fields = _brief_readiness(brief)
    datasets = [_dataset_summary(item) for item in _all_datasets(session, project_id)]
    decision = DecisionCard.model_validate(record.decision_json) if record.decision_json else None
    pivot_record = (
        _latest_pivot_revision_record(session, project_id, decision.id) if decision else None
    )
    return ProjectDetail(
        id=record.id,
        name=record.name,
        scenario_id=(DemoScenarioId(record.scenario_id) if record.scenario_id else None),
        status=ProjectStatus(record.status),
        workflow_state=ProjectStatus(record.status),
        data_status=DataStatus(record.data_status),
        data_origin=DataStatus(record.data_status),
        data_sensitivity_level=_project_data_sensitivity(session, record.id),
        brief_version=record.brief_version,
        brief=brief,
        brief_missing_fields=brief_missing_fields,
        first_order_assumptions_confirmation=_first_order_assumptions_confirmation(
            session, record
        ),
        experiment_plan=(
            ExperimentPlan.model_validate(record.plan_json) if record.plan_json else None
        ),
        current_day=record.current_day,
        total_days=record.total_days,
        policy_version=record.policy_version,
        policy_revision=record.policy_revision,
        current_policy=record.policy_json,
        scenario_version=record.scenario_version,
        fixed_seed=record.fixed_seed,
        generator_version=record.generator_version,
        agent_mode=AgentMode(record.agent_mode),
        datasets=datasets,
        artifacts=ArtifactBundle(
            brief_normalization=(
                AgentBriefNormalization.model_validate(record.brief_normalization_json)
                if record.brief_normalization_json
                else None
            ),
            quality=(
                QualityReport.model_validate(record.quality_json) if record.quality_json else None
            ),
            metrics=(
                MetricBundle.model_validate(record.metrics_json) if record.metrics_json else None
            ),
            evidence=(
                EvidenceCard.model_validate(record.evidence_json) if record.evidence_json else None
            ),
            decision=decision,
            pivot_revision=(_pivot_revision_schema(pivot_record) if pivot_record else None),
            handoff=(
                HandoffPackage.model_validate(record.handoff_json) if record.handoff_json else None
            ),
        ),
        created_at=_as_utc(record.created_at),
        updated_at=record.updated_at,
    )


def list_projects(session: Session) -> list[ProjectListItem]:
    records = list(session.scalars(select(ProjectRecord).order_by(ProjectRecord.updated_at.desc())))
    items: list[ProjectListItem] = []
    for record in records:
        expected = None
        if record.scenario_id:
            expected = get_scenario(DemoScenarioId(record.scenario_id)).expected_outcome
        items.append(
            ProjectListItem(
                id=record.id,
                name=record.name,
                scenario_id=(DemoScenarioId(record.scenario_id) if record.scenario_id else None),
                status=ProjectStatus(record.status),
                workflow_state=ProjectStatus(record.status),
                data_status=DataStatus(record.data_status),
                data_origin=DataStatus(record.data_status),
                data_sensitivity_level=_project_data_sensitivity(session, record.id),
                current_day=record.current_day,
                total_days=record.total_days,
                expected_outcome=expected,
                updated_at=record.updated_at,
            )
        )
    return items


def create_project(session: Session, payload: ProjectCreate) -> ProjectDetail:
    _require_p0_synthetic_origin(payload.brief)
    ready_brief, missing_fields = _brief_readiness(payload.brief)
    initial_status = (
        ProjectStatus.BRIEF_READY if ready_brief is not None else ProjectStatus.DRAFT
    )
    project = ProjectRecord(
        id=new_id(),
        name=payload.name,
        scenario_id=None,
        status=initial_status.value,
        data_status=payload.brief.data_status.value,
        brief_version=1,
        brief_json=_dump(payload.brief),
        brief_normalization_json=None,
        plan_json=None,
        current_day=0,
        total_days=7,
        policy_version=DEFAULT_POLICY.version,
        policy_revision=DEFAULT_POLICY.revision,
        policy_json=_dump(DEFAULT_POLICY),
        scenario_version=None,
        fixed_seed=None,
        generator_version=None,
        agent_mode=AgentMode.OFFLINE_REPLAY.value,
    )
    session.add(project)
    session.flush()
    _append_object_version(
        session,
        project_id=project.id,
        object_type="ProductBrief",
        object_id=f"product-brief-{project.id}",
        object_version=project.brief_version,
        payload=project.brief_json,
    )
    _append_object_version(
        session,
        project_id=project.id,
        object_type="DemoPolicy",
        object_id=f"demo-policy-{project.id}",
        object_version=project.policy_revision,
        payload=project.policy_json,
    )
    _record_audit(
        session,
        project,
        action="PROJECT_CREATED",
        object_type="DecisionProject",
        actor="user",
        from_state=None,
        to_state=initial_status.value,
        summary={
            "data_status": payload.brief.data_status.value,
            "brief_ready": ready_brief is not None,
            "missing_fields": missing_fields,
        },
    )
    session.flush()
    return project_detail(session, project.id)


async def create_scenario_project(
    session: Session, scenario_id: DemoScenarioId, adapter: AgentAdapter
) -> ProjectDetail:
    scenario = get_scenario(scenario_id)
    brief = make_brief(scenario)
    normalization, normalization_execution = await adapter.normalize_brief(brief)
    plan_text, plan_execution = await adapter.generate_plan_text(brief)
    project_id = new_id()
    plan = make_plan(
        scenario,
        generated_by=("live-agent" if plan_execution.mode == AgentMode.LIVE else "offline-replay"),
        project_id=project_id,
    )
    plan.decision_question = plan_text.decision_question
    plan.hypotheses = plan_text.hypotheses
    plan.potential_biases = plan_text.potential_biases
    plan.policy_version = DEFAULT_POLICY.version
    plan.policy_snapshot = _dump(DEFAULT_POLICY)
    project = ProjectRecord(
        id=project_id,
        name=scenario.name,
        scenario_id=scenario.id.value,
        status=ProjectStatus.PLAN_PROPOSED.value,
        data_status=DataStatus.SYNTHETIC.value,
        brief_version=1,
        brief_json=_dump(brief),
        brief_normalization_json=_dump(normalization),
        plan_json=_dump(plan),
        current_day=0,
        total_days=scenario.total_days,
        policy_version=DEFAULT_POLICY.version,
        policy_revision=DEFAULT_POLICY.revision,
        policy_json=_dump(DEFAULT_POLICY),
        scenario_version=SCENARIO_VERSION,
        fixed_seed=FIXED_SEED,
        generator_version=GENERATOR_VERSION,
        agent_mode=plan_execution.mode.value,
    )
    session.add(project)
    session.flush()
    _append_object_version(
        session,
        project_id=project.id,
        object_type="ProductBrief",
        object_id=f"product-brief-{project.id}",
        object_version=project.brief_version,
        payload=project.brief_json,
    )
    _append_object_version(
        session,
        project_id=project.id,
        object_type="DemoPolicy",
        object_id=f"demo-policy-{project.id}",
        object_version=project.policy_revision,
        payload=project.policy_json,
    )
    _append_object_version(
        session,
        project_id=project.id,
        object_type="ExperimentPlan",
        object_id=f"experiment-plan-{project.id}",
        object_version=plan.version,
        payload=_dump(plan),
    )
    _record_audit(
        session,
        project,
        action="DEMO_PROJECT_CREATED",
        object_type="DecisionProject",
        actor="demo",
        from_state=None,
        to_state=ProjectStatus.PLAN_PROPOSED.value,
        summary={
            "scenario_id": scenario.id.value,
            "expected_outcome": scenario.expected_outcome.value,
            "data_status": DataStatus.SYNTHETIC.value,
        },
    )
    _store_agent_run(session, project, "NORMALIZE_BRIEF", normalization_execution, normalization)
    _store_agent_run(session, project, "GENERATE_EXPERIMENT_PLAN", plan_execution, plan_text)
    session.flush()
    return project_detail(session, project.id)


def _save_brief_version(
    session: Session,
    project: ProjectRecord,
    brief: ProductBriefDraft,
    *,
    expected_version: int,
) -> None:
    if project.status == ProjectStatus.ARCHIVED.value:
        raise ConflictError("archived projects are immutable")
    _require_p0_synthetic_origin(brief)
    if project.brief_version != expected_version:
        raise ConflictError(
            f"stale ProductBrief version: expected {expected_version}, current {project.brief_version}"
        )

    ready_brief, missing_fields = _brief_readiness(brief)
    invalidated = _invalidation_summary(project)
    previous_state = project.status
    project.brief_json = _dump(brief)
    project.brief_version = _next_object_version(
        session,
        project_id=project.id,
        object_type="ProductBrief",
        object_id=f"product-brief-{project.id}",
    )
    project.brief_normalization_json = None
    project.data_status = brief.data_status.value
    _clear_downstream(project, keep_plan=False)
    project.current_day = 0
    for dataset in _active_datasets(session, project.id):
        dataset.active = False
    _append_object_version(
        session,
        project_id=project.id,
        object_type="ProductBrief",
        object_id=f"product-brief-{project.id}",
        object_version=project.brief_version,
        payload=project.brief_json,
    )
    target = ProjectStatus.BRIEF_READY if ready_brief is not None else ProjectStatus.DRAFT
    _transition(
        session,
        project,
        target,
        action="BRIEF_VERSION_CREATED",
        object_type="ProductBrief",
        actor="user",
        summary={
            "previous_version": expected_version,
            "new_version": project.brief_version,
            "reopened_from_state": previous_state,
            "brief_ready": ready_brief is not None,
            "missing_fields": missing_fields,
            **invalidated,
        },
    )


def update_project(session: Session, project_id: str, payload: ProjectUpdate) -> ProjectDetail:
    project = _get_project_record(session, project_id)
    if project.status == ProjectStatus.ARCHIVED.value:
        raise ConflictError("archived projects are immutable")
    if payload.name is not None:
        project.name = payload.name
    if payload.brief is not None:
        _save_brief_version(
            session,
            project,
            payload.brief,
            expected_version=project.brief_version,
        )
    else:
        project.updated_at = utc_now()
        _record_audit(
            session,
            project,
            action="PROJECT_UPDATED",
            object_type="DecisionProject",
            actor="user",
            summary={"name_changed": payload.name is not None},
        )
    session.flush()
    return project_detail(session, project.id)


def update_brief(
    session: Session,
    project_id: str,
    brief: ProductBriefDraft,
    expected_version: int,
) -> ProjectDetail:
    project = _get_project_record(session, project_id)
    _save_brief_version(session, project, brief, expected_version=expected_version)
    session.flush()
    return project_detail(session, project.id)


def update_project_policy(session: Session, project_id: str, payload: DemoPolicy) -> ProjectDetail:
    project = _get_project_record(session, project_id)
    if project.status == ProjectStatus.ARCHIVED.value:
        raise ConflictError("archived projects are immutable")
    if payload.version != project.policy_version or payload.revision != project.policy_revision:
        raise ConflictError(
            f"stale DemoPolicy version: current {project.policy_version} revision {project.policy_revision}"
        )
    if payload.primary_metric != DEFAULT_POLICY.primary_metric:
        raise ConflictError("DemoPolicy primary metric is fixed for the MVP")
    if payload.expected_arm_share != DEFAULT_POLICY.expected_arm_share:
        raise ConflictError("DemoPolicy v1 experiment split is fixed at 50/50")

    previous_version = project.policy_version
    previous_state = project.status
    invalidated = _invalidation_summary(project)
    new_revision = project.policy_revision + 1
    new_policy = payload.model_copy(
        update={
            "version": f"demo-policy-v1-project-{project.id[:8]}-r{new_revision}",
            "revision": new_revision,
        }
    )
    project.policy_json = _dump(new_policy)
    project.policy_version = new_policy.version
    project.policy_revision = new_policy.revision
    _clear_downstream(project, keep_plan=False)
    project.current_day = 0
    for dataset in _active_datasets(session, project_id):
        dataset.active = False
    _append_object_version(
        session,
        project_id=project.id,
        object_type="DemoPolicy",
        object_id=f"demo-policy-{project.id}",
        object_version=project.policy_revision,
        payload=project.policy_json,
    )
    ready_brief, missing_fields = _brief_readiness(project.brief_json)
    _transition(
        session,
        project,
        ProjectStatus.BRIEF_READY if ready_brief is not None else ProjectStatus.DRAFT,
        action="DEMO_POLICY_VERSION_CREATED",
        object_type="DemoPolicy",
        actor="user",
        summary={
            "previous_version": previous_version,
            "new_version": new_policy.version,
            "revision": new_policy.revision,
            "reopened_from_state": previous_state,
            "brief_ready": ready_brief is not None,
            "missing_fields": missing_fields,
            **invalidated,
        },
    )
    session.flush()
    return project_detail(session, project.id)


async def normalize_project_brief(
    session: Session, project_id: str, adapter: AgentAdapter
) -> ProjectDetail:
    project = _get_project_record(session, project_id)
    if project.status not in {
        ProjectStatus.BRIEF_READY.value,
        ProjectStatus.PLAN_PROPOSED.value,
    }:
        raise ConflictError("brief normalization is not allowed in the current state")
    brief = _require_ready_brief(project)
    normalization, execution = await adapter.normalize_brief(brief)
    project.brief_normalization_json = _dump(normalization)
    project.agent_mode = execution.mode.value
    _store_agent_run(session, project, "NORMALIZE_BRIEF", execution, normalization)
    _record_audit(
        session,
        project,
        action="BRIEF_NORMALIZED",
        object_type="ProductBrief",
        actor="agent",
        summary={
            "brief_version": project.brief_version,
            "agent_mode": execution.mode.value,
            "prompt_version": execution.prompt_version,
            "fallback_reason": execution.fallback_reason,
        },
    )
    session.flush()
    return project_detail(session, project.id)


def _base_plan_from_text(
    project: ProjectRecord,
    brief: ProductBrief,
    plan_text: Any,
    generated_by: str,
    version: int,
) -> ExperimentPlan:
    policy = DemoPolicy.model_validate(project.policy_json)
    # DemoPolicy v1 is a fixed two-arm, 50/50 experiment.
    selected_variants = brief.variants[:2]
    share = 0.5
    arms = [
        ExperimentArm(
            id=("ARM-A", "ARM-B")[index],
            label=variant.label,
            variant_id=variant.id,
            expected_share=share,
        )
        for index, variant in enumerate(selected_variants)
    ]
    return ExperimentPlan(
        id=f"plan-{project.id}-v{version}",
        version=version,
        approval_status=ApprovalStatus.PENDING,
        decision_question=plan_text.decision_question,
        hypotheses=plan_text.hypotheses,
        controlled_variable="COLOR",
        invariants=["鞋型", "价格", "素材表达", "人群", "渠道", "投放时段"],
        primary_metric="purchase_intent_count/exposure",
        secondary_metrics=["ctr", "add_to_cart_rate", "return_and_refund_rate"],
        arms=arms,
        target_audience=brief.target_audience,
        channel=brief.channel,
        duration_days=7,
        min_exposure_per_arm=policy.min_exposure_per_arm,
        min_intent_per_arm=policy.min_purchase_intent_events_per_arm,
        budget_cap_fen=brief.trial_budget_fen,
        stop_rules=[
            StopRule(code="BUDGET_CAP", description="花费不得超过人工批准的预算。"),
            StopRule(code="QUALITY_BLOCK", description="质量门阻断时不得输出强决策。"),
        ],
        quality_requirements=[
            f"每臂曝光不少于 {policy.min_exposure_per_arm}",
            f"每臂可复算购买意向事件不少于 {policy.min_purchase_intent_events_per_arm}",
            "漏斗计数符合聚合口径",
            "分流不得严重偏离预设比例",
        ],
        potential_biases=plan_text.potential_biases,
        policy_version=policy.version,
        policy_snapshot=_dump(policy),
        generated_by=generated_by,
    )


async def generate_experiment_plan(
    session: Session, project_id: str, adapter: AgentAdapter
) -> ProjectDetail:
    project = _get_project_record(session, project_id)
    if project.status not in {
        ProjectStatus.BRIEF_READY.value,
        ProjectStatus.PLAN_PROPOSED.value,
    }:
        raise ConflictError("experiment plan cannot be regenerated in the current state")
    if not project.brief_normalization_json:
        raise ConflictError("normalize the current ProductBrief before generating a plan")
    brief = _require_ready_brief(project)
    plan_text, execution = await adapter.generate_plan_text(brief)
    logical_plan_id = f"experiment-plan-{project.id}"
    plan_version = _next_object_version(
        session,
        project_id=project.id,
        object_type="ExperimentPlan",
        object_id=logical_plan_id,
    )
    plan = _base_plan_from_text(
        project,
        brief,
        plan_text,
        generated_by=("live-agent" if execution.mode == AgentMode.LIVE else "offline-replay"),
        version=plan_version,
    )
    project.plan_json = _dump(plan)
    project.agent_mode = execution.mode.value
    _clear_downstream(project, keep_plan=True)
    _append_object_version(
        session,
        project_id=project.id,
        object_type="ExperimentPlan",
        object_id=logical_plan_id,
        object_version=plan.version,
        payload=_dump(plan),
    )
    _store_agent_run(session, project, "GENERATE_EXPERIMENT_PLAN", execution, plan_text)
    _transition(
        session,
        project,
        ProjectStatus.PLAN_PROPOSED,
        action="EXPERIMENT_PLAN_GENERATED",
        object_type="ExperimentPlan",
        actor="agent",
        summary={
            "agent_mode": execution.mode.value,
            "plan_version": plan.version,
            "numeric_fields_source": "deterministic-template",
            "fallback_reason": execution.fallback_reason,
        },
    )
    session.flush()
    return project_detail(session, project.id)


def approve(
    session: Session,
    project_id: str,
    payload: ApprovalRequest,
    *,
    target_id: str | None = None,
) -> ApprovalResponse:
    project = _get_project_record(session, project_id)
    if payload.request_id:
        existing = session.scalar(
            select(ApprovalRecord).where(
                ApprovalRecord.project_id == project_id,
                ApprovalRecord.request_id == payload.request_id,
            )
        )
        if existing:
            return ApprovalResponse(
                id=existing.id,
                project_id=existing.project_id,
                gate=ApprovalGate(existing.gate),
                target_type=existing.target_type,
                target_id=existing.target_id,
                decision=ApprovalDecision(existing.decision),
                object_version=existing.object_version,
                actor=existing.actor,
                comment=existing.comment,
                created_at=existing.created_at,
                project_status=ProjectStatus(project.status),
            )

    status_map = {
        ApprovalDecision.APPROVE: ApprovalStatus.APPROVED,
        ApprovalDecision.REJECT: ApprovalStatus.REJECTED,
        ApprovalDecision.REQUEST_CHANGES: ApprovalStatus.CHANGES_REQUESTED,
        ApprovalDecision.REQUEST_MORE_DATA: ApprovalStatus.MORE_DATA_REQUESTED,
    }

    if payload.gate == ApprovalGate.EXPERIMENT_PLAN:
        if not project.plan_json:
            raise ConflictError("experiment plan does not exist")
        if project.status != ProjectStatus.PLAN_PROPOSED.value:
            raise ConflictError("experiment plan approval is not allowed in the current state")
        plan = ExperimentPlan.model_validate(project.plan_json)
        object_version = plan.version
        if payload.object_version != object_version:
            raise ConflictError(
                f"stale ExperimentPlan version: expected {payload.object_version}, current {object_version}"
            )
        if (
            len(plan.arms) != 2
            or any(abs(arm.expected_share - 0.5) > 0.001 for arm in plan.arms)
            or plan.min_exposure_per_arm
            != DemoPolicy.model_validate(project.policy_json).min_exposure_per_arm
            or plan.min_intent_per_arm
            != DemoPolicy.model_validate(project.policy_json).min_purchase_intent_events_per_arm
            or plan.primary_metric != DemoPolicy.model_validate(project.policy_json).primary_metric
            or plan.policy_version != project.policy_version
            or plan.policy_snapshot != project.policy_json
        ):
            raise ConflictError("ExperimentPlan does not satisfy DemoPolicy v1")
        resolved_target_id = plan.id
        target_type = "ExperimentPlanVersion"
        if target_id is not None and target_id != resolved_target_id:
            raise ConflictError("approval target does not match the current ExperimentPlan")
        plan.approval_status = status_map[payload.decision]
        project.plan_json = _dump(plan)
        if payload.decision == ApprovalDecision.APPROVE:
            target = ProjectStatus.PLAN_APPROVED
        else:
            target = ProjectStatus.BRIEF_READY
    elif payload.gate == ApprovalGate.DECISION:
        if not project.decision_json:
            raise ConflictError("decision card does not exist")
        if project.status != ProjectStatus.DECISION_PROPOSED.value:
            raise ConflictError("decision approval is not allowed in the current state")
        decision = DecisionCard.model_validate(project.decision_json)
        object_version = decision.version
        if payload.object_version != object_version:
            raise ConflictError(
                f"stale DecisionCard version: expected {payload.object_version}, current {object_version}"
            )
        if (
            decision.outcome == DecisionOutcome.EVIDENCE_INSUFFICIENT
            and payload.decision == ApprovalDecision.APPROVE
        ):
            raise ConflictError("Evidence Insufficient cannot be approved for handoff")
        resolved_target_id = decision.id
        target_type = "DecisionCard"
        if target_id is not None and target_id != resolved_target_id:
            raise ConflictError("approval target does not match the current DecisionCard")
        decision.approval_status = status_map[payload.decision]
        project.decision_json = _dump(decision)
        if payload.decision == ApprovalDecision.APPROVE:
            target = ProjectStatus.DECISION_APPROVED
        elif payload.decision == ApprovalDecision.REQUEST_MORE_DATA:
            target = ProjectStatus.DATA_READY
        else:
            target = ProjectStatus.ANALYZED
    elif payload.gate == ApprovalGate.PIVOT_REVISION:
        if not project.decision_json:
            raise ConflictError("decision card does not exist")
        decision = DecisionCard.model_validate(project.decision_json)
        if decision.outcome != DecisionOutcome.PIVOT:
            raise ConflictError("PivotRevision approval is only valid for a PIVOT decision")
        if (
            project.status != ProjectStatus.DECISION_APPROVED.value
            or decision.approval_status != ApprovalStatus.APPROVED
        ):
            raise ConflictError("the PIVOT DecisionCard must be approved first")
        revision_record = _latest_pivot_revision_record(session, project.id, decision.id)
        if revision_record is None:
            raise ConflictError("PivotRevision does not exist")
        if revision_record.approval_status != ApprovalStatus.PENDING.value:
            raise ConflictError(
                "PivotRevision approval is already decided; generate a new version"
            )
        resolved_target_id = revision_record.id
        target_type = "PivotRevision"
        if target_id is not None and target_id != resolved_target_id:
            raise ConflictError(
                "stale PivotRevision target: only the latest revision may be approved"
            )
        object_version = revision_record.version
        if payload.object_version != object_version:
            raise ConflictError(
                f"stale PivotRevision version: expected {payload.object_version}, "
                f"current {object_version}"
            )
        revision_record.approval_status = status_map[payload.decision].value
        project.handoff_json = None
        target = ProjectStatus.DECISION_APPROVED
    elif payload.gate == ApprovalGate.FIRST_ORDER_ASSUMPTIONS:
        if payload.decision != ApprovalDecision.APPROVE:
            raise InputError(
                "first-order assumptions must be explicitly confirmed with APPROVE; "
                "edit the Brief proposal to change its values"
            )
        if not payload.actor.strip():
            raise InputError("first-order assumptions confirmation requires a named actor")
        if not project.decision_json:
            raise ConflictError("decision card does not exist")
        decision = DecisionCard.model_validate(project.decision_json)
        if (
            project.status != ProjectStatus.DECISION_APPROVED.value
            or decision.approval_status != ApprovalStatus.APPROVED
            or decision.outcome not in {DecisionOutcome.GO, DecisionOutcome.PIVOT}
        ):
            raise ConflictError(
                "first-order assumptions can only be confirmed after an approved GO or PIVOT decision"
            )
        brief = ProductBrief.model_validate(project.brief_json)
        if brief.first_order_assumptions is None:
            raise ConflictError("first-order assumptions proposal does not exist")
        object_version = project.brief_version
        if payload.object_version != object_version:
            raise ConflictError(
                "stale FirstOrderAssumptions proposal version: "
                f"expected {payload.object_version}, current {object_version}"
            )
        resolved_target_id = _first_order_assumptions_target_id(
            project.id, object_version
        )
        target_type = "FirstOrderAssumptionsProposal"
        if target_id is not None and target_id != resolved_target_id:
            raise ConflictError(
                "approval target does not match the current first-order assumptions proposal"
            )
        already_decided = session.scalar(
            select(ApprovalRecord).where(
                ApprovalRecord.project_id == project.id,
                ApprovalRecord.gate == ApprovalGate.FIRST_ORDER_ASSUMPTIONS.value,
                ApprovalRecord.target_id == resolved_target_id,
                ApprovalRecord.object_version == object_version,
            )
        )
        if already_decided is not None:
            raise ConflictError(
                "first-order assumptions approval is already decided for this Brief version"
            )
        project.handoff_json = None
        target = ProjectStatus.DECISION_APPROVED
    else:  # pragma: no cover - the Pydantic enum prevents this path
        raise InputError("unsupported approval gate")

    approval = ApprovalRecord(
        id=new_id(),
        project_id=project.id,
        gate=payload.gate.value,
        target_type=target_type,
        target_id=resolved_target_id,
        decision=payload.decision.value,
        object_version=object_version,
        actor=payload.actor,
        comment=payload.comment,
        request_id=payload.request_id,
    )
    session.add(approval)
    _transition(
        session,
        project,
        target,
        action="APPROVAL_RECORDED",
        object_type=payload.gate.value,
        actor=payload.actor,
        request_id=payload.request_id,
        summary={
            "approval_id": approval.id,
            "target_id": resolved_target_id,
            "target_type": target_type,
            "decision": payload.decision.value,
            "object_version": object_version,
        },
    )
    if (
        payload.gate == ApprovalGate.EXPERIMENT_PLAN
        and payload.decision == ApprovalDecision.APPROVE
    ):
        _transition(
            session,
            project,
            ProjectStatus.SIMULATION_READY,
            action="SIMULATION_PREPARED",
            object_type="SimulationRun",
            actor="system",
            summary={"experiment_plan_version": object_version},
        )
    session.flush()
    return ApprovalResponse(
        id=approval.id,
        project_id=approval.project_id,
        gate=ApprovalGate(approval.gate),
        target_type=approval.target_type,
        target_id=approval.target_id,
        decision=ApprovalDecision(approval.decision),
        object_version=approval.object_version,
        actor=approval.actor,
        comment=approval.comment,
        created_at=approval.created_at,
        project_status=ProjectStatus(project.status),
    )


def _add_observation_records(
    session: Session,
    project_id: str,
    dataset_id: str,
    observations: Sequence[TrialObservation],
) -> None:
    for row in observations:
        session.add(
            TrialObservationRecord(
                project_id=project_id,
                dataset_id=dataset_id,
                date=row.date.isoformat(),
                candidate_id=row.candidate_id,
                variant_id=row.variant_id,
                arm_id=row.arm_id,
                channel=row.channel,
                audience_segment=row.audience_segment,
                exposure=row.exposure,
                click=row.click,
                favorite=row.favorite,
                inquiry=row.inquiry,
                add_to_cart=row.add_to_cart,
                purchase_intent=row.purchase_intent,
                preorder=row.preorder,
                order=row.order,
                refund=row.refund,
                return_count=row.return_count,
                price_fen=row.price_fen,
                spend_fen=row.spend_fen,
            )
        )


def advance_simulation(session: Session, project_id: str, days: int) -> SimulationResponse:
    project = _get_project_record(session, project_id)
    if not project.scenario_id:
        raise ConflictError("project is not a fixed demo scenario")
    if not project.plan_json:
        raise ConflictError("experiment plan does not exist")
    plan = ExperimentPlan.model_validate(project.plan_json)
    if plan.approval_status != ApprovalStatus.APPROVED:
        raise ConflictError("experiment plan must be approved before simulation")
    if project.status not in {
        ProjectStatus.SIMULATION_READY.value,
        ProjectStatus.SIMULATION_RUNNING.value,
    }:
        raise ConflictError("simulation cannot advance in the current state")
    if project.current_day >= project.total_days:
        raise ConflictError("simulation is already complete")

    if project.status == ProjectStatus.SIMULATION_READY.value:
        _transition(
            session,
            project,
            ProjectStatus.SIMULATION_RUNNING,
            action="SIMULATION_STARTED",
            object_type="SimulationRun",
            actor="demo",
            summary={"total_days": project.total_days, "plan_version": plan.version},
        )

    scenario = get_scenario(DemoScenarioId(project.scenario_id))
    all_rows = make_observations(scenario)
    new_current_day = min(project.total_days, project.current_day + days)
    dates = sorted({row.date for row in all_rows})
    selected_dates = set(dates[project.current_day : new_current_day])
    new_rows = [row for row in all_rows if row.date in selected_dates]

    datasets = _active_datasets(session, project_id)
    if datasets:
        dataset = datasets[0]
    else:
        dataset = DatasetRecord(
            id=new_id(),
            project_id=project_id,
            data_status=DataStatus.SYNTHETIC.value,
            source_label=f"built-in scenario {project.scenario_id}",
            authorization_note="固定随机性为零的合成演示场景；不代表企业经营数据。",
            file_name=f"scenario_{project.scenario_id.lower()}.json",
            sha256="",
            schema_version=SCHEMA_VERSION,
            row_count=0,
            scenario_id=project.scenario_id,
            scenario_version=project.scenario_version,
            fixed_seed=project.fixed_seed,
            generator_version=project.generator_version,
            plan_version=plan.version,
            active=True,
        )
        session.add(dataset)
        session.flush()
    _add_observation_records(session, project_id, dataset.id, new_rows)
    session.flush()
    project.current_day = new_current_day
    project.data_status = DataStatus.SYNTHETIC.value
    current_rows = _load_observations(session, project_id)
    dataset.row_count = len(current_rows)
    if (
        project.scenario_id is None
        or project.scenario_version is None
        or project.fixed_seed is None
        or project.generator_version is None
    ):
        raise ConflictError("simulation provenance is incomplete")
    dataset.sha256 = trial_dataset_sha256(
        current_rows,
        scenario_id=project.scenario_id,
        scenario_version=project.scenario_version,
        fixed_seed=project.fixed_seed,
        generator_version=project.generator_version,
        plan_version=plan.version,
        schema_version=SCHEMA_VERSION,
    )
    _clear_downstream(project, keep_plan=True)
    advance_summary = {
        "days_added": len(selected_dates),
        "rows_added": len(new_rows),
        "current_day": new_current_day,
        "total_days": project.total_days,
        "data_status": DataStatus.SYNTHETIC.value,
    }
    if new_current_day >= project.total_days:
        _transition(
            session,
            project,
            ProjectStatus.DATA_READY,
            action="SIMULATION_COMPLETED",
            object_type="TrialDataset",
            actor="demo",
            summary=advance_summary,
        )
    else:
        _record_audit(
            session,
            project,
            action="SIMULATION_ADVANCED",
            object_type="TrialDataset",
            actor="demo",
            summary=advance_summary,
        )
    session.flush()
    return SimulationResponse(
        project_id=project.id,
        current_day=project.current_day,
        total_days=project.total_days,
        rows_added=len(new_rows),
        dataset=_dataset_summary(dataset),
        project_status=ProjectStatus(project.status),
        scenario_id=DemoScenarioId(project.scenario_id),
        scenario_version=project.scenario_version,
        fixed_seed=project.fixed_seed,
        generator_version=project.generator_version,
        plan_version=plan.version,
        schema_version=SCHEMA_VERSION,
        dataset_sha256=dataset.sha256,
    )


def run_simulation(session: Session, project_id: str) -> SimulationResponse:
    project = _get_project_record(session, project_id)
    if project.status == ProjectStatus.ARCHIVED.value:
        raise ConflictError("archived projects are immutable")
    remaining = project.total_days - project.current_day
    if remaining <= 0:
        if project.status != ProjectStatus.DATA_READY.value:
            raise ConflictError("completed simulation cannot run in the current workflow state")
        datasets = _active_datasets(session, project_id)
        if not datasets:
            raise ConflictError("simulation is complete but no dataset exists")
        return SimulationResponse(
            project_id=project.id,
            current_day=project.current_day,
            total_days=project.total_days,
            rows_added=0,
            dataset=_dataset_summary(datasets[0]),
            project_status=ProjectStatus(project.status),
            scenario_id=DemoScenarioId(datasets[0].scenario_id),
            scenario_version=datasets[0].scenario_version,
            fixed_seed=datasets[0].fixed_seed,
            generator_version=datasets[0].generator_version,
            plan_version=datasets[0].plan_version,
            schema_version=datasets[0].schema_version,
            dataset_sha256=datasets[0].sha256,
        )
    return advance_simulation(session, project_id, remaining)


def reset_simulation_replay(
    session: Session,
    project_id: str,
    *,
    request_id: str | None = None,
) -> ProjectDetail:
    """Reset one approved demo plan for an auditable same-project replay.

    Historical datasets, observations, object versions, agent runs, and audit events
    remain append-only. Only the current projections and active-dataset pointer are
    reset. An approved decision is a hard boundary: once business approval exists,
    replay must happen in a new project/version rather than rewriting its context.
    """

    project = _get_project_record(session, project_id)
    if not project.scenario_id:
        raise ConflictError("project is not a fixed demo scenario")
    if not project.plan_json:
        raise ConflictError("experiment plan does not exist")
    plan = ExperimentPlan.model_validate(project.plan_json)
    if plan.approval_status != ApprovalStatus.APPROVED:
        raise ConflictError("experiment plan must be approved before replay reset")
    if project.handoff_json is not None:
        raise ConflictError("simulation replay cannot reset after handoff generation")
    if project.decision_json is not None:
        decision = DecisionCard.model_validate(project.decision_json)
        if decision.approval_status == ApprovalStatus.APPROVED:
            raise ConflictError("simulation replay cannot reset after decision approval")

    resettable_states = {
        ProjectStatus.PLAN_APPROVED.value,
        ProjectStatus.SIMULATION_READY.value,
        ProjectStatus.SIMULATION_RUNNING.value,
        ProjectStatus.DATA_READY.value,
        ProjectStatus.DATA_VALIDATED.value,
        ProjectStatus.DATA_BLOCKED.value,
        ProjectStatus.ANALYZED.value,
        ProjectStatus.DECISION_PROPOSED.value,
    }
    if project.status not in resettable_states:
        raise ConflictError("simulation replay cannot reset in the current state")

    active_datasets = _active_datasets(session, project_id)
    prior_dataset_refs = [
        {
            "dataset_id": dataset.id,
            "sha256": dataset.sha256,
            "row_count": dataset.row_count,
        }
        for dataset in active_datasets
    ]
    for dataset in active_datasets:
        dataset.active = False

    cleared_projections = [
        name
        for name, value in (
            ("QualityReport", project.quality_json),
            ("MetricBundle", project.metrics_json),
            ("EvidenceCard", project.evidence_json),
            ("DecisionCard", project.decision_json),
            ("HandoffPackage", project.handoff_json),
        )
        if value is not None
    ]
    project.current_day = 0
    project.data_status = DataStatus.SYNTHETIC.value
    _clear_downstream(project, keep_plan=True)
    _transition(
        session,
        project,
        ProjectStatus.SIMULATION_READY,
        action="SIMULATION_REPLAY_RESET",
        object_type="SimulationRun",
        actor="user",
        request_id=request_id,
        summary={
            "plan_id": plan.id,
            "plan_version": plan.version,
            "scenario_id": project.scenario_id,
            "scenario_version": project.scenario_version,
            "fixed_seed": project.fixed_seed,
            "generator_version": project.generator_version,
            "deactivated_datasets": prior_dataset_refs,
            "cleared_projections": cleared_projections,
            "historical_observations_retained": True,
            "historical_object_versions_retained": True,
        },
    )
    session.flush()
    return project_detail(session, project.id)


async def analyze_project(
    session: Session,
    project_id: str,
    adapter: AgentAdapter,
) -> AnalysisBundle:
    project = _get_project_record(session, project_id)
    if not project.plan_json:
        raise ConflictError("experiment plan does not exist")
    plan = ExperimentPlan.model_validate(project.plan_json)
    if not plan.policy_snapshot:
        raise ConflictError("approved plan is missing its immutable policy snapshot")
    policy = DemoPolicy.model_validate(plan.policy_snapshot)
    if plan.approval_status != ApprovalStatus.APPROVED:
        raise ConflictError("experiment plan must be approved before analysis")
    if project.status not in {
        ProjectStatus.DATA_READY.value,
        ProjectStatus.DATA_VALIDATED.value,
        ProjectStatus.DATA_BLOCKED.value,
    }:
        raise ConflictError("analysis is not allowed in the current state")
    observations = _load_observations(session, project_id)
    if not observations:
        raise ConflictError("trial dataset is empty")
    brief = ProductBrief.model_validate(project.brief_json)
    datasets = _active_datasets(session, project_id)
    if any(item.plan_version != plan.version for item in datasets):
        raise ConflictError("active dataset was not generated under the approved plan version")
    dataset_ids = [item.id for item in datasets]
    data_status = DataStatus(project.data_status)
    quality = validate_trial_data(
        observations,
        brief,
        plan,
        srm_block_p_value=policy.srm_block_p_value,
    )
    if len(datasets) == 1:
        quality.dataset_sha256 = datasets[0].sha256
    metrics = calculate_metrics(observations)
    version = _next_object_version(
        session,
        project_id=project.id,
        object_type="DecisionCard",
        object_id=f"decision-card-{project.id}",
    )
    evidence = build_evidence_card(
        project_id,
        data_status,
        dataset_ids,
        quality,
        metrics,
        brief,
        policy,
        version,
    )
    decision = build_decision_card(project_id, quality, metrics, evidence, brief, policy, version)
    narrative, execution = await adapter.explain_decision(
        decision.outcome, decision.reason_codes, evidence
    )
    decision.agent_narrative = narrative
    project.agent_mode = execution.mode.value
    _store_agent_run(session, project, "EXPLAIN_DECISION", execution, narrative)
    project.quality_json = _dump(quality)
    project.metrics_json = _dump(metrics)
    project.evidence_json = _dump(evidence)
    project.decision_json = _dump(decision)
    project.handoff_json = None
    _append_changed_object_version(
        session,
        project_id=project.id,
        object_type="QualityReport",
        object_id=f"quality-report-{project.id}",
        payload=_dump(quality),
    )
    _append_object_version(
        session,
        project_id=project.id,
        object_type="MetricBundle",
        object_id=f"metric-bundle-{project.id}",
        object_version=version,
        payload=_dump(metrics),
    )
    _append_object_version(
        session,
        project_id=project.id,
        object_type="EvidenceCard",
        object_id=f"evidence-card-{project.id}",
        object_version=version,
        payload=_dump(evidence),
    )
    _append_object_version(
        session,
        project_id=project.id,
        object_type="DecisionCard",
        object_id=f"decision-card-{project.id}",
        object_version=version,
        payload=_dump(decision),
    )
    quality_target = (
        ProjectStatus.DATA_VALIDATED
        if quality.can_make_strong_decision
        else ProjectStatus.DATA_BLOCKED
    )
    _transition(
        session,
        project,
        quality_target,
        action="DATA_QUALITY_CHECKED",
        object_type="QualityReport",
        actor="rule-engine",
        summary={
            "quality_status": quality.status.value,
            "issue_codes": [issue.code for issue in quality.issues],
            "dataset_sha256": quality.dataset_sha256,
        },
    )
    _transition(
        session,
        project,
        ProjectStatus.ANALYZED,
        action="METRICS_CALCULATED",
        object_type="MetricBundle",
        actor="deterministic-tool",
        summary={
            "metric_version": metrics.metric_version,
            "total_exposure": metrics.total_exposure,
            "total_purchase_intent": metrics.total_purchase_intent,
        },
    )
    _transition(
        session,
        project,
        ProjectStatus.DECISION_PROPOSED,
        action="DECISION_PROPOSED",
        object_type="DecisionCard",
        actor="rule-engine",
        summary={
            "outcome": decision.outcome.value,
            "reason_codes": decision.reason_codes,
            "policy_version": decision.policy_version,
            "model_decided_outcome": False,
            "explanation_mode": execution.mode.value,
            "explanation_prompt_version": execution.prompt_version,
        },
    )
    session.flush()
    return AnalysisBundle(
        project_id=project.id,
        project_status=ProjectStatus(project.status),
        quality=quality,
        metrics=metrics,
        evidence=evidence,
        decision=decision,
    )


def _round_to_step(value: float, step: int) -> int:
    return max(0, round(value / step) * step)


def _first_order_scenarios(
    brief: ProductBrief,
    metrics: MetricBundle,
    confirmation: FirstOrderAssumptionsConfirmation,
    *,
    conditional_retest: bool = False,
) -> list[FirstOrderScenario]:
    inputs = brief.first_order_assumptions
    if inputs is None or metrics.total_exposure <= 0:
        return [
            FirstOrderScenario(
                name="BASE",
                quantity_low=0,
                quantity_high=0,
                assumptions=[
                    "缺少人工确认的 intent_to_order_rate、planned_reach 或 packing_step。"
                ],
                constraint_notes=["未生成可执行数量。"],
                status="NOT_READY",
            )
        ]

    anchor = (
        metrics.total_purchase_intent
        * inputs.intent_to_order_rate
        * inputs.planned_reach
        / metrics.total_exposure
    )
    budget_ceiling = (
        brief.production_budget_fen // brief.estimated_cost_fen // inputs.packing_step
    ) * inputs.packing_step
    specs = [("CONSERVATIVE", 0.8), ("BASE", 1.0), ("AGGRESSIVE", 1.2)]
    quantities = [
        min(_round_to_step(anchor * factor, inputs.packing_step), budget_ceiling)
        for _, factor in specs
    ]
    if budget_ceiling < brief.moq or any(quantity < brief.moq for quantity in quantities):
        return [
            FirstOrderScenario(
                name="BASE",
                quantity_low=0,
                quantity_high=0,
                assumptions=[
                    (
                        "anchor = purchase_intent_count × intent_to_order_rate × "
                        "planned_reach / simulated_exposure。"
                    ),
                    (
                        f"假设提案来源：{inputs.source}；人工确认人："
                        f"{confirmation.actor}（Brief v{confirmation.brief_version}）。"
                    ),
                ],
                constraint_notes=[
                    f"计算结果或预算上限低于 MOQ {brief.moq} 双；仅返回冲突，不输出可执行量。"
                ],
                status="CONFLICT",
            )
        ]

    results: list[FirstOrderScenario] = []
    for (name, factor), quantity in zip(specs, quantities):
        results.append(
            FirstOrderScenario(
                name=name,
                quantity_low=quantity,
                quantity_high=quantity,
                assumptions=[
                    (
                        "anchor = purchase_intent_count × intent_to_order_rate × "
                        "planned_reach / simulated_exposure。"
                    ),
                    f"情景系数固定为 {factor:.1f}。",
                    (
                        f"假设提案来源：{inputs.source}；人工确认人："
                        f"{confirmation.actor}（Brief v{confirmation.brief_version}）。"
                    ),
                    "purchase_intent_count 是需求代理量，不是真实订单或销量预测。",
                ],
                constraint_notes=[
                    f"按 {inputs.packing_step} 双包装步长取整，并受预算上限 {budget_ceiling} 双约束。",
                    "不含尺码配比和售罄预测。",
                ],
                status=("CONDITIONAL_RETEST_REQUIRED" if conditional_retest else "READY"),
            )
        )
    return results


def _go_handoff(
    project: ProjectRecord,
    brief: ProductBrief,
    decision: DecisionCard,
    metrics: MetricBundle,
    confirmation: FirstOrderAssumptionsConfirmation,
) -> HandoffPackage:
    if not metrics.best_variant_id:
        raise ConflictError("cannot generate handoff without a best variant")
    variant: CandidateVariant = next(
        item for item in brief.variants if item.id == metrics.best_variant_id
    )
    techpack = TechPackLite(
        id=f"techpack-{project.id}-v{decision.version}",
        candidate_id=brief.candidate_id,
        variant_id=variant.id,
        decision_id=decision.id,
        title=f"{brief.product_name} / {variant.color_name} / TechPack Lite",
        fields=[
            TechPackField(
                name="款号",
                value=brief.candidate_id,
                status="USER_PROVIDED",
                source_ref="product-brief",
            ),
            TechPackField(
                name="品类",
                value=brief.category,
                status="USER_PROVIDED",
                source_ref="product-brief",
            ),
            TechPackField(
                name="配色", value=variant.color_name, status="CONFIRMED", source_ref=decision.id
            ),
            TechPackField(
                name="目标人群",
                value=brief.target_audience,
                status="USER_PROVIDED",
                source_ref="product-brief",
            ),
            TechPackField(
                name="使用场景",
                value=brief.usage_scenario,
                status="USER_PROVIDED",
                source_ref="product-brief",
            ),
            TechPackField(name="尺码范围", value=None, status="PENDING_CONFIRMATION"),
            TechPackField(name="鞋楦", value=None, status="PENDING_CONFIRMATION"),
            TechPackField(
                name="帮面材料",
                value=variant.material_notes,
                status=("USER_PROVIDED" if variant.material_notes else "PENDING_CONFIRMATION"),
                source_ref=("product-brief" if variant.material_notes else None),
            ),
            TechPackField(name="里料", value=None, status="PENDING_CONFIRMATION"),
            TechPackField(name="鞋垫", value=None, status="PENDING_CONFIRMATION"),
            TechPackField(name="大底材料", value=None, status="PENDING_CONFIRMATION"),
            TechPackField(name="闭合方式", value=None, status="PENDING_CONFIRMATION"),
            TechPackField(name="关键工艺", value=None, status="PENDING_CONFIRMATION"),
            TechPackField(name="包装", value=None, status="PENDING_CONFIRMATION"),
            TechPackField(name="男士休闲鞋版型", value=None, status="PENDING_CONFIRMATION"),
            TechPackField(name="楦宽/适配脚型", value=None, status="PENDING_CONFIRMATION"),
            TechPackField(name="单鞋重量目标", value=None, status="PENDING_CONFIRMATION"),
            TechPackField(name="缓震验收标准", value=None, status="PENDING_CONFIRMATION"),
            TechPackField(name="弯折验收标准", value=None, status="PENDING_CONFIRMATION"),
            TechPackField(name="防滑验收标准", value=None, status="PENDING_CONFIRMATION"),
            TechPackField(
                name="目标零售价",
                value=format_fen(brief.target_price_fen),
                status="USER_PROVIDED",
                source_ref="product-brief",
            ),
            TechPackField(
                name="目标成本",
                value=format_fen(brief.estimated_cost_fen),
                status="USER_PROVIDED",
                source_ref="product-brief",
            ),
            TechPackField(
                name="MOQ",
                value=f"{brief.moq} 双",
                status="USER_PROVIDED",
                source_ref="product-brief",
            ),
        ],
        warnings=[
            "这是打样沟通草案，不是生产级技术包。",
            "未知工艺字段不得由模型自动补全。",
        ],
    )
    sample_task = SampleTask(
        id=f"sample-task-{project.id}-v{decision.version}",
        candidate_id=brief.candidate_id,
        variant_id=variant.id,
        objective="验证轻量通勤休闲鞋的外观、穿着和可制造性。",
        acceptance_points=[
            "核对配色与外观样",
            "确认鞋楦、帮面、大底和工艺字段",
            "复核样品成本、MOQ 和交期",
        ],
        risks=["当前材料、鞋楦和尺码字段尚待工厂确认"],
    )
    return HandoffPackage(
        id=f"handoff-{project.id}-v{decision.version}",
        decision_id=decision.id,
        outcome=decision.outcome,
        techpack=techpack,
        sample_task=sample_task,
        first_order_scenarios=_first_order_scenarios(brief, metrics, confirmation),
        status="DRAFT_REQUIRES_SEPARATE_EXTERNAL_APPROVAL",
    )


def _pivot_change_contract(
    decision: DecisionCard,
    metrics: MetricBundle,
    brief: ProductBrief,
) -> tuple[str, str, list[str], list[str]]:
    """Map deterministic reason codes to exactly one editable variable."""

    reason_codes = set(decision.reason_codes)
    best_variant = metrics.best_variant_id or brief.variants[0].id
    worst_variant = metrics.worst_variant_id or brief.variants[-1].id
    if reason_codes & {"VARIANT_DIVERGENCE", "MODIFIABLE_DESIGN_VARIABLE"}:
        variable = "COLOR"
        target_variant = worst_variant
        changes = ["仅替换目标变体的配色；新色名与色号由人工在打样前确认。"]
    elif reason_codes & {
        "MARGIN_BELOW_FLOOR",
        "MODIFIABLE_PRICE_OR_COST_VARIABLE",
        "INTEREST_WITH_PURCHASE_FRICTION",
        "MODIFIABLE_PRICE_OR_OFFER_VARIABLE",
    }:
        variable = "PRICE"
        target_variant = best_variant
        changes = ["仅创建一个新的试销价格版本；具体价格由人工确认后写入新实验计划。"]
    elif reason_codes & {"MOQ_BUDGET_CONFLICT", "MODIFIABLE_SUPPLY_VARIABLE"}:
        variable = "MOQ"
        target_variant = best_variant
        changes = ["仅将 MOQ 作为供应协商变量；目标 MOQ 由人工与供应方确认。"]
    elif reason_codes & {"LEAD_TIME_WINDOW_CONFLICT", "MODIFIABLE_LEAD_TIME_VARIABLE"}:
        variable = "LEAD_TIME"
        target_variant = best_variant
        changes = ["仅将供应交期作为协商变量；目标交期由人工与供应方确认。"]
    else:
        raise ConflictError("PIVOT reason codes do not identify one supported change variable")

    retest_plan = [
        f"创建只改变 {variable} 的新 Product Brief 与 ExperimentPlan 版本。",
        "保持鞋型、其他商品条件、目标人群、渠道、素材版式和主指标不变。",
        "人工批准新的实验计划后重新运行固定场景，并以新证据重新生成 DecisionCard。",
    ]
    return variable, target_variant, changes, retest_plan


def generate_pivot_revision(session: Session, project_id: str) -> PivotRevision:
    project = _get_project_record(session, project_id)
    if not project.decision_json:
        raise ConflictError("decision card does not exist")
    decision = DecisionCard.model_validate(project.decision_json)
    if decision.outcome != DecisionOutcome.PIVOT:
        raise ConflictError("PivotRevision is only valid for a PIVOT decision")
    if (
        project.status != ProjectStatus.DECISION_APPROVED.value
        or decision.approval_status != ApprovalStatus.APPROVED
    ):
        raise ConflictError("the PIVOT DecisionCard must be approved first")
    metrics = MetricBundle.model_validate(project.metrics_json or {})
    brief = ProductBrief.model_validate(project.brief_json)
    variable, target_variant, changes, retest_plan = _pivot_change_contract(
        decision, metrics, brief
    )
    previous = _latest_pivot_revision_record(session, project.id)
    version = (previous.version if previous else 0) + 1
    revision = PivotRevisionRecord(
        id=f"pivot-revision-{project.id}-v{version}",
        project_id=project.id,
        decision_id=decision.id,
        target_variant_id=target_variant,
        version=version,
        approval_status=ApprovalStatus.PENDING.value,
        change_variable=variable,
        change_list_json=changes,
        retest_plan_json=retest_plan,
        created_by="deterministic-tool",
    )
    session.add(revision)
    project.handoff_json = None
    project.updated_at = utc_now()
    _record_audit(
        session,
        project,
        action="PIVOT_REVISION_GENERATED",
        object_type="PivotRevision",
        actor="deterministic-tool",
        from_state=project.status,
        to_state=project.status,
        summary={
            "pivot_revision_id": revision.id,
            "pivot_revision_version": version,
            "decision_id": decision.id,
            "target_variant_id": target_variant,
            "change_variable": variable,
            "change_count": len(changes),
            "approval_status": ApprovalStatus.PENDING.value,
        },
    )
    session.flush()
    return _pivot_revision_schema(revision)


def get_pivot_revision(session: Session, pivot_revision_id: str) -> PivotRevision:
    record = session.get(PivotRevisionRecord, pivot_revision_id)
    if record is None:
        raise NotFoundError("PivotRevision not found")
    return _pivot_revision_schema(record)


def generate_handoff(session: Session, project_id: str) -> HandoffPackage:
    project = _get_project_record(session, project_id)
    if not project.decision_json:
        raise ConflictError("decision card does not exist")
    decision = DecisionCard.model_validate(project.decision_json)
    if project.status != ProjectStatus.DECISION_APPROVED.value:
        raise ConflictError("handoff is not allowed in the current state")
    if decision.approval_status != ApprovalStatus.APPROVED:
        raise ConflictError("decision must be approved before handoff generation")
    brief = ProductBrief.model_validate(project.brief_json)
    metrics = MetricBundle.model_validate(project.metrics_json or {})
    confirmation = _first_order_assumptions_confirmation(session, project)
    if confirmation is None:
        raise ConflictError(
            "the current Brief version's first-order assumptions require explicit human confirmation"
        )
    if decision.outcome == DecisionOutcome.GO:
        package = _go_handoff(project, brief, decision, metrics, confirmation)
        target = ProjectStatus.HANDOFF_DRAFT_READY
    elif decision.outcome == DecisionOutcome.PIVOT:
        revision_record = _latest_pivot_revision_record(session, project.id, decision.id)
        if revision_record is None:
            raise ConflictError(
                "generate and approve an exact PivotRevision version before handoff"
            )
        revision = _pivot_revision_schema(revision_record)
        if revision.approval_status != ApprovalStatus.APPROVED:
            raise ConflictError(
                "the latest PivotRevision version must be approved before handoff"
            )
        approval = session.scalar(
            select(ApprovalRecord).where(
                ApprovalRecord.project_id == project.id,
                ApprovalRecord.gate == ApprovalGate.PIVOT_REVISION.value,
                ApprovalRecord.target_id == revision.id,
                ApprovalRecord.object_version == revision.version,
                ApprovalRecord.decision == ApprovalDecision.APPROVE.value,
            )
        )
        if approval is None:
            raise ConflictError(
                "the exact PivotRevision version has no effective APPROVE record"
            )
        package = HandoffPackage(
            id=(
                f"handoff-{project.id}-decision-v{decision.version}"
                f"-pivot-v{revision.version}"
            ),
            decision_id=decision.id,
            pivot_revision_id=revision.id,
            outcome=decision.outcome,
            sample_task=SampleTask(
                id=(
                    f"sample-task-{project.id}-decision-v{decision.version}"
                    f"-pivot-v{revision.version}"
                ),
                candidate_id=brief.candidate_id,
                variant_id=revision.target_variant_id,
                pivot_revision_id=revision.id,
                objective=(
                    f"仅修改已批准 PivotRevision v{revision.version} 的 "
                    f"{revision.change_variable} 变量，完成改款打样并重新试销。"
                ),
                change_list=revision.change_list,
                acceptance_points=[
                    f"确认唯一修改变量：{revision.change_variable}",
                    "保持其他预注册条件不变",
                    "新 ExperimentPlan 完成人工审批后才复测",
                ],
                risks=["这是改款打样草案，尚待复测，不是生产指令。"],
            ),
            first_order_scenarios=_first_order_scenarios(
                brief, metrics, confirmation, conditional_retest=True
            ),
            retest_plan=revision.retest_plan,
            blocked_reason=None,
            watermark="条件式、需复测、尚待复测，不得下单 / 非生产指令",
            status="CONDITIONAL_DRAFT",
        )
        target = ProjectStatus.HANDOFF_DRAFT_READY
    else:
        raise ConflictError(f"{decision.outcome.value} decisions cannot generate a handoff pack")
    project.handoff_json = _dump(package)
    handoff_version = _next_object_version(
        session,
        project_id=project.id,
        object_type="HandoffPackage",
        object_id=f"handoff-package-{project.id}",
    )
    _append_object_version(
        session,
        project_id=project.id,
        object_type="HandoffPackage",
        object_id=f"handoff-package-{project.id}",
        object_version=handoff_version,
        payload=_dump(package),
    )
    _transition(
        session,
        project,
        target,
        action="HANDOFF_DRAFT_GENERATED",
        object_type="HandoffPackage",
        actor="deterministic-tool",
        summary={
            "outcome": decision.outcome.value,
            "status": package.status,
            "object_version": handoff_version,
            "pivot_revision_id": package.pivot_revision_id,
            "contains_first_order": bool(package.first_order_scenarios),
            "first_order_assumptions_target_id": confirmation.target_id,
            "first_order_assumptions_brief_version": confirmation.brief_version,
            "first_order_assumptions_confirmed_by": confirmation.actor,
            "first_order_assumptions_confirmed_at": confirmation.confirmed_at.isoformat(),
            "external_action_executed": False,
        },
    )
    session.flush()
    return package


def archive_project(
    session: Session,
    project_id: str,
    payload: ProjectArchiveRequest,
    *,
    request_id: str | None = None,
) -> ProjectDetail:
    """Archive a completed project, or explicitly cancel and archive active work."""

    project = _get_project_record(session, project_id)
    if project.status == ProjectStatus.ARCHIVED.value:
        raise ConflictError("project is already archived")
    terminal_states = {
        ProjectStatus.DECISION_APPROVED.value,
        ProjectStatus.HANDOFF_DRAFT_READY.value,
        ProjectStatus.CANCELLED.value,
    }
    was_terminal = project.status in terminal_states
    if not was_terminal and not payload.cancel_active_work:
        raise ConflictError(
            "active projects require cancel_active_work=true before archival"
        )
    _transition(
        session,
        project,
        ProjectStatus.ARCHIVED,
        action=("PROJECT_ARCHIVED" if was_terminal else "PROJECT_CANCELLED_AND_ARCHIVED"),
        object_type="DecisionProject",
        actor=payload.actor,
        request_id=request_id,
        summary={
            "reason": payload.reason,
            "cancelled_active_work": not was_terminal,
            "history_retained": True,
            "external_delete_performed": False,
        },
    )
    session.flush()
    return project_detail(session, project.id)


def audit_events(session: Session, project_id: str) -> list[AuditEvent]:
    _get_project_record(session, project_id)
    rows = list(
        session.scalars(
            select(AuditEventRecord)
            .where(AuditEventRecord.project_id == project_id)
            .order_by(AuditEventRecord.created_at.asc(), AuditEventRecord.id.asc())
        )
    )
    return [
        AuditEvent(
            id=row.id,
            project_id=row.project_id,
            action=row.action,
            object_type=row.object_type,
            from_state=(ProjectStatus(row.from_state) if row.from_state else None),
            to_state=(ProjectStatus(row.to_state) if row.to_state else None),
            actor=row.actor,
            request_id=row.request_id,
            summary=row.summary_json,
            created_at=row.created_at,
        )
        for row in rows
    ]


def object_versions(session: Session, project_id: str) -> list[ObjectVersionSummary]:
    _get_project_record(session, project_id)
    rows = list(
        session.scalars(
            select(ObjectVersionRecord)
            .where(ObjectVersionRecord.project_id == project_id)
            .order_by(ObjectVersionRecord.created_at.asc(), ObjectVersionRecord.id.asc())
        )
    )
    return [
        ObjectVersionSummary(
            project_id=row.project_id,
            object_type=row.object_type,
            object_id=row.object_id,
            object_version=row.object_version,
            payload=row.payload_json,
            sha256=row.sha256,
            created_at=_as_utc(row.created_at),
        )
        for row in rows
    ]


def agent_runs(session: Session, project_id: str) -> list[AgentRunSummary]:
    _get_project_record(session, project_id)
    rows = list(
        session.scalars(
            select(AgentRunRecord)
            .where(AgentRunRecord.project_id == project_id)
            .order_by(AgentRunRecord.created_at.asc())
        )
    )
    return [
        AgentRunSummary(
            id=row.id,
            project_id=row.project_id,
            mode=AgentMode(row.mode),
            operation=row.operation,
            model_name=row.model_name,
            reasoning_effort=row.reasoning_effort,
            prompt_version=row.prompt_version,
            output_schema_version=row.output_schema_version,
            recording_id=row.recording_id,
            duration_ms=row.duration_ms,
            input_sha256=row.input_sha256,
            output_sha256=row.output_sha256,
            input_tokens=row.input_tokens,
            output_tokens=row.output_tokens,
            tracing_disabled=row.tracing_disabled,
            api_store_disabled=row.api_store_disabled,
            success=row.success,
            fallback_reason=row.fallback_reason,
            created_at=row.created_at,
        )
        for row in rows
    ]


def trial_observations(session: Session, project_id: str) -> list[TrialObservation]:
    _get_project_record(session, project_id)
    return _load_observations(session, project_id)


def _attachment_schema(record: AttachmentRecord) -> Attachment:
    return Attachment(
        id=record.id,
        project_id=record.project_id,
        object_key=record.object_key,
        original_filename=record.original_filename,
        mime_type=record.mime_type,
        size_bytes=record.size_bytes,
        sha256=record.sha256,
        rights_declaration=record.rights_declaration,
        source=record.source,
        created_at=_as_utc(record.created_at),
    )


def create_attachment_metadata(
    session: Session,
    *,
    attachment_id: str,
    project_id: str,
    object_key: str,
    original_filename: str,
    mime_type: str,
    size_bytes: int,
    sha256: str,
    rights_declaration: str,
) -> Attachment:
    project = _get_project_record(session, project_id)
    if project.status == ProjectStatus.ARCHIVED.value:
        raise ConflictError("archived projects are immutable")
    if not rights_declaration.strip():
        raise InputError("rights_declaration is required")
    record = AttachmentRecord(
        id=attachment_id,
        project_id=project.id,
        object_key=object_key,
        original_filename=original_filename,
        mime_type=mime_type,
        size_bytes=size_bytes,
        sha256=sha256,
        rights_declaration=rights_declaration.strip(),
        source="USER_UPLOAD",
    )
    session.add(record)
    _record_audit(
        session,
        project,
        action="IMAGE_ATTACHMENT_ADDED",
        object_type="Attachment",
        actor="user",
        summary={
            "attachment_id": attachment_id,
            "mime_type": mime_type,
            "size_bytes": size_bytes,
            "sha256": sha256,
            "rights_declared": True,
            "vision_analysis_performed": False,
        },
    )
    session.flush()
    return _attachment_schema(record)


def list_attachments(session: Session, project_id: str) -> list[Attachment]:
    _get_project_record(session, project_id)
    rows = session.scalars(
        select(AttachmentRecord)
        .where(AttachmentRecord.project_id == project_id)
        .order_by(AttachmentRecord.created_at.asc(), AttachmentRecord.id.asc())
    )
    return [_attachment_schema(record) for record in rows]


def get_attachment_metadata(session: Session, project_id: str, attachment_id: str) -> Attachment:
    _get_project_record(session, project_id)
    record = session.get(AttachmentRecord, attachment_id)
    if record is None or record.project_id != project_id:
        raise NotFoundError("attachment not found")
    return _attachment_schema(record)


def project_id_for_plan(session: Session, plan_id: str) -> str:
    """Resolve the persisted plan id (or documented project-id convenience id)."""

    direct = session.get(ProjectRecord, plan_id)
    if direct is not None and direct.plan_json:
        return direct.id
    for project in session.scalars(select(ProjectRecord)):
        if project.plan_json and project.plan_json.get("id") == plan_id:
            return project.id
    raise NotFoundError("experiment plan not found")


def project_id_for_decision(session: Session, decision_id: str) -> str:
    direct = session.get(ProjectRecord, decision_id)
    if direct is not None and direct.decision_json:
        return direct.id
    for project in session.scalars(select(ProjectRecord)):
        if project.decision_json and project.decision_json.get("id") == decision_id:
            return project.id
    raise NotFoundError("decision card not found")


def project_id_for_pivot_revision(session: Session, pivot_revision_id: str) -> str:
    revision = session.get(PivotRevisionRecord, pivot_revision_id)
    if revision is None:
        raise NotFoundError("PivotRevision not found")
    return revision.project_id


def project_id_for_dataset(session: Session, dataset_id: str) -> str:
    dataset = session.get(DatasetRecord, dataset_id)
    if dataset is None or not dataset.active:
        raise NotFoundError("active trial dataset not found")
    return dataset.project_id


def simulation_run_detail(session: Session, run_id: str) -> SimulationRun:
    """MVP simulation runs are project-backed; their stable id is the project id."""

    project = _get_project_record(session, run_id)
    if not project.plan_json:
        raise ConflictError("experiment plan does not exist")
    plan = ExperimentPlan.model_validate(project.plan_json)
    if not plan.policy_snapshot:
        raise ConflictError("approved plan is missing its immutable policy snapshot")
    if plan.approval_status != ApprovalStatus.APPROVED:
        raise ConflictError("experiment plan must be approved before creating a run")
    datasets = _active_datasets(session, project.id)
    return SimulationRun(
        id=project.id,
        project_id=project.id,
        experiment_plan_id=plan.id,
        experiment_plan_version=plan.version,
        status=ProjectStatus(project.status),
        current_day=project.current_day,
        total_days=project.total_days,
        dataset_id=datasets[0].id if datasets else None,
        scenario_id=DemoScenarioId(project.scenario_id),
        scenario_version=project.scenario_version or SCENARIO_VERSION,
        fixed_seed=project.fixed_seed if project.fixed_seed is not None else FIXED_SEED,
        generator_version=project.generator_version or GENERATOR_VERSION,
        schema_version=SCHEMA_VERSION,
        dataset_sha256=datasets[0].sha256 if datasets else None,
    )


def create_simulation_run(session: Session, project_id: str) -> SimulationRun:
    project = _get_project_record(session, project_id)
    if project.status != ProjectStatus.SIMULATION_READY.value:
        raise ConflictError("simulation run can only be created in SIMULATION_READY")
    run = simulation_run_detail(session, project_id)
    _record_audit(
        session,
        project,
        action="SIMULATION_RUN_REGISTERED",
        object_type="SimulationRun",
        actor="user",
        summary={
            "simulation_run_id": run.id,
            "implementation": "project-backed-mvp-run",
            "experiment_plan_version": run.experiment_plan_version,
        },
    )
    session.flush()
    return run


def validate_dataset(session: Session, dataset_id: str) -> QualityReport:
    dataset = session.get(DatasetRecord, dataset_id)
    if dataset is None or not dataset.active:
        raise NotFoundError("active trial dataset not found")
    project = _get_project_record(session, dataset.project_id)
    if project.status != ProjectStatus.DATA_READY.value:
        raise ConflictError("dataset validation is only allowed in DATA_READY")
    if not project.plan_json:
        raise ConflictError("experiment plan does not exist")
    plan = ExperimentPlan.model_validate(project.plan_json)
    if not plan.policy_snapshot:
        raise ConflictError("approved plan is missing its immutable policy snapshot")
    policy = DemoPolicy.model_validate(plan.policy_snapshot)
    if dataset.plan_version != plan.version:
        raise ConflictError("dataset plan version does not match the approved plan")
    observations = _load_observations(session, project.id)
    quality = validate_trial_data(
        observations,
        ProductBrief.model_validate(project.brief_json),
        plan,
        srm_block_p_value=policy.srm_block_p_value,
    )
    quality.dataset_sha256 = dataset.sha256
    project.quality_json = _dump(quality)
    _append_changed_object_version(
        session,
        project_id=project.id,
        object_type="QualityReport",
        object_id=f"quality-report-{project.id}",
        payload=_dump(quality),
    )
    target = (
        ProjectStatus.DATA_VALIDATED
        if quality.can_make_strong_decision
        else ProjectStatus.DATA_BLOCKED
    )
    _transition(
        session,
        project,
        target,
        action="DATASET_VALIDATED",
        object_type="QualityReport",
        actor="rule-engine",
        summary={
            "dataset_id": dataset.id,
            "dataset_sha256": quality.dataset_sha256,
            "quality_status": quality.status.value,
            "issue_codes": [issue.code for issue in quality.issues],
        },
    )
    session.flush()
    return quality


def existing_decision_card(session: Session, experiment_id: str) -> DecisionCard:
    project_id = project_id_for_plan(session, experiment_id)
    project = _get_project_record(session, project_id)
    if not project.decision_json:
        raise ConflictError("analyze the experiment before generating its decision card")
    if project.status not in {
        ProjectStatus.DECISION_PROPOSED.value,
        ProjectStatus.ANALYZED.value,
    }:
        raise ConflictError("decision card is not available in the current state")
    return DecisionCard.model_validate(project.decision_json)
