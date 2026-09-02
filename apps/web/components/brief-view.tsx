"use client";

import Image from "next/image";
import Link from "next/link";
import { ArrowRight, Box, CircleHelp, Factory, PencilLine, ShieldCheck, Tag } from "lucide-react";
import { useState } from "react";
import { BriefEditForm } from "@/components/brief-edit-form";
import { AttachmentPanel } from "@/components/attachment-panel";
import { useProject } from "@/components/project-context";
import {
  DataList,
  EmptyState,
  PageHeading,
  SectionHeading,
  StatusPill,
  Surface,
} from "@/components/ui";
import {
  formatCurrency,
  formatCompactNumber,
  pickNumber,
  pickString,
  projectBrief,
  stringifyValue,
} from "@/lib/presentation";

export function BriefView() {
  const { projectId, project } = useProject();
  const brief = projectBrief(project);
  const record = brief as Record<string, unknown> | undefined;
  const [editing, setEditing] = useState(false);
  const workflowState = project?.workflow_state ?? project?.status ?? project?.state;
  const archived = workflowState === "ARCHIVED";
  const missingFields = project?.brief_missing_fields ?? [];
  const candidates = Array.isArray(brief?.variants)
    ? brief.variants
    : Array.isArray(brief?.candidates)
      ? brief.candidates
      : [];
  const sellingPoints = Array.isArray(brief?.core_selling_points) ? brief.core_selling_points : [];
  const constraints = Array.isArray(brief?.known_risks)
    ? brief.known_risks
    : Array.isArray(brief?.constraints)
      ? brief.constraints
      : [];
  const yuanFromFen = (keys: string[], fallbackKeys: string[] = []) => {
    const fen = pickNumber(record, keys);
    return fen === undefined ? pickNumber(record, fallbackKeys) : fen / 100;
  };

  return (
    <>
      <PageHeading
        eyebrow="01 · Product brief"
        title="先把经营问题说清楚"
        description="Brief 是后续实验和决策的唯一业务起点。缺失字段保留为待确认，不由模型补成事实。"
        actions={
          <>
            <button
              className="button button--secondary"
              disabled={archived}
              onClick={() => setEditing((value) => !value)}
            >
              <PencilLine className="size-4" /> 编辑 Brief
            </button>
            {workflowState === "DRAFT" ? (
              <StatusPill tone="warn">补齐关键字段后才能规划实验</StatusPill>
            ) : (
              <Link className="button" href={`/projects/${projectId}/experiment`}>
                查看实验计划 <ArrowRight className="size-4" />
              </Link>
            )}
          </>
        }
      />

      {!brief ? (
        <EmptyState
          icon={<CircleHelp className="size-5" />}
          title="API 尚未返回 Product Brief"
          description="页面不会使用占位业务数据。请返回场景库重新创建项目，或检查项目响应中的 brief 字段。"
        />
      ) : (
        <div className="stack">
          {workflowState === "DRAFT" ? (
            <div className="callout callout--warn">
              <CircleHelp className="mb-2 size-5 text-[var(--amber)]" />
              <strong>Brief 草稿尚未就绪</strong>
              <p>缺失或无效字段：{missingFields.length ? missingFields.join("、") : "待服务端校验"}。可以反复保存草稿；系统不会让 Agent 补造这些事实。</p>
            </div>
          ) : null}
          {editing ? <BriefEditForm onClose={() => setEditing(false)} /> : null}
          <AttachmentPanel />
          <div className="content-grid">
          <div className="stack">
            <Surface className="brief-hero">
              <div className="brief-hero__image">
                <Image
                  src="/demo-shoe-colorways.png"
                  alt="AI 生成的轻量休闲鞋深灰蓝和米白配色示意，用于合成 Demo"
                  fill
                  sizes="(max-width: 1050px) 100vw, 55vw"
                />
                <StatusPill tone="warn" className="brief-hero__label">AI 生成示意 · SYNTHETIC</StatusPill>
              </div>
              <div className="brief-hero__copy">
                <p className="eyebrow">Candidate product</p>
                <h2>{pickString(record, ["product_name", "name"], "未命名候选款")}</h2>
                <p>{pickString(record, ["description", "product_description", "style_description"], "未提供产品描述")}</p>
                <div className="brief-hero__tags">
                  <StatusPill tone="info"><Tag className="size-3.5" /> {pickString(record, ["category"], "鞋类")}</StatusPill>
                  <StatusPill><Box className="size-3.5" /> {pickString(record, ["candidate_id", "sku"], "候选款")}</StatusPill>
                </div>
              </div>
            </Surface>

            <Surface className="overflow-hidden">
              <div className="panel-pad pb-0">
                <SectionHeading title="经营与生产约束" description="以下字段由 Brief 提供，直接进入规则引擎。" />
              </div>
              <DataList
                items={[
                  { label: "目标人群", value: pickString(record, ["target_audience", "audience_segment"]) },
                  { label: "使用场景", value: pickString(record, ["usage_scenario", "scenario"]) },
                  { label: "目标零售价", value: formatCurrency(yuanFromFen(["target_price_fen"], ["target_price", "retail_price"])) },
                  { label: "预计成本", value: formatCurrency(yuanFromFen(["estimated_cost_fen"], ["estimated_cost", "cost"])) },
                  { label: "MOQ", value: formatCompactNumber(pickNumber(record, ["moq"])), hint: "最小起订量" },
                  { label: "交期", value: `${formatCompactNumber(pickNumber(record, ["expected_lead_time_days", "lead_time_days", "lead_time"]))} 天` },
                  { label: "试销预算", value: formatCurrency(yuanFromFen(["trial_budget_fen"], ["trial_budget", "budget"])) },
                  { label: "季节", value: pickString(record, ["season", "launch_season"]) },
                ]}
              />
            </Surface>

            {candidates.length > 0 ? (
              <Surface className="panel-pad">
                <SectionHeading title="候选方案" description="只比较 API 返回的候选项，不自动扩写材料或工艺。" />
                <div className="candidate-grid">
                  {candidates.map((candidate, index) => (
                    <article className="candidate-card" key={String(candidate.id ?? index)}>
                      <span className="candidate-card__letter">{String.fromCharCode(65 + index)}</span>
                      <div>
                        <strong>{stringifyValue("label" in candidate ? candidate.label : candidate.name ?? candidate.variant_name ?? candidate.color)}</strong>
                        <p>{stringifyValue("color_name" in candidate ? candidate.color_name : candidate.description ?? candidate.key_difference ?? "待确认")}</p>
                      </div>
                    </article>
                  ))}
                </div>
              </Surface>
            ) : null}
          </div>

          <aside className="stack">
            <Surface className="panel-pad">
              <SectionHeading title="核心卖点" description="实验将验证这些表达是否被目标人群接受。" />
              {sellingPoints.length ? (
                <ul className="numbered-list">
                  {sellingPoints.map((point, index) => <li key={`${point}-${index}`}><span>{index + 1}</span><span>{point}</span></li>)}
                </ul>
              ) : <p className="mono-note">未提供，需在实验计划中补充。</p>}
            </Surface>
            <Surface className="panel-pad">
              <SectionHeading title="已知限制" description="限制不会被模型静默忽略。" />
              {constraints.length ? (
                <ul className="plain-list">{constraints.map((item, index) => <li key={`${item}-${index}`}>{item}</li>)}</ul>
              ) : <p className="mono-note">API 未返回额外限制。</p>}
            </Surface>
            <div className="callout">
              <ShieldCheck className="mb-2 size-5 text-[var(--teal)]" />
              <strong>数据边界已锁定</strong>
              <p>当前图片和项目数据均用于合成流程演示，不代表真实永嘉企业经营结果。</p>
            </div>
            <div className="callout callout--warn">
              <Factory className="mb-2 size-5 text-[var(--amber)]" />
              <strong>不是生产指令</strong>
              <p>任何打样、首单或外部发布动作都需要后续人工审批。</p>
            </div>
          </aside>
          </div>
        </div>
      )}
    </>
  );
}
