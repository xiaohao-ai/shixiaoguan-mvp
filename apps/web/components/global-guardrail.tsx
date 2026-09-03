"use client";

import { Bot, Cloud, FlaskConical, ShieldAlert, Wifi, WifiOff } from "lucide-react";
import { useApiStatus } from "@/components/providers";

export function GlobalGuardrail() {
  const { state, agentMode, publicPreviewMode } = useApiStatus();

  return (
    <div className="guardrail" aria-label="演示环境状态">
      <div className="guardrail__group">
        <span className="guardrail__synthetic">
          <FlaskConical aria-hidden="true" className="size-3.5" />
          SYNTHETIC · 合成演示
        </span>
        <span className="guardrail__notice">
          <ShieldAlert aria-hidden="true" className="size-3.5" />
          非生产指令 · 不会自动投放、下单或打样
        </span>
        {publicPreviewMode ? (
          <span className="guardrail__notice">
            <Cloud aria-hidden="true" className="size-3.5" />
            公开预览 · 临时数据会重置 · 请勿输入真实业务信息
          </span>
        ) : null}
      </div>
      <div className="guardrail__status">
        <span className="model-mode" aria-live="polite">
          <Bot aria-hidden="true" className="size-3.5" />
          {agentMode === "LIVE"
            ? "在线模型"
            : agentMode === "OFFLINE_REPLAY"
              ? "离线回放"
              : "模型模式待检查"}
        </span>
        <span className={`connection connection--${state}`} aria-live="polite">
          {state === "online" ? (
            <Wifi aria-hidden="true" className="size-3.5" />
          ) : (
            <WifiOff aria-hidden="true" className="size-3.5" />
          )}
          {state === "checking" ? "连接检查中" : state === "online" ? "API 在线" : "API 离线"}
        </span>
      </div>
    </div>
  );
}
