import { expect, type APIRequestContext, type Page, test } from "@playwright/test";

const API_BASE_URL = "http://127.0.0.1:8100/api/v1";

async function startScenario(page: Page, scenarioName: string): Promise<string> {
  await page.goto("/");
  await expect(page.getByText("SYNTHETIC · 合成演示")).toBeVisible();
  await expect(page.getByText("非生产指令 · 不会自动投放、下单或打样")).toBeVisible();
  await expect(page.getByText("API 在线")).toBeVisible();

  const scenario = page.locator(".scenario-card").filter({ hasText: scenarioName });
  await expect(scenario).toBeVisible();
  await scenario.getByRole("button", { name: "启动场景" }).click();
  await expect(page).toHaveURL(/\/projects\/[^/]+\/brief$/);
  await expect(page.getByRole("heading", { name: "先把经营问题说清楚" })).toBeVisible();

  const match = page.url().match(/\/projects\/([^/]+)\/brief$/);
  if (!match) throw new Error(`Unable to read project id from ${page.url()}`);
  return match[1];
}

async function approveExperiment(page: Page, projectId: string): Promise<void> {
  await page.goto(`/projects/${projectId}/experiment`);
  await expect(page.getByRole("heading", { name: "把假设变成可审计实验" })).toBeVisible();
  await expect(page.getByText("可创建新版本")).toBeVisible();
  await page.getByRole("button", { name: "人工批准", exact: true }).click();
  await expect(page.getByText("审批已记录，流程可以继续。")).toBeVisible();
}

async function completeReplayAndAnalyze(page: Page, projectId: string): Promise<void> {
  await page.goto(`/projects/${projectId}/simulation`);
  await expect(page.getByText("实验计划已批准")).toBeVisible();
  await page.getByRole("button", { name: "运行至结束" }).click();
  await expect(page.getByText("剩余试销周期已完成回放。")).toBeVisible();
  await expect(page.getByRole("progressbar", { name: "试销回放进度" })).toHaveAttribute(
    "aria-valuenow",
    "7",
  );

  await page.goto(`/projects/${projectId}/evidence`);
  await page.getByRole("button", { name: "执行质检与分析" }).click();
  await expect(page.getByText("确定性质检、指标计算和证据归纳已完成。")).toBeVisible();
  await expect(page.getByText("DATA QUALITY GATE")).toBeVisible();
}

async function expectDecision(
  page: Page,
  projectId: string,
  label: string,
): Promise<void> {
  await page.goto(`/projects/${projectId}/decision`);
  await expect(page.getByText(label, { exact: true })).toBeVisible();
  await expect(page.getByText("这是一项可审计建议，不是自动执行指令。")).toBeVisible();
}

async function expectReplayMode(request: APIRequestContext, projectId?: string): Promise<void> {
  const health = await request.get(`${API_BASE_URL}/health`);
  expect(health.ok()).toBeTruthy();
  await expect(health.json()).resolves.toMatchObject({ agent_mode: "OFFLINE_REPLAY" });

  if (projectId) {
    const project = await request.get(`${API_BASE_URL}/projects/${projectId}`);
    expect(project.ok()).toBeTruthy();
    await expect(project.json()).resolves.toMatchObject({
      id: projectId,
      data_status: "SYNTHETIC",
      agent_mode: "OFFLINE_REPLAY",
    });
  }
}

test.describe.serial("试销官 MVP 纵向闭环", () => {
  test("GO 场景通过决策与首单假设审批并生成交接草稿", async ({ page, request }) => {
    const projectId = await startScenario(page, "GO：需求、毛利与供应约束通过");
    await expectReplayMode(request, projectId);
    await approveExperiment(page, projectId);
    await completeReplayAndAnalyze(page, projectId);
    await expectDecision(page, projectId, "GO · 建议推进");

    await page.getByRole("button", { name: "人工批准", exact: true }).click();
    await expect(page.getByText("审批已记录，流程可以继续。")).toBeVisible();
    await page.goto(`/projects/${projectId}/handoff`);
    await expect(page.getByText("当前决策已批准")).toBeVisible();
    await expect(page.getByRole("button", { name: "生成交接草稿" })).toBeDisabled();
    await expect(page.getByText("首单假设待人工确认")).toBeVisible();
    await expect(page.getByText("这些数值只是演示提案")).toBeVisible();
    await page.getByRole("button", { name: "确认当前版本假设", exact: true }).click();
    await expect(page.getByText(/已于.*确认 Brief v1 的首单情景假设/)).toBeVisible();
    await page.getByRole("button", { name: "生成交接草稿" }).click();
    await expect(page.getByText("工厂交接草稿已生成。")).toBeVisible();
    await expect(page.getByRole("heading", { name: "TechPack Lite" })).toBeVisible();
    await expect(page.getByText("首单三情景")).toBeVisible();
  });

  test("PIVOT_DESIGN 展示可追溯的调整复测结果", async ({ page }) => {
    const projectId = await startScenario(page, "Pivot：配色分化");
    await approveExperiment(page, projectId);
    await completeReplayAndAnalyze(page, projectId);
    await expectDecision(page, projectId, "PIVOT · 调整复测");
    await expect(page.getByText("支持证据")).toBeVisible();
    await expect(page.getByText("命中的规则原因")).toBeVisible();

    await page.getByRole("button", { name: "人工批准", exact: true }).click();
    await expect(page.getByText("审批已记录，流程可以继续。")).toBeVisible();
    await page.goto(`/projects/${projectId}/handoff`);
    await page.getByRole("button", { name: "生成 Pivot 修订草稿" }).click();
    await expect(page.getByRole("heading", { name: "PivotRevision v1", exact: true })).toBeVisible();
    await expect(page.getByText("审批 DecisionCard 不等于审批本修订")).toBeVisible();
    await page.getByRole("button", { name: "人工批准", exact: true }).click();
    await expect(page.getByText("修订方案已针对精确版本批准")).toBeVisible();
    await expect(page.getByRole("button", { name: "生成条件式交接" })).toBeDisabled();
    await page.getByRole("button", { name: "确认当前版本假设", exact: true }).click();
    await expect(page.getByText(/确认 Brief v1 的首单情景假设/)).toBeVisible();
    await page.getByRole("button", { name: "生成条件式交接" }).click();
    await expect(page.getByText("条件式交接草稿已生成。")).toBeVisible();
    await expect(page.getByText(/尚待复测，不得下单/)).toBeVisible();
    await expect(page.getByRole("heading", { name: "打样任务" })).toBeVisible();
  });

  test("INSUFFICIENT_DATA 拒绝强结论且阻断交接", async ({ page }) => {
    const projectId = await startScenario(page, "Evidence Insufficient：样本不足");
    await approveExperiment(page, projectId);
    await completeReplayAndAnalyze(page, projectId);
    await expectDecision(page, projectId, "证据不足 · 暂不判断");
    await expect(page.getByText("系统拒绝强判断")).toBeVisible();
    await expect(page.getByRole("button", { name: "人工批准", exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "要求补充数据" })).toBeVisible();

    await page.goto(`/projects/${projectId}/handoff`);
    await expect(page.getByRole("button", { name: "生成交接草稿" })).toBeDisabled();
    await expect(page.getByRole("heading", { name: "交接门尚未满足" })).toBeVisible();
    await expect(page.getByText("证据不足不能进入生产交接，请先补充数据。")).toBeVisible();
  });

  test("实验审批驳回后无法启动模拟", async ({ page }) => {
    const projectId = await startScenario(page, "GO：需求、毛利与供应约束通过");
    await page.goto(`/projects/${projectId}/experiment`);
    await page.getByLabel("审批意见（可选）").fill("驳回测试：需要重新审核实验设计");
    await page.getByRole("button", { name: "驳回", exact: true }).click();
    await expect(page.getByText("处理意见已写入审计记录。")).toBeVisible();

    await page.goto(`/projects/${projectId}/simulation`);
    await expect(page.getByText("等待实验审批")).toBeVisible();
    await expect(page.getByRole("button", { name: "推进 1 天" })).toBeDisabled();
    await expect(page.getByRole("button", { name: "运行至结束" })).toBeDisabled();

    await page.goto(`/projects/${projectId}/experiment`);
    await expect(page.getByRole("heading", { name: "当前 Brief 或策略需要新计划" })).toBeVisible();
    await page.getByRole("button", { name: "归一化并生成新计划" }).click();
    await expect(page.getByText("已基于当前 Brief 和 DemoPolicy 生成新计划版本")).toBeVisible();
    await expect(page.getByText("EXP / 02")).toBeVisible();
    await page.getByRole("button", { name: "人工批准", exact: true }).click();
    await expect(page.getByText("审批已记录，流程可以继续。")).toBeVisible();
  });

  test("无 API Key 时固定进入离线回放", async ({ page, request }) => {
    await expectReplayMode(request);
    const projectId = await startScenario(page, "Pivot：配色分化");
    await expectReplayMode(request, projectId);
    await expect(page.getByText("AI 生成示意 · SYNTHETIC")).toBeVisible();
  });
});
