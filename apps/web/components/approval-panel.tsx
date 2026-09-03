"use client";

import { Check, MessageSquareMore, RotateCcw, X } from "lucide-react";
import { useState } from "react";
import { api, getErrorMessage } from "@/lib/api";
import type { ApprovalDecision, ApprovalGate } from "@/lib/types";
import { useProject } from "@/components/project-context";
import { projectDecision, projectPivotRevision } from "@/lib/presentation";
import { ActionMessage, Button, SectionHeading, Surface } from "@/components/ui";
import { STATIC_PREVIEW_ENABLED } from "@/lib/static-preview-mode";

export function ApprovalPanel({
  gate,
  title,
  description,
  allowMoreData = false,
  allowApprove = true,
  approveLabel = "人工批准",
  disabled = false,
  onSubmitted,
}: {
  gate: ApprovalGate;
  title: string;
  description: string;
  allowMoreData?: boolean;
  allowApprove?: boolean;
  approveLabel?: string;
  disabled?: boolean;
  onSubmitted?: (decision: ApprovalDecision) => void;
}) {
  const { projectId, project, refresh } = useProject();
  const [actor, setActor] = useState("比赛演示操作员");
  const [comment, setComment] = useState("");
  const [submitting, setSubmitting] = useState<ApprovalDecision>();
  const [message, setMessage] = useState<{ tone: "success" | "error"; text: string }>();
  const pivotRevision = projectPivotRevision(project);
  const objectVersion = gate === "EXPERIMENT_PLAN"
    ? project?.experiment_plan?.version
    : gate === "PIVOT_REVISION"
      ? pivotRevision?.version
      : gate === "FIRST_ORDER_ASSUMPTIONS"
        ? project?.brief_version
      : projectDecision(project)?.version;
  const canSubmit = !disabled && typeof objectVersion === "number";

  const submit = async (decision: ApprovalDecision) => {
    setSubmitting(decision);
    setMessage(undefined);
    try {
      const body = {
        gate,
        decision,
        actor: STATIC_PREVIEW_ENABLED ? "比赛演示操作员" : actor.trim() || "比赛演示操作员",
        comment: STATIC_PREVIEW_ENABLED ? undefined : comment.trim() || undefined,
        object_version: objectVersion ?? 0,
      };
      if (gate === "PIVOT_REVISION" && pivotRevision) {
        await api.approvePivotRevision(pivotRevision.id, body);
      } else if (gate === "FIRST_ORDER_ASSUMPTIONS") {
        await api.approveFirstOrderAssumptions(projectId, body);
      } else {
        await api.submitApproval(projectId, body);
      }
      setMessage({
        tone: "success",
        text:
          decision === "APPROVE"
            ? "审批已记录，流程可以继续。"
            : "处理意见已写入审计记录。",
      });
      await refresh();
      onSubmitted?.(decision);
    } catch (caught) {
      setMessage({ tone: "error", text: getErrorMessage(caught) });
    } finally {
      setSubmitting(undefined);
    }
  };

  return (
    <Surface className="panel-pad approval-panel">
      <SectionHeading title={title} description={description} />
      {STATIC_PREVIEW_ENABLED ? (
        <ActionMessage tone="info">
          GitHub Pages 使用固定演示操作者“比赛演示操作员”，不采集姓名或审批意见。
        </ActionMessage>
      ) : (
        <div className="form-grid">
          <div className="form-field">
            <label htmlFor={`${gate}-actor`}>审批人</label>
            <input
              id={`${gate}-actor`}
              className="input"
              value={actor}
              onChange={(event) => setActor(event.target.value)}
              disabled={!canSubmit}
            />
          </div>
          <div className="form-field">
            <label htmlFor={`${gate}-comment`}>审批意见（可选）</label>
            <input
              id={`${gate}-comment`}
              className="input"
              placeholder="说明通过、驳回或补充数据的原因"
              value={comment}
              onChange={(event) => setComment(event.target.value)}
              disabled={!canSubmit}
            />
          </div>
        </div>
      )}
      <div className="approval-actions">
        {allowApprove ? (
          <Button
            onClick={() => void submit("APPROVE")}
            loading={submitting === "APPROVE"}
            disabled={!canSubmit || Boolean(submitting)}
          >
            <Check className="size-4" /> {approveLabel}
          </Button>
        ) : null}
        {gate === "FIRST_ORDER_ASSUMPTIONS" ? null : allowMoreData ? (
          <Button
            variant="secondary"
            onClick={() => void submit("REQUEST_MORE_DATA")}
            loading={submitting === "REQUEST_MORE_DATA"}
            disabled={!canSubmit || Boolean(submitting)}
          >
            <RotateCcw className="size-4" /> 要求补充数据
          </Button>
        ) : (
          <Button
            variant="secondary"
            onClick={() => void submit("REQUEST_CHANGES")}
            loading={submitting === "REQUEST_CHANGES"}
            disabled={!canSubmit || Boolean(submitting)}
          >
            <MessageSquareMore className="size-4" /> 修改后再审
          </Button>
        )}
        {gate === "FIRST_ORDER_ASSUMPTIONS" ? null : (
          <Button
            variant="ghost"
            onClick={() => void submit("REJECT")}
            loading={submitting === "REJECT"}
            disabled={!canSubmit || Boolean(submitting)}
          >
            <X className="size-4" /> 驳回
          </Button>
        )}
      </div>
      {!canSubmit ? (
        <ActionMessage tone="info">
          {disabled ? "当前没有可审批的结构化对象。" : STATIC_PREVIEW_ENABLED ? "固定录制未包含对象版本，已禁止提交审批。" : "API 未返回对象版本，已禁止提交旧版本审批。"}
        </ActionMessage>
      ) : null}
      {message ? <ActionMessage tone={message.tone}>{message.text}</ActionMessage> : null}
    </Surface>
  );
}
