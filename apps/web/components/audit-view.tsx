"use client";

import {
  Activity,
  Bot,
  CheckCircle2,
  CircleHelp,
  Clock3,
  FileText,
  Fingerprint,
  RefreshCw,
  UserCheck,
  Wrench,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useProject } from "@/components/project-context";
import {
  Button,
  EmptyState,
  PageHeading,
  SectionHeading,
  StatusPill,
  Surface,
} from "@/components/ui";
import { api, reportUrl } from "@/lib/api";
import { formatDateTime } from "@/lib/presentation";
import type { AgentRun, AuditEvent, ObjectVersion } from "@/lib/types";

type AuditFilter = "ALL" | "HUMAN" | "AGENT" | "TOOL";

export function AuditView() {
  const { projectId, project } = useProject();
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [agentRuns, setAgentRuns] = useState<AgentRun[]>([]);
  const [objectVersions, setObjectVersions] = useState<ObjectVersion[]>([]);
  const [filter, setFilter] = useState<AuditFilter>("ALL");
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [nextEvents, nextAgentRuns, nextObjectVersions] = await Promise.all([
        api.getAuditEvents(projectId),
        api.getAgentRuns(projectId),
        api.getObjectVersions(projectId),
      ]);
      setEvents(nextEvents);
      setAgentRuns(nextAgentRuns);
      setObjectVersions(nextObjectVersions);
    } catch {
      setEvents([]);
      setAgentRuns([]);
      setObjectVersions([]);
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    void load();
  }, [load]);

  const filtered = useMemo(
    () => events.filter((event) => filter === "ALL" || eventKind(event) === filter),
    [events, filter],
  );

  const humanCount = events.filter((event) => eventKind(event) === "HUMAN").length;
  const toolCount = events.filter((event) => eventKind(event) === "TOOL").length;

  return (
    <>
      <PageHeading
        eyebrow="07 · Audit replay"
        title="沿着证据链回到每一步"
        description="状态变化、工具调用、对象版本和人工审批按时间记录。审计页只读取后端事件，不在浏览器中补写历史。"
        actions={
          <div className="flex flex-wrap gap-2">
            <a
              className="button button--secondary"
              href={reportUrl(projectId)}
              target="_blank"
              rel="noreferrer"
            >
              <FileText className="size-4" /> 打开 HTML 报告
            </a>
            <Button variant="secondary" onClick={() => void load()} loading={loading}>
              <RefreshCw className="size-4" /> 刷新事件
            </Button>
          </div>
        }
      />

      <div className="audit-stats">
        <Surface><span><Activity className="size-4" /> 全部事件</span><strong>{events.length}</strong><small>当前项目完整事件流</small></Surface>
        <Surface><span><UserCheck className="size-4" /> 人工节点</span><strong>{humanCount}</strong><small>审批与修改记录</small></Surface>
        <Surface><span><Wrench className="size-4" /> 系统/工具节点</span><strong>{toolCount}</strong><small>状态机、校验与确定性计算</small></Surface>
        <Surface><span><Bot className="size-4" /> Agent 运行</span><strong>{agentRuns.length}</strong><small>模式、Prompt 与输入输出哈希</small></Surface>
        <Surface><span><FileText className="size-4" /> 对象版本</span><strong>{objectVersions.length}</strong><small>不可覆盖的业务对象快照</small></Surface>
        <Surface><span><Clock3 className="size-4" /> 当前流程</span><strong className="audit-state">{project?.workflow_state ?? project?.status ?? project?.state ?? "—"}</strong><small>由服务端状态机维护</small></Surface>
      </div>

      <Surface className="panel-pad mt-5">
        <SectionHeading
          title="Agent 运行证据"
          description="仅展示必要运行元数据和哈希；模型不能改写数值、四态结果或审批状态。"
        />
        {!loading && agentRuns.length === 0 ? (
          <EmptyState
            icon={<Bot className="size-5" />}
            title="尚无 Agent 运行记录"
            description="完成 Brief 归一化、计划草案或引用式解释后，这里会显示在线/回放模式、Prompt 版本与降级原因。"
          />
        ) : (
          <div className="agent-run-list">
            {agentRuns.map((run) => <AgentRunRow key={run.id} run={run} />)}
          </div>
        )}
      </Surface>

      <Surface className="panel-pad mt-5">
        <SectionHeading
          title="不可变对象版本"
          description="每一行绑定对象 ID、版本与 canonical SHA-256；审批事件另行精确引用目标版本。"
        />
        {!loading && objectVersions.length === 0 ? (
          <EmptyState
            icon={<FileText className="size-5" />}
            title="尚无对象版本"
            description="创建 Brief 后，服务端会在此追加第一条不可变快照。"
          />
        ) : (
          <div className="agent-run-list">
            {objectVersions.map((version) => <ObjectVersionRow key={`${version.object_type}-${version.object_id}-${version.object_version}`} version={version} />)}
          </div>
        )}
      </Surface>

      <Surface className="panel-pad mt-5">
        <SectionHeading
          title="事件时间线"
          description="筛选只影响视图，不改变事件顺序和内容。"
          action={
            <div className="audit-filters" role="group" aria-label="筛选审计事件">
              {(["ALL", "HUMAN", "AGENT", "TOOL"] as const).map((value) => (
                <button key={value} className={filter === value ? "is-active" : ""} onClick={() => setFilter(value)}>
                  {{ ALL: "全部", HUMAN: "人工", AGENT: "Agent", TOOL: "系统/工具" }[value]}
                </button>
              ))}
            </div>
          }
        />

        {!loading && filtered.length === 0 ? (
          <EmptyState
            icon={<CircleHelp className="size-5" />}
            title="没有可展示的审计事件"
            description={events.length ? "当前筛选条件没有匹配事件。" : "API 尚未返回事件；页面不会构造示例历史。"}
          />
        ) : (
          <ol className="audit-timeline">
            {filtered.map((event, index) => <AuditRow event={event} index={index} key={event.id ?? event.event_id ?? index} />)}
          </ol>
        )}
      </Surface>

      <div className="callout mt-5">
        <Fingerprint className="mb-2 size-5 text-[var(--teal)]" />
        <strong>可复算，不等于可篡改</strong>
        <p>同一数据与规则版本可以重放决策；历史对象与审批事件只追加，不由当前页面覆盖。</p>
      </div>
    </>
  );
}

function ObjectVersionRow({ version }: { version: ObjectVersion }) {
  return (
    <article className="agent-run-row">
      <div className="agent-run-row__head">
        <div>
          <StatusPill tone="info">VERSION {version.object_version}</StatusPill>
          <h3>{version.object_type}</h3>
        </div>
        <time dateTime={version.created_at}>{formatDateTime(version.created_at)}</time>
      </div>
      <div className="agent-run-row__meta">
        <span>对象 ID <strong>{version.object_id}</strong></span>
        <span>项目 <strong>{version.project_id}</strong></span>
      </div>
      <dl className="agent-run-row__hashes">
        <div><dt>Canonical SHA-256</dt><dd>{version.sha256}</dd></div>
      </dl>
    </article>
  );
}

function AgentRunRow({ run }: { run: AgentRun }) {
  return (
    <article className="agent-run-row">
      <div className="agent-run-row__head">
        <div>
          <StatusPill tone={run.success ? "good" : "danger"}>{run.success ? "SUCCESS" : "FAILED"}</StatusPill>
          <StatusPill tone={run.mode === "LIVE" ? "good" : "info"}>{run.mode}</StatusPill>
          <h3>{run.operation}</h3>
        </div>
        <time dateTime={run.created_at}>{formatDateTime(run.created_at)}</time>
      </div>
      <div className="agent-run-row__meta">
        <span>模型 <strong>{run.model_name ?? "录制回放"}</strong></span>
        <span>推理 <strong>{run.reasoning_effort ?? "N/A"}</strong></span>
        <span>Prompt <strong>{run.prompt_version}</strong></span>
        <span>Schema <strong>{run.output_schema_version}</strong></span>
        <span>录制 <strong>{run.recording_id ?? "N/A"}</strong></span>
        <span>耗时 <strong>{run.duration_ms} ms</strong></span>
        <span>Tracing <strong>{run.tracing_disabled ? "OFF" : "ON"}</strong></span>
        <span>API store <strong>{run.api_store_disabled ? "OFF" : "ON"}</strong></span>
      </div>
      <dl className="agent-run-row__hashes">
        <div><dt>输入 SHA-256</dt><dd>{run.input_sha256}</dd></div>
        <div><dt>输出 SHA-256</dt><dd>{run.output_sha256}</dd></div>
      </dl>
      {run.fallback_reason ? <p className="agent-run-row__fallback">降级原因：{run.fallback_reason}</p> : null}
    </article>
  );
}

function eventKind(event: AuditEvent): Exclude<AuditFilter, "ALL"> {
  const value = `${event.actor ?? ""} ${event.actor_type ?? ""} ${event.event_type ?? ""} ${event.action ?? ""}`.toUpperCase();
  if (value.includes("HUMAN") || value.includes("APPROV")) return "HUMAN";
  if (value.includes("AGENT")) return "AGENT";
  return "TOOL";
}

function AuditRow({ event, index }: { event: AuditEvent; index: number }) {
  const kind = eventKind(event);
  const Icon = kind === "HUMAN" ? UserCheck : kind === "TOOL" ? Wrench : Bot;
  const title = event.message ?? event.action ?? event.event_type ?? "项目事件";
  const timestamp = event.created_at ?? event.timestamp;
  const eventId = event.id ?? event.event_id;
  return (
    <li className="audit-row">
      <div className={`audit-row__icon audit-row__icon--${kind.toLowerCase()}`}><Icon className="size-4" /></div>
      <div className="audit-row__rail">{index < 999 ? null : <CheckCircle2 className="size-3" />}</div>
      <article>
        <div className="audit-row__head">
          <div><StatusPill tone={kind === "HUMAN" ? "warn" : kind === "TOOL" ? "good" : "info"}>{kind}</StatusPill><h3>{title}</h3></div>
          <time dateTime={timestamp}>{formatDateTime(timestamp)}</time>
        </div>
        <div className="audit-row__meta">
          <span>操作者 <strong>{event.actor ?? "SYSTEM"}</strong></span>
          {event.from_state || event.to_state ? <span>状态 <strong>{event.from_state ?? "—"} → {event.to_state ?? "—"}</strong></span> : null}
          {eventId ? <span>事件 <strong>{eventId}</strong></span> : null}
        </div>
        {(event.summary ?? event.metadata) && Object.keys(event.summary ?? event.metadata ?? {}).length ? (
          <details className="audit-row__details"><summary>查看事件摘要</summary><pre>{JSON.stringify(event.summary ?? event.metadata, null, 2)}</pre></details>
        ) : null}
      </article>
    </li>
  );
}
