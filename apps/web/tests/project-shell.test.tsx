import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ProjectShell } from "@/components/project-shell";
import type { ProjectDetail } from "@/lib/types";

const mocks = vi.hoisted(() => ({
  archiveProject: vi.fn(),
  refresh: vi.fn(),
  useProject: vi.fn(),
}));

vi.mock("next/navigation", () => ({ usePathname: () => "/projects/project-1/brief" }));
vi.mock("@/components/project-context", () => ({
  useProject: () => mocks.useProject(),
}));
vi.mock("@/components/providers", () => ({
  useApiStatus: () => ({ check: vi.fn() }),
}));
vi.mock("@/lib/api", () => ({
  api: { archiveProject: mocks.archiveProject },
  getErrorMessage: (error: unknown) => error instanceof Error ? error.message : "操作失败",
}));

const project = {
  id: "project-1",
  name: "生命周期测试",
  status: "DRAFT",
  workflow_state: "DRAFT",
  data_status: "SYNTHETIC",
  data_sensitivity_level: "SYNTHETIC_ONLY",
  current_day: 0,
  total_days: 7,
  brief: {},
} as ProjectDetail;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.refresh.mockResolvedValue({ ...project, status: "ARCHIVED" });
  mocks.archiveProject.mockResolvedValue({ ...project, status: "ARCHIVED" });
  mocks.useProject.mockReturnValue({
    projectId: "project-1",
    project,
    loading: false,
    refreshing: false,
    error: undefined,
    refresh: mocks.refresh,
  });
});

describe("project archival control", () => {
  it("shows data sensitivity independently from data origin", () => {
    mocks.useProject.mockReturnValue({
      projectId: "project-1",
      project: { ...project, data_sensitivity_level: "USER_CONTENT_RESTRICTED" },
      loading: false,
      refreshing: false,
      error: undefined,
      refresh: mocks.refresh,
    });

    render(<ProjectShell><div>content</div></ProjectShell>);
    expect(screen.getByText("SYNTHETIC")).toBeInTheDocument();
    expect(document.body).toHaveTextContent("敏感级别 · 含用户内容 · 受限");
  });

  it("requires a second click and explicitly cancels active work", async () => {
    render(<ProjectShell><div>content</div></ProjectShell>);

    fireEvent.click(screen.getByRole("button", { name: "归档" }));
    expect(mocks.archiveProject).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "确认取消并归档" }));

    await waitFor(() => expect(mocks.archiveProject).toHaveBeenCalledWith(
      "project-1",
      expect.objectContaining({ cancel_active_work: true }),
    ));
    expect(mocks.refresh).toHaveBeenCalled();
  });

  it("does not expose a mutation control for an archived project", () => {
    mocks.useProject.mockReturnValue({
      projectId: "project-1",
      project: { ...project, status: "ARCHIVED", workflow_state: "ARCHIVED" },
      loading: false,
      refreshing: false,
      error: undefined,
      refresh: mocks.refresh,
    });

    render(<ProjectShell><div>content</div></ProjectShell>);
    expect(screen.queryByRole("button", { name: "归档" })).not.toBeInTheDocument();
  });
});
