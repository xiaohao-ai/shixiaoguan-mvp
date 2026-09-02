from __future__ import annotations

from shixiaoguan_api.analytics import (
    calculate_metrics,
    trial_dataset_sha256,
    validate_trial_data,
)
from shixiaoguan_api.enums import DemoScenarioId, QualityStatus
from shixiaoguan_api.seed import (
    FIXED_SEED,
    GENERATOR_VERSION,
    SCENARIO_VERSION,
    SCENARIOS,
    make_brief,
    make_observations,
    make_plan,
)


def test_purchase_intent_is_the_explicit_primary_metric() -> None:
    scenario = SCENARIOS[DemoScenarioId.GO]
    observations = make_observations(scenario)
    metrics = calculate_metrics(observations)

    assert metrics.total_purchase_intent == sum(row.purchase_intent for row in observations)
    assert metrics.overall_purchase_intent_rate == (
        metrics.total_purchase_intent / metrics.total_exposure
    )
    assert metrics.overall_intent_rate == metrics.overall_purchase_intent_rate


def test_purchase_intent_must_not_exceed_add_to_cart() -> None:
    scenario = SCENARIOS[DemoScenarioId.GO]
    rows = make_observations(scenario)
    rows[0] = rows[0].model_copy(update={"purchase_intent": rows[0].add_to_cart + 1})

    report = validate_trial_data(rows, make_brief(scenario), make_plan(scenario))

    assert report.status == QualityStatus.BLOCK
    assert "FUNNEL_LOGIC_ERROR" in {issue.code for issue in report.issues}


def test_srm_and_single_variable_guards_block() -> None:
    invalid = SCENARIOS[DemoScenarioId.INVALID_EXPERIMENT]
    srm = validate_trial_data(make_observations(invalid), make_brief(invalid), make_plan(invalid))
    assert "SAMPLE_RATIO_MISMATCH" in {issue.code for issue in srm.issues}

    scenario = SCENARIOS[DemoScenarioId.GO]
    rows = make_observations(scenario)
    rows[0] = rows[0].model_copy(update={"price_fen": rows[0].price_fen + 100})
    changed = validate_trial_data(rows, make_brief(scenario), make_plan(scenario))
    assert "MULTIPLE_VARIABLES_CHANGED" in {issue.code for issue in changed.issues}


def test_canonical_dataset_hash_is_identical_across_ten_replays() -> None:
    scenario = SCENARIOS[DemoScenarioId.GO]
    hashes = {
        trial_dataset_sha256(
            make_observations(scenario),
            scenario_id=scenario.id.value,
            scenario_version=SCENARIO_VERSION,
            fixed_seed=FIXED_SEED,
            generator_version=GENERATOR_VERSION,
            plan_version=1,
            schema_version="trial-observation-v1",
        )
        for _ in range(10)
    }
    assert len(hashes) == 1
