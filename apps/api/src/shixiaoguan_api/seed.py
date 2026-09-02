from __future__ import annotations

from dataclasses import dataclass
from datetime import date, timedelta

from .enums import DecisionOutcome, DemoScenarioId
from .schemas import (
    CandidateVariant,
    DemoScenarioSummary,
    ExperimentArm,
    ExperimentPlan,
    FirstOrderAssumptions,
    ProductBrief,
    StopRule,
    TrialObservation,
)

SCENARIO_VERSION = "mens-casual-demo-scenarios-v1"
FIXED_SEED = 20260903
GENERATOR_VERSION = "daily-aggregate-generator-v1"


@dataclass(frozen=True)
class VariantSimulation:
    exposure_per_day: int
    ctr: float
    favorite_per_click: float
    inquiry_per_click: float
    cart_per_click: float
    purchase_intent_per_exposure: float
    order_per_exposure: float
    refund_per_order: float = 0.0
    return_per_order: float = 0.0


@dataclass(frozen=True)
class DemoScenario:
    id: DemoScenarioId
    name: str
    description: str
    expected_outcome: DecisionOutcome
    price_fen: int
    estimated_cost_fen: int
    moq: int
    production_budget_fen: int
    variant_a: VariantSimulation
    variant_b: VariantSimulation
    total_days: int = 7


SCENARIOS: dict[DemoScenarioId, DemoScenario] = {
    DemoScenarioId.GO: DemoScenario(
        id=DemoScenarioId.GO,
        name="GO：需求、毛利与供应约束通过",
        description="两个配色都获得足够的试销意向，且 MOQ 与生产预算可行。",
        expected_outcome=DecisionOutcome.GO,
        price_fen=39900,
        estimated_cost_fen=17900,
        moq=300,
        production_budget_fen=8_000_000,
        variant_a=VariantSimulation(220, 0.14, 0.28, 0.18, 0.27, 0.032, 0.018),
        variant_b=VariantSimulation(210, 0.12, 0.25, 0.16, 0.30, 0.033, 0.015),
    ),
    DemoScenarioId.PIVOT_PRICE: DemoScenario(
        id=DemoScenarioId.PIVOT_PRICE,
        name="Pivot：价格摩擦",
        description="点击和加购信号较强，但预订/成交在当前价格下明显偏低。",
        expected_outcome=DecisionOutcome.PIVOT,
        price_fen=49900,
        estimated_cost_fen=18500,
        moq=300,
        production_budget_fen=8_000_000,
        variant_a=VariantSimulation(220, 0.16, 0.30, 0.21, 0.29, 0.012, 0.005),
        variant_b=VariantSimulation(215, 0.14, 0.27, 0.19, 0.26, 0.011, 0.005),
    ),
    DemoScenarioId.PIVOT_DESIGN: DemoScenario(
        id=DemoScenarioId.PIVOT_DESIGN,
        name="Pivot：配色分化",
        description="深灰蓝配色信号达标，米白配色明显较弱，建议保留主体并改配色复测。",
        expected_outcome=DecisionOutcome.PIVOT,
        price_fen=39900,
        estimated_cost_fen=17900,
        moq=300,
        production_budget_fen=8_000_000,
        variant_a=VariantSimulation(220, 0.14, 0.28, 0.18, 0.27, 0.032, 0.017),
        variant_b=VariantSimulation(220, 0.055, 0.12, 0.08, 0.20, 0.009, 0.003),
    ),
    DemoScenarioId.NO_GO: DemoScenario(
        id=DemoScenarioId.NO_GO,
        name="No-Go：核心信号均不达标",
        description="两个配色的点击、加购和购买意向均低于演示阈值。",
        expected_outcome=DecisionOutcome.NO_GO,
        price_fen=39900,
        estimated_cost_fen=17900,
        moq=300,
        production_budget_fen=8_000_000,
        variant_a=VariantSimulation(350, 0.04, 0.10, 0.07, 0.40, 0.005, 0.003),
        variant_b=VariantSimulation(340, 0.035, 0.09, 0.06, 0.40, 0.005, 0.003),
    ),
    DemoScenarioId.INSUFFICIENT_DATA: DemoScenario(
        id=DemoScenarioId.INSUFFICIENT_DATA,
        name="Evidence Insufficient：样本不足",
        description="漏斗表现看似积极，但每个实验臂的曝光数远低于预先锁定的最低要求。",
        expected_outcome=DecisionOutcome.EVIDENCE_INSUFFICIENT,
        price_fen=39900,
        estimated_cost_fen=17900,
        moq=300,
        production_budget_fen=8_000_000,
        variant_a=VariantSimulation(18, 0.17, 0.30, 0.20, 0.50, 0.040, 0.025),
        variant_b=VariantSimulation(20, 0.15, 0.28, 0.18, 0.50, 0.035, 0.020),
    ),
    DemoScenarioId.INVALID_EXPERIMENT: DemoScenario(
        id=DemoScenarioId.INVALID_EXPERIMENT,
        name="Evidence Insufficient：分流严重失衡",
        description="预设 50/50 分流，实际接近 90/10，不允许得出强结论。",
        expected_outcome=DecisionOutcome.EVIDENCE_INSUFFICIENT,
        price_fen=39900,
        estimated_cost_fen=17900,
        moq=300,
        production_budget_fen=8_000_000,
        variant_a=VariantSimulation(270, 0.13, 0.25, 0.16, 0.30, 0.032, 0.015),
        variant_b=VariantSimulation(25, 0.12, 0.24, 0.15, 0.40, 0.032, 0.014),
    ),
    DemoScenarioId.SUPPLY_CONSTRAINT: DemoScenario(
        id=DemoScenarioId.SUPPLY_CONSTRAINT,
        name="Pivot：供应约束冲突",
        description="试销需求信号通过，但 MOQ 对应的资金占用超过生产预算。",
        expected_outcome=DecisionOutcome.PIVOT,
        price_fen=39900,
        estimated_cost_fen=19000,
        moq=400,
        production_budget_fen=6_000_000,
        variant_a=VariantSimulation(220, 0.14, 0.28, 0.18, 0.27, 0.032, 0.018),
        variant_b=VariantSimulation(210, 0.12, 0.25, 0.16, 0.30, 0.033, 0.015),
    ),
    DemoScenarioId.CONFLICTING_SIGNALS: DemoScenario(
        id=DemoScenarioId.CONFLICTING_SIGNALS,
        name="Evidence Insufficient：高兴趣与高退款风险冲突",
        description="点击和购买意向较强，但后续退款/退货信号过高，要求人工复核。",
        expected_outcome=DecisionOutcome.EVIDENCE_INSUFFICIENT,
        price_fen=39900,
        estimated_cost_fen=17900,
        moq=300,
        production_budget_fen=8_000_000,
        variant_a=VariantSimulation(220, 0.15, 0.29, 0.20, 0.28, 0.032, 0.017, 0.45, 0.25),
        variant_b=VariantSimulation(215, 0.13, 0.26, 0.18, 0.25, 0.031, 0.015, 0.40, 0.25),
    ),
}


def scenario_summaries() -> list[DemoScenarioSummary]:
    return [
        DemoScenarioSummary(
            id=item.id,
            name=item.name,
            description=item.description,
            expected_outcome=item.expected_outcome,
            total_days=item.total_days,
            scenario_version=SCENARIO_VERSION,
            fixed_seed=FIXED_SEED,
            generator_version=GENERATOR_VERSION,
        )
        for item in SCENARIOS.values()
    ]


def get_scenario(scenario_id: DemoScenarioId) -> DemoScenario:
    return SCENARIOS[scenario_id]


def make_brief(scenario: DemoScenario) -> ProductBrief:
    return ProductBrief(
        product_name="轻量通勤休闲男鞋",
        candidate_id="CASUAL-001",
        category="MEN_LIGHTWEIGHT_CASUAL",
        target_audience="25–40 岁城市通勤男性",
        usage_scenario="通勤、日常步行与轻商务休闲",
        season="SPRING_AUTUMN",
        channel="AUTHORIZED_PRIVATE_DOMAIN_DEMO",
        core_selling_points=["轻量", "通勤易搭", "步行缓震"],
        target_price_fen=scenario.price_fen,
        estimated_cost_fen=scenario.estimated_cost_fen,
        gross_margin_floor_bps=4000,
        moq=scenario.moq,
        expected_lead_time_days=30,
        target_launch_days=60,
        trial_budget_fen=300_000,
        production_budget_fen=scenario.production_budget_fen,
        business_goal="在打样和备料前，判断主体鞋型及配色是否值得继续。",
        known_risks=["数据为合成演示", "单渠道信号不可直接外推"],
        first_order_assumptions=FirstOrderAssumptions(
            intent_to_order_rate=0.25,
            planned_reach=160_000,
            packing_step=12,
            source="DEMO_PROPOSAL",
        ),
        variants=[
            CandidateVariant(
                id="COLOR-GRAY-BLUE",
                label="配色 A",
                color_name="深灰蓝",
                color_hex="#24364B",
                material_notes=None,
                target_price_fen=scenario.price_fen,
            ),
            CandidateVariant(
                id="COLOR-IVORY",
                label="配色 B",
                color_name="米白",
                color_hex="#F2E9D8",
                material_notes=None,
                target_price_fen=scenario.price_fen,
            ),
        ],
    )


def make_plan(
    scenario: DemoScenario,
    generated_by: str = "offline-replay",
    project_id: str | None = None,
) -> ExperimentPlan:
    return ExperimentPlan(
        id=(
            f"plan-{project_id}-v1"
            if project_id is not None
            else f"plan-{scenario.id.value.lower()}-fixture-v1"
        ),
        decision_question="在其他条件不变时，哪个配色获得更可信的购买意向，是否达到进入打样的演示门槛？",
        hypotheses=[
            "两个配色的购买意向率存在可观测差异。",
            "目标价格下的兴趣信号能向加购和预订传递。",
            "MOQ、毛利底线与生产预算不构成硬冲突。",
        ],
        controlled_variable="COLOR",
        invariants=["鞋型", "价格", "素材版式", "人群", "渠道", "投放时段"],
        arms=[
            ExperimentArm(
                id="ARM-A",
                label="深灰蓝配色",
                variant_id="COLOR-GRAY-BLUE",
                expected_share=0.5,
            ),
            ExperimentArm(
                id="ARM-B", label="米白配色", variant_id="COLOR-IVORY", expected_share=0.5
            ),
        ],
        target_audience="25–40 岁城市通勤男性",
        channel="AUTHORIZED_PRIVATE_DOMAIN_DEMO",
        duration_days=scenario.total_days,
        min_exposure_per_arm=300,
        min_intent_per_arm=10,
        budget_cap_fen=300_000,
        stop_rules=[
            StopRule(code="BUDGET_CAP", description="累计消耗不得超过已批准试销预算。"),
            StopRule(code="QUALITY_BLOCK", description="漏斗异常或分流严重失衡时停止强结论。"),
        ],
        quality_requirements=[
            "每臂曝光不少于 300",
            "每臂可复算意向事件不少于 10",
            "点击不高于曝光",
            "每行符合预先声明的聚合口径",
            "实际分流不得严重偏离 50/50",
        ],
        potential_biases=["合成数据仅验证流程", "单一渠道不代表整体市场"],
        generated_by=generated_by,
    )


def _bounded_count(base: int, rate: float, upper: int) -> int:
    return max(0, min(upper, round(base * rate)))


def _daily_row(
    scenario: DemoScenario,
    sim: VariantSimulation,
    day_index: int,
    variant_id: str,
    arm_id: str,
) -> TrialObservation:
    factors = [0.94, 1.02, 0.98, 1.06, 1.00, 0.96, 1.04]
    exposure = max(1, round(sim.exposure_per_day * factors[day_index % len(factors)]))
    click = _bounded_count(exposure, sim.ctr, exposure)
    favorite = _bounded_count(click, sim.favorite_per_click, click)
    inquiry = _bounded_count(click, sim.inquiry_per_click, click)
    add_to_cart = _bounded_count(click, sim.cart_per_click, click)
    purchase_intent = _bounded_count(exposure, sim.purchase_intent_per_exposure, add_to_cart)
    order = _bounded_count(exposure, sim.order_per_exposure, purchase_intent)
    refund = _bounded_count(order, sim.refund_per_order, order)
    return_count = _bounded_count(order, sim.return_per_order, max(0, order - refund))
    spend_fen = round(exposure * 50)
    return TrialObservation(
        date=date(2026, 8, 18) + timedelta(days=day_index),
        candidate_id="CASUAL-001",
        variant_id=variant_id,
        arm_id=arm_id,
        channel="AUTHORIZED_PRIVATE_DOMAIN_DEMO",
        audience_segment="URBAN_COMMUTER_MEN_25_40",
        exposure=exposure,
        click=click,
        favorite=favorite,
        inquiry=inquiry,
        add_to_cart=add_to_cart,
        purchase_intent=purchase_intent,
        preorder=0,
        order=order,
        refund=refund,
        return_count=return_count,
        price_fen=scenario.price_fen,
        spend_fen=spend_fen,
    )


def make_observations(scenario: DemoScenario) -> list[TrialObservation]:
    rows: list[TrialObservation] = []
    for day_index in range(scenario.total_days):
        rows.append(
            _daily_row(scenario, scenario.variant_a, day_index, "COLOR-GRAY-BLUE", "ARM-A")
        )
        rows.append(_daily_row(scenario, scenario.variant_b, day_index, "COLOR-IVORY", "ARM-B"))
    return rows
