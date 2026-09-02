import type {
  DataStatus,
  DecisionCard,
  DecisionOutcome,
  JsonValue,
  PivotRevision,
  ProjectDetail,
} from "@/lib/types";

export function asRecord(value: unknown): Record<string, JsonValue> | undefined {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, JsonValue>;
  }
  return undefined;
}

export function asArray(value: unknown): JsonValue[] {
  return Array.isArray(value) ? (value as JsonValue[]) : [];
}

export function pickValue(
  record: Record<string, unknown> | undefined,
  keys: string[],
): unknown {
  if (!record) return undefined;
  for (const key of keys) {
    const value = record[key];
    if (value !== undefined && value !== null && value !== "") return value;
  }
  return undefined;
}

export function pickString(
  record: Record<string, unknown> | undefined,
  keys: string[],
  fallback = "—",
): string {
  const value = pickValue(record, keys);
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return fallback;
}

export function pickNumber(
  record: Record<string, unknown> | undefined,
  keys: string[],
): number | undefined {
  const value = pickValue(record, keys);
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) {
    return Number(value);
  }
  return undefined;
}

export function formatCompactNumber(value: number | undefined): string {
  if (value === undefined) return "—";
  return new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 1 }).format(value);
}

export function formatPercent(value: number | undefined): string {
  if (value === undefined) return "—";
  const normalized = value * 100;
  return `${normalized.toFixed(normalized >= 10 ? 1 : 2)}%`;
}

export function formatCurrency(value: number | undefined): string {
  if (value === undefined) return "—";
  return new Intl.NumberFormat("zh-CN", {
    style: "currency",
    currency: "CNY",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
}

export function formatDateTime(value?: string): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

export function outcomeOf(decision?: DecisionCard): DecisionOutcome | undefined {
  return decision?.outcome ?? decision?.decision;
}

export const outcomeMeta: Record<
  DecisionOutcome,
  { label: string; short: string; description: string; tone: string }
> = {
  GO: {
    label: "GO · 建议推进",
    short: "GO",
    description: "需求证据、经营约束与供应条件达到当前策略门槛。",
    tone: "go",
  },
  PIVOT: {
    label: "PIVOT · 调整复测",
    short: "PIVOT",
    description: "存在可定位、可修改的问题，建议调整后再次验证。",
    tone: "pivot",
  },
  NO_GO: {
    label: "NO-GO · 暂停投入",
    short: "NO-GO",
    description: "在当前目标与约束下，不建议继续投入。",
    tone: "no-go",
  },
  EVIDENCE_INSUFFICIENT: {
    label: "证据不足 · 暂不判断",
    short: "证据不足",
    description: "数据量、质量或实验设计不足，系统拒绝给出强结论。",
    tone: "insufficient",
  },
};

export const dataStatusMeta: Record<DataStatus, { label: string; description: string }> = {
  SYNTHETIC: { label: "SYNTHETIC", description: "合成演示数据" },
  PUBLIC_SAMPLE: { label: "PUBLIC SAMPLE", description: "公开许可样例" },
  USER_PROVIDED: { label: "USER PROVIDED", description: "用户上传，授权未核验" },
  ENTERPRISE_AUTHORIZED: {
    label: "ENTERPRISE AUTHORIZED",
    description: "企业授权数据",
  },
};

export function projectBrief(project?: ProjectDetail) {
  return project?.brief ?? project?.product_brief;
}

export function projectQuality(project?: ProjectDetail) {
  return project?.quality ?? project?.quality_report ?? project?.artifacts?.quality ?? project?.artifacts?.quality_report;
}

export function projectEvidence(project?: ProjectDetail) {
  return project?.evidence ?? project?.evidence_card ?? project?.artifacts?.evidence ?? project?.artifacts?.evidence_card;
}

export function projectDecision(project?: ProjectDetail) {
  return project?.decision ?? project?.decision_card ?? project?.artifacts?.decision ?? project?.artifacts?.decision_card;
}

export function projectMetrics(project?: ProjectDetail) {
  return project?.metrics ?? project?.artifacts?.metrics;
}

export function projectHandoff(project?: ProjectDetail) {
  return project?.handoff ?? project?.artifacts?.handoff;
}

export function projectPivotRevision(project?: ProjectDetail): PivotRevision | undefined {
  return project?.pivot_revision ?? project?.artifacts?.pivot_revision;
}

export function pivotRevisionIsApproved(project?: ProjectDetail): boolean {
  return projectPivotRevision(project)?.approval_status?.toUpperCase() === "APPROVED";
}

export function experimentIsApproved(project?: ProjectDetail): boolean {
  const approval = project?.experiment_plan?.approval_status?.toUpperCase();
  return approval === "APPROVED" || approval === "APPROVE";
}

export function decisionIsApproved(project?: ProjectDetail): boolean {
  const approval = projectDecision(project)?.approval_status?.toUpperCase();
  return approval === "APPROVED" || approval === "APPROVE";
}

export function humanizeKey(key: string): string {
  const labels: Record<string, string> = {
    product_name: "产品名称",
    candidate_id: "候选款编号",
    category: "品类",
    target_audience: "目标人群",
    usage_scenario: "使用场景",
    season: "季节",
    target_price: "目标零售价",
    estimated_cost: "预计成本",
    moq: "最小起订量",
    lead_time_days: "期望交期",
    trial_budget: "试销预算",
    core_selling_points: "核心卖点",
    objective: "实验目标",
    primary_metric: "主指标",
    secondary_metrics: "辅助指标",
    channel: "试销渠道",
    duration_days: "实验周期",
    target_sample_size: "建议样本量",
    budget: "预算上限",
    stop_rules: "停止规则",
    material: "材料方向",
    colors: "颜色",
    size_range: "尺码范围",
    target_cost: "目标成本",
    target_retail_price: "目标零售价",
    status: "状态",
  };
  return labels[key] ?? key.replaceAll("_", " ");
}

export function stringifyValue(value: unknown): string {
  if (value === null || value === undefined || value === "") return "待确认";
  if (Array.isArray(value)) return value.map((item) => stringifyValue(item)).join("、");
  if (typeof value === "object") return JSON.stringify(value, null, 2);
  return String(value);
}
