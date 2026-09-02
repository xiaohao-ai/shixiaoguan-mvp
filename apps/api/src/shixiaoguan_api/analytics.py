from __future__ import annotations

import hashlib
import json
import math
from collections import defaultdict
from collections.abc import Iterable, Sequence

import pandas as pd
from scipy.stats import chisquare

from .enums import QualitySeverity, QualityStatus
from .schemas import (
    ExperimentPlan,
    MetricBundle,
    ProductBrief,
    QualityIssue,
    QualityReport,
    TrialObservation,
    VariantMetric,
)

QUALITY_RULE_VERSION = "quality-rules-v1"
METRIC_VERSION = "metrics-v1"

QUALITY_ISSUE_FIELDS: dict[str, list[str]] = {
    "EXPECTED_SPLIT_NOT_50_50": ["arms.expected_share"],
    "CANDIDATE_MISMATCH": ["candidate_id"],
    "VARIANT_MISMATCH": ["variant_id"],
    "ARM_MISMATCH": ["arm_id", "variant_id"],
    "CHANNEL_MISMATCH": ["channel"],
    "FUNNEL_LOGIC_ERROR": [
        "exposure",
        "click",
        "favorite",
        "inquiry",
        "add_to_cart",
        "purchase_intent",
        "order",
        "refund",
        "return_count",
    ],
    "DUPLICATE_GRAIN": ["date", "variant_id", "arm_id", "channel", "audience_segment"],
    "SAMPLE_TOO_SMALL": ["arm_id", "exposure"],
    "SAMPLE_RATIO_MISMATCH": ["arm_id", "exposure"],
    "BUDGET_CAP_EXCEEDED": ["spend_fen"],
    "MULTIPLE_VARIABLES_CHANGED": ["price_fen", "channel", "audience_segment"],
    "DATE_OUTSIDE_APPROVED_WINDOW": ["date"],
    "EXPERIMENT_INCOMPLETE": ["date"],
    "INTENT_EVENTS_TOO_FEW": ["arm_id", "purchase_intent"],
}


def observations_sha256(observations: Sequence[TrialObservation]) -> str:
    payload = [item.model_dump(mode="json") for item in observations]
    encoded = json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(encoded.encode("utf-8")).hexdigest()


def trial_dataset_sha256(
    observations: Sequence[TrialObservation],
    *,
    scenario_id: str,
    scenario_version: str,
    fixed_seed: int,
    generator_version: str,
    plan_version: int,
    schema_version: str,
) -> str:
    """Canonical hash covers rows and the complete replay provenance contract."""

    payload = {
        "provenance": {
            "scenario_id": scenario_id,
            "scenario_version": scenario_version,
            "fixed_seed": fixed_seed,
            "generator_version": generator_version,
            "plan_version": plan_version,
            "schema_version": schema_version,
        },
        "observations": [item.model_dump(mode="json") for item in observations],
    }
    encoded = json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(encoded.encode("utf-8")).hexdigest()


def _issue(
    code: str,
    severity: QualitySeverity,
    message: str,
    impact: str,
    rows: Iterable[int] = (),
    *,
    observed: object | None = None,
    expected: object | None = None,
) -> QualityIssue:
    row_list = list(rows)
    identity = json.dumps(
        {"code": code, "message": message, "affected_rows": row_list},
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    )
    return QualityIssue(
        issue_id=f"quality-issue-{hashlib.sha256(identity.encode('utf-8')).hexdigest()[:16]}",
        code=code,
        rule_code=code,
        severity=severity,
        message=message,
        affected_rows=row_list,
        affected_fields=QUALITY_ISSUE_FIELDS.get(code, []),
        record_refs=[f"trial-observation-row:{row}" for row in row_list],
        observed=observed,
        expected=expected,
        handling_status="OPEN",
        impact=impact,
    )


def validate_trial_data(
    observations: Sequence[TrialObservation],
    brief: ProductBrief,
    plan: ExperimentPlan,
    *,
    srm_block_p_value: float = 0.01,
) -> QualityReport:
    issues: list[QualityIssue] = []
    if len(plan.arms) != 2 or any(abs(arm.expected_share - 0.5) > 0.001 for arm in plan.arms):
        issues.append(
            _issue(
                "EXPECTED_SPLIT_NOT_50_50",
                QualitySeverity.BLOCK,
                "DemoPolicy v1 只接受两臂 50/50 预注册分流。",
                "未按预注册分流无法进入强决策。",
                observed=[arm.expected_share for arm in plan.arms],
                expected=[0.5, 0.5],
            )
        )
    if not observations:
        issues.append(
            _issue(
                "EMPTY_DATASET",
                QualitySeverity.BLOCK,
                "未找到可分析的试销观测。",
                "只能要求补充数据，不能得出强结论。",
                observed=0,
                expected="at least one daily aggregate observation",
            )
        )
        return QualityReport(
            status=QualityStatus.BLOCK,
            can_make_strong_decision=False,
            row_count=0,
            observation_days=0,
            issues=issues,
            dataset_sha256=observations_sha256(observations),
            rule_version=QUALITY_RULE_VERSION,
        )

    allowed_variants = {item.id for item in brief.variants}
    arm_by_id = {item.id: item for item in plan.arms}
    duplicate_map: dict[tuple[str, str, str, str, str], list[int]] = defaultdict(list)

    for index, row in enumerate(observations, start=1):
        key = (
            row.date.isoformat(),
            row.variant_id,
            row.arm_id,
            row.channel,
            row.audience_segment,
        )
        duplicate_map[key].append(index)
        if row.candidate_id != brief.candidate_id:
            issues.append(
                _issue(
                    "CANDIDATE_MISMATCH",
                    QualitySeverity.BLOCK,
                    f"第 {index} 行候选款与 Product Brief 不匹配。",
                    "数据无法归属到当前决策任务。",
                    [index],
                    observed=row.candidate_id,
                    expected=brief.candidate_id,
                )
            )
        if row.variant_id not in allowed_variants:
            issues.append(
                _issue(
                    "VARIANT_MISMATCH",
                    QualitySeverity.BLOCK,
                    f"第 {index} 行变体不存在于 Product Brief。",
                    "该行不能进入候选款对比。",
                    [index],
                    observed=row.variant_id,
                    expected=sorted(allowed_variants),
                )
            )
        arm = arm_by_id.get(row.arm_id)
        if arm is None or arm.variant_id != row.variant_id:
            issues.append(
                _issue(
                    "ARM_MISMATCH",
                    QualitySeverity.BLOCK,
                    f"第 {index} 行实验臂与变体映射不匹配。",
                    "实验组不可比。",
                    [index],
                    observed={"arm_id": row.arm_id, "variant_id": row.variant_id},
                    expected={
                        "registered_arm_ids": sorted(arm_by_id),
                        "registered_variant_id": arm.variant_id if arm else None,
                    },
                )
            )
        if row.channel != plan.channel:
            issues.append(
                _issue(
                    "CHANNEL_MISMATCH",
                    QualitySeverity.BLOCK,
                    f"第 {index} 行渠道与已批准计划不一致。",
                    "渠道口径不一致，不能直接比较。",
                    [index],
                    observed=row.channel,
                    expected=plan.channel,
                )
            )

        funnel_errors: list[str] = []
        if row.click > row.exposure:
            funnel_errors.append("click > exposure")
        if row.favorite > row.click:
            funnel_errors.append("favorite > click")
        if row.inquiry > row.click:
            funnel_errors.append("inquiry > click")
        if row.add_to_cart > row.click:
            funnel_errors.append("add_to_cart > click")
        if row.purchase_intent > row.add_to_cart:
            funnel_errors.append("purchase_intent > add_to_cart")
        if row.order > row.purchase_intent:
            funnel_errors.append("order > purchase_intent")
        if row.refund + row.return_count > row.order:
            funnel_errors.append("refund + return_count > order")
        if funnel_errors:
            issues.append(
                _issue(
                    "FUNNEL_LOGIC_ERROR",
                    QualitySeverity.BLOCK,
                    "第 {} 行漏斗关系异常：{}".format(index, ", ".join(funnel_errors)),
                    "核心转化指标不可复算。",
                    [index],
                    observed=funnel_errors,
                    expected="registered funnel counts must not exceed their upstream count",
                )
            )

    duplicate_rows = [
        row_index
        for row_indexes in duplicate_map.values()
        if len(row_indexes) > 1
        for row_index in row_indexes
    ]
    if duplicate_rows:
        issues.append(
            _issue(
                "DUPLICATE_GRAIN",
                QualitySeverity.BLOCK,
                f"发现 {len(duplicate_rows)} 行重复的日×变体×实验臂×渠道×人群粒度。",
                "重复聚合会放大样本与转化信号。",
                duplicate_rows,
                observed=duplicate_rows,
                expected="one row per date × variant × arm × channel × audience grain",
            )
        )

    exposure_by_arm: dict[str, int] = defaultdict(int)
    for row in observations:
        exposure_by_arm[row.arm_id] += row.exposure

    for arm in plan.arms:
        exposure = exposure_by_arm.get(arm.id, 0)
        required_exposure = plan.min_exposure_per_arm
        if exposure < required_exposure:
            issues.append(
                _issue(
                    "SAMPLE_TOO_SMALL",
                    QualitySeverity.BLOCK,
                    f"实验臂 {arm.id} 曝光 {exposure}，低于预先锁定的 {required_exposure}。",
                    "只可做描述性分析，决策必须降级为证据不足。",
                    observed={"arm_id": arm.id, "exposure": exposure},
                    expected={"minimum_exposure": required_exposure},
                )
            )

    total_exposure = sum(exposure_by_arm.values())
    if total_exposure > 0 and all(arm.id in exposure_by_arm for arm in plan.arms):
        observed = [exposure_by_arm[arm.id] for arm in plan.arms]
        expected = [total_exposure * arm.expected_share for arm in plan.arms]
        if all(value > 0 for value in expected):
            _, p_value = chisquare(f_obs=observed, f_exp=expected)
            if float(p_value) < srm_block_p_value:
                issues.append(
                    _issue(
                        "SAMPLE_RATIO_MISMATCH",
                        QualitySeverity.BLOCK,
                        f"实际分流与预设分流显著不一致（p < {srm_block_p_value:.3g}）。",
                        "实验臂可能不可比，不能输出强结论。",
                        observed={
                            "exposure_by_arm": dict(exposure_by_arm),
                            "p_value": float(p_value),
                        },
                        expected={
                            "arm_shares": [arm.expected_share for arm in plan.arms],
                            "p_value_at_least": srm_block_p_value,
                        },
                    )
                )

    total_spend = sum(row.spend_fen for row in observations)
    if total_spend > plan.budget_cap_fen:
        issues.append(
            _issue(
                "BUDGET_CAP_EXCEEDED",
                QualitySeverity.BLOCK,
                "已导入数据的累计花费超过已批准试销预算。",
                "实验越过了预先锁定的停止规则，必须人工复核。",
                observed=total_spend,
                expected={"maximum_spend_fen": plan.budget_cap_fen},
            )
        )

    if plan.controlled_variable == "COLOR":
        changed_non_color = []
        if len({row.price_fen for row in observations}) > 1:
            changed_non_color.append("price")
        if len({row.channel for row in observations}) > 1:
            changed_non_color.append("channel")
        if len({row.audience_segment for row in observations}) > 1:
            changed_non_color.append("audience_segment")
        if changed_non_color:
            issues.append(
                _issue(
                    "MULTIPLE_VARIABLES_CHANGED",
                    QualitySeverity.BLOCK,
                    "配色实验中同时变化了：{}。".format(", ".join(changed_non_color)),
                    "无法将差异归因到唯一预注册变量。",
                    observed=changed_non_color,
                    expected=["COLOR"],
                )
            )

    unique_days = len({row.date for row in observations})
    observed_dates = [row.date for row in observations]
    observed_span_days = (max(observed_dates) - min(observed_dates)).days + 1
    if observed_span_days > plan.duration_days:
        issues.append(
            _issue(
                "DATE_OUTSIDE_APPROVED_WINDOW",
                QualitySeverity.BLOCK,
                (
                    f"观测日期跨度为 {observed_span_days} 天，超出已批准的 "
                    f"{plan.duration_days} 天实验周期。"
                ),
                "数据不属于同一个已批准实验窗口，必须拒绝强决策。",
                observed=observed_span_days,
                expected={"maximum_days": plan.duration_days},
            )
        )
    if unique_days < plan.duration_days:
        issues.append(
            _issue(
                "EXPERIMENT_INCOMPLETE",
                QualitySeverity.WARN,
                f"当前仅导入 {unique_days} / {plan.duration_days} 天数据。",
                "结果仍可变化，应继续观察到预定周期。",
                observed=unique_days,
                expected=plan.duration_days,
            )
        )

    intent_by_arm: dict[str, int] = defaultdict(int)
    for row in observations:
        intent_by_arm[row.arm_id] += row.purchase_intent
    for arm in plan.arms:
        intent = intent_by_arm.get(arm.id, 0)
        required_intent = plan.min_intent_per_arm
        if intent < required_intent:
            issues.append(
                _issue(
                    "INTENT_EVENTS_TOO_FEW",
                    QualitySeverity.BLOCK,
                    f"实验臂 {arm.id} 的可复算意向事件仅 {intent}，低于预先锁定的 {required_intent}。",
                    "极少事件无法支持强决策。",
                    observed={"arm_id": arm.id, "purchase_intent": intent},
                    expected={"minimum_purchase_intent": required_intent},
                )
            )

    has_blocker = any(issue.severity == QualitySeverity.BLOCK for issue in issues)
    has_warning = any(issue.severity == QualitySeverity.WARN for issue in issues)
    if has_blocker:
        status = QualityStatus.BLOCK
    elif has_warning:
        status = QualityStatus.WARN
    else:
        status = QualityStatus.PASS
    return QualityReport(
        status=status,
        can_make_strong_decision=not has_blocker,
        row_count=len(observations),
        observation_days=unique_days,
        issues=issues,
        dataset_sha256=observations_sha256(observations),
        rule_version=QUALITY_RULE_VERSION,
    )


def _safe_rate(numerator: int, denominator: int) -> float:
    if denominator <= 0:
        return 0.0
    return numerator / denominator


def wilson_interval(successes: int, trials: int, z: float = 1.96) -> tuple[float, float]:
    if trials <= 0:
        return 0.0, 0.0
    proportion = successes / trials
    denominator = 1 + (z * z / trials)
    center = (proportion + (z * z / (2 * trials))) / denominator
    margin = (
        z
        * math.sqrt((proportion * (1 - proportion) / trials) + (z * z / (4 * trials * trials)))
        / denominator
    )
    return max(0.0, center - margin), min(1.0, center + margin)


def calculate_metrics(observations: Sequence[TrialObservation]) -> MetricBundle:
    columns = [
        "exposure",
        "click",
        "favorite",
        "inquiry",
        "add_to_cart",
        "purchase_intent",
        "preorder",
        "order",
        "refund",
        "return_count",
        "spend_fen",
    ]
    if not observations:
        return MetricBundle(
            variants=[],
            total_exposure=0,
            total_purchase_intent=0,
            total_intent=0,
            overall_purchase_intent_rate=0.0,
            overall_intent_rate=0.0,
            best_variant_id=None,
            worst_variant_id=None,
            relative_purchase_intent_uplift=None,
            relative_intent_uplift=None,
            metric_version=METRIC_VERSION,
        )

    frame = pd.DataFrame([item.model_dump(mode="json") for item in observations])
    grouped = frame.groupby(["variant_id", "arm_id"], as_index=False)[columns].sum()
    variants: list[VariantMetric] = []
    for record in grouped.to_dict(orient="records"):
        exposure = int(record["exposure"])
        click = int(record["click"])
        purchase_intent = int(record["purchase_intent"])
        preorder = int(record["preorder"])
        order = int(record["order"])
        ci_low, ci_high = wilson_interval(purchase_intent, exposure)
        variants.append(
            VariantMetric(
                id=(
                    f"metric-result-{record['variant_id']}-{record['arm_id']}-{METRIC_VERSION}"
                ),
                variant_id=str(record["variant_id"]),
                arm_id=str(record["arm_id"]),
                exposure=exposure,
                click=click,
                favorite=int(record["favorite"]),
                inquiry=int(record["inquiry"]),
                add_to_cart=int(record["add_to_cart"]),
                purchase_intent=purchase_intent,
                preorder=preorder,
                order=order,
                refund=int(record["refund"]),
                return_count=int(record["return_count"]),
                spend_fen=int(record["spend_fen"]),
                ctr=_safe_rate(click, exposure),
                favorite_rate=_safe_rate(int(record["favorite"]), click),
                inquiry_rate=_safe_rate(int(record["inquiry"]), click),
                add_to_cart_rate=_safe_rate(int(record["add_to_cart"]), click),
                purchase_intent_rate=_safe_rate(purchase_intent, exposure),
                intent_rate=_safe_rate(purchase_intent, exposure),
                order_rate=_safe_rate(order, exposure),
                return_and_refund_rate=_safe_rate(
                    int(record["refund"]) + int(record["return_count"]), order
                ),
                purchase_intent_rate_ci_low=ci_low,
                purchase_intent_rate_ci_high=ci_high,
                intent_rate_ci_low=ci_low,
                intent_rate_ci_high=ci_high,
            )
        )
    variants.sort(key=lambda item: item.purchase_intent_rate, reverse=True)
    total_exposure = sum(item.exposure for item in variants)
    total_intent = sum(item.purchase_intent for item in variants)
    best_variant_id = variants[0].variant_id if variants else None
    worst_variant_id = variants[-1].variant_id if variants else None
    relative_uplift = None
    if len(variants) >= 2 and variants[-1].purchase_intent_rate > 0:
        relative_uplift = (
            variants[0].purchase_intent_rate - variants[-1].purchase_intent_rate
        ) / variants[-1].purchase_intent_rate
    return MetricBundle(
        variants=variants,
        total_exposure=total_exposure,
        total_purchase_intent=total_intent,
        total_intent=total_intent,
        overall_purchase_intent_rate=_safe_rate(total_intent, total_exposure),
        overall_intent_rate=_safe_rate(total_intent, total_exposure),
        best_variant_id=best_variant_id,
        worst_variant_id=worst_variant_id,
        relative_purchase_intent_uplift=relative_uplift,
        relative_intent_uplift=relative_uplift,
        metric_version=METRIC_VERSION,
    )
