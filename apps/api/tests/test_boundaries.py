from __future__ import annotations

from datetime import UTC, date, datetime
from time import perf_counter

import pytest
from pydantic import ValidationError

from shixiaoguan_api.analytics import (
    calculate_metrics,
    trial_dataset_sha256,
    validate_trial_data,
    wilson_interval,
)
from shixiaoguan_api.database import ProjectRecord
from shixiaoguan_api.enums import DecisionOutcome, DemoScenarioId, QualityStatus
from shixiaoguan_api.formatting import format_fen
from shixiaoguan_api.policy import build_decision_card, build_evidence_card, classify_decision
from shixiaoguan_api.schemas import (
    ExperimentPlan,
    FirstOrderAssumptionsConfirmation,
    ProductBrief,
    TrialObservation,
)
from shixiaoguan_api.seed import (
    FIXED_SEED,
    GENERATOR_VERSION,
    SCENARIO_VERSION,
    SCENARIOS,
    make_brief,
    make_observations,
    make_plan,
)
from shixiaoguan_api.services import _go_handoff

SQLITE_SIGNED_INT_MAX = 2**63 - 1


def _row(
    *,
    arm_id: str,
    variant_id: str,
    exposure: int = 1_000,
    click: int = 200,
    favorite: int = 40,
    inquiry: int = 30,
    add_to_cart: int = 80,
    purchase_intent: int = 30,
    order: int = 0,
    refund: int = 0,
    return_count: int = 0,
    observation_date: date = date(2026, 8, 18),
) -> TrialObservation:
    return TrialObservation(
        date=observation_date,
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
        price_fen=39_900,
        spend_fen=0,
    )


def _two_rows(
    *,
    exposure_a: int = 1_000,
    exposure_b: int = 1_000,
    intent_a: int = 30,
    intent_b: int = 30,
    click_a: int = 200,
    click_b: int = 200,
    cart_a: int = 80,
    cart_b: int = 80,
    order_a: int = 0,
    order_b: int = 0,
    refund_a: int = 0,
    refund_b: int = 0,
) -> list[TrialObservation]:
    return [
        _row(
            arm_id="ARM-A",
            variant_id="COLOR-GRAY-BLUE",
            exposure=exposure_a,
            click=click_a,
            favorite=min(40, click_a),
            inquiry=min(30, click_a),
            add_to_cart=cart_a,
            purchase_intent=intent_a,
            order=order_a,
            refund=refund_a,
        ),
        _row(
            arm_id="ARM-B",
            variant_id="COLOR-IVORY",
            exposure=exposure_b,
            click=click_b,
            favorite=min(40, click_b),
            inquiry=min(30, click_b),
            add_to_cart=cart_b,
            purchase_intent=intent_b,
            order=order_b,
            refund=refund_b,
        ),
    ]


def _one_day_plan() -> ExperimentPlan:
    return make_plan(SCENARIOS[DemoScenarioId.GO]).model_copy(update={"duration_days": 1})


def _decision(
    rows: list[TrialObservation], brief: ProductBrief | None = None
) -> tuple[DecisionOutcome, list[str]]:
    actual_brief = brief or make_brief(SCENARIOS[DemoScenarioId.GO])
    quality = validate_trial_data(rows, actual_brief, _one_day_plan())
    assert quality.can_make_strong_decision, [issue.code for issue in quality.issues]
    return classify_decision(quality, calculate_metrics(rows), actual_brief)


@pytest.mark.parametrize(
    ("exposure_a", "exposure_b", "blocked"),
    [
        (539, 461, False),  # p = 0.01364, just above the 0.01 DemoPolicy boundary
        (541, 459, True),   # p = 0.00951, just below the 0.01 DemoPolicy boundary
    ],
)
def test_srm_p_value_boundary_is_strictly_below_one_percent(
    exposure_a: int, exposure_b: int, blocked: bool
) -> None:
    report = validate_trial_data(
        _two_rows(exposure_a=exposure_a, exposure_b=exposure_b),
        make_brief(SCENARIOS[DemoScenarioId.GO]),
        _one_day_plan(),
    )

    issue_codes = {issue.code for issue in report.issues}
    assert ("SAMPLE_RATIO_MISMATCH" in issue_codes) is blocked


@pytest.mark.parametrize(
    "field",
    [
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
    ],
)
def test_trial_observation_schema_rejects_negative_counts(field: str) -> None:
    payload = _row(arm_id="ARM-A", variant_id="COLOR-GRAY-BLUE").model_dump()
    payload[field] = -1

    with pytest.raises(ValidationError):
        TrialObservation.model_validate(payload)


def test_trial_observation_rejects_zero_price_invalid_date_and_extra_fields() -> None:
    payload = _row(arm_id="ARM-A", variant_id="COLOR-GRAY-BLUE").model_dump(mode="json")

    with pytest.raises(ValidationError):
        TrialObservation.model_validate({**payload, "price_fen": 0})
    with pytest.raises(ValidationError):
        TrialObservation.model_validate({**payload, "date": "2026-02-30"})
    with pytest.raises(ValidationError):
        TrialObservation.model_validate({**payload, "unregistered_metric": 1})


@pytest.mark.parametrize(
    "field",
    [
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
        "price_fen",
        "spend_fen",
    ],
)
def test_trial_observation_rejects_values_above_sqlite_signed_integer_range(
    field: str,
) -> None:
    """RED test: persistence must never receive an integer SQLite cannot store."""
    payload = _row(arm_id="ARM-A", variant_id="COLOR-GRAY-BLUE").model_dump()
    payload[field] = SQLITE_SIGNED_INT_MAX + 1

    with pytest.raises(ValidationError):
        TrialObservation.model_validate(payload)


@pytest.mark.parametrize(
    "field",
    [
        "target_price_fen",
        "estimated_cost_fen",
        "moq",
        "trial_budget_fen",
        "production_budget_fen",
    ],
)
def test_product_brief_rejects_values_above_sqlite_signed_integer_range(
    field: str,
) -> None:
    payload = make_brief(SCENARIOS[DemoScenarioId.GO]).model_dump(mode="json")
    payload[field] = SQLITE_SIGNED_INT_MAX + 1

    with pytest.raises(ValidationError):
        ProductBrief.model_validate(payload)


def test_zero_denominators_return_explicit_zero_metrics_and_block_quality() -> None:
    rows = _two_rows(
        exposure_a=0,
        exposure_b=0,
        intent_a=0,
        intent_b=0,
        click_a=0,
        click_b=0,
        cart_a=0,
        cart_b=0,
    )

    metrics = calculate_metrics(rows)
    quality = validate_trial_data(rows, make_brief(SCENARIOS[DemoScenarioId.GO]), _one_day_plan())

    assert metrics.total_exposure == 0
    assert metrics.overall_purchase_intent_rate == 0.0
    assert all(item.ctr == item.purchase_intent_rate == 0.0 for item in metrics.variants)
    assert all(item.purchase_intent_rate_ci_low == 0.0 for item in metrics.variants)
    assert wilson_interval(0, 0) == (0.0, 0.0)
    assert quality.status == QualityStatus.BLOCK
    assert {issue.code for issue in quality.issues} >= {
        "SAMPLE_TOO_SMALL",
        "INTENT_EVENTS_TOO_FEW",
    }


@pytest.mark.parametrize(
    "invalid_values",
    [
        {"exposure": 100, "click": 101},
        {"click": 50, "favorite": 51},
        {"click": 50, "inquiry": 51},
        {"click": 50, "add_to_cart": 51},
        {"add_to_cart": 15, "purchase_intent": 16},
        {"purchase_intent": 10, "order": 11},
        {"order": 5, "refund": 4, "return_count": 2},
    ],
)
def test_every_registered_funnel_upstream_violation_blocks(
    invalid_values: dict[str, int],
) -> None:
    baseline = _row(
        arm_id="ARM-A",
        variant_id="COLOR-GRAY-BLUE",
        exposure=100,
        click=50,
        favorite=20,
        inquiry=10,
        add_to_cart=15,
        purchase_intent=10,
        order=5,
        refund=1,
        return_count=1,
    )
    rows = [
        baseline.model_copy(update=invalid_values),
        baseline.model_copy(update={"arm_id": "ARM-B", "variant_id": "COLOR-IVORY"}),
    ]
    plan = _one_day_plan().model_copy(
        update={"min_exposure_per_arm": 1, "min_intent_per_arm": 0}
    )

    quality = validate_trial_data(rows, make_brief(SCENARIOS[DemoScenarioId.GO]), plan)

    assert quality.status == QualityStatus.BLOCK
    assert "FUNNEL_LOGIC_ERROR" in {issue.code for issue in quality.issues}


def test_duplicate_daily_grain_is_rejected_with_row_references() -> None:
    rows = _two_rows()
    rows.insert(1, rows[0].model_copy())

    quality = validate_trial_data(rows, make_brief(SCENARIOS[DemoScenarioId.GO]), _one_day_plan())
    duplicate = next(issue for issue in quality.issues if issue.code == "DUPLICATE_GRAIN")

    assert quality.status == QualityStatus.BLOCK
    assert duplicate.affected_rows == [1, 2]
    assert duplicate.issue_id.startswith("quality-issue-")
    assert duplicate.rule_code == duplicate.code
    assert duplicate.affected_fields == [
        "date",
        "variant_id",
        "arm_id",
        "channel",
        "audience_segment",
    ]
    assert duplicate.record_refs == [
        "trial-observation-row:1",
        "trial-observation-row:2",
    ]
    assert duplicate.handling_status == "OPEN"


def test_observation_span_beyond_approved_duration_is_blocked() -> None:
    """RED test: duration_days must bound the observed calendar span."""
    scenario = SCENARIOS[DemoScenarioId.GO]
    rows = make_observations(scenario)
    rows.extend(
        [
            rows[0].model_copy(update={"date": date(2026, 8, 25)}),
            rows[1].model_copy(update={"date": date(2026, 8, 25)}),
        ]
    )

    quality = validate_trial_data(rows, make_brief(scenario), make_plan(scenario))

    assert quality.status == QualityStatus.BLOCK
    assert "DATE_OUTSIDE_APPROVED_WINDOW" in {issue.code for issue in quality.issues}


@pytest.mark.parametrize(
    ("exposure", "expected_status", "expected_code"),
    [
        (299, QualityStatus.BLOCK, "SAMPLE_TOO_SMALL"),
        (300, QualityStatus.PASS, None),
    ],
)
def test_exposure_minimum_boundary_is_inclusive(
    exposure: int, expected_status: QualityStatus, expected_code: str | None
) -> None:
    rows = _two_rows(
        exposure_a=exposure,
        exposure_b=exposure,
        intent_a=10,
        intent_b=10,
        click_a=50,
        click_b=50,
        cart_a=20,
        cart_b=20,
    )

    quality = validate_trial_data(rows, make_brief(SCENARIOS[DemoScenarioId.GO]), _one_day_plan())
    codes = {issue.code for issue in quality.issues}

    assert quality.status == expected_status
    assert (expected_code in codes) if expected_code else ("SAMPLE_TOO_SMALL" not in codes)


@pytest.mark.parametrize(
    ("intent", "expected_status", "expected_code"),
    [
        (9, QualityStatus.BLOCK, "INTENT_EVENTS_TOO_FEW"),
        (10, QualityStatus.PASS, None),
    ],
)
def test_purchase_intent_event_minimum_boundary_is_inclusive(
    intent: int, expected_status: QualityStatus, expected_code: str | None
) -> None:
    rows = _two_rows(intent_a=intent, intent_b=intent, cart_a=20, cart_b=20)

    quality = validate_trial_data(rows, make_brief(SCENARIOS[DemoScenarioId.GO]), _one_day_plan())
    codes = {issue.code for issue in quality.issues}

    assert quality.status == expected_status
    assert (expected_code in codes) if expected_code else ("INTENT_EVENTS_TOO_FEW" not in codes)


def test_three_percent_demand_threshold_is_inclusive() -> None:
    outcome, reasons = _decision(_two_rows(intent_a=30, intent_b=30))

    assert outcome == DecisionOutcome.GO
    assert "PURCHASE_INTENT_THRESHOLD_MET" in reasons


def test_fifteen_percent_relative_uplift_threshold_is_inclusive() -> None:
    rows = _two_rows(
        exposure_a=2_300,
        exposure_b=2_300,
        intent_a=69,
        intent_b=60,
        click_a=300,
        click_b=300,
        cart_a=100,
        cart_b=100,
    )
    metrics = calculate_metrics(rows)

    outcome, reasons = _decision(rows)

    assert metrics.relative_purchase_intent_uplift == pytest.approx(0.15)
    assert outcome == DecisionOutcome.PIVOT
    assert reasons == ["VARIANT_DIVERGENCE", "MODIFIABLE_DESIGN_VARIABLE"]


def test_forty_percent_margin_supply_budget_and_lead_time_equalities_pass() -> None:
    brief = make_brief(SCENARIOS[DemoScenarioId.GO]).model_copy(
        update={
            "target_price_fen": 10_000,
            "estimated_cost_fen": 6_000,
            "moq": 1,
            "production_budget_fen": 6_000,
            "expected_lead_time_days": 60,
            "target_launch_days": 60,
        }
    )

    outcome, reasons = _decision(_two_rows(), brief)

    assert outcome == DecisionOutcome.GO
    assert {"MARGIN_OK", "MOQ_BUDGET_OK", "LEAD_TIME_OK"} <= set(reasons)


@pytest.mark.parametrize(
    ("cost_fen", "expected", "reason"),
    [
        (6_500, DecisionOutcome.PIVOT, "MODIFIABLE_PRICE_OR_COST_VARIABLE"),
        (6_501, DecisionOutcome.NO_GO, "NON_MODIFIABLE_ECONOMIC_CONSTRAINT"),
    ],
)
def test_margin_gap_modifiable_boundary_is_inclusive(
    cost_fen: int, expected: DecisionOutcome, reason: str
) -> None:
    brief = make_brief(SCENARIOS[DemoScenarioId.GO]).model_copy(
        update={
            "target_price_fen": 10_000,
            "estimated_cost_fen": cost_fen,
            "moq": 1,
            "production_budget_fen": 20_000,
        }
    )

    outcome, reasons = _decision(_two_rows(), brief)

    assert outcome == expected
    assert reason in reasons


@pytest.mark.parametrize(
    ("cost_fen", "expected", "reason"),
    [
        (13_500, DecisionOutcome.PIVOT, "MODIFIABLE_SUPPLY_VARIABLE"),
        (13_501, DecisionOutcome.NO_GO, "NON_MODIFIABLE_SUPPLY_CONSTRAINT"),
    ],
)
def test_supply_budget_gap_modifiable_boundary_is_inclusive(
    cost_fen: int, expected: DecisionOutcome, reason: str
) -> None:
    brief = make_brief(SCENARIOS[DemoScenarioId.GO]).model_copy(
        update={"estimated_cost_fen": cost_fen, "moq": 1, "production_budget_fen": 10_000}
    )

    outcome, reasons = _decision(_two_rows(), brief)

    assert outcome == expected
    assert reason in reasons


@pytest.mark.parametrize(
    ("lead_time", "expected", "reason"),
    [
        (74, DecisionOutcome.PIVOT, "MODIFIABLE_LEAD_TIME_VARIABLE"),
        (75, DecisionOutcome.NO_GO, "NON_MODIFIABLE_SUPPLY_CONSTRAINT"),
    ],
)
def test_lead_time_gap_modifiable_boundary_is_inclusive(
    lead_time: int, expected: DecisionOutcome, reason: str
) -> None:
    brief = make_brief(SCENARIOS[DemoScenarioId.GO]).model_copy(
        update={"expected_lead_time_days": lead_time, "target_launch_days": 60}
    )

    outcome, reasons = _decision(_two_rows(), brief)

    assert outcome == expected
    assert reason in reasons


def test_interest_and_cart_floor_equalities_route_to_price_pivot() -> None:
    rows = _two_rows(
        intent_a=20,
        intent_b=20,
        click_a=100,
        click_b=100,
        cart_a=20,
        cart_b=20,
    )

    outcome, reasons = _decision(rows)

    assert outcome == DecisionOutcome.PIVOT
    assert reasons == [
        "INTEREST_WITH_PURCHASE_FRICTION",
        "MODIFIABLE_PRICE_OR_OFFER_VARIABLE",
    ]


@pytest.mark.parametrize(
    "brief_updates",
    [
        {"estimated_cost_fen": 13_500, "moq": 1, "production_budget_fen": 10_000},
        {
            "target_price_fen": 10_000,
            "estimated_cost_fen": 6_500,
            "moq": 1,
            "production_budget_fen": 20_000,
        },
        {"expected_lead_time_days": 74, "target_launch_days": 60},
    ],
    ids=["modifiable-moq", "modifiable-margin", "modifiable-lead-time"],
)
def test_clearly_low_demand_cannot_be_upgraded_to_pivot(
    brief_updates: dict[str, int],
) -> None:
    brief = make_brief(SCENARIOS[DemoScenarioId.GO]).model_copy(update=brief_updates)

    outcome, reasons = _decision(
        _two_rows(
            intent_a=10,
            intent_b=10,
            click_a=50,
            click_b=50,
            cart_a=10,
            cart_b=10,
        ),
        brief,
    )

    assert outcome == DecisionOutcome.NO_GO
    assert reasons == [
        "ALL_ARMS_PURCHASE_INTENT_CLEARLY_LOW",
        "DEMAND_BELOW_FLOOR",
    ]


def test_two_modifiable_business_failures_are_not_collapsed_into_one_pivot() -> None:
    brief = make_brief(SCENARIOS[DemoScenarioId.GO]).model_copy(
        update={
            "target_price_fen": 10_000,
            "estimated_cost_fen": 6_500,
            "moq": 1,
            "production_budget_fen": 20_000,
            "expected_lead_time_days": 74,
            "target_launch_days": 60,
        }
    )

    outcome, reasons = _decision(_two_rows(), brief)

    assert outcome == DecisionOutcome.EVIDENCE_INSUFFICIENT
    assert reasons[0] == "MULTIPLE_MODIFIABLE_CONSTRAINTS"
    assert "MODIFIABLE_PRICE_OR_COST_VARIABLE" in reasons
    assert "MODIFIABLE_LEAD_TIME_VARIABLE" in reasons
    assert reasons[-1] == "ONE_VARIABLE_PIVOT_REQUIRED"


@pytest.mark.parametrize(
    ("refund", "expected"),
    [
        (4, DecisionOutcome.GO),
        (5, DecisionOutcome.EVIDENCE_INSUFFICIENT),
    ],
)
def test_conflicting_post_order_signal_uses_strictly_greater_than_twenty_percent(
    refund: int, expected: DecisionOutcome
) -> None:
    rows = _two_rows(
        intent_a=30,
        intent_b=30,
        cart_a=80,
        cart_b=80,
        order_a=20,
        order_b=20,
        refund_a=refund,
        refund_b=refund,
    )

    outcome, reasons = _decision(rows)

    assert outcome == expected
    assert ("CONFLICTING_POST_ORDER_SIGNAL" in reasons) is (
        expected == DecisionOutcome.EVIDENCE_INSUFFICIENT
    )


@pytest.mark.parametrize("scenario", list(SCENARIOS.values()), ids=lambda item: item.id.value)
def test_decision_outcome_and_reason_codes_are_stable_across_ten_runs(scenario: object) -> None:
    results: set[tuple[DecisionOutcome, tuple[str, ...]]] = set()
    for _ in range(10):
        observations = make_observations(scenario)  # type: ignore[arg-type]
        brief = make_brief(scenario)  # type: ignore[arg-type]
        plan = make_plan(scenario)  # type: ignore[arg-type]
        quality = validate_trial_data(observations, brief, plan)
        outcome, reasons = classify_decision(quality, calculate_metrics(observations), brief)
        results.add((outcome, tuple(reasons)))

    assert len(results) == 1
    outcome, _ = next(iter(results))
    assert outcome == scenario.expected_outcome  # type: ignore[attr-defined]


def test_local_deterministic_pipeline_p95_is_below_mvp_budget(
    record_property: pytest.RecordProperty,
) -> None:
    scenario = SCENARIOS[DemoScenarioId.GO]
    outputs: set[tuple[str, DecisionOutcome, tuple[str, ...]]] = set()
    elapsed_ms: list[float] = []

    for _ in range(30):
        started = perf_counter()
        observations = make_observations(scenario)
        brief = make_brief(scenario)
        plan = make_plan(scenario)
        quality = validate_trial_data(observations, brief, plan)
        metrics = calculate_metrics(observations)
        outcome, reasons = classify_decision(quality, metrics, brief)
        dataset_hash = trial_dataset_sha256(
            observations,
            scenario_id=scenario.id.value,
            scenario_version=SCENARIO_VERSION,
            fixed_seed=FIXED_SEED,
            generator_version=GENERATOR_VERSION,
            plan_version=1,
            schema_version="trial-observation-v1",
        )
        elapsed_ms.append((perf_counter() - started) * 1_000)
        outputs.add((dataset_hash, outcome, tuple(reasons)))

    p95_ms = sorted(elapsed_ms)[int(len(elapsed_ms) * 0.95) - 1]
    record_property("deterministic_pipeline_p95_ms", f"{p95_ms:.3f}")
    record_property("deterministic_pipeline_runs", len(elapsed_ms))

    assert len(outputs) == 1
    assert p95_ms > 0
    assert p95_ms < 2_000


def test_report_money_format_preserves_sqlite_integer_precision() -> None:
    assert format_fen(9_223_372_036_854_775_807) == "92233720368547758.07 元"
    assert format_fen(1) == "0.01 元"
    assert format_fen(None) == "待确认"


def test_evidence_and_techpack_preserve_max_integer_money_precision() -> None:
    scenario = SCENARIOS[DemoScenarioId.GO]
    observations = make_observations(scenario)
    original_brief = make_brief(scenario)
    plan = make_plan(scenario)
    quality = validate_trial_data(observations, original_brief, plan)
    metrics = calculate_metrics(observations)
    original_evidence = build_evidence_card(
        "money-boundary",
        original_brief.data_status,
        ["dataset-money-boundary"],
        quality,
        metrics,
        original_brief,
    )
    decision = build_decision_card(
        "money-boundary", quality, metrics, original_evidence, original_brief
    )
    max_money_brief = original_brief.model_copy(
        update={
            "target_price_fen": SQLITE_SIGNED_INT_MAX,
            "estimated_cost_fen": SQLITE_SIGNED_INT_MAX,
            "moq": 1,
            "production_budget_fen": SQLITE_SIGNED_INT_MAX,
        }
    )
    boundary_evidence = build_evidence_card(
        "money-boundary",
        max_money_brief.data_status,
        ["dataset-money-boundary"],
        quality,
        metrics,
        max_money_brief,
    )
    supply_claim = next(
        claim for claim in boundary_evidence.claims if claim.id.startswith("evidence-supply-")
    )
    expected = "92233720368547758.07 元"
    assert supply_claim.statement.count(expected) == 2

    handoff = _go_handoff(
        ProjectRecord(id="money-boundary"),
        max_money_brief,
        decision,
        metrics,
        FirstOrderAssumptionsConfirmation(
            target_id="first-order-money-boundary-v1",
            brief_version=1,
            intent_to_order_rate=0.1,
            planned_reach=1_000,
            packing_step=12,
            proposal_source="DEMO_PROPOSAL",
            actor="test",
            confirmed_at=datetime.now(UTC),
        ),
    )
    assert handoff.techpack is not None
    money_fields = {
        field.name: field.value
        for field in handoff.techpack.fields
        if field.name in {"目标零售价", "目标成本"}
    }
    assert money_fields == {"目标零售价": expected, "目标成本": expected}
