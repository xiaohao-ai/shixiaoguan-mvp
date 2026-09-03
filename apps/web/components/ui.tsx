import type { ButtonHTMLAttributes, HTMLAttributes, ReactNode } from "react";
import { AlertTriangle, LoaderCircle, RotateCw } from "lucide-react";
import { STATIC_PREVIEW_ENABLED } from "@/lib/static-preview-mode";

type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";

export function Button({
  className = "",
  variant = "primary",
  loading = false,
  children,
  disabled,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  loading?: boolean;
}) {
  return (
    <button
      className={`button button--${variant} ${className}`}
      disabled={disabled || loading}
      {...props}
    >
      {loading ? <LoaderCircle aria-hidden="true" className="size-4 animate-spin" /> : null}
      {children}
    </button>
  );
}

export function Surface({
  className = "",
  children,
  ...props
}: HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={`surface ${className}`} {...props}>
      {children}
    </div>
  );
}

export function Eyebrow({ children }: { children: ReactNode }) {
  return <p className="eyebrow">{children}</p>;
}

export function PageHeading({
  eyebrow,
  title,
  description,
  actions,
}: {
  eyebrow: string;
  title: string;
  description: string;
  actions?: ReactNode;
}) {
  return (
    <header className="page-heading">
      <div className="min-w-0">
        <Eyebrow>{eyebrow}</Eyebrow>
        <h1>{title}</h1>
        <p>{description}</p>
      </div>
      {actions ? <div className="page-heading__actions">{actions}</div> : null}
    </header>
  );
}

export function SectionHeading({
  title,
  description,
  action,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className="section-heading">
      <div>
        <h2>{title}</h2>
        {description ? <p>{description}</p> : null}
      </div>
      {action}
    </div>
  );
}

export function StatusPill({
  children,
  tone = "neutral",
  className = "",
}: {
  children: ReactNode;
  tone?: "neutral" | "good" | "warn" | "danger" | "info" | "ink";
  className?: string;
}) {
  return <span className={`status-pill status-pill--${tone} ${className}`}>{children}</span>;
}

export function LoadingPanel({ label = "正在读取项目数据…" }: { label?: string }) {
  return (
    <div className="state-panel" role="status">
      <LoaderCircle aria-hidden="true" className="size-6 animate-spin text-[var(--teal)]" />
      <div>
        <strong>{label}</strong>
        <p>{STATIC_PREVIEW_ENABLED ? "界面只展示浏览器内固定合成录制，不连接后端或真实数据。" : "界面只展示 API 返回的真实结果，不会填充推测数据。"}</p>
      </div>
    </div>
  );
}

export function ErrorPanel({
  title = "暂时无法读取数据",
  message,
  onRetry,
}: {
  title?: string;
  message: string;
  onRetry?: () => void;
}) {
  return (
    <div className="state-panel state-panel--error" role="alert">
      <AlertTriangle aria-hidden="true" className="size-6 shrink-0 text-[var(--signal)]" />
      <div className="min-w-0 flex-1">
        <strong>{title}</strong>
        <p>{message}</p>
      </div>
      {onRetry ? (
        <Button variant="secondary" onClick={onRetry}>
          <RotateCw aria-hidden="true" className="size-4" />
          重试
        </Button>
      ) : null}
    </div>
  );
}

export function EmptyState({
  icon,
  title,
  description,
  action,
}: {
  icon?: ReactNode;
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <div className="empty-state">
      {icon ? <div className="empty-state__icon">{icon}</div> : null}
      <h3>{title}</h3>
      <p>{description}</p>
      {action ? <div className="mt-5">{action}</div> : null}
    </div>
  );
}

export function DataList({
  items,
}: {
  items: Array<{ label: string; value: ReactNode; hint?: string }>;
}) {
  return (
    <dl className="data-list">
      {items.map((item) => (
        <div key={item.label} className="data-list__item">
          <dt>{item.label}</dt>
          <dd>{item.value}</dd>
          {item.hint ? <span>{item.hint}</span> : null}
        </div>
      ))}
    </dl>
  );
}

export function ActionMessage({
  tone,
  children,
}: {
  tone: "success" | "error" | "info";
  children: ReactNode;
}) {
  return (
    <div className={`action-message action-message--${tone}`} role={tone === "error" ? "alert" : "status"}>
      {children}
    </div>
  );
}
