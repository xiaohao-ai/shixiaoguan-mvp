from __future__ import annotations

import os
import uuid
from collections.abc import Generator
from pathlib import Path
from typing import Annotated

from fastapi import Depends, FastAPI, File, Form, Header, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse
from sqlalchemy.orm import Session

from . import __version__
from .agent import AgentAdapter, ReplayMissError, configured_agent_mode
from .attachments import (
    MAX_IMAGE_BYTES,
    AttachmentValidationError,
    persist_image,
    resolve_object_path,
    validate_image,
)
from .database import Database
from .enums import ApprovalGate, DemoScenarioId, ProjectStatus
from .idempotency import IdempotencyMiddleware
from .policy import DEFAULT_POLICY, DemoPolicy
from .reporting import render_report
from .schemas import (
    AgentRunSummary,
    AnalysisBundle,
    ApprovalRequest,
    ApprovalResponse,
    Attachment,
    AuditEvent,
    DecisionCard,
    DemoScenarioSummary,
    EvidenceCard,
    HandoffPackage,
    HealthResponse,
    MetricBundle,
    ObjectVersionSummary,
    PivotRevision,
    ProductBriefDraft,
    ProjectArchiveRequest,
    ProjectCreate,
    ProjectDetail,
    ProjectListItem,
    QualityReport,
    SimulationAdvanceRequest,
    SimulationResponse,
    SimulationRun,
    TrialObservation,
)
from .seed import scenario_summaries
from .services import (
    ConflictError,
    InputError,
    NotFoundError,
    advance_simulation,
    agent_runs,
    analyze_project,
    approve,
    archive_project,
    audit_events,
    create_attachment_metadata,
    create_project,
    create_scenario_project,
    create_simulation_run,
    existing_decision_card,
    generate_experiment_plan,
    generate_handoff,
    generate_pivot_revision,
    get_attachment_metadata,
    get_pivot_revision,
    list_attachments,
    list_projects,
    normalize_project_brief,
    object_versions,
    project_detail,
    project_id_for_dataset,
    project_id_for_decision,
    project_id_for_pivot_revision,
    project_id_for_plan,
    reset_simulation_replay,
    run_simulation,
    simulation_run_detail,
    trial_observations,
    update_brief,
    update_project_policy,
    validate_dataset,
)


def _default_database_url() -> str:
    database_path = Path(__file__).resolve().parents[2] / "shixiaoguan.db"
    return f"sqlite:///{database_path}"


def get_session(request: Request) -> Generator[Session, None, None]:
    with request.app.state.database.session() as session:
        yield session


# End the database dependency before the response is handed back to middleware.
# The idempotency middleware writes its response record with a second session;
# keeping the route session open until response streaming completes deadlocks a
# file-backed SQLite database even though the same flow appears to work in memory.
SessionDependency = Annotated[Session, Depends(get_session, scope="function")]


def require_idempotency_key(
    idempotency_key: Annotated[str, Header(alias="Idempotency-Key")],
) -> str:
    return idempotency_key


WRITE_DEPENDENCY = [Depends(require_idempotency_key)]


def _artifact_or_404(project: ProjectDetail, name: str) -> object:
    artifact = getattr(project.artifacts, name)
    if artifact is None:
        raise NotFoundError(f"{name} has not been generated")
    return artifact


def create_app(database_url: str | None = None) -> FastAPI:
    app = FastAPI(
        title="试销官 MVP API",
        version=__version__,
        description=(
            "单编排 Agent + 确定性质检/指标/四态规则 + 人工审批。所有 Demo 数据均标记为 SYNTHETIC。"
        ),
    )
    url = (
        database_url
        or os.getenv("DATABASE_URL")
        or os.getenv("SHIXIAOGUAN_DATABASE_URL")
        or _default_database_url()
    )
    database = Database(url)
    alembic_config = Path(__file__).resolve().parents[2] / "alembic.ini"
    database.migrate(str(alembic_config))
    app.state.database = database
    app.state.agent_adapter = AgentAdapter()
    upload_root = Path(
        os.getenv("UPLOAD_DIR")
        or os.getenv("SHIXIAOGUAN_UPLOAD_DIR")
        or (Path(__file__).resolve().parents[2] / "var" / "uploads")
    ).resolve()
    upload_root.mkdir(parents=True, exist_ok=True)
    app.state.upload_root = upload_root

    configured_origins = (
        os.getenv("WEB_ORIGIN")
        or os.getenv("SHIXIAOGUAN_CORS_ORIGINS")
        or "http://localhost:3000,http://127.0.0.1:3000"
    )
    origins = [value.strip() for value in configured_origins.split(",") if value.strip()]
    app.add_middleware(
        CORSMiddleware,
        allow_origins=origins,
        allow_credentials=True,
        allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
        allow_headers=["Content-Type", "Idempotency-Key", "If-Match-Version"],
    )
    app.add_middleware(IdempotencyMiddleware)

    @app.exception_handler(NotFoundError)
    async def not_found_handler(_: Request, exc: NotFoundError) -> JSONResponse:
        return JSONResponse(status_code=404, content={"detail": str(exc)})

    @app.exception_handler(ConflictError)
    async def conflict_handler(_: Request, exc: ConflictError) -> JSONResponse:
        return JSONResponse(status_code=409, content={"detail": str(exc)})

    @app.exception_handler(InputError)
    async def input_handler(_: Request, exc: InputError) -> JSONResponse:
        return JSONResponse(status_code=422, content={"detail": str(exc)})

    @app.exception_handler(ReplayMissError)
    async def replay_miss_handler(_: Request, exc: ReplayMissError) -> JSONResponse:
        return JSONResponse(
            status_code=422,
            content={
                "detail": str(exc),
                "code": "REPLAY_RECORDING_MISS",
                "replay_key": {
                    "input_sha256": exc.key.input_sha256,
                    "prompt_version": exc.key.prompt_version,
                    "output_schema_version": exc.key.output_schema_version,
                },
            },
        )

    @app.get("/health", response_model=HealthResponse, tags=["system"])
    @app.get("/api/v1/health", response_model=HealthResponse, tags=["system"])
    def health() -> HealthResponse:
        return HealthResponse(
            status="ok",
            service="shixiaoguan-api",
            version=__version__,
            agent_mode=configured_agent_mode(),
        )

    @app.get("/api/v1/policy", response_model=DemoPolicy, tags=["policy"])
    def policy() -> DemoPolicy:
        return DEFAULT_POLICY

    @app.get(
        "/api/v1/demo/scenarios",
        response_model=list[DemoScenarioSummary],
        tags=["demo"],
    )
    def scenarios() -> list[DemoScenarioSummary]:
        return scenario_summaries()

    @app.post(
        "/api/v1/demo/scenarios/{scenario_id}/projects",
        response_model=ProjectDetail,
        status_code=201,
        tags=["demo"],
        dependencies=WRITE_DEPENDENCY,
    )
    async def scenario_project(
        scenario_id: DemoScenarioId, request: Request, session: SessionDependency
    ) -> ProjectDetail:
        return await create_scenario_project(session, scenario_id, request.app.state.agent_adapter)

    @app.post(
        "/api/v1/projects",
        response_model=ProjectDetail,
        status_code=201,
        tags=["projects"],
        dependencies=WRITE_DEPENDENCY,
    )
    def post_project(payload: ProjectCreate, session: SessionDependency) -> ProjectDetail:
        return create_project(session, payload)

    @app.get("/api/v1/projects", response_model=list[ProjectListItem], tags=["projects"])
    def get_projects(session: SessionDependency) -> list[ProjectListItem]:
        return list_projects(session)

    @app.get("/api/v1/projects/{project_id}", response_model=ProjectDetail, tags=["projects"])
    def get_project(project_id: str, session: SessionDependency) -> ProjectDetail:
        return project_detail(session, project_id)

    @app.post(
        "/api/v1/projects/{project_id}:archive",
        response_model=ProjectDetail,
        tags=["projects"],
        summary="Archive a completed project or explicitly cancel and archive active work",
    )
    def archive(
        project_id: str,
        payload: ProjectArchiveRequest,
        session: SessionDependency,
        idempotency_key: Annotated[str, Header(alias="Idempotency-Key")],
    ) -> ProjectDetail:
        return archive_project(
            session,
            project_id,
            payload,
            request_id=idempotency_key,
        )

    @app.get(
        "/api/v1/projects/{project_id}/attachments",
        response_model=list[Attachment],
        tags=["attachments"],
    )
    def get_attachments(project_id: str, session: SessionDependency) -> list[Attachment]:
        return list_attachments(session, project_id)

    @app.post(
        "/api/v1/projects/{project_id}/attachments",
        response_model=Attachment,
        status_code=201,
        tags=["attachments"],
        dependencies=WRITE_DEPENDENCY,
        description="PNG/JPEG/WebP only, verified by magic bytes, maximum 5 MB; no vision analysis.",
    )
    async def post_attachment(
        project_id: str,
        session: SessionDependency,
        file: Annotated[UploadFile, File()],
        rights_declaration: Annotated[str, Form(min_length=1, max_length=2000)],
    ) -> Attachment:
        # Resolve the parent first so invalid projects never create files.
        parent = project_detail(session, project_id)
        if parent.status == ProjectStatus.ARCHIVED:
            raise ConflictError("archived projects are immutable")
        data = await file.read(MAX_IMAGE_BYTES + 1)
        try:
            mime_type, extension, sha256 = validate_image(data, file.content_type)
        except AttachmentValidationError as exc:
            raise InputError(str(exc)) from exc
        attachment_id = uuid.uuid4().hex
        object_key = f"{project_id}/{attachment_id}{extension}"
        try:
            persist_image(upload_root, object_key, data)
        except AttachmentValidationError as exc:
            raise InputError(str(exc)) from exc
        original_filename = (
            (file.filename or f"image{extension}").replace("\\", "/").rsplit("/", 1)[-1]
        )
        return create_attachment_metadata(
            session,
            attachment_id=attachment_id,
            project_id=project_id,
            object_key=object_key,
            original_filename=original_filename[:300],
            mime_type=mime_type,
            size_bytes=len(data),
            sha256=sha256,
            rights_declaration=rights_declaration,
        )

    @app.get(
        "/api/v1/projects/{project_id}/attachments/{attachment_id}/content",
        response_class=FileResponse,
        tags=["attachments"],
    )
    def get_attachment_content(
        project_id: str, attachment_id: str, session: SessionDependency
    ) -> FileResponse:
        attachment = get_attachment_metadata(session, project_id, attachment_id)
        try:
            path = resolve_object_path(upload_root, attachment.object_key)
        except AttachmentValidationError as exc:
            raise InputError(str(exc)) from exc
        if not path.is_file():
            raise NotFoundError("attachment content not found")
        return FileResponse(
            path,
            media_type=attachment.mime_type,
            filename=attachment.original_filename,
        )

    @app.get(
        "/api/v1/projects/{project_id}/policy",
        response_model=DemoPolicy,
        tags=["policy"],
    )
    def get_project_policy(project_id: str, session: SessionDependency) -> DemoPolicy:
        return DemoPolicy.model_validate(project_detail(session, project_id).current_policy)

    @app.put(
        "/api/v1/projects/{project_id}/policy",
        response_model=ProjectDetail,
        tags=["policy"],
        dependencies=WRITE_DEPENDENCY,
        summary="Create the next immutable project DemoPolicy version",
    )
    def put_project_policy(
        project_id: str, payload: DemoPolicy, session: SessionDependency
    ) -> ProjectDetail:
        return update_project_policy(session, project_id, payload)

    @app.put(
        "/api/v1/projects/{project_id}/brief",
        response_model=ProjectDetail,
        tags=["projects"],
        dependencies=WRITE_DEPENDENCY,
    )
    def put_brief(
        project_id: str,
        brief: ProductBriefDraft,
        session: SessionDependency,
        expected_version: Annotated[int, Header(alias="If-Match-Version", ge=1)],
    ) -> ProjectDetail:
        return update_brief(session, project_id, brief, expected_version)

    @app.put(
        "/api/v1/projects/{project_id}/brief-versions",
        response_model=ProjectDetail,
        tags=["canonical-workflow"],
        dependencies=WRITE_DEPENDENCY,
        summary="Create the next immutable ProductBrief version",
    )
    def put_brief_version(
        project_id: str,
        brief: ProductBriefDraft,
        session: SessionDependency,
        expected_version: Annotated[int, Header(alias="If-Match-Version", ge=1)],
    ) -> ProjectDetail:
        return update_brief(session, project_id, brief, expected_version)

    @app.post(
        "/api/v1/projects/{project_id}/brief/normalize",
        response_model=ProjectDetail,
        tags=["agent"],
        dependencies=WRITE_DEPENDENCY,
    )
    async def normalize_brief(
        project_id: str, request: Request, session: SessionDependency
    ) -> ProjectDetail:
        return await normalize_project_brief(session, project_id, request.app.state.agent_adapter)

    @app.post(
        "/api/v1/projects/{project_id}/experiment-plan/generate",
        response_model=ProjectDetail,
        tags=["agent"],
        dependencies=WRITE_DEPENDENCY,
    )
    async def generate_plan(
        project_id: str, request: Request, session: SessionDependency
    ) -> ProjectDetail:
        return await generate_experiment_plan(session, project_id, request.app.state.agent_adapter)

    @app.post(
        "/api/v1/projects/{project_id}/experiment-plans:generate",
        response_model=ProjectDetail,
        tags=["canonical-workflow"],
        dependencies=WRITE_DEPENDENCY,
    )
    async def generate_canonical_plan(
        project_id: str, request: Request, session: SessionDependency
    ) -> ProjectDetail:
        return await generate_experiment_plan(session, project_id, request.app.state.agent_adapter)

    @app.post(
        "/api/v1/projects/{project_id}/approvals",
        response_model=ApprovalResponse,
        tags=["approvals"],
    )
    def post_approval(
        project_id: str,
        payload: ApprovalRequest,
        session: SessionDependency,
        idempotency_key: Annotated[str, Header(alias="Idempotency-Key")],
    ) -> ApprovalResponse:
        payload.request_id = idempotency_key
        return approve(session, project_id, payload)

    @app.post(
        "/api/v1/experiment-plans/{plan_id}/approvals",
        response_model=ApprovalResponse,
        tags=["canonical-workflow"],
    )
    def approve_canonical_plan(
        plan_id: str,
        payload: ApprovalRequest,
        session: SessionDependency,
        idempotency_key: Annotated[str, Header(alias="Idempotency-Key")],
    ) -> ApprovalResponse:
        if payload.gate != ApprovalGate.EXPERIMENT_PLAN:
            raise InputError("gate must be EXPERIMENT_PLAN for this endpoint")
        payload.request_id = idempotency_key
        return approve(session, project_id_for_plan(session, plan_id), payload)

    @app.post(
        "/api/v1/projects/{project_id}/simulation-runs",
        response_model=SimulationRun,
        status_code=201,
        tags=["canonical-workflow"],
        dependencies=WRITE_DEPENDENCY,
        description="The MVP run id is the project id and remains stable for replay.",
    )
    def post_simulation_run(project_id: str, session: SessionDependency) -> SimulationRun:
        return create_simulation_run(session, project_id)

    @app.get(
        "/api/v1/simulation-runs/{run_id}",
        response_model=SimulationRun,
        tags=["canonical-workflow"],
        description="The MVP run id is the project id returned when the run is created.",
    )
    def get_simulation_run(run_id: str, session: SessionDependency) -> SimulationRun:
        return simulation_run_detail(session, run_id)

    @app.post(
        "/api/v1/simulation-runs/{run_id}:complete",
        response_model=SimulationResponse,
        tags=["canonical-workflow"],
        dependencies=WRITE_DEPENDENCY,
    )
    def complete_simulation_run(run_id: str, session: SessionDependency) -> SimulationResponse:
        return run_simulation(session, run_id)

    @app.post(
        "/api/v1/projects/{project_id}/simulation/advance",
        response_model=SimulationResponse,
        tags=["simulation"],
        dependencies=WRITE_DEPENDENCY,
    )
    def advance(
        project_id: str,
        payload: SimulationAdvanceRequest,
        session: SessionDependency,
    ) -> SimulationResponse:
        return advance_simulation(session, project_id, payload.days)

    @app.post(
        "/api/v1/projects/{project_id}/simulation/run",
        response_model=SimulationResponse,
        tags=["simulation"],
        dependencies=WRITE_DEPENDENCY,
    )
    def run(project_id: str, session: SessionDependency) -> SimulationResponse:
        return run_simulation(session, project_id)

    @app.post(
        "/api/v1/projects/{project_id}/simulation/replay-reset",
        response_model=ProjectDetail,
        tags=["simulation"],
        description=(
            "Deactivates the current synthetic dataset and clears unapproved analysis "
            "projections while retaining observations, object versions, and audit history."
        ),
    )
    def replay_reset(
        project_id: str,
        session: SessionDependency,
        idempotency_key: Annotated[str, Header(alias="Idempotency-Key")],
    ) -> ProjectDetail:
        return reset_simulation_replay(
            session,
            project_id,
            request_id=idempotency_key,
        )

    @app.get(
        "/api/v1/projects/{project_id}/observations",
        response_model=list[TrialObservation],
        tags=["simulation"],
    )
    def observations(project_id: str, session: SessionDependency) -> list[TrialObservation]:
        return trial_observations(session, project_id)

    @app.post(
        "/api/v1/projects/{project_id}/analyze",
        response_model=AnalysisBundle,
        tags=["analysis"],
        dependencies=WRITE_DEPENDENCY,
    )
    async def analyze(
        project_id: str, request: Request, session: SessionDependency
    ) -> AnalysisBundle:
        return await analyze_project(session, project_id, request.app.state.agent_adapter)

    @app.post(
        "/api/v1/datasets/{dataset_id}:validate",
        response_model=QualityReport,
        tags=["canonical-workflow"],
        dependencies=WRITE_DEPENDENCY,
        description="Validates only an existing dataset produced by the built-in simulator.",
    )
    def validate_canonical_dataset(dataset_id: str, session: SessionDependency) -> QualityReport:
        # Resolution proves that the id is an active, simulator-owned dataset.
        project_id_for_dataset(session, dataset_id)
        return validate_dataset(session, dataset_id)

    @app.post(
        "/api/v1/experiments/{experiment_id}:analyze",
        response_model=AnalysisBundle,
        tags=["canonical-workflow"],
        dependencies=WRITE_DEPENDENCY,
        description="In the MVP the persisted ExperimentPlan id is the experiment id.",
    )
    async def analyze_canonical_experiment(
        experiment_id: str, request: Request, session: SessionDependency
    ) -> AnalysisBundle:
        return await analyze_project(
            session,
            project_id_for_plan(session, experiment_id),
            request.app.state.agent_adapter,
        )

    @app.post(
        "/api/v1/experiments/{experiment_id}/decision-cards:generate",
        response_model=DecisionCard,
        tags=["canonical-workflow"],
        dependencies=WRITE_DEPENDENCY,
        description=(
            "Analysis already materializes the deterministic DecisionCard; this command "
            "returns that version without invoking a model for numbers or status."
        ),
    )
    def generate_canonical_decision(experiment_id: str, session: SessionDependency) -> DecisionCard:
        return existing_decision_card(session, experiment_id)

    @app.post(
        "/api/v1/decision-cards/{decision_id}/approvals",
        response_model=ApprovalResponse,
        tags=["canonical-workflow"],
    )
    def approve_canonical_decision(
        decision_id: str,
        payload: ApprovalRequest,
        session: SessionDependency,
        idempotency_key: Annotated[str, Header(alias="Idempotency-Key")],
    ) -> ApprovalResponse:
        if payload.gate != ApprovalGate.DECISION:
            raise InputError("gate must be DECISION for this endpoint")
        payload.request_id = idempotency_key
        return approve(session, project_id_for_decision(session, decision_id), payload)

    @app.post(
        "/api/v1/decision-cards/{decision_id}/handoff-pack:generate",
        response_model=HandoffPackage,
        tags=["canonical-workflow"],
        dependencies=WRITE_DEPENDENCY,
    )
    def generate_canonical_handoff(decision_id: str, session: SessionDependency) -> HandoffPackage:
        return generate_handoff(session, project_id_for_decision(session, decision_id))

    @app.post(
        "/api/v1/projects/{project_id}/first-order-assumptions/approvals",
        response_model=ApprovalResponse,
        tags=["canonical-workflow"],
        description=(
            "Records a human decision for the first-order assumptions proposal bound "
            "to the current immutable ProductBrief version."
        ),
    )
    def approve_first_order_assumptions(
        project_id: str,
        payload: ApprovalRequest,
        session: SessionDependency,
        idempotency_key: Annotated[str, Header(alias="Idempotency-Key")],
    ) -> ApprovalResponse:
        if payload.gate != ApprovalGate.FIRST_ORDER_ASSUMPTIONS:
            raise InputError("gate must be FIRST_ORDER_ASSUMPTIONS for this endpoint")
        payload.request_id = idempotency_key
        return approve(session, project_id, payload)

    @app.post(
        "/api/v1/decision-cards/{decision_id}/pivot-revisions:generate",
        response_model=PivotRevision,
        tags=["canonical-workflow"],
        dependencies=WRITE_DEPENDENCY,
        description=(
            "Creates the next immutable, single-variable PivotRevision draft. "
            "The PIVOT DecisionCard must already be approved."
        ),
    )
    def generate_canonical_pivot_revision(
        decision_id: str, session: SessionDependency
    ) -> PivotRevision:
        return generate_pivot_revision(
            session, project_id_for_decision(session, decision_id)
        )

    @app.get(
        "/api/v1/pivot-revisions/{pivot_revision_id}",
        response_model=PivotRevision,
        tags=["canonical-workflow"],
    )
    def get_canonical_pivot_revision(
        pivot_revision_id: str, session: SessionDependency
    ) -> PivotRevision:
        return get_pivot_revision(session, pivot_revision_id)

    @app.post(
        "/api/v1/pivot-revisions/{pivot_revision_id}/approvals",
        response_model=ApprovalResponse,
        tags=["canonical-workflow"],
    )
    def approve_canonical_pivot_revision(
        pivot_revision_id: str,
        payload: ApprovalRequest,
        session: SessionDependency,
        idempotency_key: Annotated[str, Header(alias="Idempotency-Key")],
    ) -> ApprovalResponse:
        if payload.gate != ApprovalGate.PIVOT_REVISION:
            raise InputError("gate must be PIVOT_REVISION for this endpoint")
        payload.request_id = idempotency_key
        return approve(
            session,
            project_id_for_pivot_revision(session, pivot_revision_id),
            payload,
            target_id=pivot_revision_id,
        )

    @app.get(
        "/api/v1/projects/{project_id}/quality",
        response_model=QualityReport,
        tags=["analysis"],
    )
    def quality(project_id: str, session: SessionDependency) -> QualityReport:
        return _artifact_or_404(project_detail(session, project_id), "quality")  # type: ignore[return-value]

    @app.get(
        "/api/v1/projects/{project_id}/metrics",
        response_model=MetricBundle,
        tags=["analysis"],
    )
    def metrics(project_id: str, session: SessionDependency) -> MetricBundle:
        return _artifact_or_404(project_detail(session, project_id), "metrics")  # type: ignore[return-value]

    @app.get(
        "/api/v1/projects/{project_id}/evidence",
        response_model=EvidenceCard,
        tags=["analysis"],
    )
    def evidence(project_id: str, session: SessionDependency) -> EvidenceCard:
        return _artifact_or_404(project_detail(session, project_id), "evidence")  # type: ignore[return-value]

    @app.get(
        "/api/v1/projects/{project_id}/decision",
        response_model=DecisionCard,
        tags=["analysis"],
    )
    def decision(project_id: str, session: SessionDependency) -> DecisionCard:
        return _artifact_or_404(project_detail(session, project_id), "decision")  # type: ignore[return-value]

    @app.post(
        "/api/v1/projects/{project_id}/handoff",
        response_model=HandoffPackage,
        tags=["handoff"],
        dependencies=WRITE_DEPENDENCY,
    )
    def post_handoff(project_id: str, session: SessionDependency) -> HandoffPackage:
        return generate_handoff(session, project_id)

    @app.get(
        "/api/v1/projects/{project_id}/handoff",
        response_model=HandoffPackage,
        tags=["handoff"],
    )
    def get_handoff(project_id: str, session: SessionDependency) -> HandoffPackage:
        return _artifact_or_404(project_detail(session, project_id), "handoff")  # type: ignore[return-value]

    @app.get(
        "/api/v1/projects/{project_id}/audit-events",
        response_model=list[AuditEvent],
        tags=["audit"],
    )
    def get_audit(project_id: str, session: SessionDependency) -> list[AuditEvent]:
        return audit_events(session, project_id)

    @app.get(
        "/api/v1/projects/{project_id}/object-versions",
        response_model=list[ObjectVersionSummary],
        tags=["audit"],
    )
    def get_object_versions(
        project_id: str, session: SessionDependency
    ) -> list[ObjectVersionSummary]:
        return object_versions(session, project_id)

    @app.get(
        "/api/v1/projects/{project_id}/agent-runs",
        response_model=list[AgentRunSummary],
        tags=["audit"],
    )
    def get_agent_runs(project_id: str, session: SessionDependency) -> list[AgentRunSummary]:
        return agent_runs(session, project_id)

    @app.get(
        "/api/v1/projects/{project_id}/report",
        response_class=HTMLResponse,
        tags=["report"],
    )
    def report(project_id: str, session: SessionDependency) -> HTMLResponse:
        project = project_detail(session, project_id)
        events = audit_events(session, project_id)
        runs = agent_runs(session, project_id)
        return HTMLResponse(render_report(project, events, runs))

    return app


app = create_app()
