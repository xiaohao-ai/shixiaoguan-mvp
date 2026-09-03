import type {
  AgentRun,
  ApprovalRequest,
  AuditEvent,
  DecisionCard,
  EvidenceCard,
  HandoffBundle,
  JsonValue,
  ObjectVersion,
  PivotRevision,
  ProjectDetail,
  TrialObservation,
} from "@/lib/types";
import {
  getStaticScenario,
  makeStaticBrief,
  makeStaticMetrics,
  makeStaticObservations,
  makeStaticPlan,
  makeStaticQuality,
  outcomeCopy,
  STATIC_PREVIEW_FIXED_SEED,
  STATIC_PREVIEW_GENERATOR_VERSION,
  STATIC_PREVIEW_POLICY,
  STATIC_PREVIEW_PROJECT_ID,
  STATIC_PREVIEW_SCENARIOS,
  STATIC_PREVIEW_SCENARIO_VERSION,
  STATIC_PREVIEW_TIMESTAMP,
  type StaticScenarioFixture,
} from "@/lib/static-preview-fixtures";

const STORAGE_KEY = "shixiaoguan.github-pages-preview.v1";
const STORE_VERSION = 1;

interface StaticPreviewState {
  version: number;
  scenarioId: string;
  project: ProjectDetail;
  auditEvents: AuditEvent[];
  agentRuns: AgentRun[];
  objectVersions: ObjectVersion[];
}

let memoryState: StaticPreviewState | undefined;

export class StaticPreviewRequestError extends Error {
  readonly status: number;
  readonly detail: string;

  constructor(status: number, detail: string) {
    super(detail);
    this.name = "StaticPreviewRequestError";
    this.status = status;
    this.detail = detail;
  }
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function browserStorage(): Storage | undefined {
  try {
    return typeof window === "undefined" ? undefined : window.localStorage;
  } catch {
    return undefined;
  }
}

function loadState(): StaticPreviewState | undefined {
  const storage = browserStorage();
  if (storage) {
    try {
      const raw = storage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as StaticPreviewState;
        if (parsed.version === STORE_VERSION && parsed.project?.id === STATIC_PREVIEW_PROJECT_ID) {
          memoryState = parsed;
          return parsed;
        }
      }
    } catch {
      try {
        storage.removeItem(STORAGE_KEY);
      } catch {
        // Storage can be entirely unavailable in hardened privacy modes.
      }
    }
  }
  return memoryState;
}

function saveState(state: StaticPreviewState): void {
  memoryState = state;
  const storage = browserStorage();
  if (!storage) return;
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // A storage quota/privacy failure keeps the current tab's in-memory demo usable.
  }
}

export function resetStaticPreviewStore(): void {
  memoryState = undefined;
  try {
    browserStorage()?.removeItem(STORAGE_KEY);
  } catch {
    // The in-memory store is already cleared; persistent storage is best-effort.
  }
}

async function sha256(value: unknown): Promise<string> {
  if (!globalThis.crypto?.subtle) {
    throw new StaticPreviewRequestError(500, "当前浏览器不支持 SHA-256，无法启动可追溯静态演示。");
  }
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function projectArtifacts(project: ProjectDetail): NonNullable<ProjectDetail["artifacts"]> {
  project.artifacts ??= {};
  return project.artifacts;
}

function setWorkflow(project: ProjectDetail, workflowState: string): void {
  project.workflow_state = workflowState;
  project.status = workflowState;
  project.state = workflowState;
  project.updated_at = new Date().toISOString();
}

function addAudit(
  state: StaticPreviewState,
  action: string,
  fromState: string | undefined,
  toState: string | undefined,
  actor = "STATIC_PREVIEW_TOOL",
  summary: Record<string, JsonValue> = {},
): void {
  const sequence = state.auditEvents.length + 1;
  state.auditEvents.push({
    id: `static-audit-${String(sequence).padStart(3, "0")}`,
    action,
    event_type: action,
    actor,
    actor_type: actor.includes("AGENT") ? "AGENT" : actor.includes("HUMAN") ? "HUMAN" : "TOOL",
    from_state: fromState,
    to_state: toState,
    summary: { ...summary, runtime: "BROWSER_STATIC_PREVIEW" },
    created_at: new Date(Date.parse(STATIC_PREVIEW_TIMESTAMP) + sequence * 1_000).toISOString(),
  });
}

async function addObjectVersion(
  state: StaticPreviewState,
  objectType: string,
  objectId: string,
  objectVersion: number,
  payload: unknown,
): Promise<void> {
  const canonicalPayload = clone(payload) as Record<string, JsonValue>;
  state.objectVersions.push({
    project_id: STATIC_PREVIEW_PROJECT_ID,
    object_type: objectType,
    object_id: objectId,
    object_version: objectVersion,
    payload: canonicalPayload,
    sha256: await sha256(canonicalPayload),
    created_at: new Date(Date.parse(STATIC_PREVIEW_TIMESTAMP) + (state.objectVersions.length + 1) * 1_000).toISOString(),
  });
}

async function makeAgentRun(
  state: StaticPreviewState,
  operation: string,
  input: unknown,
  output: unknown,
): Promise<AgentRun> {
  return {
    id: `static-agent-run-${state.agentRuns.length + 1}`,
    project_id: STATIC_PREVIEW_PROJECT_ID,
    mode: "OFFLINE_REPLAY",
    operation,
    model_name: null,
    reasoning_effort: null,
    prompt_version: operation === "EXPLAIN_DECISION" ? "decision-explanation-v1" : "experiment-plan-v1",
    output_schema_version: operation === "EXPLAIN_DECISION" ? "agent-decision-narrative-v1" : "experiment-plan-v1",
    recording_id: `browser-static-${operation.toLowerCase()}-v1`,
    duration_ms: 0,
    input_sha256: await sha256(input),
    output_sha256: await sha256(output),
    input_tokens: null,
    output_tokens: null,
    tracing_disabled: true,
    api_store_disabled: true,
    success: true,
    fallback_reason: "GitHub Pages 静态预览强制使用浏览器内固定录制；未配置任何模型 Key。",
    created_at: new Date(Date.parse(STATIC_PREVIEW_TIMESTAMP) + (state.agentRuns.length + 1) * 1_000).toISOString(),
  };
}

async function createScenarioState(scenario: StaticScenarioFixture): Promise<StaticPreviewState> {
  const brief = makeStaticBrief(scenario);
  const plan = makeStaticPlan(scenario);
  const project: ProjectDetail = {
    id: STATIC_PREVIEW_PROJECT_ID,
    name: scenario.name,
    scenario_id: scenario.id,
    scenario_name: scenario.name,
    status: "PLAN_PROPOSED",
    workflow_state: "PLAN_PROPOSED",
    state: "PLAN_PROPOSED",
    data_status: "SYNTHETIC",
    data_origin: "SYNTHETIC",
    data_sensitivity_level: "SYNTHETIC_ONLY",
    agent_mode: "OFFLINE_REPLAY",
    current_day: 0,
    total_days: scenario.total_days,
    brief_version: 1,
    brief_missing_fields: [],
    brief,
    product_brief: brief,
    experiment_plan: plan,
    policy_version: STATIC_PREVIEW_POLICY.version,
    policy_revision: STATIC_PREVIEW_POLICY.revision,
    current_policy: clone(STATIC_PREVIEW_POLICY),
    scenario_version: STATIC_PREVIEW_SCENARIO_VERSION,
    fixed_seed: STATIC_PREVIEW_FIXED_SEED,
    generator_version: STATIC_PREVIEW_GENERATOR_VERSION,
    datasets: [],
    artifacts: {},
    created_at: STATIC_PREVIEW_TIMESTAMP,
    updated_at: STATIC_PREVIEW_TIMESTAMP,
  };
  const state: StaticPreviewState = {
    version: STORE_VERSION,
    scenarioId: scenario.id,
    project,
    auditEvents: [],
    agentRuns: [],
    objectVersions: [],
  };
  addAudit(state, "STATIC_PREVIEW_PROJECT_CREATED", undefined, "PLAN_PROPOSED", "STATIC_PREVIEW_TOOL", {
    scenario_id: scenario.id,
    data_origin: "SYNTHETIC",
    fixed_seed: STATIC_PREVIEW_FIXED_SEED,
  });
  await addObjectVersion(state, "ProductBrief", String(brief.id), 1, brief);
  await addObjectVersion(state, "ExperimentPlan", String(plan.id), 1, plan);
  state.agentRuns.push(await makeAgentRun(state, "GENERATE_EXPERIMENT_PLAN", brief, plan));
  addAudit(state, "AGENT_REPLAY_COMPLETED", "PLAN_PROPOSED", "PLAN_PROPOSED", "STATIC_PREVIEW_AGENT", {
    mode: "OFFLINE_REPLAY",
  });
  return state;
}

function requireState(projectId?: string): StaticPreviewState {
  const state = loadState();
  if (!state || (projectId && projectId !== STATIC_PREVIEW_PROJECT_ID)) {
    throw new StaticPreviewRequestError(404, "静态预览项目不存在；请从场景库重新启动合成演示。");
  }
  return state;
}

function assertNotArchived(state: StaticPreviewState): void {
  if (state.project.workflow_state === "ARCHIVED") {
    throw new StaticPreviewRequestError(409, "项目已归档，浏览器静态预览只保留读取。");
  }
}

function assertWorkflow(state: StaticPreviewState, allowed: string[], action: string): void {
  const current = state.project.workflow_state ?? "UNKNOWN";
  if (!allowed.includes(current)) {
    throw new StaticPreviewRequestError(409, `${action}不允许在 ${current} 状态执行。`);
  }
}

function invalidateDownstream(state: StaticPreviewState): void {
  state.project.current_day = 0;
  state.project.first_order_assumptions_confirmation = null;
  state.project.quality = undefined;
  state.project.quality_report = undefined;
  state.project.metrics = undefined;
  state.project.evidence = undefined;
  state.project.evidence_card = undefined;
  state.project.decision = undefined;
  state.project.decision_card = undefined;
  state.project.pivot_revision = undefined;
  state.project.handoff = undefined;
  state.project.artifacts = {};
}

function scenarioOf(state: StaticPreviewState): StaticScenarioFixture {
  const scenario = getStaticScenario(state.scenarioId);
  if (!scenario) throw new StaticPreviewRequestError(409, "当前草稿未绑定可回放的合成场景。");
  return scenario;
}

function parseBody(init: RequestInit): Record<string, unknown> {
  if (typeof init.body !== "string" || !init.body) return {};
  try {
    return JSON.parse(init.body) as Record<string, unknown>;
  } catch {
    throw new StaticPreviewRequestError(422, "请求体不是有效 JSON。");
  }
}

function approvalStatus(decision: string): string {
  if (decision === "APPROVE") return "APPROVED";
  if (decision === "REJECT") return "REJECTED";
  if (decision === "REQUEST_MORE_DATA") return "MORE_DATA_REQUESTED";
  return "CHANGES_REQUESTED";
}

function projectDecision(state: StaticPreviewState): DecisionCard | undefined {
  return projectArtifacts(state.project).decision;
}

function visibleObservations(state: StaticPreviewState): TrialObservation[] {
  const allRows = makeStaticObservations(scenarioOf(state));
  const visibleDates = new Set(
    Array.from({ length: state.project.current_day ?? 0 }, (_, index) =>
      new Date(Date.UTC(2026, 7, 18 + index)).toISOString().slice(0, 10),
    ),
  );
  return allRows.filter((row) => visibleDates.has(row.date));
}

async function normalizeBrief(state: StaticPreviewState): Promise<ProjectDetail> {
  assertNotArchived(state);
  assertWorkflow(state, ["BRIEF_READY"], "Brief 归一化");
  const brief = state.project.brief ?? {};
  const normalization = {
    normalized_summary: "男士轻量通勤休闲鞋，仅比较深灰蓝与米白两个配色。",
    decision_question: "在其他条件不变时，哪个配色获得更可信的购买意向？",
    missing_questions: [],
    fact_boundaries: ["数据为浏览器内合成回放", "不代表真实市场需求"],
    generated_by: "browser-static-replay",
    prompt_version: "brief-normalization-v1",
  };
  projectArtifacts(state.project).brief_normalization = normalization;
  state.agentRuns.push(await makeAgentRun(state, "NORMALIZE_BRIEF", brief, normalization));
  addAudit(state, "AGENT_REPLAY_COMPLETED", state.project.workflow_state, state.project.workflow_state, "STATIC_PREVIEW_AGENT", {
    operation: "NORMALIZE_BRIEF",
  });
  saveState(state);
  return clone(state.project);
}

async function generatePlan(state: StaticPreviewState): Promise<ProjectDetail> {
  assertNotArchived(state);
  assertWorkflow(state, ["BRIEF_READY"], "生成实验计划");
  const scenario = scenarioOf(state);
  const version = (state.project.experiment_plan?.version ?? 0) + 1;
  const plan = makeStaticPlan(scenario, version);
  const previousState = state.project.workflow_state;
  state.project.experiment_plan = plan;
  setWorkflow(state.project, "PLAN_PROPOSED");
  state.agentRuns.push(await makeAgentRun(state, "GENERATE_EXPERIMENT_PLAN", state.project.brief, plan));
  addAudit(state, "EXPERIMENT_PLAN_GENERATED", previousState, "PLAN_PROPOSED", "STATIC_PREVIEW_AGENT", {
    plan_id: String(plan.id),
    plan_version: version,
  });
  await addObjectVersion(state, "ExperimentPlan", String(plan.id), version, plan);
  saveState(state);
  return clone(state.project);
}

function submitProjectApproval(state: StaticPreviewState, body: ApprovalRequest): Record<string, unknown> {
  assertNotArchived(state);
  const previousState = state.project.workflow_state;
  const status = approvalStatus(body.decision);
  let targetId = "";
  if (body.gate === "EXPERIMENT_PLAN") {
    assertWorkflow(state, ["PLAN_PROPOSED"], "实验计划审批");
    const plan = state.project.experiment_plan;
    if (!plan?.id || plan.version !== body.object_version) throw new StaticPreviewRequestError(409, "实验计划审批版本不匹配。");
    plan.approval_status = status;
    plan.status = status;
    targetId = String(plan.id);
    setWorkflow(state.project, body.decision === "APPROVE" ? "SIMULATION_READY" : "BRIEF_READY");
  } else if (body.gate === "DECISION") {
    assertWorkflow(state, ["DECISION_PROPOSED"], "决策卡审批");
    const decision = projectDecision(state);
    if (!decision?.id || decision.version !== body.object_version) throw new StaticPreviewRequestError(409, "决策卡审批版本不匹配。");
    if (decision.outcome === "EVIDENCE_INSUFFICIENT" && body.decision === "APPROVE") {
      throw new StaticPreviewRequestError(409, "证据不足不能批准进入交接。");
    }
    decision.approval_status = status;
    targetId = String(decision.id);
    setWorkflow(state.project, body.decision === "APPROVE" ? "DECISION_APPROVED" : "DECISION_PROPOSED");
  } else {
    throw new StaticPreviewRequestError(422, "请使用对应的独立审批门。");
  }
  addAudit(state, `${body.gate}_${body.decision}`, previousState, state.project.workflow_state, "STATIC_PREVIEW_HUMAN", {
    target_id: targetId,
    object_version: body.object_version,
    actor: body.actor,
    comment: body.comment ?? null,
  });
  saveState(state);
  return { id: `static-approval-${state.auditEvents.length}`, target_id: targetId, object_version: body.object_version, status };
}

async function advanceSimulation(state: StaticPreviewState, days: number): Promise<Record<string, unknown>> {
  assertNotArchived(state);
  assertWorkflow(state, ["SIMULATION_READY", "SIMULATION_RUNNING"], "推进试销回放");
  if (state.project.experiment_plan?.approval_status !== "APPROVED") {
    throw new StaticPreviewRequestError(409, "实验计划未批准，不能启动回放。");
  }
  const current = state.project.current_day ?? 0;
  const total = state.project.total_days ?? 7;
  if (current >= total) throw new StaticPreviewRequestError(409, "当前回放已完成。");
  const previousState = state.project.workflow_state;
  state.project.current_day = Math.min(total, current + Math.max(1, Math.floor(days)));
  setWorkflow(state.project, state.project.current_day >= total ? "DATA_READY" : "SIMULATION_RUNNING");
  addAudit(state, "SIMULATION_ADVANCED", previousState, state.project.workflow_state, "STATIC_PREVIEW_TOOL", {
    current_day: state.project.current_day,
    fixed_seed: STATIC_PREVIEW_FIXED_SEED,
  });
  saveState(state);
  return { current_day: state.project.current_day, total_days: total, workflow_state: state.project.workflow_state };
}

function resetSimulation(state: StaticPreviewState): ProjectDetail {
  assertNotArchived(state);
  assertWorkflow(
    state,
    ["SIMULATION_RUNNING", "DATA_READY", "DATA_VALIDATED", "DATA_BLOCKED", "ANALYZED", "DECISION_PROPOSED"],
    "重置试销回放",
  );
  const decision = projectDecision(state);
  if (decision?.approval_status === "APPROVED" || state.project.handoff || projectArtifacts(state.project).handoff) {
    throw new StaticPreviewRequestError(409, "决策已批准或交接已生成，不能重置。");
  }
  const previousState = state.project.workflow_state;
  invalidateDownstream(state);
  setWorkflow(state.project, "SIMULATION_READY");
  addAudit(state, "SIMULATION_REPLAY_RESET", previousState, "SIMULATION_READY", "STATIC_PREVIEW_HUMAN", {
    browser_history_retained: true,
    observations_regenerated_from_fixed_fixture: true,
  });
  saveState(state);
  return clone(state.project);
}

async function analyze(state: StaticPreviewState): Promise<Record<string, unknown>> {
  assertNotArchived(state);
  assertWorkflow(state, ["DATA_READY"], "执行质检与分析");
  if ((state.project.current_day ?? 0) < (state.project.total_days ?? 7)) {
    throw new StaticPreviewRequestError(409, "请先完成全部试销周期再分析。");
  }
  const scenario = scenarioOf(state);
  const observations = visibleObservations(state);
  const datasetSha = await sha256(observations);
  const metrics = makeStaticMetrics(observations);
  const analysisVersion = state.objectVersions
    .filter((item) => item.object_type === "DecisionCard")
    .reduce((highest, item) => Math.max(highest, item.object_version), 0) + 1;
  const versionSuffix = `v${analysisVersion}`;
  metrics.metric_version = `metrics-${versionSuffix}`;
  metrics.variants = metrics.variants?.map((metric) => ({
    ...metric,
    id: `metric-${STATIC_PREVIEW_PROJECT_ID}-${String(metric.variant_id)}-${versionSuffix}`,
  }));
  const quality = makeStaticQuality(scenario, metrics, datasetSha);
  const grade = quality.can_make_strong_decision ? "B" : "D";
  const datasetId = `dataset-${STATIC_PREVIEW_PROJECT_ID}-${scenario.id.toLowerCase()}-${versionSuffix}`;
  const claims = [
    {
      id: `evidence-quality-${STATIC_PREVIEW_PROJECT_ID}-${versionSuffix}`,
      kind: "OBSERVED",
      statement_type: "OBSERVED",
      inference_strength: "UNDETERMINED",
      evidence_grade: grade,
      stance: quality.can_make_strong_decision ? "SUPPORTS" : "OPPOSES",
      statement: `数据质量状态为 ${quality.status}，共 ${quality.row_count} 行、${quality.observation_days} 个观测日。`,
      metric_refs: [],
      source_refs: [datasetId],
      counterexamples: [],
      limitations: ["质量报告只能描述当前合成数据集是否满足预注册校验。"],
    },
    ...(metrics.variants ?? []).map((metric) => {
      const variantId = String(metric.variant_id);
      const intentRate = Number(metric.purchase_intent_rate);
      return {
        id: `evidence-metric-${STATIC_PREVIEW_PROJECT_ID}-${variantId}-${versionSuffix}`,
        kind: "OBSERVED",
        statement_type: "OBSERVED",
        inference_strength: "ASSOCIATIONAL",
        evidence_grade: grade,
        stance: intentRate >= STATIC_PREVIEW_POLICY.purchase_intent_rate_threshold ? "SUPPORTS" : "OPPOSES",
        statement: `变体 ${variantId} 的曝光为 ${metric.exposure}，点击率 ${(Number(metric.ctr) * 100).toFixed(2)}%，购买意向率 ${(intentRate * 100).toFixed(2)}%。`,
        metric_refs: [`${metric.id}:purchase_intent_count`, `${metric.id}:exposure`],
        source_refs: [datasetId],
        counterexamples: ["购买意向可能不会转化为真实订单。"],
        limitations: ["单一合成渠道样本不能外推真实市场。"],
      };
    }),
    {
      id: `evidence-supply-${STATIC_PREVIEW_PROJECT_ID}-${versionSuffix}`,
      kind: "OBSERVED",
      statement_type: "OBSERVED",
      inference_strength: "UNDETERMINED",
      evidence_grade: grade,
      stance: scenario.moq * scenario.estimatedCostFen <= scenario.productionBudgetFen ? "SUPPORTS" : "OPPOSES",
      statement: `MOQ 对应的估算资金占用为 ¥${((scenario.moq * scenario.estimatedCostFen) / 100).toFixed(2)}，生产预算为 ¥${(scenario.productionBudgetFen / 100).toFixed(2)}。`,
      metric_refs: [],
      source_refs: ["product-brief"],
      counterexamples: [],
      limitations: ["成本、MOQ 与预算均是合成 Brief 值，尚需业务人员复核。"],
    },
  ];
  const evidence: EvidenceCard = {
    id: `evidence-card-${STATIC_PREVIEW_PROJECT_ID}-${versionSuffix}`,
    version: analysisVersion,
    data_status: "SYNTHETIC",
    quality_status: String(quality.status),
    evidence_grade: grade,
    claims,
    limitations: [
      ...((quality.issues ?? []).map((item) => item.impact ?? "存在质量限制。")),
      "合成数据只能验证流程和规则，不能验证真实市场需求。",
      "GitHub Pages 版本在浏览器内运行，不是真实服务端审计记录。",
    ],
    dataset_refs: [datasetId],
    policy_version: STATIC_PREVIEW_POLICY.version,
    generated_at: STATIC_PREVIEW_TIMESTAMP,
  };
  const copy = outcomeCopy(scenario.expected_outcome);
  const decision: DecisionCard = {
    id: `decision-card-${STATIC_PREVIEW_PROJECT_ID}-${versionSuffix}`,
    version: analysisVersion,
    outcome: scenario.expected_outcome,
    one_sentence: copy.sentence,
    evidence_grade: grade,
    reason_codes: scenario.reasonCodes,
    key_evidence_ids: claims.filter((claim) => claim.stance === "SUPPORTS").map((claim) => claim.id),
    opposing_evidence_ids: claims.filter((claim) => claim.stance === "OPPOSES").map((claim) => claim.id),
    limitations: evidence.limitations,
    risks: [...(evidence.limitations ?? []), ...(scenario.expected_outcome === "PIVOT" ? ["修改后必须复测，当前结果不是生产指令。"] : [])],
    next_actions: copy.nextActions,
    policy_version: STATIC_PREVIEW_POLICY.version,
    approval_status: "PENDING",
    generated_at: STATIC_PREVIEW_TIMESTAMP,
    agent_narrative: {
      headline: copy.sentence,
      interpretation: "该解释仅复述已锁定的合成指标和规则结果。",
      evidence_refs: claims.map((claim) => claim.id),
      limitations: evidence.limitations,
      generated_by: "browser-static-replay",
      prompt_version: "decision-explanation-v1",
    },
  };
  const artifacts = projectArtifacts(state.project);
  artifacts.quality = quality;
  artifacts.metrics = metrics;
  artifacts.evidence = evidence;
  artifacts.decision = decision;
  state.project.quality = quality;
  state.project.quality_report = quality;
  state.project.metrics = metrics;
  state.project.evidence = evidence;
  state.project.evidence_card = evidence;
  state.project.decision = decision;
  state.project.decision_card = decision;
  const previousState = state.project.workflow_state;
  setWorkflow(state.project, "DECISION_PROPOSED");
  addAudit(state, "DETERMINISTIC_ANALYSIS_COMPLETED", previousState, "DECISION_PROPOSED", "STATIC_PREVIEW_TOOL", {
    dataset_sha256: datasetSha,
    quality_status: String(quality.status),
    decision_outcome: scenario.expected_outcome,
  });
  await addObjectVersion(state, "QualityReport", `quality-${STATIC_PREVIEW_PROJECT_ID}-${versionSuffix}`, analysisVersion, quality);
  await addObjectVersion(state, "MetricBundle", `metrics-${STATIC_PREVIEW_PROJECT_ID}-${versionSuffix}`, analysisVersion, metrics);
  await addObjectVersion(state, "EvidenceCard", String(evidence.id), analysisVersion, evidence);
  await addObjectVersion(state, "DecisionCard", String(decision.id), analysisVersion, decision);
  state.agentRuns.push(await makeAgentRun(state, "EXPLAIN_DECISION", { outcome: decision.outcome, claims }, decision.agent_narrative));
  addAudit(state, "AGENT_REPLAY_COMPLETED", "DECISION_PROPOSED", "DECISION_PROPOSED", "STATIC_PREVIEW_AGENT", {
    operation: "EXPLAIN_DECISION",
    mode: "OFFLINE_REPLAY",
  });
  saveState(state);
  return clone({ quality, metrics, evidence, decision });
}

function generatePivotRevision(state: StaticPreviewState, decisionId: string): PivotRevision {
  assertNotArchived(state);
  assertWorkflow(state, ["DECISION_APPROVED"], "生成 PivotRevision");
  const decision = projectDecision(state);
  if (!decision?.id || decision.id !== decisionId || decision.outcome !== "PIVOT" || decision.approval_status !== "APPROVED") {
    throw new StaticPreviewRequestError(409, "只有已批准的 Pivot 决策可生成修订草稿。");
  }
  const current = projectArtifacts(state.project).pivot_revision;
  const version = (current?.version ?? 0) + 1;
  const designPivot = decision.reason_codes?.includes("MODIFIABLE_DESIGN_VARIABLE");
  const supplyPivot = decision.reason_codes?.includes("MODIFIABLE_SUPPLY_VARIABLE");
  const revision: PivotRevision = {
    id: `pivot-revision-${STATIC_PREVIEW_PROJECT_ID}-v${version}`,
    decision_id: decisionId,
    target_variant_id: designPivot ? "COLOR-IVORY" : "COLOR-GRAY-BLUE",
    version,
    approval_status: "PENDING",
    change_variable: designPivot ? "COLOR" : supplyPivot ? "MOQ" : "PRICE_OR_OFFER",
    change_list: [designPivot ? "仅替换米白配色方案" : supplyPivot ? "与供应方复核 MOQ 与资金占用" : "仅调整价格或报价表达"],
    retest_plan: ["保持鞋型、人群、渠道和素材不变", "新建单变量复测并重新审批"],
    created_by: "browser-static-deterministic-tool",
    created_at: STATIC_PREVIEW_TIMESTAMP,
  };
  projectArtifacts(state.project).pivot_revision = revision;
  state.project.pivot_revision = revision;
  addAudit(state, "PIVOT_REVISION_GENERATED", state.project.workflow_state, state.project.workflow_state, "STATIC_PREVIEW_TOOL", {
    pivot_revision_id: revision.id,
    version,
  });
  saveState(state);
  return clone(revision);
}

function approvePivotRevision(state: StaticPreviewState, revisionId: string, body: ApprovalRequest): Record<string, unknown> {
  assertNotArchived(state);
  assertWorkflow(state, ["DECISION_APPROVED"], "PivotRevision 审批");
  const revision = projectArtifacts(state.project).pivot_revision;
  if (!revision || revision.id !== revisionId || revision.version !== body.object_version) {
    throw new StaticPreviewRequestError(409, "PivotRevision 审批版本不匹配。");
  }
  revision.approval_status = approvalStatus(body.decision);
  state.project.pivot_revision = revision;
  addAudit(state, `PIVOT_REVISION_${body.decision}`, state.project.workflow_state, state.project.workflow_state, "STATIC_PREVIEW_HUMAN", {
    pivot_revision_id: revision.id,
    object_version: revision.version,
    actor: body.actor,
  });
  saveState(state);
  return { id: `static-approval-${state.auditEvents.length}`, target_id: revision.id, object_version: revision.version, status: revision.approval_status };
}

function approveFirstOrderAssumptions(state: StaticPreviewState, body: ApprovalRequest): Record<string, unknown> {
  assertNotArchived(state);
  assertWorkflow(state, ["DECISION_APPROVED"], "首单情景假设确认");
  const decision = projectDecision(state);
  const assumptions = state.project.brief?.first_order_assumptions;
  if (body.decision !== "APPROVE" || !decision || decision.approval_status !== "APPROVED" || !assumptions) {
    throw new StaticPreviewRequestError(409, "当前决策或首单假设不满足确认条件。");
  }
  if (body.object_version !== state.project.brief_version) {
    throw new StaticPreviewRequestError(409, "首单假设必须绑定当前 Brief 版本。");
  }
  if (decision.outcome === "PIVOT" && projectArtifacts(state.project).pivot_revision?.approval_status !== "APPROVED") {
    throw new StaticPreviewRequestError(409, "Pivot 修订版本未批准。");
  }
  const targetId = `first-order-assumptions-${STATIC_PREVIEW_PROJECT_ID}-brief-v${state.project.brief_version}`;
  state.project.first_order_assumptions_confirmation = {
    target_id: targetId,
    brief_version: state.project.brief_version ?? 1,
    intent_to_order_rate: assumptions.intent_to_order_rate,
    planned_reach: assumptions.planned_reach,
    packing_step: assumptions.packing_step,
    proposal_source: assumptions.source,
    actor: body.actor,
    comment: body.comment ?? null,
    confirmed_at: STATIC_PREVIEW_TIMESTAMP,
  };
  addAudit(state, "FIRST_ORDER_ASSUMPTIONS_APPROVE", state.project.workflow_state, state.project.workflow_state, "STATIC_PREVIEW_HUMAN", {
    target_id: targetId,
    object_version: body.object_version,
    actor: body.actor,
  });
  saveState(state);
  return { id: `static-approval-${state.auditEvents.length}`, target_id: targetId, object_version: body.object_version, status: "APPROVED" };
}

async function createHandoff(state: StaticPreviewState): Promise<HandoffBundle> {
  assertNotArchived(state);
  assertWorkflow(state, ["DECISION_APPROVED"], "生成交接草稿");
  const decision = projectDecision(state);
  const revision = projectArtifacts(state.project).pivot_revision;
  const confirmation = state.project.first_order_assumptions_confirmation;
  if (!decision?.id || decision.approval_status !== "APPROVED" || !["GO", "PIVOT"].includes(String(decision.outcome))) {
    throw new StaticPreviewRequestError(409, "只有已批准的 GO 或 PIVOT 决策可生成交接草稿。");
  }
  if (decision.outcome === "PIVOT" && revision?.approval_status !== "APPROVED") {
    throw new StaticPreviewRequestError(409, "Pivot 修订版本未批准。");
  }
  if (!confirmation || confirmation.brief_version !== state.project.brief_version) {
    throw new StaticPreviewRequestError(409, "当前 Brief 版本的首单情景假设未确认。");
  }
  const metrics = projectArtifacts(state.project).metrics;
  const intent = metrics?.total_intent ?? 0;
  const exposure = metrics?.total_exposure ?? 1;
  const rawAnchor = intent * confirmation.intent_to_order_rate * confirmation.planned_reach / Math.max(1, exposure);
  const roundToStep = (value: number) => Math.max(0, Math.round(value / confirmation.packing_step) * confirmation.packing_step);
  const names = [["CONSERVATIVE", 0.8], ["BASE", 1], ["AGGRESSIVE", 1.2]] as const;
  const estimatedCostFen = Number(state.project.brief?.estimated_cost_fen ?? 0);
  const productionBudgetFen = Number(state.project.brief?.production_budget_fen ?? 0);
  const moq = Number(state.project.brief?.moq ?? 0);
  const budgetCeiling = estimatedCostFen > 0
    ? Math.floor(productionBudgetFen / estimatedCostFen / confirmation.packing_step) * confirmation.packing_step
    : 0;
  const quantities = names.map(([, multiplier]) =>
    Math.min(roundToStep(rawAnchor * multiplier), budgetCeiling),
  );
  const hasMoqConflict = budgetCeiling < moq || quantities.some((quantity) => quantity < moq);
  const firstOrderScenarios = hasMoqConflict ? [{
    name: "BASE",
    quantity_low: 0,
    quantity_high: 0,
    assumptions: [
      "anchor = purchase_intent_count × intent_to_order_rate × planned_reach / simulated_exposure。",
      `假设由 ${confirmation.actor} 确认（Brief v${confirmation.brief_version}）。`,
    ],
    constraint_notes: [`计算结果或预算上限低于 MOQ ${moq} 双；仅返回冲突，不输出可执行量。`],
    status: "CONFLICT",
  }] : names.map(([name, multiplier], index) => {
    const quantity = quantities[index];
    return {
      name,
      quantity_low: quantity,
      quantity_high: quantity,
      assumptions: [
        "购买意向不等于真实订单",
        `情景系数 ${multiplier.toFixed(1)}`,
        `意向转订单率 ${(confirmation.intent_to_order_rate * 100).toFixed(0)}%`,
      ],
      constraint_notes: [
        `以 ${confirmation.packing_step} 双包装步长取整，并受预算上限 ${budgetCeiling} 双约束`,
        "仅为合成情景点，不是销量预测",
      ],
      status: decision.outcome === "PIVOT" ? "CONDITIONAL_RETEST_REQUIRED" : "READY",
    };
  });
  const handoff: HandoffBundle = {
    id: `handoff-${STATIC_PREVIEW_PROJECT_ID}-v${decision.version ?? 1}`,
    decision_id: decision.id,
    pivot_revision_id: revision?.id ?? null,
    outcome: decision.outcome,
    techpack: decision.outcome === "GO" ? {
      id: `techpack-${STATIC_PREVIEW_PROJECT_ID}-v${decision.version ?? 1}`,
      candidate_id: "CASUAL-001",
      variant_id: "COLOR-GRAY-BLUE",
      decision_id: decision.id,
      title: "男士轻量休闲鞋 TechPack Lite 草稿",
      fields: [
        { name: "品类", value: "男士轻量休闲鞋", status: "CONFIRMED", source_ref: "ProductBrief" },
        { name: "鞋型", value: null, status: "PENDING_CONFIRMATION", source_ref: null },
        { name: "帮面材料", value: null, status: "PENDING_CONFIRMATION", source_ref: null },
        { name: "大底工艺", value: null, status: "PENDING_CONFIRMATION", source_ref: null },
        { name: "尺码范围", value: null, status: "PENDING_CONFIRMATION", source_ref: null },
      ],
      warnings: ["未经鞋类工艺专家确认的字段全部保持“待确认”。", "本对象不是生产指令。"],
      status: "DRAFT_NOT_SENT",
    } : undefined,
    sample_task: {
      id: `sample-task-${STATIC_PREVIEW_PROJECT_ID}-v${decision.version ?? 1}`,
      candidate_id: "CASUAL-001",
      variant_id: decision.outcome === "PIVOT" ? revision?.target_variant_id ?? "COLOR-IVORY" : "COLOR-GRAY-BLUE",
      pivot_revision_id: revision?.id ?? null,
      objective: decision.outcome === "PIVOT" ? "按已批准修订草稿制作非生产复测样鞋" : "制作人工复核用样鞋",
      change_list: revision?.change_list ?? [],
      acceptance_points: ["两个配色除受控变量外保持一致", "未知材料与工艺字段由工厂确认"],
      risks: ["合成试销不能验证真实穿着与市场表现"],
      status: "DRAFT_REQUIRES_HUMAN_APPROVAL",
    },
    first_order_scenarios: firstOrderScenarios,
    retest_plan: decision.outcome === "PIVOT" ? revision?.retest_plan ?? [] : [],
    blocked_reason: null,
    watermark: decision.outcome === "PIVOT" ? "条件式情景 · 需复测 · 非生产指令" : "合成演示 · 非生产指令",
    status: decision.outcome === "PIVOT" ? "CONDITIONAL_DRAFT" : "DRAFT_REQUIRES_SEPARATE_EXTERNAL_APPROVAL",
    generated_at: STATIC_PREVIEW_TIMESTAMP,
  };
  projectArtifacts(state.project).handoff = handoff;
  state.project.handoff = handoff;
  const previousState = state.project.workflow_state;
  setWorkflow(state.project, "HANDOFF_DRAFT_READY");
  addAudit(state, "HANDOFF_DRAFT_GENERATED", previousState, "HANDOFF_DRAFT_READY", "STATIC_PREVIEW_TOOL", {
    handoff_id: String(handoff.id),
    outcome: String(decision.outcome),
  });
  await addObjectVersion(state, "HandoffPackage", String(handoff.id), decision.version ?? 1, handoff);
  saveState(state);
  return clone(handoff);
}

function methodOf(init: RequestInit): string {
  return (init.method ?? "GET").toUpperCase();
}

/**
 * Browser-local substitute for the API transport used only by GitHub Pages.
 * It intentionally has no network, model, upload, or production integration.
 */
export async function staticPreviewRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
  const pathname = new URL(path, "https://static-preview.invalid").pathname;
  const method = methodOf(init);

  if (pathname === "/health" && method === "GET") {
    return clone({
      status: "ok",
      service: "shixiaoguan-browser-static-preview",
      version: "github-pages-v1",
      agent_mode: "OFFLINE_REPLAY",
      public_preview_mode: true,
      attachment_upload_enabled: false,
    }) as T;
  }
  if (pathname === "/demo/scenarios" && method === "GET") {
    return clone(STATIC_PREVIEW_SCENARIOS.map(({ id, name, description, expected_outcome, total_days }) => ({
      id,
      name,
      description,
      expected_outcome,
      total_days,
      scenario_version: STATIC_PREVIEW_SCENARIO_VERSION,
      fixed_seed: STATIC_PREVIEW_FIXED_SEED,
      generator_version: STATIC_PREVIEW_GENERATOR_VERSION,
    }))) as T;
  }
  const scenarioCreate = pathname.match(/^\/demo\/scenarios\/([^/]+)\/projects$/);
  if (scenarioCreate && method === "POST") {
    const scenario = getStaticScenario(decodeURIComponent(scenarioCreate[1]));
    if (!scenario) throw new StaticPreviewRequestError(404, "未找到该预注册合成场景。");
    const state = await createScenarioState(scenario);
    saveState(state);
    return clone(state.project) as T;
  }
  if (pathname === "/projects" && method === "GET") {
    const state = loadState();
    return clone(state ? [state.project] : []) as T;
  }
  if (pathname === "/projects" && method === "POST") {
    throw new StaticPreviewRequestError(405, "GitHub Pages 固定场景预览不支持空白 Brief；请从八个显式场景中选择。");
  }

  const projectRoute = pathname.match(/^\/projects\/([^/:]+)$/);
  if (projectRoute && method === "GET") return clone(requireState(decodeURIComponent(projectRoute[1])).project) as T;

  const briefRoute = pathname.match(/^\/projects\/([^/]+)\/brief$/);
  if (briefRoute && method === "PUT") {
    const state = requireState(decodeURIComponent(briefRoute[1]));
    assertNotArchived(state);
    throw new StaticPreviewRequestError(405, "GitHub Pages 固定场景的 Brief 只读；请在本地完整版中创建新版本。");
  }

  const normalizeRoute = pathname.match(/^\/projects\/([^/]+)\/brief\/normalize$/);
  if (normalizeRoute && method === "POST") return await normalizeBrief(requireState(decodeURIComponent(normalizeRoute[1]))) as T;

  const planRoute = pathname.match(/^\/projects\/([^/]+)\/experiment-plans:generate$/);
  if (planRoute && method === "POST") return await generatePlan(requireState(decodeURIComponent(planRoute[1]))) as T;

  const policyRoute = pathname.match(/^\/projects\/([^/]+)\/policy$/);
  if (policyRoute && method === "GET") return clone(requireState(decodeURIComponent(policyRoute[1])).project.current_policy ?? STATIC_PREVIEW_POLICY) as T;
  if (policyRoute && method === "PUT") {
    const state = requireState(decodeURIComponent(policyRoute[1]));
    assertNotArchived(state);
    throw new StaticPreviewRequestError(405, "GitHub Pages 固定场景的 DemoPolicy 只读；策略编辑仅在本地完整版开放。");
  }

  const attachmentRoute = pathname.match(/^\/projects\/([^/]+)\/attachments$/);
  if (attachmentRoute && method === "GET") {
    requireState(decodeURIComponent(attachmentRoute[1]));
    return [] as T;
  }
  if (attachmentRoute && method === "POST") {
    const state = requireState(decodeURIComponent(attachmentRoute[1]));
    assertNotArchived(state);
    throw new StaticPreviewRequestError(403, "GitHub Pages 公开静态预览已禁用附件上传；请勿输入真实企业或个人信息。");
  }

  const approvalRoute = pathname.match(/^\/projects\/([^/]+)\/approvals$/);
  if (approvalRoute && method === "POST") {
    const state = requireState(decodeURIComponent(approvalRoute[1]));
    return clone(submitProjectApproval(state, parseBody(init) as unknown as ApprovalRequest)) as T;
  }

  const advanceRoute = pathname.match(/^\/projects\/([^/]+)\/simulation\/advance$/);
  if (advanceRoute && method === "POST") {
    const body = parseBody(init);
    return await advanceSimulation(requireState(decodeURIComponent(advanceRoute[1])), Number(body.days ?? 1)) as T;
  }
  const runRoute = pathname.match(/^\/projects\/([^/]+)\/simulation\/run$/);
  if (runRoute && method === "POST") {
    const state = requireState(decodeURIComponent(runRoute[1]));
    return await advanceSimulation(state, state.project.total_days ?? 7) as T;
  }
  const resetRoute = pathname.match(/^\/projects\/([^/]+)\/simulation\/replay-reset$/);
  if (resetRoute && method === "POST") return resetSimulation(requireState(decodeURIComponent(resetRoute[1]))) as T;

  const observationRoute = pathname.match(/^\/projects\/([^/]+)\/observations$/);
  if (observationRoute && method === "GET") return clone(visibleObservations(requireState(decodeURIComponent(observationRoute[1])))) as T;

  const analyzeRoute = pathname.match(/^\/projects\/([^/]+)\/analyze$/);
  if (analyzeRoute && method === "POST") return await analyze(requireState(decodeURIComponent(analyzeRoute[1]))) as T;

  const artifactRoute = pathname.match(/^\/projects\/([^/]+)\/(quality|metrics|evidence|decision|handoff)$/);
  if (artifactRoute && method === "GET") {
    const state = requireState(decodeURIComponent(artifactRoute[1]));
    const artifact = projectArtifacts(state.project)[artifactRoute[2] as keyof NonNullable<ProjectDetail["artifacts"]>];
    if (!artifact) throw new StaticPreviewRequestError(404, "当前审批门尚未产生该对象。");
    return clone(artifact) as T;
  }
  if (artifactRoute && artifactRoute[2] === "handoff" && method === "POST") {
    return await createHandoff(requireState(decodeURIComponent(artifactRoute[1]))) as T;
  }

  const pivotGenerateRoute = pathname.match(/^\/decision-cards\/([^/]+)\/pivot-revisions:generate$/);
  if (pivotGenerateRoute && method === "POST") {
    const state = requireState();
    return generatePivotRevision(state, decodeURIComponent(pivotGenerateRoute[1])) as T;
  }
  const pivotApprovalRoute = pathname.match(/^\/pivot-revisions\/([^/]+)\/approvals$/);
  if (pivotApprovalRoute && method === "POST") {
    const state = requireState();
    return clone(approvePivotRevision(state, decodeURIComponent(pivotApprovalRoute[1]), parseBody(init) as unknown as ApprovalRequest)) as T;
  }

  const firstOrderRoute = pathname.match(/^\/projects\/([^/]+)\/first-order-assumptions\/approvals$/);
  if (firstOrderRoute && method === "POST") {
    const state = requireState(decodeURIComponent(firstOrderRoute[1]));
    return clone(approveFirstOrderAssumptions(state, parseBody(init) as unknown as ApprovalRequest)) as T;
  }

  const auditRoute = pathname.match(/^\/projects\/([^/]+)\/audit-events$/);
  if (auditRoute && method === "GET") return clone(requireState(decodeURIComponent(auditRoute[1])).auditEvents) as T;
  const agentRoute = pathname.match(/^\/projects\/([^/]+)\/agent-runs$/);
  if (agentRoute && method === "GET") return clone(requireState(decodeURIComponent(agentRoute[1])).agentRuns) as T;
  const versionRoute = pathname.match(/^\/projects\/([^/]+)\/object-versions$/);
  if (versionRoute && method === "GET") return clone(requireState(decodeURIComponent(versionRoute[1])).objectVersions) as T;

  const archiveRoute = pathname.match(/^\/projects\/([^/]+):archive$/);
  if (archiveRoute && method === "POST") {
    const state = requireState(decodeURIComponent(archiveRoute[1]));
    assertNotArchived(state);
    const previousState = state.project.workflow_state;
    setWorkflow(state.project, "ARCHIVED");
    addAudit(state, "PROJECT_ARCHIVED", previousState, "ARCHIVED", "STATIC_PREVIEW_HUMAN", { retained_locally: true });
    saveState(state);
    return clone(state.project) as T;
  }

  throw new StaticPreviewRequestError(404, `GitHub Pages 静态预览未实现路由：${method} ${pathname}`);
}

function escapeHtml(value: unknown): string {
  return String(value ?? "—")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function staticPreviewReportHtml(): string {
  const state = loadState();
  const decision = state ? projectDecision(state) : undefined;
  const quality = state ? projectArtifacts(state.project).quality : undefined;
  const metrics = state ? projectArtifacts(state.project).metrics : undefined;
  const limitations = decision?.limitations ?? ["尚未生成决策；当前只是流程预览。"];
  const list = (values: unknown[]) => values.map((value) => `<li>${escapeHtml(value)}</li>`).join("");
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>试销官浏览器评审快照</title><style>body{font:16px/1.7 system-ui;max-width:820px;margin:48px auto;padding:0 24px;color:#17251f}code{background:#eef2ef;padding:2px 6px}aside{border:2px solid #b36b00;padding:16px;background:#fff8e8}table{width:100%;border-collapse:collapse}th,td{padding:10px;border:1px solid #d7ddd9;text-align:left}small{color:#59645f}</style><body><h1>试销官 · GitHub Pages 评审快照</h1><aside><strong>非生产指令</strong><p>本快照由当前浏览器内合成固定录制生成，不是 FastAPI 服务端报告，不代表真实市场效果。</p></aside><h2>当前状态</h2><table><tr><th>项目</th><td>${escapeHtml(state?.project.id ?? "未创建")}</td><th>场景</th><td>${escapeHtml(state?.scenarioId ?? "未选择")}</td></tr><tr><th>流程</th><td>${escapeHtml(state?.project.workflow_state ?? "未开始")}</td><th>数据/模式</th><td>SYNTHETIC / OFFLINE_REPLAY</td></tr><tr><th>质量</th><td>${escapeHtml(quality?.status ?? "未分析")}</td><th>决策/审批</th><td>${escapeHtml(decision?.outcome ?? "未生成")} / ${escapeHtml(decision?.approval_status ?? "未审批")}</td></tr></table><h2>指标快照</h2><table><tr><th>总曝光</th><td>${escapeHtml(metrics?.total_exposure ?? "—")}</td><th>总购买意向</th><td>${escapeHtml(metrics?.total_intent ?? "—")}</td></tr><tr><th>总体意向率</th><td>${escapeHtml(metrics?.overall_intent_rate === undefined ? "—" : `${(metrics.overall_intent_rate * 100).toFixed(2)}%`)}</td><th>数据 SHA-256</th><td><small>${escapeHtml(quality?.dataset_sha256 ?? "—")}</small></td></tr></table><h2>原因码</h2><ul>${list(decision?.reason_codes ?? ["尚未生成"])}</ul><h2>限制</h2><ul>${list(limitations)}</ul><h2>浏览器演示记录</h2><p>事件 ${escapeHtml(state?.auditEvents.length ?? 0)} 条 · 对象快照 ${escapeHtml(state?.objectVersions.length ?? 0)} 条。这些记录可被清理浏览器站点数据删除，不应作为真实企业审计证据。</p></body></html>`;
}

export function openStaticPreviewReport(): Window | null {
  const blob = new Blob([staticPreviewReportHtml()], { type: "text/html;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const report = window.open(url, "_blank", "noopener,noreferrer");
  if (report) report.opener = null;
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
  return report;
}

export function staticPreviewAttachmentUrl(): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180"><rect width="100%" height="100%" fill="#f4f1e9"/><text x="50%" y="50%" text-anchor="middle" fill="#59645f" font-family="sans-serif">GitHub Pages 已禁用附件</text></svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}
