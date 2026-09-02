"use client";

import Link from "next/link";
import {
  Archive,
  ArrowRight,
  Boxes,
  CircleHelp,
  ClipboardCheck,
  ExternalLink,
  Factory,
  FileWarning,
  PackageCheck,
  ShieldAlert,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { ApprovalPanel } from "@/components/approval-panel";
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
import { api, getErrorMessage, reportUrl } from "@/lib/api";
import {
  decisionIsApproved,
  formatDateTime,
  humanizeKey,
  outcomeOf,
  projectDecision,
  projectHandoff,
  projectPivotRevision,
  stringifyValue,
} from "@/lib/presentation";
import type { FirstOrderScenario, HandoffBundle, JsonValue, PivotRevision } from "@/lib/types";

interface TechPackFieldView {
  name: string;
  value?: string | null;
  status: "CONFIRMED" | "USER_PROVIDED" | "PENDING_CONFIRMATION" | "UNKNOWN";
  source_ref?: string | null;
}

interface TechPackView {
  title?: string;
  fields?: TechPackFieldView[];
  warnings?: string[];
  status?: string;
}

export function HandoffView() {
  const { projectId, project, refresh } = useProject();
  const [handoff, setHandoff] = useState<HandoffBundle | undefined>(() => projectHandoff(project));
  const [pivotRevision, setPivotRevision] = useState<PivotRevision | undefined>(() => projectPivotRevision(project));
  const [generating, setGenerating] = useState(false);
  const [generatingRevision, setGeneratingRevision] = useState(false);
  const [message, setMessage] = useState<{ tone: "success" | "error" | "info"; text: string }>();
  const decision = projectDecision(project);
  const outcome = outcomeOf(decision);
  const approved = decisionIsApproved(project);
  const revisionApproved = pivotRevision?.approval_status === "APPROVED";
  const assumptions = project?.brief?.first_order_assumptions;
  const assumptionsConfirmation = project?.first_order_assumptions_confirmation;
  const assumptionsConfirmed = Boolean(
    assumptionsConfirmation
    && assumptionsConfirmation.brief_version === project?.brief_version,
  );
  const canGenerate = approved
    && assumptionsConfirmed
    && (outcome === "GO" || (outcome === "PIVOT" && revisionApproved));

  const load = useCallback(async () => {
    try {
      setHandoff(await api.getHandoff(projectId));
    } catch {
      // A missing artifact is an expected gated state and is shown below.
    }
  }, [projectId]);

  useEffect(() => {
    setHandoff(projectHandoff(project));
    setPivotRevision(projectPivotRevision(project));
    void load();
  }, [load, project]);

  const generate = async () => {
    setGenerating(true);
    setMessage(undefined);
    try {
      const bundle = await api.createHandoff(projectId);
      setHandoff(bundle);
      await refresh();
      setMessage({ tone: "success", text: outcome === "PIVOT" ? "条件式交接草稿已生成。" : "工厂交接草稿已生成。" });
    } catch (caught) {
      setMessage({ tone: "error", text: getErrorMessage(caught) });
    } finally {
      setGenerating(false);
    }
  };

  const generateRevision = async () => {
    if (!decision?.id) return;
    setGeneratingRevision(true);
    setMessage(undefined);
    try {
      const revision = await api.generatePivotRevision(decision.id);
      setPivotRevision(revision);
      await refresh();
      setMessage({ tone: "success", text: `PivotRevision v${revision.version} 修订草稿已生成，等待针对该版本的人工审批。` });
    } catch (caught) {
      setMessage({ tone: "error", text: getErrorMessage(caught) });
    } finally {
      setGeneratingRevision(false);
    }
  };

  const scenarios = handoff?.first_order_scenarios ?? handoff?.first_order_recommendation?.scenarios ?? [];
  const retestPlan = handoff?.retest_plan ?? [];

  return (
    <>
      <PageHeading
        eyebrow="06 · Factory handoff"
        title="把决策变成可执行草稿"
        description="GO 生成 TechPack Lite、打样任务和首单情景；PIVOT 只生成改款打样草稿、复测计划与带水印的条件式首单情景。所有输出仍是非生产指令。"
        actions={
          <>
            {outcome === "PIVOT" && !revisionApproved ? (
              <Button
                onClick={() => void generateRevision()}
                loading={generatingRevision}
                disabled={!approved || pivotRevision?.approval_status === "PENDING"}
              >
                <ClipboardCheck className="size-4" />
                {pivotRevision?.approval_status === "PENDING" ? "等待修订审批" : "生成 Pivot 修订草稿"}
              </Button>
            ) : (
              <Button onClick={() => void generate()} loading={generating} disabled={!canGenerate}>
                <PackageCheck className="size-4" /> {outcome === "PIVOT" ? "生成条件式交接" : "生成交接草稿"}
              </Button>
            )}
            <Link className="button button--secondary" href={`/projects/${projectId}/audit`}>
              查看审计 <ArrowRight className="size-4" />
            </Link>
          </>
        }
      />

      <div className="handoff-guardrail">
        <ShieldAlert className="size-5" />
        <div><strong>非生产指令</strong><span>本页不会向工厂发送文件、创建采购单或触发真实订单。</span></div>
        <StatusPill tone={approved ? "good" : "warn"}>{approved ? "当前决策已批准" : "等待决策审批"}</StatusPill>
        {outcome === "PIVOT" ? (
          <StatusPill tone={revisionApproved ? "good" : "warn"}>
            {pivotRevision ? `修订 v${pivotRevision.version} ${revisionApproved ? "已批准" : "待审批"}` : "尚未生成修订"}
          </StatusPill>
        ) : null}
        {outcome === "GO" || outcome === "PIVOT" ? (
          <StatusPill tone={assumptionsConfirmed ? "good" : "warn"}>
            {assumptionsConfirmed
              ? `首单假设已由 ${assumptionsConfirmation?.actor} 确认`
              : assumptions
                ? "首单假设待人工确认"
                : "首单假设提案缺失"}
          </StatusPill>
        ) : null}
      </div>

      {message ? <ActionMessage tone={message.tone}>{message.text}</ActionMessage> : null}

      {outcome === "PIVOT" && pivotRevision ? (
        <div className="stack mt-5">
          <RecordCard
            title={`PivotRevision v${pivotRevision.version}`}
            description="当前精确修订版本；审批 DecisionCard 不等于审批本修订。"
            icon={<ClipboardCheck className="size-5" />}
            record={pivotRevision as unknown as Record<string, JsonValue>}
          />
          {pivotRevision.approval_status === "PENDING" ? (
            <ApprovalPanel
              gate="PIVOT_REVISION"
              title={`人工审批 PivotRevision v${pivotRevision.version}`}
              description="审批只对当前精确版本生效；产生新版本后必须重新审批。"
            />
          ) : revisionApproved ? (
            <ActionMessage tone="success">修订方案已针对精确版本批准，可生成条件式打样与首单情景草稿。</ActionMessage>
          ) : (
            <ActionMessage tone="info">当前修订审批已结束且未通过；请生成新版本后重新审批。</ActionMessage>
          )}
        </div>
      ) : null}

      {approved && (outcome === "GO" || (outcome === "PIVOT" && revisionApproved)) && assumptions ? (
        <div className="stack mt-5">
          <RecordCard
            title={`首单情景假设提案 · Brief v${project?.brief_version ?? "?"}`}
            description="这些数值只是演示提案；系统不会把预置值冒充人工确认。"
            icon={<ClipboardCheck className="size-5" />}
            record={assumptions as unknown as Record<string, JsonValue>}
          />
          {!assumptionsConfirmed ? (
            <ApprovalPanel
              gate="FIRST_ORDER_ASSUMPTIONS"
              title="人工确认首单情景假设"
              description="请当前操作者复核意向转订单率、计划触达量和包装步长。确认只对当前 Brief 版本有效。"
              approveLabel="确认当前版本假设"
            />
          ) : (
            <ActionMessage tone="success">
              {assumptionsConfirmation?.actor} 已于 {formatDateTime(assumptionsConfirmation?.confirmed_at)} 确认 Brief v{assumptionsConfirmation?.brief_version} 的首单情景假设。
            </ActionMessage>
          )}
        </div>
      ) : null}

      {approved && (outcome === "GO" || outcome === "PIVOT") && !assumptions ? (
        <ActionMessage tone="error">
          当前 Brief 没有首单情景假设提案；系统已阻断交接生成。
        </ActionMessage>
      ) : null}

      {!handoff ? (
        <div className="mt-5">
          <EmptyState
            icon={<CircleHelp className="size-5" />}
            title={canGenerate ? "尚未生成下游草稿" : "交接门尚未满足"}
            description={
              canGenerate
                ? "点击上方按钮，由后端根据已批准决策生成结构化草稿。"
                : approved && (outcome === "GO" || outcome === "PIVOT") && !assumptions
                  ? "当前 Brief 缺少首单情景假设提案，后端会拒绝生成交接物。"
                : approved && (outcome === "GO" || outcome === "PIVOT") && !assumptionsConfirmed
                  ? "先由当前操作者确认绑定到当前 Brief 版本的首单情景假设；未确认时后端也会拒绝生成。"
                : outcome === "PIVOT" && approved
                  ? "先生成 PivotRevision，再由人工审批当前精确版本；DecisionCard 审批不能替代修订审批。"
                : outcome === "EVIDENCE_INSUFFICIENT"
                  ? "证据不足不能进入生产交接，请先补充数据。"
                  : "只有已批准的 GO 或 PIVOT 决策可以进入本页后续动作。"
            }
          />
        </div>
      ) : (
        <div className="stack mt-5">
          <Surface className="handoff-summary">
            <div>
              <p>HANDOFF ARTIFACT</p>
              <h2>{outcome === "PIVOT" ? "复测任务草稿" : "工厂交接包草稿"}</h2>
              <span>生成时间 {formatDateTime(handoff.generated_at)}</span>
            </div>
            <StatusPill tone="warn"><Archive className="size-3.5" /> {handoff.status ?? "DRAFT"}</StatusPill>
          </Surface>

          {handoff.watermark ? (
            <div className="callout callout--warn"><ShieldAlert className="mb-2 size-5 text-[var(--amber)]" /><strong>{handoff.watermark}</strong></div>
          ) : null}

          {handoff.blocked_reason ? (
            <div className="callout callout--danger"><FileWarning className="mb-2 size-5 text-[var(--red)]" /><strong>交接已阻断</strong><p>{handoff.blocked_reason}</p></div>
          ) : null}

          {retestPlan.length ? (
            <Surface className="panel-pad">
              <SectionHeading title="下一轮复测计划" description="PIVOT 不创建可执行生产资料，只形成经证据支持的改款打样草稿、复测任务和条件式情景。" />
              <ol className="numbered-list">{retestPlan.map((item, index) => <li key={`${item}-${index}`}><span>{index + 1}</span><span>{item}</span></li>)}</ol>
            </Surface>
          ) : null}

          <div className="content-grid">
            <div className="stack">
              {handoff.techpack_lite ?? handoff.techpack ? (
                <TechPackCard techpack={(handoff.techpack_lite ?? handoff.techpack) as TechPackView} />
              ) : null}
              {handoff.sample_task ? (
                <RecordCard title="打样任务" description="任务仍为草稿，不会自动发送工厂。" icon={<Factory className="size-5" />} record={handoff.sample_task} />
              ) : null}
            </div>
            <aside className="stack">
              <Surface className="panel-pad">
                <SectionHeading title="首单三情景" description="三个离散计算点整体形成情景范围，不是销量预测或置信区间。" />
                {scenarios.length ? <OrderScenarios scenarios={scenarios} /> : <p className="mono-note">当前交接不包含首单情景。</p>}
              </Surface>
              <Surface className="panel-pad">
                <SectionHeading title="完整决策报告" description="由 API 生成 HTML，包含来源、规则、限制与审批记录。" />
                <a className="button button--secondary w-full" href={reportUrl(projectId)} target="_blank" rel="noreferrer">
                  <ExternalLink className="size-4" /> 打开 HTML 报告
                </a>
              </Surface>
              <div className="callout callout--warn">
                <ClipboardCheck className="mb-2 size-5 text-[var(--amber)]" />
                <strong>仍需业务复核</strong>
                <p>材料、鞋楦、工艺和尺码字段未经鞋企专家确认前，不得直接用于生产。</p>
              </div>
            </aside>
          </div>
        </div>
      )}
    </>
  );
}

function TechPackCard({ techpack }: { techpack: TechPackView }) {
  const fields = techpack.fields ?? [];
  return (
    <Surface className="panel-pad">
      <SectionHeading
        title="TechPack Lite"
        description="轻量化鞋类打样字段；没有可追溯输入的值统一显示“待确认”。"
        action={<span className="record-card__icon"><Boxes className="size-5" /></span>}
      />
      {techpack.title ? <p className="mono-note">{techpack.title}</p> : null}
      <dl className="record-grid mt-4">
        {fields.map((field) => {
          const pending = field.status === "PENDING_CONFIRMATION" || field.status === "UNKNOWN";
          return (
            <div key={field.name}>
              <dt>{field.name}</dt>
              <dd className={pending ? "is-unknown" : ""}>{pending ? "待确认" : stringifyValue(field.value)}</dd>
              <small>{techPackStatusLabel(field.status)}{field.source_ref ? ` · ${field.source_ref}` : ""}</small>
            </div>
          );
        })}
      </dl>
      {techpack.warnings?.length ? (
        <ul className="plain-list mt-4">
          {techpack.warnings.map((warning) => <li key={warning}>{warning}</li>)}
        </ul>
      ) : null}
      <StatusPill tone="warn"><Archive className="size-3.5" /> {techpack.status ?? "DRAFT_NOT_SENT"}</StatusPill>
    </Surface>
  );
}

function techPackStatusLabel(status: TechPackFieldView["status"]): string {
  const labels: Record<TechPackFieldView["status"], string> = {
    CONFIRMED: "已确认",
    USER_PROVIDED: "用户提供",
    PENDING_CONFIRMATION: "待确认",
    UNKNOWN: "待确认",
  };
  return labels[status];
}

function RecordCard({
  title,
  description,
  icon,
  record,
}: {
  title: string;
  description: string;
  icon: React.ReactNode;
  record: Record<string, JsonValue>;
}) {
  const entries = Object.entries(record).filter(([key]) => !["id", "created_at", "updated_at"].includes(key));
  return (
    <Surface className="panel-pad">
      <SectionHeading title={title} description={description} action={<span className="record-card__icon">{icon}</span>} />
      <dl className="record-grid">
        {entries.map(([key, value]) => (
          <div key={key}><dt>{humanizeKey(key)}</dt><dd className={value === null || value === "" ? "is-unknown" : ""}>{stringifyValue(value)}</dd></div>
        ))}
      </dl>
    </Surface>
  );
}

function OrderScenarios({ scenarios }: { scenarios: FirstOrderScenario[] }) {
  return (
    <div className="order-scenarios">
      {scenarios.map((scenario, index) => (
        <div className={index === 1 ? "is-baseline" : ""} key={scenario.name ?? scenario.label ?? index}>
          <span>{scenario.label ?? scenarioName(scenario.name, index)}</span>
          <strong>{scenario.quantity_range ?? quantityRange(scenario)}</strong>
          <small>{scenario.rationale ?? scenario.risk ?? scenario.assumptions?.join("；") ?? "以 API 返回假设为准"}</small>
        </div>
      ))}
    </div>
  );
}

function quantityRange(scenario: FirstOrderScenario): string {
  if (scenario.quantity_low !== undefined && scenario.quantity_high !== undefined) {
    if (scenario.quantity_low === scenario.quantity_high) return `${scenario.quantity_low} 双 · 情景点`;
    return `${scenario.quantity_low}–${scenario.quantity_high} 双`;
  }
  if (scenario.lower !== undefined && scenario.upper !== undefined) return `${scenario.lower}–${scenario.upper} 双`;
  if (scenario.baseline !== undefined) return `基准 ${scenario.baseline} 双`;
  return "待确认";
}

function scenarioName(name: string | undefined, index: number): string {
  const labels: Record<string, string> = {
    CONSERVATIVE: "保守情景",
    BASE: "基准情景",
    AGGRESSIVE: "进取情景",
  };
  return name ? labels[name] ?? name : ["保守情景", "基准情景", "进取情景"][index] ?? `情景 ${index + 1}`;
}
