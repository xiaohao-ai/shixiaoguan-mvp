"use client";

import Link from "next/link";
import {
  ArrowRight,
  CalendarDays,
  Check,
  CirclePause,
  FastForward,
  Pause,
  Play,
  RotateCcw,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useProject } from "@/components/project-context";
import {
  ActionMessage,
  Button,
  PageHeading,
  SectionHeading,
  StatusPill,
  Surface,
} from "@/components/ui";
import { api, getErrorMessage } from "@/lib/api";
import { experimentIsApproved, pickNumber } from "@/lib/presentation";
import type { JsonValue, TrialObservation } from "@/lib/types";
import { STATIC_PREVIEW_ENABLED } from "@/lib/static-preview-mode";

const AUTO_REPLAY_INTERVAL_MS = 700;
const RESETTABLE_WORKFLOW_STATES = new Set([
  "PLAN_APPROVED",
  "SIMULATION_READY",
  "SIMULATION_RUNNING",
  "DATA_READY",
  "DATA_VALIDATED",
  "DATA_BLOCKED",
  "ANALYZED",
  "DECISION_PROPOSED",
]);

export function SimulationView() {
  const { projectId, project, refresh } = useProject();
  const [running, setRunning] = useState<"advance" | "all" | "auto" | "reset">();
  const [autoPlaying, setAutoPlaying] = useState(false);
  const [observations, setObservations] = useState<TrialObservation[]>([]);
  const [message, setMessage] = useState<{ tone: "success" | "error" | "info"; text: string }>();

  const currentDay = project?.current_day ?? 0;
  const totalDays = project?.total_days ?? 7;
  const approved = experimentIsApproved(project);
  const workflowState = (
    project?.workflow_state ?? project?.state ?? project?.status ?? ""
  ).toUpperCase();
  const canAdvance = approved
    && ["SIMULATION_READY", "SIMULATION_RUNNING"].includes(workflowState)
    && currentDay < totalDays;
  const canResetReplay = approved
    && currentDay > 0
    && RESETTABLE_WORKFLOW_STATES.has(workflowState);
  const loadObservations = useCallback(async () => {
    try {
      setObservations(await api.getObservations(projectId));
    } catch {
      setObservations([]);
    }
  }, [projectId]);

  useEffect(() => {
    void loadObservations();
  }, [loadObservations]);

  const daily = useMemo<Array<Record<string, JsonValue>>>(() => {
    const byDate = new Map<string, { exposure: number; click: number; purchase_intent: number }>();
    observations.forEach((row) => {
      const value = byDate.get(row.date) ?? { exposure: 0, click: 0, purchase_intent: 0 };
      value.exposure += row.exposure;
      value.click += row.click;
      value.purchase_intent += row.purchase_intent;
      byDate.set(row.date, value);
    });
    return Array.from(byDate.entries())
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([date, values], index) => ({ date, day: index + 1, ...values }));
  }, [observations]);

  const run = useCallback(async (mode: "advance" | "all" | "auto") => {
    setRunning(mode);
    setMessage(undefined);
    try {
      if (mode === "advance" || mode === "auto") await api.advanceSimulation(projectId, 1);
      else await api.runSimulation(projectId);
      const [nextProject] = await Promise.all([refresh(), loadObservations()]);
      const nextDay = nextProject?.current_day;
      const nextTotalDays = nextProject?.total_days ?? totalDays;
      if (mode === "auto" && (nextDay === undefined || nextDay >= nextTotalDays)) {
        setAutoPlaying(false);
      }
      setMessage({
        tone: "success",
        text: mode === "all"
          ? "剩余试销周期已完成回放。"
          : mode === "auto"
            ? `自动回放已推进至第 ${nextDay ?? "—"} 天。`
            : STATIC_PREVIEW_ENABLED ? "已在当前浏览器追加 1 天合成观测和演示事件。" : "已追加 1 天聚合观测并写入审计记录。",
      });
    } catch (caught) {
      if (mode === "auto") setAutoPlaying(false);
      setMessage({ tone: "error", text: getErrorMessage(caught) });
    } finally {
      setRunning(undefined);
    }
  }, [loadObservations, projectId, refresh, totalDays]);

  useEffect(() => {
    if (!autoPlaying || !canAdvance || running) return;
    const timer = window.setTimeout(() => {
      void run("auto");
    }, AUTO_REPLAY_INTERVAL_MS);
    return () => window.clearTimeout(timer);
  }, [autoPlaying, canAdvance, currentDay, run, running]);

  const startAutoReplay = () => {
    setAutoPlaying(true);
    setMessage({ tone: "info", text: STATIC_PREVIEW_ENABLED ? "已开始浏览器内自动回放；不发起网络或服务端请求。" : "已开始自动回放；控制台将按日调用同一个服务端推进接口。" });
  };

  const pauseAutoReplay = () => {
    setAutoPlaying(false);
    setMessage({ tone: "info", text: "自动回放已暂停；暂停只停止前端计时器，不撤销已写入的观测。" });
  };

  const resetReplay = useCallback(async () => {
    setAutoPlaying(false);
    setRunning("reset");
    setMessage(undefined);
    try {
      await api.resetSimulationReplay(projectId);
      await Promise.all([refresh(), loadObservations()]);
      setMessage({
        tone: "success",
        text: STATIC_PREVIEW_ENABLED
          ? "已重置浏览器内当前回放。演示事件与对象快照保留；逐日观测可由固定场景重新生成。"
          : "已重置当前回放。旧数据集已标记为非活跃，原始观测、对象版本和审计历史仍保留。",
      });
    } catch (caught) {
      setMessage({ tone: "error", text: getErrorMessage(caught) });
    } finally {
      setRunning(undefined);
    }
  }, [loadObservations, projectId, refresh]);

  return (
    <>
      <PageHeading
        eyebrow="03 · Trial replay"
        title="逐日回放低成本试销"
        description="固定种子场景让每次演示可复现。回放只写入合成聚合观测，不连接真实平台或产生预算支出。"
        actions={
          <Link className="button" href={`/projects/${projectId}/evidence`}>
            进入质检与证据 <ArrowRight className="size-4" />
          </Link>
        }
      />

      <div className="stack">
        <Surface className="replay-console">
          <div className="replay-console__summary">
            <p className="eyebrow">Replay position</p>
            <div className="replay-day"><strong>{String(currentDay).padStart(2, "0")}</strong><span>/ {String(totalDays).padStart(2, "0")} DAYS</span></div>
            <p>{currentDay >= totalDays ? "试销回放已完成，可执行质检与证据分析。" : "按天推进，观察证据如何累积并改变可判断范围。"}</p>
            <div className="replay-actions">
              <Button
                onClick={startAutoReplay}
                disabled={!canAdvance || autoPlaying || Boolean(running)}
              >
                <Play className="size-4" /> 开始自动回放
              </Button>
              <Button
                variant="secondary"
                onClick={pauseAutoReplay}
                disabled={!autoPlaying}
              >
                <Pause className="size-4" /> 暂停
              </Button>
              <Button
                variant="secondary"
                onClick={() => void run("advance")}
                loading={running === "advance"}
                disabled={!canAdvance || autoPlaying || Boolean(running)}
              >
                <Play className="size-4" /> 推进 1 天
              </Button>
              <Button
                variant="secondary"
                onClick={() => void run("all")}
                loading={running === "all"}
                disabled={!canAdvance || autoPlaying || Boolean(running)}
              >
                <FastForward className="size-4" /> 运行至结束
              </Button>
              <Button
                variant="secondary"
                onClick={() => void resetReplay()}
                loading={running === "reset"}
                disabled={!canResetReplay || autoPlaying || Boolean(running)}
                title="决策批准或生成交接物后不可在同项目重置"
              >
                <RotateCcw className="size-4" /> 重置并重放
              </Button>
            </div>
            <p className="text-xs text-muted">
              {STATIC_PREVIEW_ENABLED
                ? "暂停只停止浏览器计时器。重置会清除当前分析投影，并保留演示事件和对象快照。"
                : "暂停只停止前端自动推进。重置会清除当前分析投影，但保留旧数据集、观测、版本与审计历史。"}
            </p>
          </div>
          <div className="replay-console__timeline">
            <div className="replay-timeline__header">
              <span><CalendarDays className="size-4" /> 7 日试销窗口</span>
              <StatusPill tone={approved ? "good" : "warn"}>
                {approved ? <Check className="size-3.5" /> : <CirclePause className="size-3.5" />}
                {approved ? "实验计划已批准" : "等待实验审批"}
              </StatusPill>
            </div>
            <div className="day-track" role="progressbar" aria-label="试销回放进度" aria-valuemin={0} aria-valuemax={totalDays} aria-valuenow={currentDay}>
              {Array.from({ length: totalDays }, (_, index) => {
                const day = index + 1;
                return (
                  <div className={`day-node ${day <= currentDay ? "is-complete" : ""} ${day === currentDay ? "is-current" : ""}`} key={day}>
                    <span>{day <= currentDay ? <Check className="size-3.5" /> : day}</span>
                    <small>DAY {day}</small>
                  </div>
                );
              })}
            </div>
            {!approved ? (
              <div className="callout callout--warn mt-6">
                <strong>实验质量门尚未通过</strong>
                <p>{STATIC_PREVIEW_ENABLED ? "请先到“实验计划”页完成浏览器内演示审批；它仅验证门禁交互。" : "请先到“实验计划”页完成服务器端人工审批；前端不会绕过质量门启动回放。"}</p>
              </div>
            ) : null}
          </div>
        </Surface>

        {message ? <ActionMessage tone={message.tone}>{message.text}</ActionMessage> : null}

        {daily.length > 0 ? (
          <Surface className="panel-pad">
            <SectionHeading title="已写入的逐日观测" description={STATIC_PREVIEW_ENABLED ? "仅显示浏览器内固定合成计数；条形长度按当前最大曝光归一化。" : "仅显示 API 返回的聚合计数；条形长度按当前最大曝光归一化。"} />
            <DailyBars rows={daily} />
          </Surface>
        ) : null}

        <div className="callout">
          <strong>P0 数据入口已收敛</strong>
          <p>本轮仅运行 8 个固定种子合成场景，不接收用户 CSV、Excel 或手工经营数据，避免授权与口径被误读。</p>
        </div>
      </div>
    </>
  );
}

function DailyBars({ rows }: { rows: Array<Record<string, JsonValue>> }) {
  const maxExposure = Math.max(
    1,
    ...rows.map((row) => pickNumber(row, ["exposure", "impressions"]) ?? 0),
  );
  return (
    <div className="daily-bars">
      {rows.map((row, index) => {
        const day = pickNumber(row, ["day", "day_index"]) ?? index + 1;
        const exposure = pickNumber(row, ["exposure", "impressions"]);
        const clicks = pickNumber(row, ["click", "clicks"]);
        const purchaseIntent = pickNumber(row, ["purchase_intent"]);
        const width = exposure === undefined ? 0 : Math.max(2, (exposure / maxExposure) * 100);
        return (
          <div className="daily-bar" key={`${day}-${index}`}>
            <strong>DAY {day}</strong>
            <div className="daily-bar__track" aria-label={`第 ${day} 天曝光 ${exposure ?? "未返回"}`}>
              <span style={{ width: `${width}%` }} />
            </div>
            <span>曝光 {exposure ?? "—"}</span>
            <span>点击 {clicks ?? "—"}</span>
            <span>购买意向 {purchaseIntent ?? "—"}</span>
          </div>
        );
      })}
    </div>
  );
}
