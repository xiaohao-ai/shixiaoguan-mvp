import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GlobalGuardrail } from "@/components/global-guardrail";
import { Providers } from "@/components/providers";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("GlobalGuardrail", () => {
  it("keeps synthetic and non-production warnings visible", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    render(
      <Providers>
        <GlobalGuardrail />
      </Providers>,
    );
    expect(screen.getByText(/SYNTHETIC/)).toBeInTheDocument();
    expect(screen.getByText(/非生产指令/)).toBeInTheDocument();
    expect(await screen.findByText("API 离线")).toBeInTheDocument();
  });

  it("shows the model execution mode returned by the API", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          status: "ok",
          service: "shixiaoguan-api",
          version: "0.1.0",
          agent_mode: "OFFLINE_REPLAY",
        }),
      }),
    );
    render(
      <Providers>
        <GlobalGuardrail />
      </Providers>,
    );
    expect(await screen.findByText("离线回放")).toBeInTheDocument();
    expect(screen.getByText("API 在线")).toBeInTheDocument();
  });
});
