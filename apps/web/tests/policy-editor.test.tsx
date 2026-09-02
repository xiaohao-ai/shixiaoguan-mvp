import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PolicyEditor } from "@/components/policy-editor";
import type { DemoPolicy, ProjectDetail } from "@/lib/types";

const mocks = vi.hoisted(() => ({
  getPolicy: vi.fn(),
  updatePolicy: vi.fn(),
  refresh: vi.fn(),
  useProject: vi.fn(),
}));

vi.mock("@/components/project-context", () => ({
  useProject: () => mocks.useProject(),
}));

vi.mock("@/lib/api", () => ({
  api: {
    getPolicy: mocks.getPolicy,
    updatePolicy: mocks.updatePolicy,
  },
  getErrorMessage: (error: unknown) => error instanceof Error ? error.message : "操作失败",
}));

const policy: DemoPolicy = {
  version: "demo-policy-v1",
  revision: 1,
  primary_metric: "purchase_intent_count/exposure",
  min_exposure_per_arm: 300,
  min_purchase_intent_events_per_arm: 10,
  expected_arm_share: 0.5,
  srm_block_p_value: 0.01,
  purchase_intent_rate_threshold: 0.03,
  relative_uplift_threshold: 0.15,
  gross_margin_floor_bps: 4000,
  interest_ctr_floor: 0.1,
  cart_per_click_floor: 0.2,
  clearly_low_intent_rate_ceiling: 0.01,
  clearly_low_ctr_ceiling: 0.06,
  conflicting_return_and_refund_rate: 0.2,
  modifiable_supply_budget_gap_ratio: 0.35,
  modifiable_lead_time_gap_days: 14,
  modifiable_margin_gap_bps: 500,
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getPolicy.mockResolvedValue(policy);
  mocks.updatePolicy.mockResolvedValue({ id: "project-1", status: "BRIEF_READY" });
  mocks.refresh.mockResolvedValue({ id: "project-1", status: "BRIEF_READY" });
  mocks.useProject.mockReturnValue({
    projectId: "project-1",
    project: { id: "project-1", status: "PLAN_PROPOSED", policy_version: policy.version } as ProjectDetail,
    refresh: mocks.refresh,
  });
});

describe("DemoPolicy editor", () => {
  it("shows demo defaults and saves a complete new version before approval", async () => {
    render(<PolicyEditor />);

    const exposure = await screen.findByLabelText("每臂最低曝光");
    expect(exposure).toHaveValue(300);
    expect(screen.getByLabelText("预期单臂流量占比")).toHaveValue(0.5);
    expect(screen.getByLabelText("毛利率底线（bps）")).toHaveValue(4000);
    expect(screen.getByText("可创建新版本")).toBeInTheDocument();

    fireEvent.change(exposure, { target: { value: "450" } });
    fireEvent.click(screen.getByRole("button", { name: /保存为新策略版本/ }));

    await waitFor(() => expect(mocks.updatePolicy).toHaveBeenCalledTimes(1));
    expect(mocks.updatePolicy).toHaveBeenCalledWith(
      "project-1",
      expect.objectContaining({
        version: "demo-policy-v1",
        revision: 1,
        min_exposure_per_arm: 450,
        min_purchase_intent_events_per_arm: 10,
        expected_arm_share: 0.5,
        srm_block_p_value: 0.01,
        purchase_intent_rate_threshold: 0.03,
        relative_uplift_threshold: 0.15,
        gross_margin_floor_bps: 4000,
        modifiable_supply_budget_gap_ratio: 0.35,
      }),
    );
    expect(mocks.refresh).toHaveBeenCalled();
  });

  it("allows a new policy version after plan approval so the workflow can reopen", async () => {
    mocks.useProject.mockReturnValue({
      projectId: "project-1",
      project: { id: "project-1", status: "PLAN_APPROVED", policy_version: policy.version } as ProjectDetail,
      refresh: mocks.refresh,
    });

    render(<PolicyEditor />);

    expect(await screen.findByText("可创建新版本")).toBeInTheDocument();
    expect(screen.getByLabelText("每臂最低曝光")).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: /保存为新策略版本/ }));
    await waitFor(() => expect(mocks.updatePolicy).toHaveBeenCalledTimes(1));
  });

  it("keeps policy immutable after archival", async () => {
    mocks.useProject.mockReturnValue({
      projectId: "project-1",
      project: { id: "project-1", status: "ARCHIVED", policy_version: policy.version } as ProjectDetail,
      refresh: mocks.refresh,
    });

    render(<PolicyEditor />);

    expect(await screen.findByText("已归档·只读")).toBeInTheDocument();
    expect(screen.getByLabelText("每臂最低曝光")).toBeDisabled();
    expect(screen.getByRole("button", { name: /保存为新策略版本/ })).toBeDisabled();
  });
});
