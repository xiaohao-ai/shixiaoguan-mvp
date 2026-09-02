from __future__ import annotations

import asyncio
import json
from types import SimpleNamespace

import pytest

from shixiaoguan_api.agent import (
    BRIEF_OUTPUT_SCHEMA_VERSION,
    BRIEF_PROMPT_VERSION,
    EXPLANATION_OUTPUT_SCHEMA_VERSION,
    EXPLANATION_PROMPT_VERSION,
    PLAN_OUTPUT_SCHEMA_VERSION,
    PLAN_PROMPT_VERSION,
    AgentAdapter,
    AgentExecution,
    BriefDraft,
    DecisionNarrativeDraft,
    ReplayMissError,
    configured_agent_mode,
    lookup_fixed_replay,
)
from shixiaoguan_api.analytics import calculate_metrics, validate_trial_data
from shixiaoguan_api.enums import AgentMode, DataStatus, DecisionOutcome, DemoScenarioId
from shixiaoguan_api.policy import build_evidence_card, classify_decision
from shixiaoguan_api.schemas import AgentBriefNormalization, EvidenceCard
from shixiaoguan_api.seed import SCENARIOS, make_brief, make_observations, make_plan


def _decision_fixture(
    scenario_id: DemoScenarioId,
    project_id: str = "11111111-1111-4111-8111-111111111111",
    dataset_id: str = "22222222-2222-4222-8222-222222222222",
) -> tuple[DecisionOutcome, list[str], EvidenceCard]:
    scenario = SCENARIOS[scenario_id]
    brief = make_brief(scenario)
    observations = make_observations(scenario)
    metrics = calculate_metrics(observations)
    quality = validate_trial_data(observations, brief, make_plan(scenario))
    evidence = build_evidence_card(
        project_id, DataStatus.SYNTHETIC, [dataset_id], quality, metrics, brief
    )
    outcome, reason_codes = classify_decision(quality, metrics, brief)
    return outcome, reason_codes, evidence


def test_no_key_forces_audited_fixed_recording_replay(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("MODEL_MODE", "live")
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    monkeypatch.delenv("OPENAI_MODEL", raising=False)
    adapter = AgentAdapter()

    output, execution = asyncio.run(
        adapter.normalize_brief(make_brief(SCENARIOS[DemoScenarioId.GO]))
    )

    assert configured_agent_mode() == AgentMode.OFFLINE_REPLAY
    assert adapter.model_name == "gpt-5.6-terra"
    assert adapter.reasoning_effort == "low"
    assert adapter.timeout_seconds == 25
    assert adapter.repair_retries == 1
    assert output.generated_by == "offline-replay"
    assert execution.mode == AgentMode.OFFLINE_REPLAY
    assert execution.output_schema_version == BRIEF_OUTPUT_SCHEMA_VERSION
    assert execution.recording_id == "demo-brief-standard-v1"
    assert execution.fallback_reason
    assert len(execution.input_sha256) == len(execution.output_sha256) == 64


def test_all_builtin_demo_recordings_cover_normalize_plan_and_explain(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("MODEL_MODE", "replay")
    adapter = AgentAdapter()

    for scenario_id, scenario in SCENARIOS.items():
        normalization, normalization_run = asyncio.run(
            adapter.normalize_brief(make_brief(scenario))
        )
        plan, plan_run = asyncio.run(adapter.generate_plan_text(make_brief(scenario)))
        outcome, reason_codes, evidence = _decision_fixture(scenario_id)
        narrative, explanation_run = asyncio.run(
            adapter.explain_decision(outcome, reason_codes, evidence)
        )

        assert normalization.generated_by == "offline-replay"
        assert plan.decision_question
        assert set(narrative.evidence_refs).issubset({claim.id for claim in evidence.claims})
        assert normalization_run.recording_id
        assert plan_run.recording_id
        assert plan_run.prompt_version == PLAN_PROMPT_VERSION
        assert plan_run.output_schema_version == PLAN_OUTPUT_SCHEMA_VERSION
        assert explanation_run.recording_id
        assert explanation_run.output_schema_version == EXPLANATION_OUTPUT_SCHEMA_VERSION


def test_dynamic_claim_and_dataset_ids_are_canonicalized_then_rehydrated(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("MODEL_MODE", "replay")
    adapter = AgentAdapter()
    outcome_a, reasons_a, evidence_a = _decision_fixture(
        DemoScenarioId.GO,
        project_id="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        dataset_id="bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    )
    outcome_b, reasons_b, evidence_b = _decision_fixture(
        DemoScenarioId.GO,
        project_id="cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        dataset_id="dddddddd-dddd-4ddd-8ddd-dddddddddddd",
    )

    narrative_a, execution_a = asyncio.run(
        adapter.explain_decision(outcome_a, reasons_a, evidence_a)
    )
    narrative_b, execution_b = asyncio.run(
        adapter.explain_decision(outcome_b, reasons_b, evidence_b)
    )

    assert execution_a.input_sha256 == execution_b.input_sha256
    assert execution_a.recording_id == execution_b.recording_id == "demo-explain-go-v1"
    assert narrative_a.evidence_refs != narrative_b.evidence_refs
    assert narrative_a.evidence_refs == [claim.id for claim in evidence_a.claims[:5]]
    assert narrative_b.evidence_refs == [claim.id for claim in evidence_b.claims[:5]]


def test_changed_business_input_is_a_replay_miss(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("MODEL_MODE", "replay")
    adapter = AgentAdapter()
    changed_brief = make_brief(SCENARIOS[DemoScenarioId.GO]).model_copy(
        update={"target_audience": "不在内置录制中的新人群"}
    )

    with pytest.raises(ReplayMissError):
        asyncio.run(adapter.normalize_brief(changed_brief))
    with pytest.raises(ReplayMissError):
        asyncio.run(adapter.generate_plan_text(changed_brief))

    outcome, reasons, evidence = _decision_fixture(DemoScenarioId.GO)
    changed_claim = evidence.claims[0].model_copy(
        update={"statement": f"{evidence.claims[0].statement}未录制的语义变更。"}
    )
    changed_evidence = evidence.model_copy(
        update={"claims": [changed_claim, *evidence.claims[1:]]}
    )
    with pytest.raises(ReplayMissError):
        asyncio.run(adapter.explain_decision(outcome, reasons, changed_evidence))


def test_prompt_and_output_schema_versions_are_part_of_the_replay_key() -> None:
    payload = make_brief(SCENARIOS[DemoScenarioId.GO]).model_dump(mode="json")
    output, key, recording_id = lookup_fixed_replay(
        AgentBriefNormalization,
        payload,
        BRIEF_PROMPT_VERSION,
        BRIEF_OUTPUT_SCHEMA_VERSION,
    )
    assert output.generated_by == "offline-replay"
    assert key.prompt_version == BRIEF_PROMPT_VERSION
    assert recording_id == "demo-brief-standard-v1"

    with pytest.raises(ReplayMissError) as prompt_miss:
        lookup_fixed_replay(
            AgentBriefNormalization,
            payload,
            f"{BRIEF_PROMPT_VERSION}-changed",
            BRIEF_OUTPUT_SCHEMA_VERSION,
        )
    assert prompt_miss.value.key.output_schema_version == BRIEF_OUTPUT_SCHEMA_VERSION

    with pytest.raises(ReplayMissError) as schema_miss:
        lookup_fixed_replay(
            AgentBriefNormalization,
            payload,
            BRIEF_PROMPT_VERSION,
            f"{BRIEF_OUTPUT_SCHEMA_VERSION}-changed",
        )
    assert schema_miss.value.key.prompt_version == BRIEF_PROMPT_VERSION


def test_live_failure_falls_back_only_when_a_recording_matches(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("MODEL_MODE", "live")
    monkeypatch.setenv("OPENAI_API_KEY", "test-key-not-used")
    adapter = AgentAdapter()

    async def fake_failed_live(*args: object, **kwargs: object) -> tuple[None, AgentExecution]:
        return None, AgentExecution(
            mode=AgentMode.LIVE,
            model_name="test-model",
            reasoning_effort="low",
            prompt_version=BRIEF_PROMPT_VERSION,
            output_schema_version=BRIEF_OUTPUT_SCHEMA_VERSION,
            recording_id=None,
            duration_ms=1,
            input_sha256="a" * 64,
            output_sha256="b" * 64,
            input_tokens=None,
            output_tokens=None,
            success=False,
            fallback_reason="live agent failed: TimeoutError",
        )

    monkeypatch.setattr(adapter, "_run_live", fake_failed_live)
    _, matched_execution = asyncio.run(
        adapter.normalize_brief(make_brief(SCENARIOS[DemoScenarioId.GO]))
    )
    assert matched_execution.mode == AgentMode.OFFLINE_REPLAY
    assert matched_execution.recording_id == "demo-brief-standard-v1"
    assert "fixed replay recording matched" in (matched_execution.fallback_reason or "")

    changed_brief = make_brief(SCENARIOS[DemoScenarioId.GO]).model_copy(
        update={"business_goal": "没有对应录制的新目标"}
    )
    with pytest.raises(ReplayMissError):
        asyncio.run(adapter.normalize_brief(changed_brief))


def test_live_explanation_with_ungrounded_number_falls_back_to_matching_recording(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("MODEL_MODE", "live")
    monkeypatch.setenv("OPENAI_API_KEY", "test-key-not-used")
    outcome, reason_codes, evidence = _decision_fixture(DemoScenarioId.GO)
    adapter = AgentAdapter()

    async def fake_live(
        *args: object, **kwargs: object
    ) -> tuple[DecisionNarrativeDraft, AgentExecution]:
        return (
            DecisionNarrativeDraft(
                headline="模型声称提升 99%",
                interpretation="这个数字没有出现在任何已引用证据中。",
                evidence_refs=[evidence.claims[0].id],
            ),
            AgentExecution(
                mode=AgentMode.LIVE,
                model_name="test-model",
                reasoning_effort="low",
                prompt_version=EXPLANATION_PROMPT_VERSION,
                output_schema_version=EXPLANATION_OUTPUT_SCHEMA_VERSION,
                recording_id=None,
                duration_ms=1,
                input_sha256="a" * 64,
                output_sha256="b" * 64,
                input_tokens=1,
                output_tokens=1,
                success=True,
                fallback_reason=None,
            ),
        )

    monkeypatch.setattr(adapter, "_run_live", fake_live)
    narrative, execution = asyncio.run(
        adapter.explain_decision(outcome, reason_codes, evidence)
    )

    assert narrative.generated_by == "offline-replay"
    assert execution.mode == AgentMode.OFFLINE_REPLAY
    assert execution.recording_id == "demo-explain-go-v1"
    assert execution.fallback_reason == (
        "live explanation introduced ungrounded numeric tokens; "
        "fixed replay recording matched"
    )
    assert execution.output_schema_version == EXPLANATION_OUTPUT_SCHEMA_VERSION


def test_live_explanation_has_one_call_scoped_read_only_tool(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import agents

    monkeypatch.setenv("MODEL_MODE", "live")
    monkeypatch.setenv("OPENAI_API_KEY", "test-key-not-used")
    captured_agents: list[dict[str, object]] = []
    captured_tool_outputs: list[dict[str, object]] = []

    def fake_model_settings(
        *,
        store: bool | None = None,
        reasoning: dict[str, str] | None = None,
        timeout: float | None = None,
    ) -> dict[str, object]:
        return {"store": store, "reasoning": reasoning, "timeout": timeout}

    def fake_function_tool(function: object, **kwargs: object) -> object:
        assert kwargs["name_override"] == "read_locked_decision_evidence"
        assert "Read-only" in str(kwargs["description_override"])
        return function

    def fake_agent(**kwargs: object) -> SimpleNamespace:
        captured_agents.append(kwargs)
        return SimpleNamespace(**kwargs)

    class FakeRunner:
        @staticmethod
        async def run(agent: SimpleNamespace, prompt: str) -> SimpleNamespace:
            assert "read_locked_decision_evidence" in prompt
            assert len(agent.tools) == 1
            locked_json = await agent.tools[0]()
            captured_tool_outputs.append(json.loads(locked_json))
            output = DecisionNarrativeDraft(
                headline="确定性决策解释",
                interpretation="只解释已经锁定的证据。",
                evidence_refs=[captured_tool_outputs[-1]["evidence_claims"][0]["id"]],
                limitations=captured_tool_outputs[-1]["limitations"],
            )
            return SimpleNamespace(
                final_output=output,
                context_wrapper=SimpleNamespace(
                    usage=SimpleNamespace(input_tokens=7, output_tokens=5)
                ),
            )

    monkeypatch.setattr(agents, "Agent", fake_agent)
    monkeypatch.setattr(agents, "ModelSettings", fake_model_settings)
    monkeypatch.setattr(agents, "Runner", FakeRunner)
    monkeypatch.setattr(agents, "function_tool", fake_function_tool)
    monkeypatch.setattr(agents, "set_tracing_disabled", lambda disabled: None)

    outcome, reason_codes, evidence = _decision_fixture(DemoScenarioId.GO)
    adapter = AgentAdapter()
    narrative, execution = asyncio.run(
        adapter.explain_decision(outcome, reason_codes, evidence)
    )

    assert narrative.generated_by == "live-agent"
    assert execution.mode == AgentMode.LIVE
    assert len(captured_agents) == 1
    assert captured_agents[0]["handoffs"] == []
    assert len(captured_agents[0]["tools"]) == 1  # type: ignore[arg-type]
    assert captured_tool_outputs == [
        {
            "fixed_outcome": outcome.value,
            "fixed_reason_codes": reason_codes,
            "evidence_claims": [
                claim.model_dump(mode="json") for claim in evidence.claims
            ],
            "limitations": evidence.limitations,
        }
    ]

    asyncio.run(
        adapter._run_live(
            BriefDraft,
            "测试提示",
            BRIEF_PROMPT_VERSION,
            BRIEF_OUTPUT_SCHEMA_VERSION,
            "测试指令",
            {"brief": "value"},
        )
    )
    assert captured_agents[-1]["tools"] == []
    assert captured_agents[-1]["handoffs"] == []
