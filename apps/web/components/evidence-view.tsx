"use client";

import Link from "next/link";
import {
  AlertOctagon,
  ArrowRight,
  BarChart3,
  CheckCircle2,
  CircleHelp,
  FileCheck2,
  Fingerprint,
  PlayCircle,
  ShieldAlert,
  ShieldCheck,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { useProject } from "@/components/project-context";
import {
  ActionMessage,
  Button,
  EmptyState,
  PageHeading,
  SectionHeading,
  StatusPill,
  Surface,
} from "@/components/ui";
import { api, getErrorMessage } from "@/lib/api";
import {
  formatCompactNumber,
  formatCurrency,
  formatPercent,
  pickNumber,
  projectEvidence,
  projectMetrics,
  projectQuality,
  stringifyValue,
} from "@/lib/presentation";
import type { EvidenceCard, EvidenceItem, MetricsReport, QualityIssue, QualityReport } from "@/lib/types";
import { STATIC_PREVIEW_ENABLED } from "@/lib/static-preview-mode";

export function EvidenceView() {
  const { projectId, project, refresh } = useProject();
  const [quality, setQuality] = useState<QualityReport | undefined>(() => projectQuality(project));
  const [metrics, setMetrics] = useState<MetricsReport | undefined>(() => projectMetrics(project));
  const [evidence, setEvidence] = useState<EvidenceCard | undefined>(() => projectEvidence(project));
  const [loadingArtifacts, setLoadingArtifacts] = useState(false);
  const [analyzing, setAnalyzing] = useState(false);
  const [message, setMessage] = useState<{ tone: "success" | "error" | "info"; text: string }>();

  const loadArtifacts = useCallback(async () => {
    setLoadingArtifacts(true);
    const results = await Promise.allSettled([
      api.getQuality(projectId),
      api.getMetrics(projectId),
      api.getEvidence(projectId),
    ]);
    if (results[0].status === "fulfilled") setQuality(results[0].value);
    if (results[1].status === "fulfilled") setMetrics(results[1].value);
    if (results[2].status === "fulfilled") setEvidence(results[2].value);
    setLoadingArtifacts(false);
  }, [projectId]);

  useEffect(() => {
    setQuality(projectQuality(project));
    setMetrics(projectMetrics(project));
    setEvidence(projectEvidence(project));
    void loadArtifacts();
  }, [loadArtifacts, project]);

  const analyze = async () => {
    setAnalyzing(true);
    setMessage(undefined);
    try {
      const bundle = await api.analyze(projectId);
      setQuality(bundle.quality);
      setMetrics(bundle.metrics);
      setEvidence(bundle.evidence);
      await refresh();
      setMessage({ tone: "success", text: "确定性质检、指标计算和证据归纳已完成。" });
    } catch (caught) {
      setMessage({ tone: "error", text: getErrorMessage(caught) });
    } finally {
      setAnalyzing(false);
    }
  };

  const qualityStatus = (quality?.status ?? quality?.quality_status ?? "PENDING").toUpperCase();
  const qualityTone = qualityStatus.includes("PASS")
    ? "good"
    : qualityStatus.includes("BLOCK") || qualityStatus.includes("REJECT")
      ? "danger"
      : "warn";
  const issues = normalizeIssues(quality);
  const evidenceItems = normalizeEvidence(evidence);
  const hasArtifacts = Boolean(quality || metrics || evidence);

  return (
    <>
      <PageHeading
        eyebrow="04 · Quality & evidence"
        title="先审数据，再谈结论"
        description="漏斗、阈值和区间由确定性工具计算；Agent 只解释结构化结果，并同时展示支持证据、反向证据和限制。"
        actions={
          <>
            <Button onClick={() => void analyze()} loading={analyzing} disabled={loadingArtifacts}>
              <PlayCircle className="size-4" /> 执行质检与分析
            </Button>
            <Link className="button button--secondary" href={`/projects/${projectId}/decision`}>
              查看决策卡 <ArrowRight className="size-4" />
            </Link>
          </>
        }
      />

      {message ? <ActionMessage tone={message.tone}>{message.text}</ActionMessage> : null}

      {!hasArtifacts && !loadingArtifacts ? (
        <EmptyState
          icon={<CircleHelp className="size-5" />}
          title="尚未生成质量报告与证据卡"
          description={STATIC_PREVIEW_ENABLED ? "完成固定场景的逐日回放后，点击“执行质检与分析”。浏览器内的同一门禁会在数据不足时拒绝强结论。" : "完成固定场景的逐日回放后，点击“执行质检与分析”。若数据不满足要求，后端会阻断强结论。"}
          action={<Button onClick={() => void analyze()} loading={analyzing}><PlayCircle className="size-4" /> 开始分析</Button>}
        />
      ) : null}

      {hasArtifacts ? (
        <div className="stack mt-5">
          <Surface className={`quality-banner quality-banner--${qualityTone}`}>
            <div className="quality-banner__icon">
              {qualityTone === "good" ? <ShieldCheck className="size-6" /> : qualityTone === "danger" ? <AlertOctagon className="size-6" /> : <ShieldAlert className="size-6" />}
            </div>
            <div className="min-w-0 flex-1">
              <p>DATA QUALITY GATE</p>
              <h2>{qualityStatus === "PENDING" ? "质量状态待返回" : qualityStatus}</h2>
              <span>{quality?.summary ?? (STATIC_PREVIEW_ENABLED ? "质量状态来自浏览器内固定场景校验。" : "质量状态直接来自后端校验结果。")}</span>
            </div>
            <div className="quality-banner__meta">
              <small>SCHEMA</small>
              <strong>{quality?.schema_version ?? quality?.rule_version ?? "—"}</strong>
              <small>{issues.length} 项告警 / 问题</small>
            </div>
          </Surface>

          <div className="content-grid">
            <div className="stack">
              <Surface className="panel-pad">
                <SectionHeading
                  title="试销漏斗"
                  description={STATIC_PREVIEW_ENABLED ? "可视化只使用浏览器内固定合成计数；条形长度相对本组最大计数归一化。" : "可视化只使用 API 返回值；条形长度相对本组最大计数归一化。"}
                  action={<StatusPill tone="info"><BarChart3 className="size-3.5" /> 确定性计算</StatusPill>}
                />
                <FunnelChart metrics={metrics} />
              </Surface>
              <Surface className="panel-pad">
                <SectionHeading title="关键比率与经营量" description="百分比和金额未返回时显示为“—”，不会估算。" />
                <MetricTiles metrics={metrics} />
              </Surface>
              <Surface className="panel-pad">
                <SectionHeading title="Evidence Card" description="每条理由都应指向真实字段、规则或来源引用。" />
                {evidenceItems.length ? (
                  <div className="evidence-list">
                    {evidenceItems.map((item, index) => <EvidenceRow item={item} index={index} key={item.id ?? `${item.title}-${index}`} />)}
                  </div>
                ) : <p className="mono-note">{STATIC_PREVIEW_ENABLED ? "当前固定录制尚未生成证据条目。" : "API 尚未返回可展示的证据条目。"}</p>}
              </Surface>
            </div>

            <aside className="stack">
              <Surface className="panel-pad">
                <SectionHeading title="质量问题" description="BLOCK 会阻止系统给出 Go 或 No-Go。" />
                {issues.length ? (
                  <div className="issue-list">
                    {issues.map((issue, index) => <IssueRow issue={issue} index={index} key={`${issue.code}-${index}`} />)}
                  </div>
                ) : (
                  <div className="verified-empty"><CheckCircle2 className="size-5" /><span><strong>未返回质量问题</strong><small>仅表示当前校验器未发现告警。</small></span></div>
                )}
              </Surface>
              <Surface className="panel-pad">
                <SectionHeading title="证据边界" />
                <div className="evidence-grade">
                  <div><small>充分程度</small><strong>{evidence?.evidence_grade ?? "—"}</strong></div>
                  <div><small>推断强度</small><strong>{evidence?.claim_type ?? (evidenceItems.map((item) => item.inference_strength).filter(Boolean).join(" / ") || "—")}</strong></div>
                </div>
                <div className="divider" />
                <p className="mono-note">充分度 A–D 与因果/准实验/相关性是两个独立维度，不能合并为“准确率”。</p>
                {evidence?.limitations?.length ? (
                  <ul className="plain-list mt-4">
                    {evidence.limitations.map((limitation) => <li key={limitation}>{limitation}</li>)}
                  </ul>
                ) : null}
              </Surface>
              <div className="callout">
                <Fingerprint className="mb-2 size-5 text-[var(--teal)]" />
                <strong>证据可追溯</strong>
                <p>决策卡将绑定数据状态、文件摘要、规则版本与分析结果；文字解释不能改写数值。</p>
              </div>
            </aside>
          </div>
        </div>
      ) : null}
    </>
  );
}

function normalizeIssues(quality?: QualityReport): QualityIssue[] {
  if (Array.isArray(quality?.issues)) return quality.issues;
  if (Array.isArray(quality?.checks)) {
    return quality.checks
      .filter((check) => String(check.status ?? "").toUpperCase() !== "PASS")
      .map((check) => ({
        code: String(check.code ?? check.name ?? "QUALITY_CHECK"),
        severity: String(check.severity ?? check.status ?? "WARN"),
        message: String(check.message ?? check.description ?? "质量检查未通过"),
        impact: typeof check.impact === "string" ? check.impact : undefined,
      }));
  }
  return [];
}

function normalizeEvidence(evidence?: EvidenceCard): EvidenceItem[] {
  if (Array.isArray(evidence?.items)) return evidence.items;
  if (Array.isArray(evidence?.claims)) return evidence.claims;
  const raw = evidence?.evidence_items;
  return Array.isArray(raw) ? (raw as unknown as EvidenceItem[]) : [];
}

function funnelRecord(metrics?: MetricsReport): Record<string, unknown> | undefined {
  if (metrics?.funnel) return metrics.funnel;
  if (Array.isArray(metrics?.variants) && metrics.variants.length > 0) {
    const sum = (keys: string[]) => metrics.variants?.reduce(
      (total, row) => total + (pickNumber(row, keys) ?? 0),
      0,
    ) ?? 0;
    return {
      exposure: sum(["exposure"]),
      click: sum(["click"]),
      favorite: sum(["favorite"]),
      add_to_cart: sum(["add_to_cart"]),
      purchase_intent: sum(["purchase_intent"]),
      spend_fen: sum(["spend_fen"]),
      overall_intent_rate: metrics.overall_intent_rate,
      relative_intent_uplift: metrics.relative_intent_uplift,
      total_exposure: metrics.total_exposure,
      total_intent: metrics.total_intent,
    };
  }
  const overall = metrics?.overall;
  if (overall && typeof overall === "object" && !Array.isArray(overall)) return overall as Record<string, unknown>;
  return metrics as Record<string, unknown> | undefined;
}

function FunnelChart({ metrics }: { metrics?: MetricsReport }) {
  const record = funnelRecord(metrics);
  const stages = [
    { label: "曝光", keys: ["exposure", "impressions"] },
    { label: "点击", keys: ["click", "clicks"] },
    { label: "收藏", keys: ["favorite", "favorites"] },
    { label: "加购", keys: ["add_to_cart", "cart"] },
    { label: "购买意向", keys: ["purchase_intent", "total_intent"] },
  ].map((stage) => ({ ...stage, value: pickNumber(record, stage.keys) }));
  const available = stages.filter((stage) => stage.value !== undefined);
  if (!available.length) {
    return <div className="chart-empty"><BarChart3 className="size-5" /><span>{STATIC_PREVIEW_ENABLED ? "固定录制尚未生成漏斗计数" : "API 尚未返回漏斗计数"}</span></div>;
  }
  const max = Math.max(1, ...available.map((stage) => stage.value ?? 0));
  const chartData = available.map((stage) => ({
    label: stage.label,
    value: stage.value ?? 0,
    relative: Math.max(4, ((stage.value ?? 0) / max) * 100),
  }));
  return (
    <div className="funnel-visual">
      <div className="funnel-rechart" role="img" aria-label="试销漏斗各阶段聚合计数条形图">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart accessibilityLayer data={chartData} layout="vertical" margin={{ top: 4, right: 24, bottom: 4, left: 4 }}>
            <CartesianGrid stroke="#E7E2D8" horizontal={false} />
            <XAxis type="number" tick={{ fill: "#6B756F", fontSize: 10 }} axisLine={false} tickLine={false} />
            <YAxis type="category" dataKey="label" width={72} tick={{ fill: "#34445A", fontSize: 11, fontWeight: 700 }} axisLine={false} tickLine={false} />
            <Tooltip cursor={{ fill: "#F4F1E9" }} contentStyle={{ border: "1px solid #DCD7CD", borderRadius: 8, fontSize: 11 }} />
            <Bar dataKey="value" name="聚合计数" fill="#1E756E" radius={[0, 5, 5, 0]} barSize={17} />
          </BarChart>
        </ResponsiveContainer>
      </div>
      <table className="sr-only">
        <caption>试销漏斗计数</caption>
        <thead><tr><th>阶段</th><th>计数</th></tr></thead>
        <tbody>{chartData.map((row) => <tr key={row.label}><th>{row.label}</th><td>{row.value}</td></tr>)}</tbody>
      </table>
    </div>
  );
}

function MetricTiles({ metrics }: { metrics?: MetricsReport }) {
  const record = funnelRecord(metrics);
  const spendFen = pickNumber(record, ["spend_fen"]);
  const definitions = [
    { label: "总体意向率", value: formatPercent(metrics?.overall_intent_rate ?? pickNumber(record, ["overall_intent_rate"])) },
    { label: "相对意向提升", value: formatPercent(metrics?.relative_intent_uplift ?? pickNumber(record, ["relative_intent_uplift"])) },
    { label: "总曝光", value: formatCompactNumber(metrics?.total_exposure ?? pickNumber(record, ["total_exposure", "exposure"])) },
    { label: "总意向", value: formatCompactNumber(metrics?.total_intent ?? pickNumber(record, ["total_intent"])) },
    { label: "总试销花费", value: formatCurrency(spendFen === undefined ? undefined : spendFen / 100) },
    { label: "规则版本", value: metrics?.metric_version ?? "—" },
  ];
  return <div className="metric-tiles">{definitions.map((metric) => <div key={metric.label}><span>{metric.label}</span><strong>{metric.value}</strong></div>)}</div>;
}

function IssueRow({ issue, index }: { issue: QualityIssue; index: number }) {
  const severity = String(issue.severity ?? "WARN").toUpperCase();
  const tone = severity.includes("BLOCK") ? "danger" : severity.includes("INFO") ? "info" : "warn";
  return (
    <div className="issue-row">
      <StatusPill tone={tone}>{severity}</StatusPill>
      <div>
        <strong>{issue.code ?? `CHECK-${index + 1}`}</strong>
        <p>{issue.message ?? "质量检查告警"}</p>
        {issue.impact ? <small>影响：{issue.impact}</small> : null}
        {issue.affected_fields?.length ? <small>字段：{issue.affected_fields.join(" · ")}</small> : null}
        {issue.record_refs?.length ? <small>记录：{issue.record_refs.join(" · ")}</small> : null}
        {issue.observed !== null && issue.observed !== undefined ? <small>观测：{stringifyValue(issue.observed)}</small> : null}
        {issue.expected !== null && issue.expected !== undefined ? <small>期望：{stringifyValue(issue.expected)}</small> : null}
        {issue.handling_status ? <small>处理状态：{issue.handling_status}</small> : null}
      </div>
    </div>
  );
}

function EvidenceRow({ item, index }: { item: EvidenceItem; index: number }) {
  const direction = String(item.stance ?? item.direction ?? "NEUTRAL").toUpperCase();
  const tone = direction.includes("SUPPORT") ? "good" : direction.includes("OPPOSE") ? "danger" : "neutral";
  const traceRefs = [...(item.metric_refs ?? []), ...(item.source_refs ?? [])];
  if (item.source_ref) traceRefs.push(item.source_ref);
  return (
    <article className="evidence-row">
      <div className="evidence-row__index">E{String(index + 1).padStart(2, "0")}</div>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <StatusPill tone={tone}>{direction}</StatusPill>
          <span className="mono-note">陈述 {item.statement_type ?? item.kind ?? "OBSERVED"}</span>
          <span className="mono-note">推断 {item.inference_strength ?? "UNDETERMINED"}</span>
          <span className="mono-note">证据 {item.evidence_grade ?? "D"}</span>
        </div>
        <h3>{item.title ?? item.statement ?? "未命名证据"}</h3>
        {item.title && item.statement ? <p>{item.statement}</p> : null}
        <div className="evidence-row__source"><FileCheck2 className="size-3.5" /> {traceRefs.join(" · ") || "来源引用未返回"}</div>
        {item.counterexamples?.length ? <p className="mono-note">反例：{item.counterexamples.join("；")}</p> : null}
        {item.limitations?.length ? <p className="mono-note">限制：{item.limitations.join("；")}</p> : null}
      </div>
    </article>
  );
}
