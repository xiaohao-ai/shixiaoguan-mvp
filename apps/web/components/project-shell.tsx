"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Activity,
  Archive,
  ArrowLeft,
  Beaker,
  Bot,
  Check,
  ClipboardCheck,
  FileInput,
  FlaskConical,
  Gauge,
  PackageCheck,
  RefreshCw,
  ScrollText,
  ShieldCheck,
  Sparkles,
} from "lucide-react";
import { useState } from "react";
import { useProject } from "@/components/project-context";
import { ActionMessage, Button, ErrorPanel, LoadingPanel, StatusPill } from "@/components/ui";
import { api, getErrorMessage } from "@/lib/api";
import {
  dataStatusMeta,
  outcomeOf,
  projectDecision,
  projectEvidence,
  projectHandoff,
  projectQuality,
} from "@/lib/presentation";
import type { ProjectDetail } from "@/lib/types";
import type { ReactNode } from "react";

const steps = [
  { key: "brief", label: "产品 Brief", caption: "目标与经营约束", icon: FileInput },
  { key: "experiment", label: "实验计划", caption: "假设、指标与审批", icon: Beaker },
  { key: "simulation", label: "试销回放", caption: "逐日生成观测", icon: Activity },
  { key: "evidence", label: "质检与证据", caption: "确定性计算", icon: Gauge },
  { key: "decision", label: "决策卡", caption: "四态建议与审批", icon: ClipboardCheck },
  { key: "handoff", label: "工厂交接", caption: "打样与首单情景", icon: PackageCheck },
  { key: "audit", label: "审计回放", caption: "证据链与版本", icon: ScrollText },
] as const;

function completion(project: ProjectDetail | undefined, key: (typeof steps)[number]["key"]): boolean {
  if (!project) return false;
  const day = project.current_day ?? 0;
  const total = project.total_days ?? 0;
  if (key === "brief") return Boolean(project.brief ?? project.product_brief);
  if (key === "experiment") return Boolean(project.experiment_plan);
  if (key === "simulation") return day > 0 || total > 0 && day >= total;
  if (key === "evidence") return Boolean(projectEvidence(project) ?? projectQuality(project));
  if (key === "decision") return Boolean(projectDecision(project));
  if (key === "handoff") return Boolean(projectHandoff(project));
  return false;
}

export function ProjectShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const { projectId, project, loading, refreshing, error, refresh } = useProject();
  const currentDay = project?.current_day ?? 0;
  const totalDays = project?.total_days ?? 7;
  const dataStatus = project?.data_origin ?? project?.data_status ?? "SYNTHETIC";
  const statusMeta = dataStatusMeta[dataStatus];
  const sensitivity = project?.data_sensitivity_level ?? "SYNTHETIC_ONLY";
  const sensitivityLabel = sensitivity === "USER_CONTENT_RESTRICTED"
    ? "含用户内容 · 受限"
    : "仅合成数据";
  const outcome = outcomeOf(projectDecision(project));
  const workflowState = project?.workflow_state ?? project?.status ?? project?.state;
  const terminal = ["DECISION_APPROVED", "HANDOFF_DRAFT_READY", "CANCELLED"].includes(
    workflowState ?? "",
  );
  const [confirmingArchive, setConfirmingArchive] = useState(false);
  const [archiving, setArchiving] = useState(false);
  const [archiveMessage, setArchiveMessage] = useState<{ tone: "success" | "error"; text: string }>();

  const archive = async () => {
    setArchiving(true);
    setArchiveMessage(undefined);
    try {
      await api.archiveProject(projectId, {
        actor: "demo-operator",
        reason: terminal ? "当前 MVP 决策流程已结束" : "人工取消当前 MVP 工作并保留审计历史",
        cancel_active_work: !terminal,
      });
      await refresh();
      setConfirmingArchive(false);
      setArchiveMessage({ tone: "success", text: "项目已归档；历史对象、审批与数据均保留。" });
    } catch (caught) {
      setArchiveMessage({ tone: "error", text: getErrorMessage(caught) });
    } finally {
      setArchiving(false);
    }
  };

  if (loading && !project) {
    return <main className="standalone-state"><LoadingPanel label="正在装载决策工作台…" /></main>;
  }

  if (error && !project) {
    return (
      <main className="standalone-state">
        <ErrorPanel message={error} onRetry={() => void refresh()} />
        <Link className="text-link mt-5 inline-flex" href="/">
          <ArrowLeft className="size-4" /> 返回场景库
        </Link>
      </main>
    );
  }

  return (
    <div className="workspace-shell">
      <aside className="workspace-sidebar">
        <Link href="/" className="brand-lockup" aria-label="返回试销官场景库">
          <span className="brand-mark"><Sparkles className="size-5" /></span>
          <span><strong>试销官</strong><small>新品快反决策 Agent</small></span>
        </Link>

        <div className="project-mini-card">
          <p>当前决策任务</p>
          <strong>{project?.name ?? project?.scenario_name ?? "未命名项目"}</strong>
          <span className="font-mono">#{projectId.slice(0, 8)}</span>
        </div>

        <nav className="project-stepper" aria-label="项目步骤">
          {steps.map((step, index) => {
            const active = pathname.endsWith(`/${step.key}`);
            const completed = completion(project, step.key);
            const Icon = step.icon;
            return (
              <Link
                key={step.key}
                href={`/projects/${projectId}/${step.key}`}
                className={`project-step ${active ? "is-active" : ""}`}
                aria-current={active ? "page" : undefined}
              >
                <span className="project-step__rail">
                  <span className="project-step__dot">
                    {completed && !active ? <Check className="size-3.5" /> : <Icon className="size-4" />}
                  </span>
                  {index < steps.length - 1 ? <span className="project-step__line" /> : null}
                </span>
                <span className="project-step__copy">
                  <strong>{step.label}</strong>
                  <small>{step.caption}</small>
                </span>
              </Link>
            );
          })}
        </nav>

        <Link className="sidebar-return" href="/">
          <ArrowLeft className="size-4" /> 返回场景库
        </Link>
      </aside>

      <div className="workspace-main">
        <header className="project-toolbar">
          <div className="project-toolbar__status">
            <StatusPill tone="info">
              <FlaskConical className="size-3.5" /> {statusMeta.label}
            </StatusPill>
            <StatusPill tone={sensitivity === "USER_CONTENT_RESTRICTED" ? "warn" : "neutral"}>
              <ShieldCheck className="size-3.5" /> 敏感级别 · {sensitivityLabel}
            </StatusPill>
            <StatusPill tone={currentDay >= totalDays ? "good" : "warn"}>
              <Archive className="size-3.5" />
              {currentDay >= totalDays ? "回放完成" : `逐日回放 · DAY ${currentDay}/${totalDays}`}
            </StatusPill>
            {outcome ? <StatusPill tone="ink">决策已生成</StatusPill> : null}
            <StatusPill tone={project?.agent_mode === "LIVE" ? "good" : "info"}>
              <Bot className="size-3.5" /> {project?.agent_mode === "LIVE" ? "在线模型" : project?.agent_mode === "OFFLINE_REPLAY" ? "离线回放" : "模式未知"}
            </StatusPill>
            <StatusPill tone="neutral">流程 · {project?.workflow_state ?? project?.status ?? project?.state ?? "未知"}</StatusPill>
          </div>
          <div className="flex flex-wrap items-center justify-end gap-2">
            {workflowState !== "ARCHIVED" ? (
              confirmingArchive ? (
                <>
                  <Button variant="ghost" onClick={() => setConfirmingArchive(false)} disabled={archiving}>
                    取消
                  </Button>
                  <Button variant="secondary" onClick={() => void archive()} loading={archiving}>
                    <Archive className="size-4" /> {terminal ? "确认归档" : "确认取消并归档"}
                  </Button>
                </>
              ) : (
                <Button variant="ghost" onClick={() => setConfirmingArchive(true)}>
                  <Archive className="size-4" /> 归档
                </Button>
              )
            ) : null}
            <Button
              variant="ghost"
              loading={refreshing}
              onClick={() => void refresh()}
              aria-label="刷新项目数据"
            >
              <RefreshCw className="size-4" /> 刷新
            </Button>
          </div>
        </header>
        {archiveMessage ? <div className="workspace-error"><ActionMessage tone={archiveMessage.tone}>{archiveMessage.text}</ActionMessage></div> : null}
        {error ? <div className="workspace-error"><ErrorPanel message={error} onRetry={() => void refresh()} /></div> : null}
        <main className="workspace-content">{children}</main>
      </div>
    </div>
  );
}
