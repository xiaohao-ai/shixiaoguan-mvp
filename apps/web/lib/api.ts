import type {
  AnalysisBundle,
  AgentRun,
  ApprovalRequest,
  AuditEvent,
  DecisionCard,
  DemoPolicy,
  DemoScenario,
  EvidenceCard,
  HandoffBundle,
  MetricsReport,
  ObjectVersion,
  PivotRevision,
  ProductBrief,
  ProjectAttachment,
  ProjectDetail,
  QualityReport,
  TrialObservation,
} from "@/lib/types";
import type { components } from "@/lib/api.generated";
import { z } from "zod";

type ApiHealthResponse = components["schemas"]["HealthResponse"];

export const API_BASE_URL = (
  process.env.NEXT_PUBLIC_API_BASE_URL ?? "/api/v1"
).replace(/\/$/, "");

export class ApiError extends Error {
  readonly status: number;
  readonly detail: string;

  constructor(status: number, detail: string) {
    super(detail);
    this.name = "ApiError";
    this.status = status;
    this.detail = detail;
  }
}

export class ApiUnavailableError extends Error {
  constructor(message = "无法连接演示 API，请确认本地服务已启动。") {
    super(message);
    this.name = "ApiUnavailableError";
  }
}

async function request<T>(
  path: string,
  init: RequestInit = {},
  timeoutMs = 15_000,
): Promise<T> {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), timeoutMs);

  try {
    const headers = new Headers(init.headers);
    const method = (init.method ?? "GET").toUpperCase();
    if (!["GET", "HEAD", "OPTIONS"].includes(method) && !headers.has("Idempotency-Key")) {
      headers.set("Idempotency-Key", createIdempotencyKey());
    }
    if (init.body && !(init.body instanceof FormData) && !headers.has("Content-Type")) {
      headers.set("Content-Type", "application/json");
    }
    headers.set("Accept", "application/json");

    const response = await fetch(`${API_BASE_URL}${path}`, {
      ...init,
      headers,
      signal: controller.signal,
      cache: "no-store",
    });

    if (!response.ok) {
      let detail = `请求失败（${response.status}）`;
      try {
        const payload = (await response.json()) as { detail?: string | unknown };
        if (typeof payload.detail === "string") detail = payload.detail;
      } catch {
        const text = await response.text().catch(() => "");
        if (text) detail = text;
      }
      throw new ApiError(response.status, detail);
    }

    if (response.status === 204) return undefined as T;
    return (await response.json()) as T;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    if (error instanceof Error && error.name === "AbortError") {
      throw new ApiUnavailableError("演示 API 响应超时，请稍后重试。\n");
    }
    throw new ApiUnavailableError();
  } finally {
    window.clearTimeout(timer);
  }
}

function createIdempotencyKey(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return `web-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

const decisionOutcomeSchema = z.enum(["GO", "PIVOT", "NO_GO", "EVIDENCE_INSUFFICIENT"]);
const scenarioSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string(),
  expected_outcome: decisionOutcomeSchema,
  total_days: z.number().int().positive(),
}).passthrough();
const projectSchema = z.object({
  id: z.string().min(1),
  status: z.string().optional(),
  current_day: z.number().int().nonnegative().optional(),
  total_days: z.number().int().positive().optional(),
}).passthrough();
const qualitySchema = z.object({
  status: z.enum(["PASS", "WARN", "BLOCK"]),
  can_make_strong_decision: z.boolean(),
  row_count: z.number().int().nonnegative(),
  observation_days: z.number().int().nonnegative(),
  issues: z.array(z.object({
    issue_id: z.string(),
    code: z.string(),
    rule_code: z.string(),
    severity: z.enum(["BLOCK", "WARN", "INFO"]),
    message: z.string(),
    affected_rows: z.array(z.number().int()),
    affected_fields: z.array(z.string()),
    record_refs: z.array(z.string()),
    observed: z.unknown().nullable(),
    expected: z.unknown().nullable(),
    handling_status: z.enum(["OPEN", "ACKNOWLEDGED", "RESOLVED"]),
    impact: z.string(),
  }).passthrough()),
  dataset_sha256: z.string(),
  rule_version: z.string(),
  generated_at: z.string(),
}).passthrough();
const metricsSchema = z.object({
  variants: z.array(z.record(z.unknown())),
  total_exposure: z.number().nonnegative(),
  total_intent: z.number().nonnegative(),
  overall_intent_rate: z.number(),
  best_variant_id: z.string().nullable(),
  worst_variant_id: z.string().nullable(),
  relative_intent_uplift: z.number().nullable(),
  metric_version: z.string(),
  generated_at: z.string(),
}).passthrough();
const evidenceSchema = z.object({
  id: z.string(),
  version: z.number().int().positive(),
  data_status: z.enum(["SYNTHETIC", "PUBLIC_SAMPLE", "USER_PROVIDED", "ENTERPRISE_AUTHORIZED"]),
  quality_status: z.string(),
  evidence_grade: z.string(),
  claims: z.array(z.record(z.unknown())),
  limitations: z.array(z.string()),
  dataset_refs: z.array(z.string()),
  policy_version: z.string(),
  generated_at: z.string(),
}).passthrough();
const decisionSchema = z.object({
  id: z.string(),
  version: z.number().int().positive(),
  outcome: decisionOutcomeSchema,
  one_sentence: z.string(),
  evidence_grade: z.string(),
  reason_codes: z.array(z.string()),
  key_evidence_ids: z.array(z.string()),
  opposing_evidence_ids: z.array(z.string()),
  limitations: z.array(z.string()),
  risks: z.array(z.string()),
  next_actions: z.array(z.string()),
  policy_version: z.string(),
  approval_status: z.string(),
  generated_at: z.string(),
}).passthrough();
const pivotRevisionSchema = z.object({
  id: z.string().min(1),
  decision_id: z.string().min(1),
  target_variant_id: z.string().min(1),
  version: z.number().int().positive(),
  approval_status: z.string().min(1),
  change_variable: z.string().min(1),
  change_list: z.array(z.string()).min(1),
  retest_plan: z.array(z.string()).min(1),
  created_by: z.string().min(1),
  created_at: z.string().min(1),
}).passthrough();
const handoffSchema = z.object({
  id: z.string(),
  decision_id: z.string(),
  outcome: decisionOutcomeSchema,
  first_order_scenarios: z.array(z.record(z.unknown())).optional(),
  retest_plan: z.array(z.string()).optional(),
  blocked_reason: z.string().nullable().optional(),
  status: z.string(),
  generated_at: z.string(),
}).passthrough();
const auditEventSchema = z.object({
  id: z.string().optional(),
  event_id: z.string().optional(),
  event_type: z.string().optional(),
  action: z.string().optional(),
  actor: z.string().optional(),
  created_at: z.string().optional(),
  timestamp: z.string().optional(),
}).passthrough().refine((event) => Boolean(event.id || event.event_id), "审计事件必须包含 ID");
const agentRunSchema = z.object({
  id: z.string().min(1),
  project_id: z.string().min(1),
  mode: z.enum(["OFFLINE_REPLAY", "LIVE"]),
  operation: z.string().min(1),
  model_name: z.string().nullable(),
  reasoning_effort: z.string().nullable(),
  prompt_version: z.string().min(1),
  output_schema_version: z.string().min(1),
  recording_id: z.string().min(1).nullable(),
  duration_ms: z.number().int().nonnegative(),
  input_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  output_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  input_tokens: z.number().int().nonnegative().nullable(),
  output_tokens: z.number().int().nonnegative().nullable(),
  tracing_disabled: z.boolean(),
  api_store_disabled: z.boolean(),
  success: z.boolean(),
  fallback_reason: z.string().nullable(),
  created_at: z.string().min(1),
}).passthrough();
const objectVersionSchema = z.object({
  project_id: z.string().min(1),
  object_type: z.string().min(1),
  object_id: z.string().min(1),
  object_version: z.number().int().positive(),
  payload: z.record(z.unknown()),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  created_at: z.string().min(1),
}).passthrough();
const trialObservationSchema = z.object({
  date: z.string(),
  candidate_id: z.string(),
  variant_id: z.string(),
  arm_id: z.string(),
  channel: z.string(),
  audience_segment: z.string(),
  exposure: z.number().int().nonnegative(),
  click: z.number().int().nonnegative(),
  favorite: z.number().int().nonnegative(),
  inquiry: z.number().int().nonnegative(),
  add_to_cart: z.number().int().nonnegative(),
  purchase_intent: z.number().int().nonnegative(),
  preorder: z.number().int().nonnegative(),
  order: z.number().int().nonnegative(),
  refund: z.number().int().nonnegative(),
  return_count: z.number().int().nonnegative(),
  price_fen: z.number().int().positive(),
  spend_fen: z.number().int().nonnegative(),
}).passthrough();
const recordSchema = z.record(z.unknown());
const demoPolicySchema = z.object({
  version: z.string().min(1),
  revision: z.number().int().positive(),
  primary_metric: z.string().min(1),
  min_exposure_per_arm: z.number().int().positive(),
  min_purchase_intent_events_per_arm: z.number().int().positive(),
  expected_arm_share: z.number().gt(0).lt(1),
  srm_block_p_value: z.number().gt(0).lt(1),
  purchase_intent_rate_threshold: z.number().min(0).max(1),
  relative_uplift_threshold: z.number().nonnegative(),
  gross_margin_floor_bps: z.number().int().min(0).max(10_000),
  interest_ctr_floor: z.number().min(0).max(1),
  cart_per_click_floor: z.number().min(0).max(1),
  clearly_low_intent_rate_ceiling: z.number().min(0).max(1),
  clearly_low_ctr_ceiling: z.number().min(0).max(1),
  conflicting_return_and_refund_rate: z.number().min(0).max(1),
  modifiable_supply_budget_gap_ratio: z.number().min(0).max(1),
  modifiable_lead_time_gap_days: z.number().int().nonnegative(),
  modifiable_margin_gap_bps: z.number().int().nonnegative(),
}).passthrough();
const attachmentSchema = z.object({
  id: z.string().min(1),
  project_id: z.string().min(1),
  object_key: z.string().min(1),
  original_filename: z.string().min(1),
  mime_type: z.enum(["image/jpeg", "image/png", "image/webp"]),
  size_bytes: z.number().int().positive().max(5 * 1024 * 1024),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  rights_declaration: z.string().min(1),
  source: z.string().min(1),
  created_at: z.string().min(1),
}).passthrough();

function validatePayload<T>(schema: z.ZodType<T>, payload: unknown, label: string): T {
  const result = schema.safeParse(payload);
  if (!result.success) {
    throw new ApiError(502, `${label} 响应不符合约定 Schema，已停止展示。`);
  }
  return result.data;
}

export const api = {
  health: () => request<ApiHealthResponse>("/health", {}, 4_000),
  listScenarios: async () =>
    validatePayload(z.array(scenarioSchema), await request<unknown>("/demo/scenarios"), "场景列表") as DemoScenario[],
  listProjects: async () =>
    validatePayload(z.array(projectSchema), await request<unknown>("/projects"), "项目列表") as ProjectDetail[],
  createProjectFromScenario: (scenarioId: string) =>
    request<unknown>(`/demo/scenarios/${encodeURIComponent(scenarioId)}/projects`, {
      method: "POST",
    }).then((payload) => validatePayload(projectSchema, payload, "项目创建") as ProjectDetail),
  createDraftProject: (name: string) =>
    request<unknown>("/projects", {
      method: "POST",
      body: JSON.stringify({ name, brief: {} }),
    }).then((payload) => validatePayload(projectSchema, payload, "草稿项目创建") as ProjectDetail),
  getProject: (projectId: string) => request<unknown>(`/projects/${encodeURIComponent(projectId)}`)
    .then((payload) => validatePayload(projectSchema, payload, "项目详情") as ProjectDetail),
  updateBrief: (projectId: string, brief: ProductBrief, briefVersion: number) =>
    request<unknown>(`/projects/${encodeURIComponent(projectId)}/brief`, {
      method: "PUT",
      body: JSON.stringify(brief),
      headers: { "If-Match-Version": String(briefVersion) },
    }).then((payload) => validatePayload(projectSchema, payload, "Brief 更新") as ProjectDetail),
  normalizeBrief: (projectId: string) =>
    request<unknown>(`/projects/${encodeURIComponent(projectId)}/brief/normalize`, {
      method: "POST",
    }).then((payload) => validatePayload(projectSchema, payload, "Brief 归一化") as ProjectDetail),
  generateExperimentPlan: (projectId: string) =>
    request<unknown>(`/projects/${encodeURIComponent(projectId)}/experiment-plans:generate`, {
      method: "POST",
    }).then((payload) => validatePayload(projectSchema, payload, "实验计划生成") as ProjectDetail),
  getPolicy: (projectId: string) =>
    request<unknown>(`/projects/${encodeURIComponent(projectId)}/policy`)
      .then((payload) => validatePayload(demoPolicySchema, payload, "DemoPolicy") as DemoPolicy),
  updatePolicy: async (projectId: string, policy: DemoPolicy): Promise<ProjectDetail | DemoPolicy> => {
    const payload = await request<unknown>(`/projects/${encodeURIComponent(projectId)}/policy`, {
      method: "PUT",
      body: JSON.stringify(policy),
    });
    const project = projectSchema.safeParse(payload);
    if (project.success) return project.data as ProjectDetail;
    const nextPolicy = demoPolicySchema.safeParse(payload);
    if (nextPolicy.success) return nextPolicy.data as DemoPolicy;
    throw new ApiError(502, "DemoPolicy 更新响应不符合约定 Schema，已停止展示。");
  },
  listAttachments: (projectId: string) =>
    request<unknown>(`/projects/${encodeURIComponent(projectId)}/attachments`)
      .then((payload) => validatePayload(z.array(attachmentSchema), payload, "图片附件") as ProjectAttachment[]),
  uploadAttachment: (projectId: string, file: File, rightsDeclaration: string) => {
    const form = new FormData();
    form.set("file", file);
    form.set("rights_declaration", rightsDeclaration);
    return request<unknown>(`/projects/${encodeURIComponent(projectId)}/attachments`, {
      method: "POST",
      body: form,
    }).then((payload) => validatePayload(attachmentSchema, payload, "图片上传") as ProjectAttachment);
  },
  submitApproval: (projectId: string, body: ApprovalRequest) =>
    request<unknown>(
      `/projects/${encodeURIComponent(projectId)}/approvals`,
      { method: "POST", body: JSON.stringify(body) },
    ).then((payload) => validatePayload(recordSchema, payload, "审批") as Record<string, unknown>),
  advanceSimulation: (projectId: string, days = 1) =>
    request<unknown>(
      `/projects/${encodeURIComponent(projectId)}/simulation/advance`,
      { method: "POST", body: JSON.stringify({ days }) },
    ).then((payload) => validatePayload(recordSchema, payload, "逐日回放") as Record<string, unknown>),
  runSimulation: (projectId: string) =>
    request<unknown>(
      `/projects/${encodeURIComponent(projectId)}/simulation/run`,
      { method: "POST" },
    ).then((payload) => validatePayload(recordSchema, payload, "完整回放") as Record<string, unknown>),
  resetSimulationReplay: (projectId: string) =>
    request<unknown>(
      `/projects/${encodeURIComponent(projectId)}/simulation/replay-reset`,
      { method: "POST" },
    ).then((payload) => validatePayload(projectSchema, payload, "同项目重放重置") as ProjectDetail),
  getObservations: (projectId: string) =>
    request<unknown>(`/projects/${encodeURIComponent(projectId)}/observations`)
      .then((payload) => validatePayload(z.array(trialObservationSchema), payload, "试销观测") as TrialObservation[]),
  analyze: (projectId: string) =>
    request<unknown>(`/projects/${encodeURIComponent(projectId)}/analyze`, {
      method: "POST",
    }).then((payload) => validatePayload(z.object({
      quality: qualitySchema,
      metrics: metricsSchema,
      evidence: evidenceSchema,
      decision: decisionSchema,
    }).passthrough(), payload, "分析结果") as AnalysisBundle),
  getQuality: (projectId: string) =>
    request<unknown>(`/projects/${encodeURIComponent(projectId)}/quality`)
      .then((payload) => validatePayload(qualitySchema, payload, "质量报告") as QualityReport),
  getMetrics: (projectId: string) =>
    request<unknown>(`/projects/${encodeURIComponent(projectId)}/metrics`)
      .then((payload) => validatePayload(metricsSchema, payload, "指标报告") as MetricsReport),
  getEvidence: (projectId: string) =>
    request<unknown>(`/projects/${encodeURIComponent(projectId)}/evidence`)
      .then((payload) => validatePayload(evidenceSchema, payload, "证据卡") as EvidenceCard),
  getDecision: (projectId: string) =>
    request<unknown>(`/projects/${encodeURIComponent(projectId)}/decision`)
      .then((payload) => validatePayload(decisionSchema, payload, "决策卡") as DecisionCard),
  generatePivotRevision: (decisionId: string) =>
    request<unknown>(
      `/decision-cards/${encodeURIComponent(decisionId)}/pivot-revisions:generate`,
      { method: "POST" },
    ).then((payload) => validatePayload(pivotRevisionSchema, payload, "Pivot 修订草稿") as PivotRevision),
  approvePivotRevision: (pivotRevisionId: string, body: ApprovalRequest) =>
    request<unknown>(
      `/pivot-revisions/${encodeURIComponent(pivotRevisionId)}/approvals`,
      { method: "POST", body: JSON.stringify(body) },
    ).then((payload) => validatePayload(recordSchema, payload, "Pivot 修订审批") as Record<string, unknown>),
  approveFirstOrderAssumptions: (projectId: string, body: ApprovalRequest) =>
    request<unknown>(
      `/projects/${encodeURIComponent(projectId)}/first-order-assumptions/approvals`,
      { method: "POST", body: JSON.stringify(body) },
    ).then((payload) => validatePayload(recordSchema, payload, "首单情景假设确认") as Record<string, unknown>),
  createHandoff: (projectId: string) =>
    request<unknown>(`/projects/${encodeURIComponent(projectId)}/handoff`, {
      method: "POST",
    }).then((payload) => validatePayload(handoffSchema, payload, "交接草稿") as HandoffBundle),
  getHandoff: (projectId: string) =>
    request<unknown>(`/projects/${encodeURIComponent(projectId)}/handoff`)
      .then((payload) => validatePayload(handoffSchema, payload, "交接草稿") as HandoffBundle),
  getAuditEvents: (projectId: string) =>
    request<unknown>(`/projects/${encodeURIComponent(projectId)}/audit-events`)
      .then((payload) => validatePayload(z.array(auditEventSchema), payload, "审计事件") as AuditEvent[]),
  getAgentRuns: (projectId: string) =>
    request<unknown>(`/projects/${encodeURIComponent(projectId)}/agent-runs`)
      .then((payload) => validatePayload(z.array(agentRunSchema), payload, "Agent 运行") as AgentRun[]),
  getObjectVersions: (projectId: string) =>
    request<unknown>(`/projects/${encodeURIComponent(projectId)}/object-versions`)
      .then((payload) => validatePayload(z.array(objectVersionSchema), payload, "对象版本") as ObjectVersion[]),
  archiveProject: (
    projectId: string,
    body: { actor: string; reason: string; cancel_active_work?: boolean },
  ) => request<unknown>(`/projects/${encodeURIComponent(projectId)}:archive`, {
    method: "POST",
    body: JSON.stringify(body),
  }).then((payload) => validatePayload(projectSchema, payload, "项目归档") as ProjectDetail),
};

export function attachmentContentUrl(projectId: string, attachmentId: string): string {
  return `${API_BASE_URL}/projects/${encodeURIComponent(projectId)}/attachments/${encodeURIComponent(attachmentId)}/content`;
}

export function reportUrl(projectId: string): string {
  return `${API_BASE_URL}/projects/${encodeURIComponent(projectId)}/report`;
}

export function getErrorMessage(error: unknown): string {
  if (error instanceof ApiError || error instanceof ApiUnavailableError) {
    return error.message.trim();
  }
  return "操作未完成，请稍后重试。";
}
