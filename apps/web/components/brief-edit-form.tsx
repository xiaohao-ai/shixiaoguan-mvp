"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { Save, X } from "lucide-react";
import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { useProject } from "@/components/project-context";
import { ActionMessage, Button, SectionHeading, Surface } from "@/components/ui";
import { api, getErrorMessage } from "@/lib/api";
import { projectBrief } from "@/lib/presentation";
import type { ProductBrief } from "@/lib/types";

const MAX_SAFE_YUAN = Math.floor(Number.MAX_SAFE_INTEGER / 100);

const briefFormSchema = z.object({
  product_name: z.string().trim().max(200),
  candidate_id: z.string().trim().max(80),
  target_audience: z.string().trim().max(300),
  usage_scenario: z.string().trim().max(300),
  channel: z.string().trim().max(120),
  business_goal: z.string().trim().max(1000),
  core_selling_points_text: z.string().trim(),
  variant_a_color: z.string().trim().max(80),
  variant_b_color: z.string().trim().max(80),
  target_price_yuan: z.coerce.number().min(0).max(MAX_SAFE_YUAN),
  estimated_cost_yuan: z.coerce.number().min(0).max(MAX_SAFE_YUAN),
  gross_margin_floor_percent: z.coerce.number().min(0).max(100),
  moq: z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  expected_lead_time_days: z.coerce.number().int().min(0),
  target_launch_days: z.coerce.number().int().min(0),
  trial_budget_yuan: z.coerce.number().min(0).max(MAX_SAFE_YUAN),
  production_budget_yuan: z.coerce.number().min(0).max(MAX_SAFE_YUAN),
});

type BriefFormValues = z.infer<typeof briefFormSchema>;

function defaults(brief?: ProductBrief): BriefFormValues {
  return {
    product_name: brief?.product_name ?? "",
    candidate_id: brief?.candidate_id ?? "",
    target_audience: brief?.target_audience ?? "",
    usage_scenario: brief?.usage_scenario ?? "",
    channel: brief?.channel ?? "",
    business_goal: brief?.business_goal ?? "",
    core_selling_points_text: brief?.core_selling_points?.join("、") ?? "",
    variant_a_color: brief?.variants?.[0]?.color_name ?? "",
    variant_b_color: brief?.variants?.[1]?.color_name ?? "",
    target_price_yuan: (brief?.target_price_fen ?? 0) / 100,
    estimated_cost_yuan: (brief?.estimated_cost_fen ?? 0) / 100,
    gross_margin_floor_percent: (brief?.gross_margin_floor_bps ?? 0) / 100,
    moq: brief?.moq ?? 0,
    expected_lead_time_days: brief?.expected_lead_time_days ?? 0,
    target_launch_days: brief?.target_launch_days ?? 0,
    trial_budget_yuan: (brief?.trial_budget_fen ?? 0) / 100,
    production_budget_yuan: (brief?.production_budget_fen ?? 0) / 100,
  };
}

export function BriefEditForm({ onClose }: { onClose: () => void }) {
  const { projectId, project, refresh } = useProject();
  const brief = projectBrief(project);
  const briefVersion = project?.brief_version;
  const [message, setMessage] = useState<{ tone: "success" | "error"; text: string }>();
  const {
    register,
    handleSubmit,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<BriefFormValues>({
    resolver: zodResolver(briefFormSchema),
    defaultValues: defaults(brief),
  });

  useEffect(() => reset(defaults(brief)), [brief, reset]);

  const submit = handleSubmit(async (values) => {
    if (!brief || typeof briefVersion !== "number") {
      setMessage({ tone: "error", text: "API 未返回 Brief 或版本号，无法安全保存。" });
      return;
    }
    setMessage(undefined);
    const targetPriceFen = values.target_price_yuan > 0
      ? Math.round(values.target_price_yuan * 100)
      : undefined;
    const colorNames = [values.variant_a_color.trim(), values.variant_b_color.trim()];
    const variants = targetPriceFen && colorNames.every(Boolean)
      ? colorNames.map((colorName, index) => ({
          id: brief.variants?.[index]?.id ?? `V-${index === 0 ? "A" : "B"}`,
          label: brief.variants?.[index]?.label ?? `配色 ${index === 0 ? "A" : "B"} · ${colorName}`,
          color_name: colorName,
          color_hex: brief.variants?.[index]?.color_hex,
          material_notes: brief.variants?.[index]?.material_notes,
          image_url: brief.variants?.[index]?.image_url,
          target_price_fen: targetPriceFen,
        }))
      : [];
    const nextBrief: ProductBrief = {
      ...brief,
      product_name: values.product_name || undefined,
      candidate_id: values.candidate_id || undefined,
      target_audience: values.target_audience || undefined,
      usage_scenario: values.usage_scenario || undefined,
      channel: values.channel || undefined,
      business_goal: values.business_goal || undefined,
      core_selling_points: values.core_selling_points_text
        .split(/[、,，\n]/)
        .map((item) => item.trim())
        .filter(Boolean),
      variants,
      target_price_fen: targetPriceFen,
      estimated_cost_fen: values.estimated_cost_yuan > 0
        ? Math.round(values.estimated_cost_yuan * 100)
        : undefined,
      gross_margin_floor_bps: Math.round(values.gross_margin_floor_percent * 100),
      moq: values.moq > 0 ? values.moq : undefined,
      expected_lead_time_days: values.expected_lead_time_days > 0
        ? values.expected_lead_time_days
        : undefined,
      target_launch_days: values.target_launch_days > 0 ? values.target_launch_days : undefined,
      trial_budget_fen: values.trial_budget_yuan > 0
        ? Math.round(values.trial_budget_yuan * 100)
        : undefined,
      production_budget_fen: values.production_budget_yuan > 0
        ? Math.round(values.production_budget_yuan * 100)
        : undefined,
    };
    try {
      const updated = await api.updateBrief(projectId, nextBrief, briefVersion);
      await refresh();
      setMessage({
        tone: "success",
        text: updated.status === "DRAFT"
          ? "草稿已保存；缺失项保持待确认，Agent 不会代填。"
          : "Brief 已就绪；下游计划和旧分析已按版本规则失效。",
      });
    } catch (caught) {
      setMessage({ tone: "error", text: getErrorMessage(caught) });
    }
  });

  return (
    <Surface className="panel-pad brief-editor">
      <SectionHeading
        title="编辑 Product Brief"
        description={`当前版本 v${briefVersion ?? "—"}；保存时使用乐观锁，避免覆盖他人修改。`}
        action={<Button variant="ghost" onClick={onClose}><X className="size-4" /> 关闭</Button>}
      />
      <form onSubmit={(event) => void submit(event)} noValidate>
        <div className="form-grid">
          <FormInput label="产品名称" error={errors.product_name?.message} {...register("product_name")} />
          <FormInput label="候选款编号" error={errors.candidate_id?.message} {...register("candidate_id")} />
          <FormInput label="目标人群" error={errors.target_audience?.message} {...register("target_audience")} />
          <FormInput label="使用场景" error={errors.usage_scenario?.message} {...register("usage_scenario")} />
          <FormInput label="试销渠道" error={errors.channel?.message} {...register("channel")} />
          <FormInput label="经营目标" error={errors.business_goal?.message} {...register("business_goal")} />
          <FormInput label="配色 A" error={errors.variant_a_color?.message} {...register("variant_a_color")} />
          <FormInput label="配色 B" error={errors.variant_b_color?.message} {...register("variant_b_color")} />
          <FormInput label="目标零售价（元）" type="number" step="0.01" error={errors.target_price_yuan?.message} {...register("target_price_yuan")} />
          <FormInput label="预计成本（元）" type="number" step="0.01" error={errors.estimated_cost_yuan?.message} {...register("estimated_cost_yuan")} />
          <FormInput label="毛利底线（%）" type="number" step="0.01" error={errors.gross_margin_floor_percent?.message} {...register("gross_margin_floor_percent")} />
          <FormInput label="MOQ（双）" type="number" error={errors.moq?.message} {...register("moq")} />
          <FormInput label="期望交期（天）" type="number" error={errors.expected_lead_time_days?.message} {...register("expected_lead_time_days")} />
          <FormInput label="距目标上新窗口（天）" type="number" error={errors.target_launch_days?.message} {...register("target_launch_days")} />
          <FormInput label="试销预算（元）" type="number" step="0.01" error={errors.trial_budget_yuan?.message} {...register("trial_budget_yuan")} />
          <FormInput label="可用生产预算（元）" type="number" step="0.01" error={errors.production_budget_yuan?.message} {...register("production_budget_yuan")} />
        </div>
        <div className="form-field mt-4">
          <label htmlFor="core-selling-points">核心卖点（用顿号或逗号分隔）</label>
          <textarea id="core-selling-points" className="textarea" {...register("core_selling_points_text")} />
          {errors.core_selling_points_text ? <span className="field-error">{errors.core_selling_points_text.message}</span> : null}
        </div>
        <div className="mt-5 flex justify-end">
          <Button type="submit" loading={isSubmitting} disabled={typeof briefVersion !== "number"}>
            <Save className="size-4" /> 保存草稿 / 新版本
          </Button>
        </div>
      </form>
      {message ? <ActionMessage tone={message.tone}>{message.text}</ActionMessage> : null}
    </Surface>
  );
}

function FormInput({
  label,
  error,
  ...props
}: React.InputHTMLAttributes<HTMLInputElement> & { label: string; error?: string }) {
  const id = props.name ?? label;
  return (
    <div className="form-field">
      <label htmlFor={id}>{label}</label>
      <input id={id} className="input" aria-invalid={Boolean(error)} {...props} />
      {error ? <span className="field-error">{error}</span> : null}
    </div>
  );
}
