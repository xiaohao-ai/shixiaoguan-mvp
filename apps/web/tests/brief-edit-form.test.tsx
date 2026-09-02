import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { BriefEditForm } from "@/components/brief-edit-form";
import type { ProjectDetail } from "@/lib/types";

const mocks = vi.hoisted(() => ({
  updateBrief: vi.fn(),
  refresh: vi.fn(),
  useProject: vi.fn(),
}));

vi.mock("@/components/project-context", () => ({
  useProject: () => mocks.useProject(),
}));

vi.mock("@/lib/api", () => ({
  api: { updateBrief: mocks.updateBrief },
  getErrorMessage: (error: unknown) => error instanceof Error ? error.message : "操作失败",
}));

const draftProject = {
  id: "draft-1",
  status: "DRAFT",
  brief_version: 1,
  brief: {
    category: "MEN_LIGHTWEIGHT_CASUAL",
    season: "ALL_SEASON",
    gross_margin_floor_bps: 4000,
    target_launch_days: 60,
    core_selling_points: [],
    known_risks: [],
    variants: [],
    data_status: "SYNTHETIC",
  },
} as ProjectDetail;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.refresh.mockResolvedValue(draftProject);
  mocks.updateBrief.mockResolvedValue({ ...draftProject, brief_version: 2 });
  mocks.useProject.mockReturnValue({
    projectId: "draft-1",
    project: draftProject,
    refresh: mocks.refresh,
  });
});

describe("Brief draft editor", () => {
  it("persists an incomplete draft without inventing missing facts", async () => {
    render(<BriefEditForm onClose={vi.fn()} />);

    fireEvent.change(screen.getByLabelText("产品名称"), {
      target: { value: "轻量休闲鞋草稿" },
    });
    fireEvent.click(screen.getByRole("button", { name: /保存草稿/ }));

    await waitFor(() => expect(mocks.updateBrief).toHaveBeenCalledTimes(1));
    const [, brief, version] = mocks.updateBrief.mock.calls[0];
    expect(version).toBe(1);
    expect(brief).toMatchObject({
      product_name: "轻量休闲鞋草稿",
      variants: [],
      data_status: "SYNTHETIC",
    });
    expect(brief.target_audience).toBeUndefined();
    expect(brief.target_price_fen).toBeUndefined();
    expect(await screen.findByText(/草稿已保存/)).toBeInTheDocument();
  });

  it("constructs exactly two user-entered color variants when the Brief is completed", async () => {
    mocks.updateBrief.mockResolvedValue({
      ...draftProject,
      status: "BRIEF_READY",
      brief_version: 2,
    });
    render(<BriefEditForm onClose={vi.fn()} />);

    const values: Record<string, string> = {
      "产品名称": "男士轻量休闲鞋",
      "候选款编号": "YG-CASUAL-001",
      "目标人群": "25 至 40 岁男性轻通勤人群",
      "使用场景": "轻通勤",
      "试销渠道": "模拟私域预约",
      "经营目标": "只验证配色偏好",
      "配色 A": "深灰蓝",
      "配色 B": "米白",
      "目标零售价（元）": "399",
      "预计成本（元）": "180",
      "毛利底线（%）": "40",
      "MOQ（双）": "100",
      "期望交期（天）": "30",
      "距目标上新窗口（天）": "60",
      "试销预算（元）": "3000",
      "可用生产预算（元）": "30000",
    };
    for (const [label, value] of Object.entries(values)) {
      fireEvent.change(screen.getByLabelText(label), { target: { value } });
    }
    fireEvent.change(screen.getByLabelText("核心卖点（用顿号或逗号分隔）"), {
      target: { value: "轻量、通勤" },
    });
    fireEvent.click(screen.getByRole("button", { name: /保存草稿/ }));

    await waitFor(() => expect(mocks.updateBrief).toHaveBeenCalledTimes(1));
    const submitted = mocks.updateBrief.mock.calls[0][1];
    expect(submitted.variants).toHaveLength(2);
    expect(submitted.variants.map((item: { color_name: string }) => item.color_name)).toEqual([
      "深灰蓝",
      "米白",
    ]);
    expect(submitted.target_price_fen).toBe(39900);
    expect(await screen.findByText(/Brief 已就绪/)).toBeInTheDocument();
  });
});
