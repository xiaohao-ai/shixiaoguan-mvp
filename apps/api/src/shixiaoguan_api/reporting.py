from __future__ import annotations

import html
from collections.abc import Iterable
from datetime import UTC, datetime
from zoneinfo import ZoneInfo

from .formatting import format_fen
from .schemas import AgentRunSummary, AuditEvent, ProjectDetail


def _esc(value: object) -> str:
    return html.escape(str(value), quote=True)


def _list(items: Iterable[object]) -> str:
    values = list(items)
    if not values:
        return "<p class='muted'>暂无</p>"
    return "<ul>{}</ul>".format("".join(f"<li>{_esc(item)}</li>" for item in values))


def _shanghai_time(value: datetime) -> str:
    utc_value = value if value.tzinfo is not None else value.replace(tzinfo=UTC)
    return utc_value.astimezone(ZoneInfo("Asia/Shanghai")).strftime("%Y-%m-%d %H:%M:%S %Z")


def render_report(
    project: ProjectDetail,
    events: list[AuditEvent],
    agent_runs: list[AgentRunSummary],
) -> str:
    decision = project.artifacts.decision
    evidence = project.artifacts.evidence
    quality = project.artifacts.quality
    metrics = project.artifacts.metrics
    pivot_revision = project.artifacts.pivot_revision
    handoff = project.artifacts.handoff
    active_dataset = next((item for item in reversed(project.datasets) if item.active), None)
    target_price = format_fen(project.brief.target_price_fen)
    estimated_cost = format_fen(project.brief.estimated_cost_fen)

    metric_rows = ""
    if metrics:
        metric_rows = "".join(
            f"<tr><td>{_esc(item.variant_id)}</td><td>{item.exposure}</td><td>{item.ctr:.2%}</td><td>{item.intent_rate:.2%}</td>"
            f"<td>{item.intent_rate_ci_low:.2%}–{item.intent_rate_ci_high:.2%}</td><td>{item.return_and_refund_rate:.2%}</td></tr>"
            for item in metrics.variants
        )
    quality_items = []
    if quality:
        quality_items = [
            (
                f"{item.severity.value} / {item.code}: {item.message}｜"
                f"影响字段：{', '.join(item.affected_fields) or '全局'}｜"
                f"记录引用：{', '.join(item.record_refs) or '无单行引用'}｜"
                f"观测/期望：{item.observed!r} / {item.expected!r}｜"
                f"处理状态：{item.handling_status}"
            )
            for item in quality.issues
        ]
        if not quality_items:
            quality_items = [
                f"{quality.status.value}：未发现阻断或警告项，共校验 {quality.row_count} 行聚合观测。"
            ]
    evidence_items = []
    if evidence:
        for item in evidence.claims:
            trace_refs = [*item.metric_refs, *item.source_refs]
            parts = [
                (
                    f"{item.statement_type.value} / {item.inference_strength.value} / "
                    f"证据 {item.evidence_grade.value} / {item.stance.value}: {item.statement}"
                )
            ]
            if trace_refs:
                parts.append(f"引用：{', '.join(trace_refs)}")
            if item.counterexamples:
                parts.append(f"反例：{'; '.join(item.counterexamples)}")
            if item.limitations:
                parts.append(f"限制：{'; '.join(item.limitations)}")
            evidence_items.append("｜".join(parts))
    audit_rows = "".join(
        "<tr><td>{}</td><td>{}</td><td>{}</td><td>{} → {}</td><td>{}</td></tr>".format(
            _esc(_shanghai_time(item.created_at)),
            _esc(item.actor),
            _esc(item.action),
            _esc(item.from_state.value if item.from_state else "—"),
            _esc(item.to_state.value if item.to_state else "—"),
            _esc(item.summary),
        )
        for item in events
    )
    agent_rows = "".join(
        "<tr><td>{}</td><td>{}</td><td>{}</td><td>{}</td><td>{}</td><td>{}</td><td>{} ms</td><td><code>{}</code></td><td><code>{}</code></td><td>{}</td></tr>".format(
            _esc(_shanghai_time(item.created_at)),
            _esc(item.operation),
            _esc(item.mode.value),
            _esc(item.model_name or "录制回放"),
            _esc(item.output_schema_version),
            _esc(item.recording_id or "—"),
            item.duration_ms,
            _esc(item.input_sha256),
            _esc(item.output_sha256),
            _esc(item.fallback_reason or ("成功" if item.success else "失败")),
        )
        for item in agent_runs
    )
    if not agent_rows:
        agent_rows = "<tr><td colspan='10' class='muted'>尚无 Agent 运行记录。</td></tr>"

    dataset_provenance = "<p class='muted'>尚未生成 TrialDataset。</p>"
    if active_dataset:
        dataset_provenance = f"""
        <table><tbody>
        <tr><th>数据集</th><td><code>{_esc(active_dataset.id)}</code></td><th>Schema</th><td>{_esc(active_dataset.schema_version)}</td></tr>
        <tr><th>数据 SHA-256</th><td colspan="3"><code>{_esc(active_dataset.sha256)}</code></td></tr>
        <tr><th>场景 / 版本</th><td>{_esc(active_dataset.scenario_id.value)} / {_esc(active_dataset.scenario_version)}</td><th>种子</th><td>{active_dataset.fixed_seed}</td></tr>
        <tr><th>生成器</th><td>{_esc(active_dataset.generator_version)}</td><th>计划版本 / 行数</th><td>v{active_dataset.plan_version} / {active_dataset.row_count}</td></tr>
        </tbody></table>
        """

    handoff_html = "<p class='muted'>尚未生成交接草案。</p>"
    if handoff:
        techpack_section = (
            "<p class='muted'>Pivot 路径不生成 TechPack；仅提供已批准修订所绑定的改款打样草稿。</p>"
        )
        if handoff.techpack:
            techpack_fields = "".join(
                "<tr><td>{}</td><td>{}</td><td>{}</td></tr>".format(
                    _esc(field.name), _esc(field.value or "待确认"), _esc(field.status)
                )
                for field in handoff.techpack.fields
            )
            techpack_section = (
                "<table><thead><tr><th>字段</th><th>值</th><th>确认状态</th>"
                f"</tr></thead><tbody>{techpack_fields}</tbody></table>"
            )
        order_rows = "".join(
            "<tr><td>{}</td><td>{}</td><td>{}</td><td>{}</td></tr>".format(
                _esc(item.name),
                (
                    f"{item.quantity_low} 双（离散情景点）"
                    if item.quantity_low == item.quantity_high
                    else f"{item.quantity_low}–{item.quantity_high} 双"
                ),
                _esc(item.status),
                _esc("；".join(item.assumptions)),
            )
            for item in handoff.first_order_scenarios
        )
        handoff_html = """
        <p><span class="pill">{status}</span></p>
        <p><strong>{watermark}</strong></p>
        <p>{blocked}</p>
        <h3>TechPack Lite</h3>
        {techpack}
        <h3>首单三点情景（草案）</h3>
        <p class="muted">保守、基准、进取是三个离散计算点，三点整体构成情景范围；不是销量预测或单点置信区间。</p>
        <table><thead><tr><th>情景</th><th>包装步长数量点</th><th>状态</th><th>假设</th></tr></thead><tbody>{orders}</tbody></table>
        {retest}
        """.format(
            status=_esc(handoff.status),
            watermark=_esc(handoff.watermark or ""),
            blocked=_esc(handoff.blocked_reason or ""),
            techpack=techpack_section,
            orders=order_rows,
            retest=_list(handoff.retest_plan),
        )

    decision_html = "<p class='muted'>尚未生成 Decision Card。</p>"
    if decision:
        decision_html = f"""
        <p><span class="decision">{_esc(decision.outcome.value)}</span> <span class="pill">证据等级 {_esc(decision.evidence_grade)}</span>
        <span class="pill">{_esc(decision.approval_status.value)}</span></p>
        <p>{_esc(decision.one_sentence)}</p>
        <h3>规则原因</h3>{_list(decision.reason_codes)}
        <h3>限制</h3>{_list(decision.limitations)}
        <h3>下一步</h3>{_list(decision.next_actions)}
        """

    pivot_revision_html = "<p class='muted'>当前决策无 PivotRevision。</p>"
    if pivot_revision:
        pivot_revision_html = f"""
        <p><span class="pill">PivotRevision v{pivot_revision.version}</span>
        <span class="pill">{_esc(pivot_revision.approval_status.value)}</span></p>
        <p>目标变体 <code>{_esc(pivot_revision.target_variant_id)}</code> · 唯一修改变量
        <strong>{_esc(pivot_revision.change_variable)}</strong></p>
        <h3>修改项</h3>{_list(pivot_revision.change_list)}
        <h3>复测计划</h3>{_list(pivot_revision.retest_plan)}
        """

    return f"""<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>{_esc(project.name)} - 试销官决策报告</title>
<style>
body{{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;max-width:1060px;margin:32px auto;padding:0 20px;color:#19231f;line-height:1.55}}
h1,h2,h3{{color:#153a2d}} h2{{margin-top:34px;border-bottom:1px solid #d9e2dd;padding-bottom:8px}}
.banner{{background:#fff2c7;border:1px solid #e0bd49;padding:12px 16px;border-radius:8px;font-weight:700}}
.pill,.decision{{display:inline-block;padding:3px 9px;border-radius:999px;background:#e4eee9;margin-right:6px}}
.decision{{background:#153a2d;color:white;font-weight:700}} .muted{{color:#6b7772}}
table{{border-collapse:collapse;width:100%;font-size:14px}} th,td{{border:1px solid #d9e2dd;padding:8px;vertical-align:top;text-align:left}}
th{{background:#f1f5f3}} code{{background:#f1f5f3;padding:2px 5px;border-radius:4px}}
@media print{{body{{margin:0;max-width:none}} .no-print{{display:none}}}}
</style></head><body>
<div class="banner">数据状态：{_esc(project.data_status.value)}。合成数据只验证流程与规则，不代表真实企业成效。</div>
<h1>试销官决策报告</h1>
<p><strong>{_esc(project.name)}</strong> · 项目 <code>{_esc(project.id)}</code> · 流程状态 {_esc(project.status.value)}</p>
<p><strong>非生产指令：</strong>本报告不会下单、打样、排产或对外发布；任何后续执行必须由人在系统外复核。</p>
<h2>来源与可复算血缘</h2>
<p>数据来源 <code>{_esc(project.data_origin.value)}</code> · 敏感级别 <code>{_esc(project.data_sensitivity_level.value)}</code> · 场景 {_esc(project.scenario_id.value if project.scenario_id else "无")} · 场景版本 {_esc(project.scenario_version or "无")} · 固定种子 {_esc(project.fixed_seed if project.fixed_seed is not None else "无")} · 生成器 {_esc(project.generator_version or "无")}</p>
<p>DemoPolicy {_esc(project.policy_version)} / revision {project.policy_revision} · 质检规则 {_esc(quality.rule_version if quality else "尚未运行")} · 指标算法 {_esc(metrics.metric_version if metrics else "尚未运行")} · 当前模式 {_esc(project.agent_mode.value)}</p>
{dataset_provenance}
<h2>Product Brief</h2>
<p>产品：{_esc(project.brief.product_name or "待确认")} / 品类：{_esc(project.brief.category)} / 人群：{_esc(project.brief.target_audience or "待确认")}</p>
<p>零售价：{target_price} / 估算成本：{estimated_cost} / MOQ：{_esc(project.brief.moq if project.brief.moq is not None else "待确认")} 双</p>
<h2>数据质量</h2>{_list(quality_items)}
<h2>核心指标</h2>
<table><thead><tr><th>变体</th><th>曝光</th><th>CTR</th><th>意向率</th><th>95% Wilson 区间</th><th>退款/退货率</th></tr></thead><tbody>{metric_rows}</tbody></table>
<h2>Evidence Card</h2>{_list(evidence_items)}
<h3>全局限制</h3>{_list(evidence.limitations if evidence else [])}
<h2>Decision Card</h2>{decision_html}
<h2>Pivot 修订门禁</h2>{pivot_revision_html}
<h2>交接草案</h2>{handoff_html}
<h2>Agent 运行记录</h2>
<p class="muted">仅保存运行元数据与输入/输出哈希；不在报告中暴露 API Key 或原始个人数据。</p>
<table><thead><tr><th>时间</th><th>操作</th><th>模式</th><th>模型</th><th>输出 Schema</th><th>录制 ID</th><th>耗时</th><th>输入哈希</th><th>输出哈希</th><th>结果/降级</th></tr></thead><tbody>{agent_rows}</tbody></table>
<h2>审计日志</h2>
<table><thead><tr><th>时间</th><th>操作者</th><th>动作</th><th>状态迁移</th><th>摘要</th></tr></thead><tbody>{audit_rows}</tbody></table>
</body></html>"""
