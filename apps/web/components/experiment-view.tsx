"use client";

import Link from "next/link";
import { ArrowRight, Beaker, CheckCircle2, CircleHelp, LockKeyhole, Scale, Sparkles } from "lucide-react";
import { useState } from "react";
import { ApprovalPanel } from "@/components/approval-panel";
import { PolicyEditor } from "@/components/policy-editor";
import { useProject } from "@/components/project-context";
import {
  DataList,
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
  pickNumber,
  pickString,
} from "@/lib/presentation";
import { STATIC_PREVIEW_ENABLED } from "@/lib/static-preview-mode";

export function ExperimentView() {
  const { projectId, project, refresh } = useProject();
  const workflowState = project?.workflow_state ?? project?.status ?? project?.state;
  const planNeedsRegeneration = workflowState === "BRIEF_READY";
  const plan = planNeedsRegeneration ? undefined : project?.experiment_plan;
  const [regenerating, setRegenerating] = useState(false);
  const [regenerationMessage, setRegenerationMessage] = useState<{
    tone: "success" | "error";
    text: string;
  }>();
  const [approvalMessage, setApprovalMessage] = useState<string>();

  const regeneratePlan = async () => {
    setRegenerating(true);
    setRegenerationMessage(undefined);
    try {
      await api.normalizeBrief(projectId);
      await api.generateExperimentPlan(projectId);
      await refresh();
      setRegenerationMessage({
        tone: "success",
        text: "已基于当前 Brief 和 DemoPolicy 生成新计划版本，请重新审批。",
      });
    } catch (caught) {
      setRegenerationMessage({ tone: "error", text: getErrorMessage(caught) });
    } finally {
      setRegenerating(false);
    }
  };
  const record = plan as Record<string, unknown> | undefined;
  const hypotheses = Array.isArray(plan?.hypotheses)
    ? plan.hypotheses
    : plan?.hypothesis
      ? [plan.hypothesis]
      : [];
  const secondaryMetrics = Array.isArray(plan?.secondary_metrics) ? plan.secondary_metrics : [];
  const stopRules = Array.isArray(plan?.stop_rules) ? plan.stop_rules : [];
  const guardrails = Array.isArray(plan?.quality_requirements)
    ? plan.quality_requirements
    : Array.isArray(plan?.guardrails)
      ? plan.guardrails
      : [];
  const budgetFen = pickNumber(record, ["budget_cap_fen"]);
  const experimentBudget = budgetFen === undefined
    ? pickNumber(record, ["budget", "budget_limit"])
    : budgetFen / 100;
  const armLabels = Array.isArray(plan?.arms) ? plan.arms.map((arm) => arm.label).join(" / ") : "—";
  const approvalStatus = pickString(record, ["approval_status", "status"], "待人工审批");

  return (
    <>
      <PageHeading
        eyebrow="02 · Experiment contract"
        title="把假设变成可审计实验"
        description={STATIC_PREVIEW_ENABLED
          ? "GitHub Pages 使用固定录制的指标、预算、周期和停止规则；审批仅改变当前浏览器状态。"
          : "主指标、预算、周期与停止规则在审批后锁定；Agent 只能提出草案，不能自行执行投放。"}
        actions={plan ? (
          <Link className="button" href={`/projects/${projectId}/simulation`}>
            进入试销回放 <ArrowRight className="size-4" />
          </Link>
        ) : undefined}
      />

      <div className="mb-5">
        <PolicyEditor />
      </div>

      {regenerationMessage ? (
        <div className="mb-5">
          <ActionMessage tone={regenerationMessage.tone}>{regenerationMessage.text}</ActionMessage>
        </div>
      ) : null}

      {approvalMessage ? (
        <div className="mb-5">
          <ActionMessage tone="success">{approvalMessage}</ActionMessage>
        </div>
      ) : null}

      {!plan ? (
        <EmptyState
          icon={<CircleHelp className="size-5" />}
          title={planNeedsRegeneration ? "当前 Brief 或策略需要新计划" : STATIC_PREVIEW_ENABLED ? "静态场景尚未装载实验计划" : "API 尚未返回实验计划"}
                   description={STATIC_PREVIEW_ENABLED
            ? "浏览器可从当前固定 Brief 恢复同一份录制计划；不会调用 DeepSeek 或写入服务端。"
            : "先调用单编排 Agent 归一化当前 Brief，再由确定性模板写入新的版本化实验计划。旧计划不会被重新审批。"}
          action={
            <Button onClick={() => void regeneratePlan()} loading={regenerating}>
              <Sparkles className="size-4" /> 归一化并生成新计划
            </Button>
          }
        />
      ) : (
        <div className="stack">
          <Surface className="experiment-contract">
            <div className="experiment-contract__main">
              <div className="experiment-contract__number">EXP / {String(plan.version ?? 1).padStart(2, "0")}</div>
              <div>
                <div className="flex flex-wrap items-center gap-2">
                  <StatusPill tone="info"><Beaker className="size-3.5" /> 单一主要决策目标</StatusPill>
                  <StatusPill tone={approvalStatus.includes("APPROV") || approvalStatus.includes("通过") ? "good" : "warn"}>
                    <LockKeyhole className="size-3.5" /> {approvalStatus}
                  </StatusPill>
                </div>
                <h2>{pickString(record, ["decision_question", "objective", "experiment_goal"], "未定义实验目标")}</h2>
                <p>唯一受控变量：{pickString(record, ["controlled_variable"], "待确认")}</p>
              </div>
            </div>
            <div className="experiment-contract__metric">
              <span>PRIMARY METRIC</span>
              <strong>{pickString(record, ["primary_metric", "main_metric"], "待确认")}</strong>
              <small>审批后锁定，不因中途结果改变</small>
            </div>
          </Surface>

          <div className="content-grid">
            <div className="stack">
              <Surface className="overflow-hidden">
                <div className="panel-pad pb-0">
                  <SectionHeading title="实验参数" description="样本量是基于当前假设的演示建议，不是绝对科学结论。" />
                </div>
                <DataList
                  items={[
                    { label: "试销渠道", value: pickString(record, ["channel"]) },
                    { label: "目标人群", value: pickString(record, ["target_audience", "audience_segment"]) },
                    { label: "实验周期", value: `${formatCompactNumber(pickNumber(record, ["duration_days"]))} 天` },
                    { label: "每组最低曝光", value: formatCompactNumber(pickNumber(record, ["min_exposure_per_arm", "target_sample_size"])) },
                    { label: "预算上限", value: formatCurrency(experimentBudget) },
                    { label: "实验分组", value: armLabels },
                  ]}
                />
              </Surface>

              <Surface className="panel-pad">
                <SectionHeading title="待验证假设" description="任务可包含多个假设，但当前实验只绑定一个主决策目标。" />
                {hypotheses.length ? (
                  <ul className="numbered-list">
                    {hypotheses.map((hypothesis, index) => (
                      <li key={`${hypothesis}-${index}`}><span>{index + 1}</span><span>{hypothesis}</span></li>
                    ))}
                  </ul>
                ) : <p className="mono-note">没有可展示的结构化假设。</p>}
              </Surface>

              <ApprovalPanel
                gate="EXPERIMENT_PLAN"
                title="质量门 01 · 批准实验计划"
                description="批准后才可进入逐日试销回放；修改主要指标必须产生新版本并重新审批。"
                onSubmitted={(decision) => {
                  if (decision !== "APPROVE") {
                    setApprovalMessage("处理意见已写入审计记录。");
                  }
                }}
              />
            </div>

            <aside className="stack">
              <Surface className="panel-pad">
                <SectionHeading title="辅助观察指标" />
                {secondaryMetrics.length ? (
                  <ul className="chip-list">{secondaryMetrics.map((metric) => <li key={metric}>{metric}</li>)}</ul>
                ) : <p className="mono-note">未设置辅助指标。</p>}
              </Surface>
              <Surface className="panel-pad">
                <SectionHeading title="停止规则" description="避免看到中途结果后随意停止。" />
                {stopRules.length ? (
                  <ul className="plain-list">{stopRules.map((rule, index) => <li key={`${rule.code}-${index}`}><span><strong>{rule.code}</strong> · {rule.description}</span></li>)}</ul>
                ) : <p className="mono-note">{STATIC_PREVIEW_ENABLED ? "固定录制未包含停止规则。" : "API 未返回停止规则。"}</p>}
              </Surface>
              <Surface className="panel-pad">
                <SectionHeading title="护栏与合规" />
                {guardrails.length ? (
                  <ul className="plain-list">{guardrails.map((rule, index) => <li key={`${rule}-${index}`}>{rule}</li>)}</ul>
                ) : (
                  <div className="callout callout--warn">
                    <Scale className="mb-2 size-5 text-[var(--amber)]" />
                    <strong>默认演示护栏</strong>
                    <p>不执行真实投放；不得将相关性信号表述为因果提升。</p>
                  </div>
                )}
              </Surface>
              <div className="callout">
                <CheckCircle2 className="mb-2 size-5 text-[var(--teal)]" />
                <strong>审批产生审计事件</strong>
                <p>{STATIC_PREVIEW_ENABLED ? "审批人、意见和版本只记录在当前浏览器，仅用于体验门禁，不是真实授权。" : "审批人、意见、时间与对象版本由后端保存，前端不会在本地伪造“已批准”。"}</p>
              </div>
            </aside>
          </div>

          <details className="raw-details">
            <summary>查看实验计划原始 JSON</summary>
            <pre>{JSON.stringify(plan, null, 2)}</pre>
          </details>
        </div>
      )}
    </>
  );
}
