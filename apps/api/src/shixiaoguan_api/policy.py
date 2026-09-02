from __future__ import annotations

from pydantic import BaseModel, ConfigDict, Field

from .enums import (
    ApprovalStatus,
    DataStatus,
    DecisionOutcome,
    EvidenceGrade,
    EvidenceKind,
    EvidenceStance,
    InferenceStrength,
    QualityStatus,
    StatementType,
)
from .formatting import format_fen
from .schemas import (
    DecisionCard,
    EvidenceCard,
    EvidenceClaim,
    MetricBundle,
    ProductBrief,
    QualityReport,
)


class DemoPolicy(BaseModel):
    """Versioned deterministic policy used only by the replayable MVP demo.

    The values are pre-registered demo thresholds, not calibrated industry norms.
    LLM output is deliberately absent from this schema and from ``classify_decision``.
    """

    model_config = ConfigDict(extra="forbid", frozen=True)

    version: str = "demo-policy-v1"
    revision: int = Field(default=1, ge=1)
    primary_metric: str = "purchase_intent_count/exposure"
    min_exposure_per_arm: int = Field(default=300, ge=1)
    min_purchase_intent_events_per_arm: int = Field(default=10, ge=1)
    expected_arm_share: float = Field(default=0.5, gt=0, lt=1)
    srm_block_p_value: float = Field(default=0.01, gt=0, lt=1)
    purchase_intent_rate_threshold: float = Field(default=0.03, ge=0, le=1)
    relative_uplift_threshold: float = Field(default=0.15, ge=0)
    gross_margin_floor_bps: int = Field(default=4000, ge=0, le=10000)
    interest_ctr_floor: float = Field(default=0.10, ge=0, le=1)
    cart_per_click_floor: float = Field(default=0.20, ge=0, le=1)
    clearly_low_intent_rate_ceiling: float = Field(default=0.01, ge=0, le=1)
    clearly_low_ctr_ceiling: float = Field(default=0.06, ge=0, le=1)
    conflicting_return_and_refund_rate: float = Field(default=0.20, ge=0, le=1)
    modifiable_supply_budget_gap_ratio: float = Field(default=0.35, ge=0, le=1)
    modifiable_lead_time_gap_days: int = Field(default=14, ge=0)
    modifiable_margin_gap_bps: int = Field(default=500, ge=0)


DEFAULT_POLICY = DemoPolicy()


def evidence_grade(quality: QualityReport, data_status: DataStatus) -> EvidenceGrade:
    if not quality.can_make_strong_decision:
        return EvidenceGrade.D
    # Synthetic evidence can demonstrate the contract, but never receives grade A.
    if data_status == DataStatus.SYNTHETIC:
        return EvidenceGrade.B
    if quality.status == QualityStatus.WARN:
        return EvidenceGrade.B
    return EvidenceGrade.A


def build_evidence_card(
    project_id: str,
    data_status: DataStatus,
    dataset_ids: list[str],
    quality: QualityReport,
    metrics: MetricBundle,
    brief: ProductBrief,
    policy: DemoPolicy = DEFAULT_POLICY,
    version: int = 1,
) -> EvidenceCard:
    grade = evidence_grade(quality, data_status)
    claims: list[EvidenceClaim] = [
        EvidenceClaim(
            id=f"evidence-quality-{project_id}-v{version}",
            kind=EvidenceKind.OBSERVED,
            statement_type=StatementType.OBSERVED,
            inference_strength=InferenceStrength.UNDETERMINED,
            evidence_grade=grade,
            stance=(
                EvidenceStance.SUPPORTS
                if quality.can_make_strong_decision
                else EvidenceStance.OPPOSES
            ),
            statement=(
                f"数据质量状态为 {quality.status.value}，共 {quality.row_count} 行、"
                f"{quality.observation_days} 个观测日。"
            ),
            source_refs=dataset_ids,
            limitations=["质量报告只能描述当前数据集是否满足预注册校验。"],
        )
    ]
    for metric in metrics.variants:
        claims.append(
            EvidenceClaim(
                id=f"evidence-metric-{project_id}-{metric.variant_id}-v{version}",
                kind=EvidenceKind.OBSERVED,
                statement_type=StatementType.OBSERVED,
                inference_strength=InferenceStrength.ASSOCIATIONAL,
                evidence_grade=grade,
                stance=(
                    EvidenceStance.SUPPORTS
                    if metric.purchase_intent_rate >= policy.purchase_intent_rate_threshold
                    else EvidenceStance.OPPOSES
                ),
                statement=(
                    f"变体 {metric.variant_id} 的曝光为 {metric.exposure}，点击率 {metric.ctr:.2%}，购买意向率 {metric.purchase_intent_rate:.2%}"
                    f"（95% Wilson 区间 {metric.purchase_intent_rate_ci_low:.2%}–{metric.purchase_intent_rate_ci_high:.2%}）。"
                ),
                metric_refs=[
                    f"{metric.id}:purchase_intent_count",
                    f"{metric.id}:exposure",
                ],
                source_refs=dataset_ids,
                counterexamples=["购买意向可能不会转化为真实订单。"],
                limitations=["单一合成渠道样本不能外推真实市场。"],
            )
        )
        if metric.order > 0:
            is_conflicting = (
                metric.return_and_refund_rate
                > policy.conflicting_return_and_refund_rate
            )
            claims.append(
                EvidenceClaim(
                    id=(
                        f"evidence-post-order-{project_id}-{metric.variant_id}-v{version}"
                    ),
                    kind=EvidenceKind.OBSERVED,
                    statement_type=StatementType.OBSERVED,
                    inference_strength=InferenceStrength.ASSOCIATIONAL,
                    evidence_grade=grade,
                    stance=(
                        EvidenceStance.OPPOSES
                        if is_conflicting
                        else EvidenceStance.NEUTRAL
                    ),
                    statement=(
                        f"变体 {metric.variant_id} 的合成后序事件为订单 {metric.order}、"
                        f"退款 {metric.refund}、退货 {metric.return_count}，"
                        f"退款与退货合计率 {metric.return_and_refund_rate:.2%}。"
                    ),
                    metric_refs=[
                        f"{metric.id}:order",
                        f"{metric.id}:refund",
                        f"{metric.id}:return_count",
                    ],
                    source_refs=dataset_ids,
                    counterexamples=["合成后序事件不是真实售后记录。"],
                    limitations=[
                        "该信号仅用于触发冲突复核，不用于估计真实退货率。"
                    ],
                )
            )
    required_cash = brief.moq * brief.estimated_cost_fen
    claims.append(
        EvidenceClaim(
            id=f"evidence-supply-{project_id}-v{version}",
            kind=EvidenceKind.OBSERVED,
            statement_type=StatementType.OBSERVED,
            inference_strength=InferenceStrength.UNDETERMINED,
            evidence_grade=grade,
            stance=(
                EvidenceStance.SUPPORTS
                if required_cash <= brief.production_budget_fen
                else EvidenceStance.OPPOSES
            ),
            statement=(
                f"MOQ 对应的估算资金占用为 {format_fen(required_cash)}，"
                f"生产预算为 {format_fen(brief.production_budget_fen)}。"
            ),
            source_refs=["product-brief"],
            limitations=["成本、MOQ 与预算均来自 Product Brief，尚需业务人员复核。"],
        )
    )
    claims.append(
        EvidenceClaim(
            id=f"evidence-lead-time-{project_id}-v{version}",
            kind=EvidenceKind.OBSERVED,
            statement_type=StatementType.OBSERVED,
            inference_strength=InferenceStrength.UNDETERMINED,
            evidence_grade=grade,
            stance=(
                EvidenceStance.SUPPORTS
                if brief.expected_lead_time_days <= brief.target_launch_days
                else EvidenceStance.OPPOSES
            ),
            statement=(
                f"预计交期 {brief.expected_lead_time_days} 天，"
                f"距目标上市窗口 {brief.target_launch_days} 天。"
            ),
            source_refs=["product-brief"],
            limitations=["交期是 Brief 中的目标值，不代表供应方承诺。"],
        )
    )
    limitations = [issue.impact for issue in quality.issues]
    limitations.extend(brief.known_risks)
    if data_status == DataStatus.SYNTHETIC:
        limitations.append("合成数据只能验证流程和规则，不能验证真实市场需求。")
    return EvidenceCard(
        id=f"evidence-card-{project_id}-v{version}",
        version=version,
        data_status=data_status,
        quality_status=quality.status,
        evidence_grade=grade,
        claims=claims,
        limitations=list(dict.fromkeys(limitations)),
        dataset_refs=dataset_ids,
        policy_version=policy.version,
    )


def _gross_margin_bps(brief: ProductBrief) -> int:
    if brief.target_price_fen <= 0:
        return 0
    numerator = (brief.target_price_fen - brief.estimated_cost_fen) * 10_000
    if numerator >= 0:
        return (numerator + brief.target_price_fen // 2) // brief.target_price_fen
    return -((-numerator + brief.target_price_fen // 2) // brief.target_price_fen)


def _weighted_ctr(metrics: MetricBundle) -> float:
    return sum(item.click for item in metrics.variants) / max(1, metrics.total_exposure)


def _cart_per_click(metrics: MetricBundle) -> float:
    total_click = sum(item.click for item in metrics.variants)
    total_cart = sum(item.add_to_cart for item in metrics.variants)
    return total_cart / max(1, total_click)


def classify_decision(
    quality: QualityReport,
    metrics: MetricBundle,
    brief: ProductBrief,
    policy: DemoPolicy = DEFAULT_POLICY,
) -> tuple[DecisionOutcome, list[str]]:
    """Apply DemoPolicy v1 without using any model-generated values or labels."""

    if not quality.can_make_strong_decision:
        blockers = [issue.code for issue in quality.issues if issue.severity.value == "BLOCK"]
        return DecisionOutcome.EVIDENCE_INSUFFICIENT, blockers or ["QUALITY_BLOCK"]
    if not metrics.variants:
        return DecisionOutcome.EVIDENCE_INSUFFICIENT, ["NO_COMPUTABLE_METRICS"]

    if any(
        item.return_and_refund_rate > policy.conflicting_return_and_refund_rate
        for item in metrics.variants
    ):
        return DecisionOutcome.EVIDENCE_INSUFFICIENT, [
            "CONFLICTING_POST_ORDER_SIGNAL",
            "HUMAN_REVIEW_REQUIRED",
        ]

    sorted_metrics = sorted(
        metrics.variants, key=lambda item: item.purchase_intent_rate, reverse=True
    )
    best = sorted_metrics[0]
    worst = sorted_metrics[-1]
    all_demand_pass = all(
        item.purchase_intent_rate >= policy.purchase_intent_rate_threshold
        for item in sorted_metrics
    )

    required_cash = brief.moq * brief.estimated_cost_fen
    supply_ok = required_cash <= brief.production_budget_fen
    lead_time_ok = brief.expected_lead_time_days <= brief.target_launch_days
    margin_bps = _gross_margin_bps(brief)
    required_margin_bps = max(policy.gross_margin_floor_bps, brief.gross_margin_floor_bps)
    margin_ok = margin_bps >= required_margin_bps

    all_intent_clearly_low = all(
        item.purchase_intent_rate <= policy.clearly_low_intent_rate_ceiling
        for item in sorted_metrics
    )
    if all_intent_clearly_low or (
        _weighted_ctr(metrics) <= policy.clearly_low_ctr_ceiling and not all_demand_pass
    ):
        # A clearly failed demand signal cannot be upgraded to PIVOT merely
        # because a second, modifiable operating constraint also failed.
        return DecisionOutcome.NO_GO, [
            "ALL_ARMS_PURCHASE_INTENT_CLEARLY_LOW",
            "DEMAND_BELOW_FLOOR",
        ]

    modifiable_failures: list[list[str]] = []
    non_modifiable_failures: list[str] = []

    if not supply_ok:
        gap_ratio = (required_cash - brief.production_budget_fen) / max(
            1, brief.production_budget_fen
        )
        if gap_ratio <= policy.modifiable_supply_budget_gap_ratio:
            modifiable_failures.append(
                ["MOQ_BUDGET_CONFLICT", "MODIFIABLE_SUPPLY_VARIABLE"]
            )
        else:
            non_modifiable_failures.extend(
                ["MOQ_BUDGET_CONFLICT", "NON_MODIFIABLE_SUPPLY_CONSTRAINT"]
            )

    if not lead_time_ok:
        lead_gap = brief.expected_lead_time_days - brief.target_launch_days
        if lead_gap <= policy.modifiable_lead_time_gap_days:
            modifiable_failures.append(
                ["LEAD_TIME_WINDOW_CONFLICT", "MODIFIABLE_LEAD_TIME_VARIABLE"]
            )
        else:
            non_modifiable_failures.extend(
                ["LEAD_TIME_WINDOW_CONFLICT", "NON_MODIFIABLE_SUPPLY_CONSTRAINT"]
            )

    if not margin_ok:
        margin_gap = required_margin_bps - margin_bps
        if margin_gap <= policy.modifiable_margin_gap_bps:
            modifiable_failures.append(
                ["MARGIN_BELOW_FLOOR", "MODIFIABLE_PRICE_OR_COST_VARIABLE"]
            )
        else:
            non_modifiable_failures.extend(
                ["MARGIN_BELOW_FLOOR", "NON_MODIFIABLE_ECONOMIC_CONSTRAINT"]
            )

    if non_modifiable_failures:
        return DecisionOutcome.NO_GO, list(dict.fromkeys(non_modifiable_failures))

    demand_failure: list[str] | None = None
    if (
        len(sorted_metrics) >= 2
        and metrics.relative_purchase_intent_uplift is not None
        and metrics.relative_purchase_intent_uplift >= policy.relative_uplift_threshold
        and best.purchase_intent_rate >= policy.purchase_intent_rate_threshold
        and worst.purchase_intent_rate < policy.purchase_intent_rate_threshold
    ):
        demand_failure = [
            "VARIANT_DIVERGENCE",
            "MODIFIABLE_DESIGN_VARIABLE",
        ]
    elif (
        _weighted_ctr(metrics) >= policy.interest_ctr_floor
        and _cart_per_click(metrics) >= policy.cart_per_click_floor
        and not all_demand_pass
    ):
        demand_failure = [
            "INTEREST_WITH_PURCHASE_FRICTION",
            "MODIFIABLE_PRICE_OR_OFFER_VARIABLE",
        ]

    if not all_demand_pass:
        if demand_failure is None:
            return DecisionOutcome.EVIDENCE_INSUFFICIENT, [
                "MIXED_OR_UNLOCATABLE_SIGNAL",
                "MORE_EVIDENCE_REQUIRED",
            ]
        modifiable_failures.append(demand_failure)

    if not modifiable_failures:
        return DecisionOutcome.GO, [
            "PURCHASE_INTENT_THRESHOLD_MET",
            "MARGIN_OK",
            "MOQ_BUDGET_OK",
            "LEAD_TIME_OK",
        ]

    if len(modifiable_failures) == 1:
        return DecisionOutcome.PIVOT, modifiable_failures[0]

    return DecisionOutcome.EVIDENCE_INSUFFICIENT, [
        "MULTIPLE_MODIFIABLE_CONSTRAINTS",
        *list(dict.fromkeys(code for failure in modifiable_failures for code in failure)),
        "ONE_VARIABLE_PIVOT_REQUIRED",
    ]


def build_decision_card(
    project_id: str,
    quality: QualityReport,
    metrics: MetricBundle,
    evidence: EvidenceCard,
    brief: ProductBrief,
    policy: DemoPolicy = DEFAULT_POLICY,
    version: int = 1,
) -> DecisionCard:
    outcome, reason_codes = classify_decision(quality, metrics, brief, policy)
    copy = {
        DecisionOutcome.GO: (
            "演示规则支持进入人工审批后的打样草案阶段。",
            ["确认候选配色与未知工艺字段", "审批决策后生成交接草案"],
        ),
        DecisionOutcome.PIVOT: (
            "当前证据支持定位一个可修改变量并在修改后复测。",
            ["按 reason code 锁定一个主要修改变量", "新建版本化复测计划并重新审批"],
        ),
        DecisionOutcome.NO_GO: (
            "在当前演示目标与约束下，不建议继续投入。",
            ["记录停止原因", "归档并保留复盘条件"],
        ),
        DecisionOutcome.EVIDENCE_INSUFFICIENT: (
            "证据或信号不足以支持 Go、Pivot 或 No-Go。",
            ["按质量报告补数或修复实验", "重新验证后再运行决策"],
        ),
    }
    one_sentence, next_actions = copy[outcome]
    supporting = [claim.id for claim in evidence.claims if claim.stance == EvidenceStance.SUPPORTS]
    opposing = [claim.id for claim in evidence.claims if claim.stance == EvidenceStance.OPPOSES]
    risks = list(evidence.limitations)
    if outcome == DecisionOutcome.PIVOT:
        risks.append("修改后必须重新审批实验计划，当前结果不是生产指令。")
    return DecisionCard(
        id=f"decision-card-{project_id}-v{version}",
        version=version,
        outcome=outcome,
        one_sentence=one_sentence,
        evidence_grade=evidence.evidence_grade,
        reason_codes=reason_codes,
        key_evidence_ids=supporting,
        opposing_evidence_ids=opposing,
        limitations=evidence.limitations,
        risks=list(dict.fromkeys(risks)),
        next_actions=next_actions,
        policy_version=policy.version,
        approval_status=ApprovalStatus.PENDING,
    )
