"use client";

import { FileImage, ShieldCheck, Upload } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useApiStatus } from "@/components/providers";
import { useProject } from "@/components/project-context";
import { ActionMessage, Button, SectionHeading, StatusPill, Surface } from "@/components/ui";
import { api, attachmentContentUrl, getErrorMessage } from "@/lib/api";
import { formatDateTime } from "@/lib/presentation";
import { STATIC_PREVIEW_ENABLED } from "@/lib/static-preview-mode";
import type { ProjectAttachment } from "@/lib/types";

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const ALLOWED_IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

export function validateAttachment(file: File | undefined, rightsDeclaration: string): string | undefined {
  if (!file) return "请选择一张图片。";
  if (!ALLOWED_IMAGE_TYPES.has(file.type)) return "只允许 JPG、PNG 或 WebP 图片。";
  if (file.size > MAX_IMAGE_BYTES) return "图片不得超过 5 MB。";
  if (!rightsDeclaration.trim()) return "上传前必须填写图片权属声明。";
  if (rightsDeclaration.trim().length > 2000) return "权属声明不得超过 2000 字。";
  return undefined;
}

export function AttachmentPanel() {
  const { projectId, project } = useProject();
  const { attachmentUploadEnabled } = useApiStatus();
  const archived = (project?.workflow_state ?? project?.status) === "ARCHIVED";
  const previewUploadDisabled = STATIC_PREVIEW_ENABLED || attachmentUploadEnabled === false;
  const uploadDisabled = archived || previewUploadDisabled;
  const [attachments, setAttachments] = useState<ProjectAttachment[]>([]);
  const [file, setFile] = useState<File>();
  const [rightsDeclaration, setRightsDeclaration] = useState("");
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [message, setMessage] = useState<{ tone: "success" | "error" | "info"; text: string }>();

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setAttachments(await api.listAttachments(projectId));
    } catch (caught) {
      setMessage({ tone: "error", text: getErrorMessage(caught) });
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    void load();
  }, [load]);

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (previewUploadDisabled) {
      setMessage({ tone: "info", text: "公开预览已关闭附件上传；请在本地环境测试自有图片。" });
      return;
    }
    if (archived) {
      setMessage({ tone: "info", text: "项目已归档，附件入口只读。" });
      return;
    }
    const form = event.currentTarget;
    const error = validateAttachment(file, rightsDeclaration);
    if (error) {
      setMessage({ tone: "error", text: error });
      return;
    }
    setUploading(true);
    setMessage(undefined);
    try {
      await api.uploadAttachment(projectId, file as File, rightsDeclaration.trim());
      setFile(undefined);
      setRightsDeclaration("");
      form.reset();
      await load();
      setMessage({ tone: "success", text: "图片已上传，哈希与权属声明已记入项目审计链。" });
    } catch (caught) {
      setMessage({ tone: "error", text: getErrorMessage(caught) });
    } finally {
      setUploading(false);
    }
  };

  return (
    <Surface className="panel-pad attachment-panel">
      <SectionHeading
        title="产品图片与权属"
        description="图片只用于上传、展示和记录权属；MVP 不做自动识图、趋势检索或相似款分析。"
        action={(
          <StatusPill tone="warn">
            <ShieldCheck className="size-3.5" />
            {previewUploadDisabled ? "公开预览 · 上传关闭" : "权属必填"}
          </StatusPill>
        )}
      />

      <form className="attachment-upload" onSubmit={(event) => void submit(event)} noValidate>
        <div className="form-field">
          <label htmlFor="product-attachment">图片文件</label>
          <input
            id="product-attachment"
            className="input file-input"
            type="file"
            disabled={uploadDisabled}
            accept="image/jpeg,image/png,image/webp,.jpg,.jpeg,.png,.webp"
            onChange={(event) => {
              setFile(event.target.files?.[0]);
              setMessage(undefined);
            }}
          />
          <small>{STATIC_PREVIEW_ENABLED ? "GitHub Pages 评审版不接收或保存任何附件。" : "限 JPG / PNG / WebP，单张最大 5 MB；服务端会再校验文件头。"}</small>
        </div>
        <div className="form-field">
          <label htmlFor="rights-declaration">图片权属声明</label>
          <textarea
            id="rights-declaration"
            className="textarea"
            value={rightsDeclaration}
            disabled={uploadDisabled}
            maxLength={2000}
            placeholder="例：本图由本项目自制，授权用于本次合成 Demo 展示。"
            onChange={(event) => {
              setRightsDeclaration(event.target.value);
              setMessage(undefined);
            }}
          />
        </div>
        <div className="attachment-upload__action">
          <Button type="submit" loading={uploading} disabled={uploadDisabled}>
            <Upload className="size-4" /> 上传并记录权属
          </Button>
        </div>
      </form>

      {previewUploadDisabled ? (
        <ActionMessage tone="info">
          公开预览只接受合成数据，不保存访客附件；请勿输入真实企业信息。
        </ActionMessage>
      ) : null}
      {archived ? <ActionMessage tone="info">项目已归档；现有图片可查看，但不能再上传附件。</ActionMessage> : null}

      {message ? <ActionMessage tone={message.tone}>{message.text}</ActionMessage> : null}

      <div className="attachment-list" aria-busy={loading}>
        {loading && attachments.length === 0 ? <p className="mono-note" role="status">正在读取附件…</p> : null}
        {!loading && attachments.length === 0 ? (
          <div className="attachment-empty">
            <FileImage className="size-5" />
            <p>尚未上传项目图片。Demo 默认示意图与用户附件会始终分开。</p>
          </div>
        ) : null}
        {attachments.map((attachment) => (
          <article className="attachment-card" key={attachment.id}>
            <div className="attachment-card__preview">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={attachmentContentUrl(projectId, attachment.id)}
                alt={`${attachment.original_filename} 项目附件预览`}
                loading="lazy"
              />
              <span>仅展示 · 不识图</span>
            </div>
            <div className="attachment-card__body">
              <div className="attachment-card__heading">
                <strong>{attachment.original_filename}</strong>
                <StatusPill tone="info">{attachment.mime_type.replace("image/", "").toUpperCase()}</StatusPill>
              </div>
              <dl>
                <div><dt>大小</dt><dd>{formatBytes(attachment.size_bytes)}</dd></div>
                <div><dt>来源</dt><dd>{attachment.source}</dd></div>
                <div><dt>时间</dt><dd>{formatDateTime(attachment.created_at)}</dd></div>
                <div className="attachment-card__hash"><dt>SHA-256</dt><dd>{attachment.sha256}</dd></div>
                <div className="attachment-card__rights"><dt>权属声明</dt><dd>{attachment.rights_declaration}</dd></div>
              </dl>
            </div>
          </article>
        ))}
      </div>
    </Surface>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}
