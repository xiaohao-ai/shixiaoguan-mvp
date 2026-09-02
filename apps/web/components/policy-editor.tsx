"use client";

import { LockKeyhole, RefreshCw, Save, SlidersHorizontal } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useProject } from "@/components/project-context";
import { ActionMessage, Button, SectionHeading, StatusPill, Surface } from "@/components/ui";
import { api, getErrorMessage } from "@/lib/api";
import type { DemoPolicy } from "@/lib/types";

type NumericPolicyKey = Exclude<keyof DemoPolicy, "version" | "primary_metric">;

const demandFields: Array<{
  key: NumericPolicyKey;
  label: string;
  hint: string;
  min: number;
  max?: number;
  step: string;
  locked?: boolean;
}> = [
  { key: "min_exposure_per_arm", label: "每臂最低曝光", hint: "演示默认 300", min: 1, step: "1" },
  { key: "min_purchase_intent_events_per_arm", label: "每臂最低购买意向", hint: "演示默认 10", min: 1, step: "1" },
  { key: "expected_arm_share", label: "预期单臂流量占比", hint: "固定 0.5 / 0.5", min: 0.01, max: 0.99, step: "0.01", locked: true },
  { key: "srm_block_p_value", label: "SRM 阻断 p 值", hint: "p < 0.01 时阻断", min: 0.0001, max: 0.9999, step: "0.0001" },
  { key: "purchase_intent_rate_threshold", label: "购买意向率门槛", hint: "0.03 = 3%", min: 0, max: 1, step: "0.01" },
  { key: "relative_uplift_threshold", label: "相对提升门槛", hint: "0.15 = 15%", min: 0, step: "0.01" },
  { key: "gross_margin_floor_bps", label: "毛利率底线（bps）", hint: "4000 = 40%", min: 0, max: 10000, step: "100" },
];

const supplyFields: Array<{
  key: NumericPolicyKey;
  label: string;
  hint: string;
  min: number;
  max?: number;
  step: string;
}> = [
  { key: "modifiable_supply_budget_gap_ratio", label: "可修改供应预算缺口比例", hint: "缺口超过此值视为不可修改", min: 0, max: 1, step: "0.01" },
  { key: "modifiable_lead_time_gap_days", label: "可修改交期缺口（天）", hint: "允许通过改款处理的交期缺口", min: 0, step: "1" },
  { key: "modifiable_margin_gap_bps", label: "可修改毛利缺口（bps）", hint: "允许通过改款处理的毛利差距", min: 0, step: "100" },
];

export function isPolicyEditable(state?: string): boolean {
  return (state ?? "").toUpperCase() !== "ARCHIVED";
}

export function PolicyEditor() {
  const { projectId, project, refresh } = useProject();
  const [policy, setPolicy] = useState<DemoPolicy>();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ tone: "success" | "error" | "info"; text: string }>();
  const state = project?.state ?? project?.status;
  const editable = isPolicyEditable(state);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setPolicy(await api.getPolicy(projectId));
      setMessage(undefined);
    } catch (caught) {
      setMessage({ tone: "error", text: getErrorMessage(caught) });
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    void load();
  }, [load, project?.policy_version]);

  const changeNumber = (key: NumericPolicyKey, value: string) => {
    const parsed = Number(value);
    if (!policy || !Number.isFinite(parsed)) return;
    setPolicy({ ...policy, [key]: parsed });
  };

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!policy || !editable) return;
    setSaving(true);
    setMessage(undefined);
    try {
      await api.updatePolicy(projectId, policy);
      await refresh();
      const latest = await api.getPolicy(projectId);
      setPolicy(latest);
      setMessage({
        tone: "success",
        text: `已创建 DemoPolicy 新版本 ${latest.version}（revision ${latest.revision}）；旧版本保留可追溯。`,
      });
    } catch (caught) {
      setMessage({ tone: "error", text: getErrorMessage(caught) });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Surface className="panel-pad policy-editor">
      <SectionHeading
        title="DemoPolicy v1"
        description="这些值只是合成 Demo 的可编辑默认，不是行业标准。计划批准时会冻结当前快照。"
        action={
          <div className="flex flex-wrap items-center justify-end gap-2">
            <StatusPill tone={editable ? "warn" : "ink"}>
              {editable ? <SlidersHorizontal className="size-3.5" /> : <LockKeyhole className="size-3.5" />}
              {editable ? "可创建新版本" : "已归档·只读"}
            </StatusPill>
            <Button type="button" variant="ghost" onClick={() => void load()} disabled={loading || saving}>
              <RefreshCw className="size-4" /> 重读
            </Button>
          </div>
        }
      />

      {loading && !policy ? <p className="mono-note" role="status">正在读取项目策略…</p> : null}
      {policy ? (
        <form onSubmit={(event) => void submit(event)}>
          <div className="policy-version">
            <span>VERSION</span>
            <strong>{policy.version}</strong>
            <small>revision {policy.revision}</small>
          </div>
          <div className="form-field mt-4">
            <label htmlFor="policy-primary-metric">主指标（MVP 固定）</label>
            <input id="policy-primary-metric" className="input" value={policy.primary_metric} readOnly disabled />
          </div>

          <fieldset className="policy-fieldset" disabled={!editable || saving}>
            <legend>需求、质量与经营门槛</legend>
            <div className="form-grid">
              {demandFields.map((field) => (
                <PolicyNumberInput
                  key={field.key}
                  fieldKey={field.key}
                  label={field.label}
                  hint={field.hint}
                  min={field.min}
                  max={field.max}
                  step={field.step}
                  value={policy[field.key]}
                  disabled={field.locked}
                  onChange={(value) => changeNumber(field.key, value)}
                />
              ))}
            </div>
            <legend className="mt-5">供应约束的“可修改”界线</legend>
            <p className="policy-legend-note">MOQ × 单位成本不得超过生产预算，交期不得晚于上新窗口；下列数值只定义问题是否可通过 Pivot 修改。</p>
            <div className="form-grid">
              {supplyFields.map((field) => (
                <PolicyNumberInput
                  key={field.key}
                  fieldKey={field.key}
                  label={field.label}
                  hint={field.hint}
                  min={field.min}
                  max={field.max}
                  step={field.step}
                  value={policy[field.key]}
                  onChange={(value) => changeNumber(field.key, value)}
                />
              ))}
            </div>
          </fieldset>

          <details className="raw-details mt-5">
            <summary>展开其他决策边界</summary>
            <div className="form-grid raw-policy-grid">
              <PolicyNumberInput fieldKey="interest_ctr_floor" label="兴趣点击率底线" value={policy.interest_ctr_floor} min={0} max={1} step="0.01" disabled={!editable || saving} onChange={(value) => changeNumber("interest_ctr_floor", value)} />
              <PolicyNumberInput fieldKey="cart_per_click_floor" label="点击后加购率底线" value={policy.cart_per_click_floor} min={0} max={1} step="0.01" disabled={!editable || saving} onChange={(value) => changeNumber("cart_per_click_floor", value)} />
              <PolicyNumberInput fieldKey="clearly_low_intent_rate_ceiling" label="明显低意向率上限" value={policy.clearly_low_intent_rate_ceiling} min={0} max={1} step="0.01" disabled={!editable || saving} onChange={(value) => changeNumber("clearly_low_intent_rate_ceiling", value)} />
              <PolicyNumberInput fieldKey="clearly_low_ctr_ceiling" label="明显低点击率上限" value={policy.clearly_low_ctr_ceiling} min={0} max={1} step="0.01" disabled={!editable || saving} onChange={(value) => changeNumber("clearly_low_ctr_ceiling", value)} />
              <PolicyNumberInput fieldKey="conflicting_return_and_refund_rate" label="退货/退款信号冲突门槛" value={policy.conflicting_return_and_refund_rate} min={0} max={1} step="0.01" disabled={!editable || saving} onChange={(value) => changeNumber("conflicting_return_and_refund_rate", value)} />
            </div>
          </details>

          <div className="policy-editor__footer">
            <p>{editable ? "保存将生成不可覆盖的新版本；若计划已批准，项目会重开到 Brief Ready 并使当前下游投影失效。" : `当前流程 ${state ?? "未知"}；归档项目不可再修改。`}</p>
            <Button type="submit" loading={saving} disabled={!editable || !policy}>
              <Save className="size-4" /> 保存为新策略版本
            </Button>
          </div>
        </form>
      ) : null}
      {message ? <ActionMessage tone={message.tone}>{message.text}</ActionMessage> : null}
    </Surface>
  );
}

function PolicyNumberInput({
  fieldKey,
  label,
  hint,
  value,
  min,
  max,
  step,
  disabled,
  onChange,
}: {
  fieldKey: NumericPolicyKey;
  label: string;
  hint?: string;
  value: number;
  min: number;
  max?: number;
  step: string;
  disabled?: boolean;
  onChange: (value: string) => void;
}) {
  const name = fieldKey;
  return (
    <div className="form-field">
      <label htmlFor={`policy-${name}`}>{label}</label>
      <input
        id={`policy-${name}`}
        name={String(name)}
        className="input"
        type="number"
        value={value}
        min={min}
        max={max}
        step={step}
        disabled={disabled}
        required
        onChange={(event) => onChange(event.target.value)}
      />
      {hint ? <small>{hint}</small> : null}
    </div>
  );
}
