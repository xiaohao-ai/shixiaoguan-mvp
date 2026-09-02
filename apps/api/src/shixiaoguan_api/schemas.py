from __future__ import annotations

from datetime import UTC, date, datetime
from typing import Any

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from .enums import (
    AgentMode,
    ApprovalDecision,
    ApprovalGate,
    ApprovalStatus,
    DataSensitivityLevel,
    DataStatus,
    DecisionOutcome,
    DemoScenarioId,
    EvidenceGrade,
    EvidenceKind,
    EvidenceStance,
    InferenceStrength,
    ProjectStatus,
    QualitySeverity,
    QualityStatus,
    StatementType,
)

SQLITE_SIGNED_INT_MAX = 2**63 - 1


def utc_now() -> datetime:
    return datetime.now(UTC)


class APIModel(BaseModel):
    model_config = ConfigDict(extra="forbid", from_attributes=True)

    @field_validator("*", mode="before")
    @classmethod
    def attach_utc_to_naive_datetimes(cls, value: Any) -> Any:
        """SQLite drops timezone metadata; persisted timestamps are defined as UTC."""

        if isinstance(value, datetime) and value.tzinfo is None:
            return value.replace(tzinfo=UTC)
        return value


class CandidateVariant(APIModel):
    id: str = Field(min_length=1, max_length=80)
    label: str = Field(min_length=1, max_length=120)
    color_name: str = Field(min_length=1, max_length=80)
    color_hex: str | None = Field(default=None, pattern=r"^#[0-9A-Fa-f]{6}$")
    material_notes: str | None = Field(default=None, max_length=500)
    image_url: str | None = Field(default=None, max_length=1000)
    target_price_fen: int = Field(gt=0, le=SQLITE_SIGNED_INT_MAX)


class FirstOrderAssumptions(APIModel):
    intent_to_order_rate: float = Field(gt=0, le=1)
    planned_reach: int = Field(gt=0, le=SQLITE_SIGNED_INT_MAX)
    packing_step: int = Field(gt=0, le=SQLITE_SIGNED_INT_MAX)
    source: str = Field(pattern=r"^(DEMO_PROPOSAL|USER_PROPOSAL)$")


class FirstOrderAssumptionsConfirmation(APIModel):
    """Effective human confirmation bound to one immutable Brief version."""

    target_id: str
    brief_version: int = Field(ge=1)
    intent_to_order_rate: float = Field(gt=0, le=1)
    planned_reach: int = Field(gt=0)
    packing_step: int = Field(gt=0)
    proposal_source: str
    actor: str
    comment: str | None = None
    confirmed_at: datetime


class ProductBrief(APIModel):
    product_name: str = Field(min_length=1, max_length=200)
    candidate_id: str = Field(min_length=1, max_length=80)
    category: str = Field(default="MEN_LIGHTWEIGHT_CASUAL", min_length=1, max_length=100)
    target_audience: str = Field(min_length=1, max_length=300)
    usage_scenario: str = Field(min_length=1, max_length=300)
    season: str = Field(default="ALL_SEASON", min_length=1, max_length=80)
    channel: str = Field(min_length=1, max_length=120)
    core_selling_points: list[str] = Field(default_factory=list, max_length=8)
    target_price_fen: int = Field(gt=0, le=SQLITE_SIGNED_INT_MAX)
    estimated_cost_fen: int = Field(gt=0, le=SQLITE_SIGNED_INT_MAX)
    gross_margin_floor_bps: int = Field(default=4000, ge=0, le=10000)
    moq: int = Field(gt=0, le=SQLITE_SIGNED_INT_MAX)
    expected_lead_time_days: int = Field(gt=0, le=365)
    target_launch_days: int = Field(default=60, gt=0, le=730)
    trial_budget_fen: int = Field(gt=0, le=SQLITE_SIGNED_INT_MAX)
    production_budget_fen: int = Field(gt=0, le=SQLITE_SIGNED_INT_MAX)
    business_goal: str = Field(min_length=1, max_length=1000)
    known_risks: list[str] = Field(default_factory=list, max_length=20)
    variants: list[CandidateVariant] = Field(min_length=2, max_length=6)
    first_order_assumptions: FirstOrderAssumptions | None = None
    data_status: DataStatus = DataStatus.SYNTHETIC

    @model_validator(mode="after")
    def validate_variant_ids(self) -> ProductBrief:
        ids = [variant.id for variant in self.variants]
        if len(ids) != len(set(ids)):
            raise ValueError("variant ids must be unique")
        return self


class ProductBriefDraft(APIModel):
    """Persistable, explicitly incomplete Brief used before the readiness gate.

    Fields are never completed by the Agent.  The service promotes a draft to
    ``BRIEF_READY`` only when the same payload validates as ``ProductBrief``.
    """

    product_name: str | None = Field(default=None, max_length=200)
    candidate_id: str | None = Field(default=None, max_length=80)
    category: str = Field(default="MEN_LIGHTWEIGHT_CASUAL", min_length=1, max_length=100)
    target_audience: str | None = Field(default=None, max_length=300)
    usage_scenario: str | None = Field(default=None, max_length=300)
    season: str = Field(default="ALL_SEASON", min_length=1, max_length=80)
    channel: str | None = Field(default=None, max_length=120)
    core_selling_points: list[str] = Field(default_factory=list, max_length=8)
    target_price_fen: int | None = Field(default=None, gt=0, le=SQLITE_SIGNED_INT_MAX)
    estimated_cost_fen: int | None = Field(default=None, gt=0, le=SQLITE_SIGNED_INT_MAX)
    gross_margin_floor_bps: int = Field(default=4000, ge=0, le=10000)
    moq: int | None = Field(default=None, gt=0, le=SQLITE_SIGNED_INT_MAX)
    expected_lead_time_days: int | None = Field(default=None, gt=0, le=365)
    target_launch_days: int = Field(default=60, gt=0, le=730)
    trial_budget_fen: int | None = Field(default=None, gt=0, le=SQLITE_SIGNED_INT_MAX)
    production_budget_fen: int | None = Field(default=None, gt=0, le=SQLITE_SIGNED_INT_MAX)
    business_goal: str | None = Field(default=None, max_length=1000)
    known_risks: list[str] = Field(default_factory=list, max_length=20)
    variants: list[CandidateVariant] = Field(default_factory=list, max_length=6)
    first_order_assumptions: FirstOrderAssumptions | None = None
    data_status: DataStatus = DataStatus.SYNTHETIC

    @model_validator(mode="after")
    def validate_variant_ids(self) -> ProductBriefDraft:
        ids = [variant.id for variant in self.variants]
        if len(ids) != len(set(ids)):
            raise ValueError("variant ids must be unique")
        return self


class ExperimentArm(APIModel):
    id: str = Field(min_length=1, max_length=80)
    label: str = Field(min_length=1, max_length=120)
    variant_id: str = Field(min_length=1, max_length=80)
    expected_share: float = Field(gt=0, le=1)


class StopRule(APIModel):
    code: str = Field(min_length=1, max_length=80)
    description: str = Field(min_length=1, max_length=500)


class ExperimentPlan(APIModel):
    id: str
    version: int = Field(default=1, ge=1)
    approval_status: ApprovalStatus = ApprovalStatus.PENDING
    decision_question: str = Field(min_length=1, max_length=1000)
    hypotheses: list[str] = Field(min_length=1, max_length=5)
    controlled_variable: str = Field(min_length=1, max_length=100)
    invariants: list[str] = Field(min_length=1, max_length=20)
    primary_metric: str = Field(default="purchase_intent_count/exposure")
    secondary_metrics: list[str] = Field(default_factory=lambda: ["ctr", "add_to_cart_rate"])
    arms: list[ExperimentArm] = Field(min_length=2, max_length=6)
    target_audience: str
    channel: str
    duration_days: int = Field(default=7, ge=1, le=60)
    min_exposure_per_arm: int = Field(default=300, ge=1)
    min_intent_per_arm: int = Field(default=10, ge=0)
    budget_cap_fen: int = Field(gt=0, le=SQLITE_SIGNED_INT_MAX)
    stop_rules: list[StopRule] = Field(min_length=1)
    quality_requirements: list[str] = Field(min_length=1)
    potential_biases: list[str] = Field(default_factory=list)
    policy_version: str = Field(default="demo-policy-v1")
    policy_snapshot: dict[str, Any] = Field(default_factory=dict)
    generated_by: str = Field(default="offline-replay")
    generated_at: datetime = Field(default_factory=utc_now)

    @model_validator(mode="after")
    def validate_arms(self) -> ExperimentPlan:
        arm_ids = [arm.id for arm in self.arms]
        variants = [arm.variant_id for arm in self.arms]
        if len(arm_ids) != len(set(arm_ids)):
            raise ValueError("arm ids must be unique")
        if len(variants) != len(set(variants)):
            raise ValueError("each variant may appear in only one demo arm")
        total_share = sum(arm.expected_share for arm in self.arms)
        if abs(total_share - 1.0) > 0.001:
            raise ValueError("arm expected shares must sum to 1")
        return self


class ProjectCreate(APIModel):
    name: str = Field(min_length=1, max_length=200)
    brief: ProductBriefDraft = Field(default_factory=ProductBriefDraft)


class ProjectUpdate(APIModel):
    name: str | None = Field(default=None, min_length=1, max_length=200)
    brief: ProductBriefDraft | None = None


class ProjectArchiveRequest(APIModel):
    actor: str = Field(min_length=1, max_length=120)
    reason: str = Field(min_length=1, max_length=1000)
    cancel_active_work: bool = False


class TrialObservation(APIModel):
    date: date
    candidate_id: str = Field(min_length=1, max_length=80)
    variant_id: str = Field(min_length=1, max_length=80)
    arm_id: str = Field(min_length=1, max_length=80)
    channel: str = Field(min_length=1, max_length=120)
    audience_segment: str = Field(min_length=1, max_length=200)
    exposure: int = Field(ge=0, le=2**63 - 1)
    click: int = Field(ge=0, le=2**63 - 1)
    favorite: int = Field(ge=0, le=2**63 - 1)
    inquiry: int = Field(ge=0, le=2**63 - 1)
    add_to_cart: int = Field(ge=0, le=2**63 - 1)
    purchase_intent: int = Field(ge=0, le=2**63 - 1)
    preorder: int = Field(default=0, ge=0, le=2**63 - 1)
    order: int = Field(default=0, ge=0, le=2**63 - 1)
    refund: int = Field(default=0, ge=0, le=2**63 - 1)
    return_count: int = Field(default=0, ge=0, le=2**63 - 1)
    price_fen: int = Field(gt=0, le=2**63 - 1)
    spend_fen: int = Field(ge=0, le=2**63 - 1)


class DatasetSummary(APIModel):
    id: str
    project_id: str
    data_status: DataStatus
    source_label: str
    authorization_note: str
    file_name: str
    sha256: str
    schema_version: str
    row_count: int = Field(ge=0)
    scenario_id: DemoScenarioId
    scenario_version: str
    fixed_seed: int
    generator_version: str
    plan_version: int = Field(ge=1)
    active: bool = True
    imported_at: datetime


class Attachment(APIModel):
    id: str
    project_id: str
    object_key: str
    original_filename: str
    mime_type: str
    size_bytes: int = Field(gt=0, le=5 * 1024 * 1024)
    sha256: str = Field(pattern=r"^[0-9a-f]{64}$")
    rights_declaration: str
    source: str
    created_at: datetime


class QualityIssue(APIModel):
    issue_id: str
    code: str
    rule_code: str
    severity: QualitySeverity
    message: str
    affected_rows: list[int] = Field(default_factory=list)
    affected_fields: list[str] = Field(default_factory=list)
    record_refs: list[str] = Field(default_factory=list)
    observed: Any | None = None
    expected: Any | None = None
    handling_status: str = Field(
        default="OPEN",
        pattern=r"^(OPEN|ACKNOWLEDGED|RESOLVED)$",
    )
    impact: str


class QualityReport(APIModel):
    status: QualityStatus
    can_make_strong_decision: bool
    row_count: int
    observation_days: int
    issues: list[QualityIssue]
    dataset_sha256: str
    rule_version: str = "quality-rules-v1"
    generated_at: datetime = Field(default_factory=utc_now)


class VariantMetric(APIModel):
    id: str = Field(min_length=1, max_length=240)
    variant_id: str
    arm_id: str
    exposure: int
    click: int
    favorite: int
    inquiry: int
    add_to_cart: int
    purchase_intent: int
    preorder: int
    order: int
    refund: int
    return_count: int
    spend_fen: int
    ctr: float
    favorite_rate: float
    inquiry_rate: float
    add_to_cart_rate: float
    purchase_intent_rate: float
    # Compatibility fields remain explicit aliases of the purchase-intent metric.
    intent_rate: float
    order_rate: float
    return_and_refund_rate: float
    purchase_intent_rate_ci_low: float
    purchase_intent_rate_ci_high: float
    intent_rate_ci_low: float
    intent_rate_ci_high: float


class MetricBundle(APIModel):
    variants: list[VariantMetric]
    total_exposure: int
    total_purchase_intent: int
    total_intent: int
    overall_purchase_intent_rate: float
    overall_intent_rate: float
    best_variant_id: str | None
    worst_variant_id: str | None
    relative_purchase_intent_uplift: float | None
    relative_intent_uplift: float | None
    metric_version: str = "metrics-v1"
    generated_at: datetime = Field(default_factory=utc_now)


class EvidenceClaim(APIModel):
    id: str
    kind: EvidenceKind
    statement_type: StatementType
    inference_strength: InferenceStrength
    evidence_grade: EvidenceGrade
    stance: EvidenceStance
    statement: str
    metric_refs: list[str] = Field(default_factory=list)
    source_refs: list[str] = Field(default_factory=list)
    counterexamples: list[str] = Field(default_factory=list)
    limitations: list[str] = Field(default_factory=list)


class EvidenceCard(APIModel):
    id: str
    version: int = Field(default=1, ge=1)
    data_status: DataStatus
    quality_status: QualityStatus
    evidence_grade: EvidenceGrade
    claims: list[EvidenceClaim]
    limitations: list[str]
    dataset_refs: list[str]
    policy_version: str
    generated_at: datetime = Field(default_factory=utc_now)


class DecisionCard(APIModel):
    id: str
    version: int = Field(default=1, ge=1)
    outcome: DecisionOutcome
    one_sentence: str
    evidence_grade: EvidenceGrade
    reason_codes: list[str]
    key_evidence_ids: list[str]
    opposing_evidence_ids: list[str] = Field(default_factory=list)
    limitations: list[str]
    risks: list[str]
    next_actions: list[str]
    policy_version: str
    agent_narrative: AgentDecisionNarrative | None = None
    approval_status: ApprovalStatus = ApprovalStatus.PENDING
    generated_at: datetime = Field(default_factory=utc_now)


class PivotRevision(APIModel):
    id: str = Field(min_length=1, max_length=120)
    decision_id: str = Field(min_length=1, max_length=120)
    target_variant_id: str = Field(min_length=1, max_length=80)
    version: int = Field(ge=1)
    approval_status: ApprovalStatus = ApprovalStatus.PENDING
    change_variable: str = Field(min_length=1, max_length=80)
    change_list: list[str] = Field(min_length=1, max_length=5)
    retest_plan: list[str] = Field(min_length=1, max_length=10)
    created_by: str = Field(min_length=1, max_length=120)
    created_at: datetime = Field(default_factory=utc_now)


class TechPackField(APIModel):
    name: str
    value: str | None = None
    status: str = Field(pattern=r"^(CONFIRMED|USER_PROVIDED|PENDING_CONFIRMATION|UNKNOWN)$")
    source_ref: str | None = None


class TechPackLite(APIModel):
    id: str
    candidate_id: str
    variant_id: str
    decision_id: str
    title: str
    fields: list[TechPackField]
    warnings: list[str]
    status: str = "DRAFT_NOT_SENT"


class SampleTask(APIModel):
    id: str
    candidate_id: str
    variant_id: str
    pivot_revision_id: str | None = None
    objective: str
    change_list: list[str] = Field(default_factory=list)
    acceptance_points: list[str]
    risks: list[str]
    status: str = "DRAFT_REQUIRES_HUMAN_APPROVAL"


class FirstOrderScenario(APIModel):
    name: str = Field(pattern=r"^(CONSERVATIVE|BASE|AGGRESSIVE)$")
    quantity_low: int = Field(ge=0)
    quantity_high: int = Field(ge=0)
    assumptions: list[str]
    constraint_notes: list[str]
    status: str = Field(
        default="READY",
        pattern=r"^(READY|CONFLICT|NOT_READY|CONDITIONAL_RETEST_REQUIRED)$",
    )

    @model_validator(mode="after")
    def validate_range(self) -> FirstOrderScenario:
        if self.quantity_low > self.quantity_high:
            raise ValueError("quantity_low cannot exceed quantity_high")
        return self


class HandoffPackage(APIModel):
    id: str
    decision_id: str
    outcome: DecisionOutcome
    pivot_revision_id: str | None = None
    techpack: TechPackLite | None = None
    sample_task: SampleTask | None = None
    first_order_scenarios: list[FirstOrderScenario] = Field(default_factory=list)
    retest_plan: list[str] = Field(default_factory=list)
    blocked_reason: str | None = None
    watermark: str | None = None
    status: str
    generated_at: datetime = Field(default_factory=utc_now)


class ArtifactBundle(APIModel):
    brief_normalization: AgentBriefNormalization | None = None
    quality: QualityReport | None = None
    metrics: MetricBundle | None = None
    evidence: EvidenceCard | None = None
    decision: DecisionCard | None = None
    pivot_revision: PivotRevision | None = None
    handoff: HandoffPackage | None = None


class ProjectDetail(APIModel):
    id: str
    name: str
    scenario_id: DemoScenarioId | None
    status: ProjectStatus
    workflow_state: ProjectStatus
    data_status: DataStatus
    data_origin: DataStatus
    data_sensitivity_level: DataSensitivityLevel
    brief_version: int = Field(ge=1)
    brief: ProductBriefDraft
    brief_missing_fields: list[str] = Field(default_factory=list)
    first_order_assumptions_confirmation: FirstOrderAssumptionsConfirmation | None = None
    experiment_plan: ExperimentPlan | None
    current_day: int
    total_days: int
    policy_version: str
    policy_revision: int = Field(ge=1)
    current_policy: dict[str, Any]
    scenario_version: str | None = None
    fixed_seed: int | None = None
    generator_version: str | None = None
    agent_mode: AgentMode
    datasets: list[DatasetSummary]
    artifacts: ArtifactBundle
    created_at: datetime
    updated_at: datetime


class ProjectListItem(APIModel):
    id: str
    name: str
    scenario_id: DemoScenarioId | None
    status: ProjectStatus
    workflow_state: ProjectStatus
    data_status: DataStatus
    data_origin: DataStatus
    data_sensitivity_level: DataSensitivityLevel
    current_day: int
    total_days: int
    expected_outcome: DecisionOutcome | None = None
    updated_at: datetime


class DemoScenarioSummary(APIModel):
    id: DemoScenarioId
    name: str
    description: str
    expected_outcome: DecisionOutcome
    total_days: int
    scenario_version: str
    fixed_seed: int
    generator_version: str


class ApprovalRequest(APIModel):
    gate: ApprovalGate
    decision: ApprovalDecision
    object_version: int = Field(ge=1)
    actor: str = Field(min_length=1, max_length=120)
    comment: str | None = Field(default=None, max_length=1000)
    request_id: str | None = Field(default=None, max_length=120)


class ApprovalResponse(APIModel):
    id: str
    project_id: str
    gate: ApprovalGate
    target_type: str | None = None
    target_id: str | None = None
    decision: ApprovalDecision
    object_version: int
    actor: str
    comment: str | None
    created_at: datetime
    project_status: ProjectStatus


class SimulationAdvanceRequest(APIModel):
    days: int = Field(default=1, ge=1, le=60)


class SimulationResponse(APIModel):
    project_id: str
    current_day: int
    total_days: int
    rows_added: int
    dataset: DatasetSummary
    project_status: ProjectStatus
    scenario_id: DemoScenarioId
    scenario_version: str
    fixed_seed: int
    generator_version: str
    plan_version: int = Field(ge=1)
    schema_version: str
    dataset_sha256: str


class SimulationRun(APIModel):
    id: str
    project_id: str
    experiment_plan_id: str
    experiment_plan_version: int = Field(ge=1)
    status: ProjectStatus
    current_day: int = Field(ge=0)
    total_days: int = Field(ge=1)
    dataset_id: str | None = None
    scenario_id: DemoScenarioId
    scenario_version: str
    fixed_seed: int
    generator_version: str
    schema_version: str
    dataset_sha256: str | None = None


class AnalysisBundle(APIModel):
    project_id: str
    project_status: ProjectStatus
    quality: QualityReport
    metrics: MetricBundle
    evidence: EvidenceCard
    decision: DecisionCard


class AuditEvent(APIModel):
    id: str
    project_id: str
    action: str
    object_type: str
    from_state: ProjectStatus | None
    to_state: ProjectStatus | None
    actor: str
    request_id: str | None
    summary: dict[str, Any]
    created_at: datetime


class ObjectVersionSummary(APIModel):
    project_id: str
    object_type: str
    object_id: str
    object_version: int = Field(ge=1)
    payload: dict[str, Any]
    sha256: str = Field(pattern=r"^[0-9a-f]{64}$")
    created_at: datetime


class AgentRunSummary(APIModel):
    id: str
    project_id: str
    mode: AgentMode
    operation: str
    model_name: str | None
    reasoning_effort: str | None
    prompt_version: str
    output_schema_version: str
    recording_id: str | None
    duration_ms: int
    input_sha256: str
    output_sha256: str
    input_tokens: int | None
    output_tokens: int | None
    tracing_disabled: bool
    api_store_disabled: bool
    success: bool
    fallback_reason: str | None
    created_at: datetime


class HealthResponse(APIModel):
    status: str
    service: str
    version: str
    agent_mode: AgentMode


class ErrorDetail(APIModel):
    detail: str


class AgentPlanText(APIModel):
    decision_question: str = Field(min_length=1, max_length=1000)
    hypotheses: list[str] = Field(min_length=1, max_length=5)
    potential_biases: list[str] = Field(default_factory=list, max_length=10)


class AgentBriefNormalization(APIModel):
    normalized_summary: str = Field(min_length=1, max_length=1500)
    decision_question: str = Field(min_length=1, max_length=1000)
    missing_questions: list[str] = Field(default_factory=list, max_length=10)
    fact_boundaries: list[str] = Field(default_factory=list, max_length=10)
    generated_by: str
    prompt_version: str


class AgentDecisionNarrative(APIModel):
    headline: str = Field(min_length=1, max_length=300)
    interpretation: str = Field(min_length=1, max_length=1500)
    evidence_refs: list[str] = Field(min_length=1, max_length=20)
    limitations: list[str] = Field(default_factory=list, max_length=10)
    generated_by: str
    prompt_version: str


DecisionCard.model_rebuild()
ArtifactBundle.model_rebuild()
ProjectDetail.model_rebuild()
