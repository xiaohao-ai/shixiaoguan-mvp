import { afterEach, describe, expect, it, vi } from "vitest";
import { api, ApiError } from "@/lib/api";
import type { DemoPolicy } from "@/lib/types";

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

const attachment = {
  id: "attachment-1",
  project_id: "project-1",
  object_key: "project-1/attachment-1.png",
  original_filename: "shoe.png",
  mime_type: "image/png",
  size_bytes: 128,
  sha256: "a".repeat(64),
  rights_declaration: "项目自制并授权本次 Demo 展示",
  source: "USER_UPLOAD",
  created_at: "2026-09-03T08:00:00Z",
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("API client contracts", () => {
  it("adds a unique idempotency key to write requests", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ id: "project-1", status: "PLAN_PROPOSED" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await api.createProjectFromScenario("GO");

    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const headers = init.headers as Headers;
    expect(headers.get("Idempotency-Key")).toBeTruthy();
    expect(init.method).toBe("POST");
  });

  it("creates an empty Brief draft through the generic project endpoint", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ id: "draft-1", status: "DRAFT" }), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(api.createDraftProject("未命名试销任务")).resolves.toMatchObject({
      id: "draft-1",
      status: "DRAFT",
    });
    expect(fetchMock.mock.calls[0]?.[0]).toContain("/projects");
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(String(init.body))).toEqual({ name: "未命名试销任务", brief: {} });
    expect((init.headers as Headers).get("Idempotency-Key")).toBeTruthy();
  });

  it("archives without deleting and marks active work as an explicit cancellation", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ id: "project-1", status: "ARCHIVED" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await api.archiveProject("project-1", {
      actor: "demo-operator",
      reason: "人工取消",
      cancel_active_work: true,
    });

    expect(fetchMock.mock.calls[0]?.[0]).toContain("/projects/project-1:archive");
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(String(init.body))).toMatchObject({ cancel_active_work: true });
    expect((init.headers as Headers).get("Idempotency-Key")).toBeTruthy();
  });

  it("uses the exact PivotRevision id and version for the separate approval gate", async () => {
    const revision = {
      id: "pivot-revision-project-1-v2",
      decision_id: "decision-1",
      target_variant_id: "COLOR-IVORY",
      version: 2,
      approval_status: "PENDING",
      change_variable: "COLOR",
      change_list: ["仅替换配色"],
      retest_plan: ["新建单变量实验"],
      created_by: "deterministic-tool",
      created_at: "2026-09-03T08:00:00Z",
    };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(revision), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        id: "approval-1",
        target_id: revision.id,
        object_version: revision.version,
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(api.generatePivotRevision(revision.decision_id)).resolves.toEqual(revision);
    await api.approvePivotRevision(revision.id, {
      gate: "PIVOT_REVISION",
      decision: "APPROVE",
      actor: "pytest",
      object_version: revision.version,
    });

    expect(fetchMock.mock.calls[0]?.[0]).toContain(
      `/decision-cards/${revision.decision_id}/pivot-revisions:generate`,
    );
    expect(fetchMock.mock.calls[1]?.[0]).toContain(
      `/pivot-revisions/${revision.id}/approvals`,
    );
    const approvalInit = fetchMock.mock.calls[1]?.[1] as RequestInit;
    expect(JSON.parse(String(approvalInit.body))).toMatchObject({
      gate: "PIVOT_REVISION",
      object_version: 2,
    });
    expect((approvalInit.headers as Headers).get("Idempotency-Key")).toBeTruthy();
  });

  it("binds first-order assumption confirmation to the current Brief version", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({
        id: "approval-first-order-1",
        target_id: "first-order-assumptions-project-1-brief-v3",
        object_version: 3,
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await api.approveFirstOrderAssumptions("project-1", {
      gate: "FIRST_ORDER_ASSUMPTIONS",
      decision: "APPROVE",
      actor: "测试操作员",
      object_version: 3,
    });

    expect(fetchMock.mock.calls[0]?.[0]).toContain(
      "/projects/project-1/first-order-assumptions/approvals",
    );
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(String(init.body))).toEqual({
      gate: "FIRST_ORDER_ASSUMPTIONS",
      decision: "APPROVE",
      actor: "测试操作员",
      object_version: 3,
    });
    expect((init.headers as Headers).get("Idempotency-Key")).toBeTruthy();
  });

  it("validates Agent run provenance without accepting malformed hashes", async () => {
    const run = {
      id: "agent-run-1",
      project_id: "project-1",
      mode: "OFFLINE_REPLAY",
      operation: "EXPLAIN_DECISION",
      model_name: null,
      reasoning_effort: null,
      prompt_version: "decision-explanation-v1",
      output_schema_version: "agent-decision-narrative-v1",
      recording_id: "demo-explain-go-v1",
      duration_ms: 8,
      input_sha256: "a".repeat(64),
      output_sha256: "b".repeat(64),
      input_tokens: null,
      output_tokens: null,
      tracing_disabled: true,
      api_store_disabled: true,
      success: true,
      fallback_reason: null,
      created_at: "2026-09-03T08:00:00Z",
    };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify([run]), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify([
        { ...run, input_sha256: "not-a-sha" },
      ]), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(api.getAgentRuns("project-1")).resolves.toEqual([run]);
    await expect(api.getAgentRuns("project-1")).rejects.toBeInstanceOf(ApiError);
  });

  it("validates immutable object-version ledger rows", async () => {
    const version = {
      project_id: "project-1",
      object_type: "DecisionCard",
      object_id: "decision-card-project-1",
      object_version: 1,
      payload: { outcome: "GO" },
      sha256: "c".repeat(64),
      created_at: "2026-09-03T08:00:00Z",
    };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      new Response(JSON.stringify([version]), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    ));

    await expect(api.getObjectVersions("project-1")).resolves.toEqual([version]);
  });

  it("rejects a scenario response that does not match the runtime schema", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify([{ id: "broken" }]), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );

    await expect(api.listScenarios()).rejects.toBeInstanceOf(ApiError);
  });

  it("sends the brief version lock together with PUT", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ id: "project-1", brief_version: 3 }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await api.updateBrief(
      "project-1",
      { product_name: "轻量休闲鞋", candidate_id: "YG-01" },
      2,
    );

    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const headers = init.headers as Headers;
    expect(headers.get("If-Match-Version")).toBe("2");
    expect(headers.get("Idempotency-Key")).toBeTruthy();
  });

  it("loads and updates the complete versioned DemoPolicy contract", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(policy), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        id: "project-1",
        status: "BRIEF_READY",
        current_policy: { ...policy, revision: 2 },
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(api.getPolicy("project-1")).resolves.toEqual(policy);
    await expect(api.updatePolicy("project-1", policy)).resolves.toMatchObject({ id: "project-1" });

    expect(fetchMock.mock.calls[0]?.[0]).toContain("/projects/project-1/policy");
    const init = fetchMock.mock.calls[1]?.[1] as RequestInit;
    const headers = init.headers as Headers;
    expect(init.method).toBe("PUT");
    expect(JSON.parse(String(init.body))).toEqual(policy);
    expect(headers.get("Idempotency-Key")).toBeTruthy();
  });

  it("accepts a DemoPolicy response shape after PUT for forward compatibility", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ...policy, version: "demo-policy-v1-r2", revision: 2 }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    ));

    await expect(api.updatePolicy("project-1", policy)).resolves.toMatchObject({
      version: "demo-policy-v1-r2",
      revision: 2,
    });
  });

  it("uploads images as multipart with rights metadata and no forced content type", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(attachment), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const file = new File([new Uint8Array([137, 80, 78, 71])], "shoe.png", { type: "image/png" });

    await expect(api.uploadAttachment("project-1", file, attachment.rights_declaration)).resolves.toMatchObject({
      id: "attachment-1",
      sha256: "a".repeat(64),
    });

    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const headers = init.headers as Headers;
    expect(init.body).toBeInstanceOf(FormData);
    expect((init.body as FormData).get("file")).toBe(file);
    expect((init.body as FormData).get("rights_declaration")).toBe(attachment.rights_declaration);
    expect(headers.get("Content-Type")).toBeNull();
    expect(headers.get("Idempotency-Key")).toBeTruthy();
  });

  it("validates attachment list metadata before displaying it", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      new Response(JSON.stringify([attachment]), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    ));

    await expect(api.listAttachments("project-1")).resolves.toEqual([attachment]);
  });
});
