import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { OutcomeBadge } from "@/components/outcome-badge";

describe("OutcomeBadge", () => {
  it("renders the refusal state as evidence insufficient", () => {
    render(<OutcomeBadge outcome="EVIDENCE_INSUFFICIENT" />);
    expect(screen.getByText("证据不足 · 暂不判断")).toBeInTheDocument();
  });

  it("does not invent an outcome when the API has not returned one", () => {
    render(<OutcomeBadge />);
    expect(screen.getByText("等待决策")).toBeInTheDocument();
  });
});
