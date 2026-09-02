import { describe, expect, it } from "vitest";
import {
  decisionIsApproved,
  experimentIsApproved,
  formatCurrency,
  formatDateTime,
  formatPercent,
} from "@/lib/presentation";
import type { ProjectDetail } from "@/lib/types";

describe("percentage presentation", () => {
  it("renders every API ratio as a percentage, including uplift above 100%", () => {
    expect(formatPercent(0.0318)).toBe("3.18%");
    expect(formatPercent(1)).toBe("100.0%");
    expect(formatPercent(2.5)).toBe("250.0%");
  });

  it("does not invent a percentage for a missing value", () => {
    expect(formatPercent(undefined)).toBe("—");
  });

  it("preserves fen precision when formatting money", () => {
    expect(formatCurrency(399.01)).toContain("399.01");
  });
});

describe("timestamp presentation", () => {
  it("always renders UTC audit timestamps in Asia/Shanghai", () => {
    expect(formatDateTime("2026-09-02T20:17:00Z")).toBe("09/03 04:17");
  });
});

describe("approval presentation", () => {
  it("never infers an approval from workflow state alone", () => {
    const project = {
      status: "HANDOFF_DRAFT_READY",
      workflow_state: "HANDOFF_DRAFT_READY",
      experiment_plan: { approval_status: "PENDING" },
      artifacts: { decision: { approval_status: "PENDING" } },
    } as ProjectDetail;

    expect(experimentIsApproved(project)).toBe(false);
    expect(decisionIsApproved(project)).toBe(false);
  });
});
