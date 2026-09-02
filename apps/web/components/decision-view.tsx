"use client";

import Link from "next/link";
import {
  ArrowRight,
  Ban,
  BookOpenCheck,
  CircleHelp,
  Fingerprint,
  GitCompareArrows,
  ShieldCheck,
  TriangleAlert,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { ApprovalPanel } from "@/components/approval-panel";
import { OutcomeBadge } from "@/components/outcome-badge";
import { useProject } from "@/components/project-context";
import {
  EmptyState,
  PageHeading,
  SectionHeading,
  StatusPill,
  Surface,
} from "@/components/ui";
import { api } from "@/lib/api";
import { outcomeMeta, outcomeOf, projectDecision } from "@/lib/presentation";
import type { DecisionCard } from "@/lib/types";

export function DecisionView() {
  const { projectId, project } = useProject();
  const [decision, setDecision] = useState<DecisionCard | undefined>(() => projectDecision(project));

  const loadDecision = useCallback(async () => {
    try {
      setDecision(await api.getDecision(projectId));
    } catch {
      // Absence is rendered explicitly; a project-level connection error remains in the shell.
    }
  }, [projectId]);

  useEffect(() => {
    setDecision(projectDecision(project));
    void loadDecision();
  }, [loadDecision, project]);

  const outcome = outcomeOf(decision);
  const meta = outcome ? outcomeMeta[outcome] : undefined;
  const keyEvidence = decision?.key_evidence_ids ?? decision?.key_evidence ?? [];
  const opposingEvidence = decision?.opposing_evidence_ids ?? [];
  const reasonCodes = decision?.reason_codes ?? [];
  const limitations = decision?.limitations ?? decision?.constraints ?? [];
  const risks = decision?.risks ?? [];
  const nextActions = decision?.next_actions ?? [];

  return (
    <>
      <PageHeading
        eyebrow="05 · Decision card"
        title="建议有边界，决定在人"
        description="类别由版本化规则确定；语言模型只解释证据，不计算数字，也不能把证据等级包装成预测准确率。"
        actions={
          <Link className="button" href={`/projects/${projectId}/handoff`}>
            查看下游交接 <ArrowRight className="size-4" />
          </Link>
        }
      />

      {!decision || !outcome ? (
        <EmptyState
          icon={<CircleHelp className="size-5" />}
          title="决策卡尚未生成"
          description="请先在“质检与证据”页运行分析。页面不会根据场景预期结果自行填充决策。"
          action={<Link className="button" href={`/projects/${projectId}/evidence`}>前往质检与证据</Link>}
        />
      ) : (
        <div className="stack">
          <Surface className={`decision-hero decision-hero--${meta?.tone ?? "pending"}`}>
            <div className="decision-hero__result">
              <p>RULE-BASED RECOMMENDATION</p>
              <OutcomeBadge outcome={outcome} />
              <h2>{decision.one_sentence ?? decision.headline ?? decision.summary ?? meta?.description}</h2>
              <span>这是一项可审计建议，不是自动执行指令。</span>
            </div>
            <div className="decision-hero__facts">
              <div><small>证据充分度</small><strong>{decision.evidence_grade ?? "—"}</strong></div>
              <div><small>规则版本</small><strong>{decision.policy_version ?? decision.rule_version ?? "—"}</strong></div>
              <div><small>审批状态</small><strong>{decision.approval_status ?? "PENDING"}</strong></div>
            </div>
          </Surface>

          {outcome === "EVIDENCE_INSUFFICIENT" ? (
            <div className="callout callout--warn">
              <Ban className="mb-2 size-5 text-[var(--amber)]" />
              <strong>系统拒绝强判断</strong>
              <p>当前不能批准进入打样或首单交接。请按限制和下一步动作补充证据。</p>
            </div>
          ) : null}

          <div className="content-grid">
            <div className="stack">
              <Surface className="panel-pad">
                <SectionHeading
                  title="决策依据"
                  description="关键证据 ID 可在审计页反向追溯到指标、规则与数据集。"
                  action={<StatusPill tone="info"><Fingerprint className="size-3.5" /> TRACEABLE</StatusPill>}
                />
                <div className="decision-evidence-grid">
                  <EvidenceIds title="支持证据" ids={keyEvidence} tone="support" />
                  <EvidenceIds title="反向证据" ids={opposingEvidence} tone="oppose" />
                </div>
                {reasonCodes.length ? (
                  <div className="mt-5">
                    <span className="field-label">命中的规则原因</span>
                    <ul className="chip-list mt-2">{reasonCodes.map((code) => <li key={code}>{code}</li>)}</ul>
                  </div>
                ) : null}
              </Surface>

              <Surface className="panel-pad">
                <SectionHeading title="下一步动作" description="建议按顺序执行，每一步仍受人工审批和业务约束控制。" />
                {nextActions.length ? (
                  <ol className="numbered-list">{nextActions.map((action, index) => <li key={`${action}-${index}`}><span>{index + 1}</span><span>{action}</span></li>)}</ol>
                ) : <p className="mono-note">API 未返回下一步动作。</p>}
              </Surface>

              <ApprovalPanel
                gate="DECISION"
                title="质量门 02 · 人工确认决策"
                description="审批针对当前 DecisionCard 版本；旧版本无法被批准。"
                allowMoreData={outcome === "EVIDENCE_INSUFFICIENT"}
                allowApprove={outcome !== "EVIDENCE_INSUFFICIENT"}
              />
            </div>

            <aside className="stack">
              <Surface className="panel-pad">
                <SectionHeading title="主要风险" />
                {risks.length ? <ul className="plain-list">{risks.map((risk, index) => <li key={`${risk}-${index}`}>{risk}</li>)}</ul> : <p className="mono-note">API 未返回额外风险。</p>}
              </Surface>
              <Surface className="panel-pad">
                <SectionHeading title="适用限制" />
                {limitations.length ? <ul className="plain-list">{limitations.map((item, index) => <li key={`${item}-${index}`}>{item}</li>)}</ul> : <p className="mono-note">API 未返回额外限制。</p>}
              </Surface>
              <div className="callout">
                <BookOpenCheck className="mb-2 size-5 text-[var(--teal)]" />
                <strong>类别稳定，文字可变</strong>
                <p>相同输入和策略版本应产生相同决策类别；解释文本可以变化，但不得新增数据。</p>
              </div>
              <div className="callout callout--danger">
                <TriangleAlert className="mb-2 size-5 text-[var(--red)]" />
                <strong>禁止越权执行</strong>
                <p>即便结果为 GO，也必须完成当前版本的人工审批，才能生成工厂交接草稿。</p>
              </div>
            </aside>
          </div>
        </div>
      )}
    </>
  );
}

function EvidenceIds({ title, ids, tone }: { title: string; ids: string[]; tone: "support" | "oppose" }) {
  return (
    <div className={`evidence-ids evidence-ids--${tone}`}>
      <div className="evidence-ids__title">
        {tone === "support" ? <ShieldCheck className="size-4" /> : <GitCompareArrows className="size-4" />}
        <strong>{title}</strong><span>{ids.length}</span>
      </div>
      {ids.length ? <ul>{ids.map((id) => <li key={id}>{id}</li>)}</ul> : <p>未返回引用</p>}
    </div>
  );
}
