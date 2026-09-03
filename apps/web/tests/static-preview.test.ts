import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetStaticPreviewStore, staticPreviewReportHtml } from "@/lib/static-preview";
import type { ApprovalRequest, DecisionOutcome, ProjectDetail } from "@/lib/types";

async function staticApi() {
  vi.stubEnv("NEXT_PUBLIC_STATIC_PREVIEW", "1");
  vi.resetModules();
  return (await import("@/lib/api")).api;
}

const approval = (
  gate: ApprovalRequest["gate"],
  objectVersion: number,
): ApprovalRequest => ({
  gate,
  decision: "APPROVE",
  actor: "GitHub Pages 演示操作员",
  object_version: objectVersion,
});

async function analyzeScenario(scenarioId: string) {
  const api = await staticApi();
  const project = await api.createProjectFromScenario(scenarioId);
  await api.submitApproval(project.id, approval("EXPERIMENT_PLAN", project.experiment_plan?.version ?? 0));
  await api.runSimulation(project.id);
  const analysis = await api.analyze(project.id);
  return { api, project: await api.getProject(project.id), analysis };
}

beforeEach(() => {
  resetStaticPreviewStore();
  window.localStorage.clear();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("GitHub Pages browser-local preview", () => {
  it("forces replay-only health metadata and exposes all preregistered scenarios without fetch", async () => {
    const fetchMock = vi.fn(() => {
      throw new Error("static preview must not use fetch");
    });
    vi.stubGlobal("fetch", fetchMock);
    const api = await staticApi();

    await expect(api.health()).resolves.toMatchObject({
      public_preview_mode: true,
      agent_mode: "OFFLINE_REPLAY",
      attachment_upload_enabled: false,
    });
    const scenarios = await api.listScenarios();
    expect(scenarios).toHaveLength(8);
    expect(scenarios.map((item) => item.id)).toEqual(expect.arrayContaining([
      "GO",
      "PIVOT_DESIGN",
      "INSUFFICIENT_DATA",
    ]));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("runs the complete Pivot design gates with a fixed project id and conditional handoff", async () => {
    const { api, project, analysis } = await analyzeScenario("PIVOT_DESIGN");

    expect(project.id).toBe("github-pages-demo");
    expect(project.current_day).toBe(7);
    expect(analysis.quality?.status).toBe("PASS");
    expect(analysis.decision?.outcome).toBe("PIVOT");
    expect(analysis.decision?.reason_codes).toEqual(["VARIANT_DIVERGENCE", "MODIFIABLE_DESIGN_VARIABLE"]);

    await api.submitApproval(project.id, approval("DECISION", analysis.decision?.version ?? 0));
    const approvedProject = await api.getProject(project.id);
    expect(approvedProject.decision?.approval_status).toBe("APPROVED");
    expect(approvedProject.decision_card?.approval_status).toBe("APPROVED");
    expect(approvedProject.artifacts?.decision?.approval_status).toBe("APPROVED");

    const persisted = JSON.parse(
      window.localStorage.getItem("shixiaoguan.github-pages-preview.v1") ?? "{}",
    ) as { project?: ProjectDetail };
    if (persisted.project?.decision) persisted.project.decision.approval_status = "PENDING";
    if (persisted.project?.decision_card) persisted.project.decision_card.approval_status = "PENDING";
    window.localStorage.setItem("shixiaoguan.github-pages-preview.v1", JSON.stringify(persisted));
    await expect(api.getProject(project.id)).resolves.toMatchObject({
      decision: { approval_status: "APPROVED" },
      decision_card: { approval_status: "APPROVED" },
    });

    const revision = await api.generatePivotRevision(analysis.decision?.id ?? "");
    expect(revision).toMatchObject({ target_variant_id: "COLOR-IVORY", approval_status: "PENDING" });
    await api.approvePivotRevision(revision.id, approval("PIVOT_REVISION", revision.version));
    await api.approveFirstOrderAssumptions(project.id, approval("FIRST_ORDER_ASSUMPTIONS", project.brief_version ?? 0));
    const handoff = await api.createHandoff(project.id);

    expect(handoff.status).toBe("CONDITIONAL_DRAFT");
    expect(handoff.techpack).toBeUndefined();
    expect(handoff.techpack_lite).toBeUndefined();
    expect(handoff.watermark).toContain("需复测");
    expect(handoff.first_order_scenarios).toHaveLength(3);
    expect(handoff.first_order_scenarios?.every((item) => item.status === "CONDITIONAL_RETEST_REQUIRED")).toBe(true);
    expect(await api.getAuditEvents(project.id)).toEqual(expect.arrayContaining([
      expect.objectContaining({ action: "PIVOT_REVISION_APPROVE" }),
      expect.objectContaining({ action: "HANDOFF_DRAFT_GENERATED" }),
    ]));
  });

  it("runs GO through explicit decision and first-order approvals", async () => {
    const { api, project, analysis } = await analyzeScenario("GO");
    expect(analysis.decision?.outcome).toBe("GO");

    await api.submitApproval(project.id, approval("DECISION", analysis.decision?.version ?? 0));
    await expect(api.createHandoff(project.id)).rejects.toMatchObject({ status: 409 });
    await api.approveFirstOrderAssumptions(project.id, approval("FIRST_ORDER_ASSUMPTIONS", project.brief_version ?? 0));
    const handoff = await api.createHandoff(project.id);

    expect(handoff.outcome).toBe("GO");
    expect(handoff.first_order_scenarios).toHaveLength(3);
    expect(handoff.first_order_scenarios?.every((item) => item.status === "READY")).toBe(true);
    const step = project.brief?.first_order_assumptions?.packing_step ?? 1;
    const budgetCeiling = Math.floor(
      Number(project.brief?.production_budget_fen) / Number(project.brief?.estimated_cost_fen) / step,
    ) * step;
    expect(handoff.first_order_scenarios?.every((item) =>
      Number(item.quantity_high) <= budgetCeiling && Number(item.quantity_high) % step === 0,
    )).toBe(true);
    expect((await api.getObjectVersions(project.id)).at(-1)).toMatchObject({ object_type: "HandoffPackage" });
    expect((await api.getAgentRuns(project.id)).every((run) => run.mode === "OFFLINE_REPLAY")).toBe(true);
  });

  it("returns only a zero BASE conflict when the budget ceiling is below MOQ", async () => {
    const { api, project, analysis } = await analyzeScenario("SUPPLY_CONSTRAINT");
    await api.submitApproval(project.id, approval("DECISION", analysis.decision?.version ?? 0));
    const revision = await api.generatePivotRevision(analysis.decision?.id ?? "");
    await api.approvePivotRevision(revision.id, approval("PIVOT_REVISION", revision.version));
    await api.approveFirstOrderAssumptions(project.id, approval("FIRST_ORDER_ASSUMPTIONS", project.brief_version ?? 0));

    const handoff = await api.createHandoff(project.id);
    expect(handoff.techpack).toBeUndefined();
    expect(handoff.first_order_scenarios).toEqual([
      expect.objectContaining({ name: "BASE", quantity_low: 0, quantity_high: 0, status: "CONFLICT" }),
    ]);
  });

  it("blocks strong approval and handoff for insufficient evidence", async () => {
    const { api, project, analysis } = await analyzeScenario("INSUFFICIENT_DATA");
    expect(analysis.quality).toMatchObject({ status: "BLOCK", can_make_strong_decision: false });
    expect(analysis.evidence?.evidence_grade).toBe("D");
    expect(analysis.decision?.outcome).toBe("EVIDENCE_INSUFFICIENT" satisfies DecisionOutcome);

    await expect(
      api.submitApproval(project.id, approval("DECISION", analysis.decision?.version ?? 0)),
    ).rejects.toMatchObject({ status: 409 });
    await expect(api.createHandoff(project.id)).rejects.toMatchObject({ status: 409 });
  });

  it("keeps the selected scenario across subsequent reads and refuses attachments", async () => {
    const api = await staticApi();
    await api.createProjectFromScenario("NO_GO");
    const reloaded = await api.getProject("github-pages-demo");
    expect(reloaded.scenario_id).toBe("NO_GO");
    await expect(api.listAttachments(reloaded.id)).resolves.toEqual([]);

    const file = new File([new Uint8Array([137, 80, 78, 71])], "shoe.png", { type: "image/png" });
    await expect(api.uploadAttachment(reloaded.id, file, "测试权属")).rejects.toMatchObject({ status: 403 });
  });

  it("keeps fixed Brief and policy read-only and disables hidden blank projects", async () => {
    const api = await staticApi();
    const project = await api.createProjectFromScenario("GO");

    await expect(api.createDraftProject("未绑定场景")).rejects.toMatchObject({ status: 405 });
    await expect(api.updateBrief(project.id, project.brief ?? {}, project.brief_version ?? 0)).rejects.toMatchObject({ status: 405 });
    await expect(api.updatePolicy(project.id, project.current_policy!)).rejects.toMatchObject({ status: 405 });
    await expect(api.getProject(project.id)).resolves.toMatchObject({ scenario_id: "GO", brief_version: 1 });
  });

  it("rejects all writes after archive", async () => {
    const api = await staticApi();
    const project = await api.createProjectFromScenario("GO");
    await api.archiveProject(project.id, { actor: "GitHub Pages 演示操作员", reason: "测试归档门禁" });

    await expect(
      api.submitApproval(project.id, approval("EXPERIMENT_PLAN", project.experiment_plan?.version ?? 0)),
    ).rejects.toMatchObject({ status: 409 });
    await expect(api.advanceSimulation(project.id)).rejects.toMatchObject({ status: 409 });
  });

  it("creates distinct immutable analysis versions after replay reset", async () => {
    const { api, project, analysis } = await analyzeScenario("GO");
    expect(analysis.decision?.version).toBe(1);
    await api.resetSimulationReplay(project.id);
    await api.runSimulation(project.id);
    const nextAnalysis = await api.analyze(project.id);

    expect(nextAnalysis.decision).toMatchObject({ version: 2, id: expect.stringContaining("-v2") });
    const versions = (await api.getObjectVersions(project.id)).filter((item) => item.object_type === "DecisionCard");
    expect(versions.map((item) => [item.object_id, item.object_version])).toEqual([
      [expect.stringContaining("-v1"), 1],
      [expect.stringContaining("-v2"), 2],
    ]);
  });

  it("builds a non-API browser review snapshot with traceable limits", async () => {
    const { analysis } = await analyzeScenario("PIVOT_DESIGN");
    const report = staticPreviewReportHtml();

    expect(report).toContain("试销官 · GitHub Pages 评审快照");
    expect(report).toContain("github-pages-demo");
    expect(report).toContain("PIVOT_DESIGN");
    expect(report).toContain(analysis.decision?.outcome ?? "");
    expect(report).toContain("非生产指令");
    expect(report).toContain("限制");
    expect(report).not.toContain("/api/v1");
  });
});
