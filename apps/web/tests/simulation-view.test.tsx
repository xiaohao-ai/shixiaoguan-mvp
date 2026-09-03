import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SimulationView } from "@/components/simulation-view";
import type { ProjectDetail } from "@/lib/types";

const mocks = vi.hoisted(() => ({
  advanceSimulation: vi.fn(),
  runSimulation: vi.fn(),
  resetSimulationReplay: vi.fn(),
  getObservations: vi.fn(),
  refresh: vi.fn(),
  useProject: vi.fn(),
}));

vi.mock("@/components/project-context", () => ({
  useProject: () => mocks.useProject(),
}));

vi.mock("@/lib/api", () => ({
  api: {
    advanceSimulation: mocks.advanceSimulation,
    runSimulation: mocks.runSimulation,
    resetSimulationReplay: mocks.resetSimulationReplay,
    getObservations: mocks.getObservations,
  },
  getErrorMessage: (error: unknown) => error instanceof Error ? error.message : "操作失败",
}));

function project(overrides: Partial<ProjectDetail> = {}): ProjectDetail {
  return {
    id: "project-1",
    status: "SIMULATION_READY",
    workflow_state: "SIMULATION_READY",
    current_day: 0,
    total_days: 7,
    experiment_plan: { approval_status: "APPROVED" },
    ...overrides,
  } as ProjectDetail;
}

beforeEach(() => {
  vi.clearAllMocks();
  const initial = project();
  mocks.advanceSimulation.mockResolvedValue({});
  mocks.runSimulation.mockResolvedValue({});
  mocks.resetSimulationReplay.mockResolvedValue(project());
  mocks.getObservations.mockResolvedValue([]);
  mocks.refresh.mockResolvedValue(project({
    status: "SIMULATION_RUNNING",
    workflow_state: "SIMULATION_RUNNING",
    current_day: 1,
  }));
  mocks.useProject.mockReturnValue({
    projectId: "project-1",
    project: initial,
    refresh: mocks.refresh,
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("simulation replay controls", () => {
  it("starts the short-interval player by advancing exactly one day", async () => {
    vi.useFakeTimers();
    render(<SimulationView />);

    fireEvent.click(screen.getByRole("button", { name: "开始自动回放" }));
    expect(mocks.advanceSimulation).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(700);
    });

    expect(mocks.advanceSimulation).toHaveBeenCalledTimes(1);
    expect(mocks.advanceSimulation).toHaveBeenCalledWith("project-1", 1);
    expect(mocks.refresh).toHaveBeenCalledTimes(1);
  });

  it("pauses only the client-side player before the next daily request", async () => {
    vi.useFakeTimers();
    render(<SimulationView />);

    fireEvent.click(screen.getByRole("button", { name: "开始自动回放" }));
    fireEvent.click(screen.getByRole("button", { name: "暂停" }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });

    expect(mocks.advanceSimulation).not.toHaveBeenCalled();
    expect(screen.getByText(/暂停只停止前端计时器/)).toBeInTheDocument();
  });

  it("resets an unapproved decision projection through the same-project replay API", async () => {
    const analyzed = project({
      status: "DECISION_PROPOSED",
      workflow_state: "DECISION_PROPOSED",
      current_day: 7,
    });
    mocks.useProject.mockReturnValue({
      projectId: "project-1",
      project: analyzed,
      refresh: mocks.refresh,
    });
    render(<SimulationView />);

    fireEvent.click(screen.getByRole("button", { name: "重置并重放" }));

    expect(await screen.findByText(/旧数据集已标记为非活跃/)).toBeInTheDocument();
    expect(mocks.resetSimulationReplay).toHaveBeenCalledWith("project-1");
    expect(mocks.refresh).toHaveBeenCalled();
    expect(mocks.getObservations).toHaveBeenCalledTimes(2);
  });

  it("does not expose replay reset after decision approval", async () => {
    mocks.useProject.mockReturnValue({
      projectId: "project-1",
      project: project({
        status: "DECISION_APPROVED",
        workflow_state: "DECISION_APPROVED",
        current_day: 7,
      }),
      refresh: mocks.refresh,
    });
    render(<SimulationView />);

    await waitFor(() => expect(mocks.getObservations).toHaveBeenCalled());
    expect(screen.getByRole("button", { name: "重置并重放" })).toBeDisabled();
  });
});
