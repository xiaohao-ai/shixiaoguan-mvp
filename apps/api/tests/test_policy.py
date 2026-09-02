from __future__ import annotations

import pytest

from shixiaoguan_api.analytics import calculate_metrics, validate_trial_data
from shixiaoguan_api.enums import (
    DataStatus,
    DecisionOutcome,
    EvidenceGrade,
    EvidenceStance,
    InferenceStrength,
)
from shixiaoguan_api.policy import build_evidence_card, classify_decision
from shixiaoguan_api.seed import SCENARIOS, make_brief, make_observations, make_plan


@pytest.mark.parametrize("scenario", list(SCENARIOS.values()), ids=lambda item: item.id.value)
def test_all_eight_golden_scenarios(scenario: object) -> None:
    observations = make_observations(scenario)  # type: ignore[arg-type]
    brief = make_brief(scenario)  # type: ignore[arg-type]
    plan = make_plan(scenario)  # type: ignore[arg-type]
    quality = validate_trial_data(observations, brief, plan)
    metrics = calculate_metrics(observations)

    outcome, _ = classify_decision(quality, metrics, brief)

    assert outcome == scenario.expected_outcome  # type: ignore[attr-defined]


def test_hard_supply_constraint_is_no_go() -> None:
    scenario = SCENARIOS[next(iter(SCENARIOS))]
    brief = make_brief(scenario).model_copy(update={"production_budget_fen": 1_000_000})
    observations = make_observations(scenario)
    quality = validate_trial_data(observations, brief, make_plan(scenario))
    metrics = calculate_metrics(observations)

    outcome, reasons = classify_decision(quality, metrics, brief)

    assert outcome == DecisionOutcome.NO_GO
    assert "NON_MODIFIABLE_SUPPLY_CONSTRAINT" in reasons


def test_synthetic_evidence_grade_and_inference_are_capped() -> None:
    scenario = SCENARIOS[next(iter(SCENARIOS))]
    brief = make_brief(scenario)
    observations = make_observations(scenario)
    quality = validate_trial_data(observations, brief, make_plan(scenario))
    metrics = calculate_metrics(observations)
    evidence = build_evidence_card(
        "project", DataStatus.SYNTHETIC, ["dataset"], quality, metrics, brief
    )

    assert evidence.evidence_grade == EvidenceGrade.B
    assert all(claim.evidence_grade != EvidenceGrade.A for claim in evidence.claims)
    assert all(
        claim.inference_strength
        in {InferenceStrength.ASSOCIATIONAL, InferenceStrength.UNDETERMINED}
        for claim in evidence.claims
    )


def test_conflicting_signals_include_traceable_opposing_post_order_claims() -> None:
    scenario = next(
        item for item in SCENARIOS.values() if item.id.value == "CONFLICTING_SIGNALS"
    )
    brief = make_brief(scenario)
    observations = make_observations(scenario)
    quality = validate_trial_data(observations, brief, make_plan(scenario))
    metrics = calculate_metrics(observations)

    evidence = build_evidence_card(
        "project", DataStatus.SYNTHETIC, ["dataset"], quality, metrics, brief
    )
    opposing = [
        claim
        for claim in evidence.claims
        if claim.stance == EvidenceStance.OPPOSES
        and claim.id.startswith("evidence-post-order-")
    ]

    assert len(opposing) == 2
    assert all({"counterexamples", "limitations"} <= claim.model_fields_set for claim in opposing)
    assert all(any(":refund" in ref for ref in claim.metric_refs) for claim in opposing)
    assert len({metric.id for metric in metrics.variants}) == len(metrics.variants)
