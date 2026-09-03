"use client";

import Image from "next/image";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  ArrowRight,
  Beaker,
  Boxes,
  CheckCircle2,
  ClipboardList,
  Database,
  FilePlus2,
  FileSearch,
  History,
  PackageCheck,
  Play,
  RefreshCw,
  ShieldCheck,
  Sparkles,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { api, getErrorMessage } from "@/lib/api";
import { publicAssetPath } from "@/lib/paths";
import { STATIC_PREVIEW_ENABLED } from "@/lib/static-preview-mode";
import type { DemoScenario, ProjectDetail } from "@/lib/types";
import { formatDateTime, projectDecision, outcomeOf } from "@/lib/presentation";
import { OutcomeBadge } from "@/components/outcome-badge";
import {
  ActionMessage,
  Button,
  ErrorPanel,
  LoadingPanel,
  StatusPill,
  Surface,
} from "@/components/ui";

const flow = [
  { label: "Brief", caption: "经营约束", icon: ClipboardList },
  { label: "Experiment", caption: "实验契约", icon: Beaker },
  { label: "Evidence", caption: "确定性证据", icon: FileSearch },
  { label: "Decision", caption: "四态建议", icon: ShieldCheck },
  { label: "Handoff", caption: "工厂交接", icon: PackageCheck },
];

export function HomeDashboard() {
  const router = useRouter();
  const [scenarios, setScenarios] = useState<DemoScenario[]>([]);
  const [projects, setProjects] = useState<ProjectDetail[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [creating, setCreating] = useState<string>();
  const [actionError, setActionError] = useState<string>();

  const load = useCallback(async () => {
    setLoading(true);
    setError(undefined);
    try {
      const [scenarioRows, projectRows] = await Promise.all([
        api.listScenarios(),
        api.listProjects().catch(() => []),
      ]);
      setScenarios(scenarioRows);
      setProjects(projectRows);
    } catch (caught) {
      setError(getErrorMessage(caught));
      setScenarios([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const createProject = async (scenarioId: string) => {
    setCreating(scenarioId);
    setActionError(undefined);
    try {
      const project = await api.createProjectFromScenario(scenarioId);
      router.push(`/projects/${project.id}/brief`);
    } catch (caught) {
      setActionError(getErrorMessage(caught));
      setCreating(undefined);
    }
  };

  const createDraftProject = async () => {
    setCreating("__draft__");
    setActionError(undefined);
    try {
      const project = await api.createDraftProject("未命名男士轻量休闲鞋试销");
      router.push(`/projects/${project.id}/brief`);
    } catch (caught) {
      setActionError(getErrorMessage(caught));
      setCreating(undefined);
    }
  };

  return (
    <main className="home-shell">
      <header className="home-header">
        <div className="brand-lockup brand-lockup--light">
          <span className="brand-mark"><Sparkles className="size-5" /></span>
          <span><strong>试销官</strong><small>新品快反决策 Agent</small></span>
        </div>
        <div className="home-header__meta">
          <StatusPill tone="info"><Database className="size-3.5" /> {STATIC_PREVIEW_ENABLED ? "GitHub Pages · 浏览器内回放" : "本地演示 API"}</StatusPill>
          <span>{STATIC_PREVIEW_ENABLED ? "无 FastAPI · 无 SQLite · 无 DeepSeek · 状态仅存当前浏览器" : "一个编排 Agent · 确定性规则 · 人工审批"}</span>
        </div>
      </header>

      <section className="home-hero" aria-labelledby="home-title">
        <div className="home-hero__copy">
          <p className="eyebrow">AI + OPC · 鞋类新品验证</p>
          <h1 id="home-title">让每个“做不做”，<br />都有证据可回放。</h1>
          <p>
            把候选鞋款、低成本试销数据和经营约束，转成可审计的
            <strong> Go / Pivot / No-Go / Evidence Insufficient</strong> 建议。
          </p>
          <div className="home-principles">
            <span><CheckCircle2 className="size-4" /> 数值由规则计算</span>
            <span><CheckCircle2 className="size-4" /> 证据不足主动拒答</span>
            <span><CheckCircle2 className="size-4" /> 关键动作人工审批</span>
          </div>
          {!STATIC_PREVIEW_ENABLED ? <div className="mt-5">
            <Button
              variant="secondary"
              loading={creating === "__draft__"}
              disabled={Boolean(creating)}
              onClick={() => void createDraftProject()}
            >
              <FilePlus2 className="size-4" /> 新建空白 Brief
            </Button>
          </div> : (
            <div className="callout callout--warn mt-5">
              <strong>公开静态预览</strong>
              <p>请从下方八个固定合成场景启动；空白 Brief、策略编辑、附件和真实数据入口仅在本地完整版开放。</p>
            </div>
          )}
        </div>
        <div className="home-hero__visual">
          <Image
            src={publicAssetPath("/demo-shoe-colorways.png")}
            alt="AI 生成的同款轻量休闲鞋深灰蓝与米白两个配色，用于合成试销演示"
            fill
            priority
            sizes="(max-width: 900px) 100vw, 44vw"
          />
          <span className="visual-label"><Beaker className="size-3.5" /> AI 生成示意 · 合成演示</span>
          <div className="visual-caption">
            <span>候选变量</span>
            <strong>配色 A / B</strong>
            <small>图片不代表真实企业款式</small>
          </div>
        </div>
      </section>

      <section className="flow-strip" aria-label="试销官核心工作流">
        {flow.map((step, index) => {
          const Icon = step.icon;
          return (
            <div className="flow-step" key={step.label}>
              <span className="flow-step__number">0{index + 1}</span>
              <Icon aria-hidden="true" className="size-5" />
              <span><strong>{step.label}</strong><small>{step.caption}</small></span>
              {index < flow.length - 1 ? <ArrowRight className="flow-step__arrow size-4" /> : null}
            </div>
          );
        })}
      </section>

      <section className="home-section" aria-labelledby="scenario-heading">
        <div className="home-section__heading">
          <div>
            <p className="eyebrow">Golden scenarios</p>
            <h2 id="scenario-heading">选择一个证据场景开始回放</h2>
            <p>每个场景使用固定种子合成数据；预期结果用于验收规则，不代表市场预测。</p>
          </div>
          <div className="scenario-count">
            <strong>{loading ? "—" : scenarios.length}</strong><span>个可回放场景</span>
          </div>
        </div>

        {loading ? <LoadingPanel label={STATIC_PREVIEW_ENABLED ? "正在读取浏览器内固定场景…" : "正在从 API 读取黄金场景…"} /> : null}
        {error ? <ErrorPanel message={error} onRetry={() => void load()} /> : null}
        {actionError ? <ActionMessage tone="error">{actionError}</ActionMessage> : null}

        {!loading && !error && scenarios.length === 0 ? (
          <ErrorPanel
            title={STATIC_PREVIEW_ENABLED ? "静态场景未能装载" : "API 未返回可用场景"}
            message={STATIC_PREVIEW_ENABLED ? "请刷新页面；本预览不会连接后端。" : "没有展示占位结果。请检查后端是否已装载 8 个固定演示场景。"}
            onRetry={() => void load()}
          />
        ) : null}

        <div className="scenario-grid">
          {scenarios.map((scenario, index) => (
            <Surface className="scenario-card" key={scenario.id}>
              <div className="scenario-card__topline">
                <span className="scenario-card__index">{String(index + 1).padStart(2, "0")}</span>
                <OutcomeBadge outcome={scenario.expected_outcome} compact />
              </div>
              <div>
                <h3>{scenario.name}</h3>
                <p>{scenario.description}</p>
              </div>
              <div className="scenario-card__footer">
                <span><History className="size-3.5" /> {scenario.total_days || 7} 天逐日回放</span>
                <Button
                  loading={creating === scenario.id}
                  disabled={Boolean(creating)}
                  onClick={() => void createProject(scenario.id)}
                >
                  <Play className="size-3.5" /> 启动场景
                </Button>
              </div>
            </Surface>
          ))}
        </div>
      </section>

      {projects.length > 0 ? (
        <section className="home-section home-section--compact" aria-labelledby="recent-heading">
          <div className="home-section__heading">
            <div>
              <p className="eyebrow">Recent work</p>
              <h2 id="recent-heading">继续最近的决策任务</h2>
            </div>
            <Button variant="ghost" onClick={() => void load()}>
              <RefreshCw className="size-4" /> 刷新
            </Button>
          </div>
          <div className="recent-list">
            {projects.slice(0, 5).map((project) => (
              <Link href={`/projects/${project.id}/brief`} className="recent-row" key={project.id}>
                <span className="recent-row__icon"><Boxes className="size-4" /></span>
                <span className="recent-row__main">
                  <strong>{project.name ?? project.scenario_name ?? "未命名决策任务"}</strong>
                  <small>{project.state ?? project.status ?? "已创建"} · {formatDateTime(project.updated_at ?? project.created_at)}</small>
                </span>
                <OutcomeBadge outcome={outcomeOf(projectDecision(project))} compact />
                <ArrowRight className="size-4 text-[var(--muted)]" />
              </Link>
            ))}
          </div>
        </section>
      ) : null}

      <footer className="home-footer">
        <span>试销官 MVP · 比赛 Demo</span>
        <span>{STATIC_PREVIEW_ENABLED ? "GitHub Pages 浏览器内静态回放 · 状态只存在当前浏览器 · 非生产指令" : "合成数据仅验证流程与规则，不用于证明真实市场需求。"}</span>
      </footer>
    </main>
  );
}
