import { expect, type Page, test } from "@playwright/test";

const BASE_PATH = "/shixiaoguan-mvp";
const PROJECT_ID = "github-pages-demo";

function previewPath(path = ""): string {
  return `${BASE_PATH}/${path.replace(/^\//, "")}`;
}

async function openPreviewHome(page: Page): Promise<void> {
  const response = await page.goto(previewPath());
  expect(response?.status()).toBe(200);
  await page.evaluate(() => window.localStorage.clear());
  await page.reload();
  await expect(page.getByRole("heading", { name: /让每个“做不做”/ })).toBeVisible();
}

test("GitHub Pages 子路径完成 PIVOT_DESIGN 主闭环并支持深链刷新", async ({ page }) => {
  const apiRequests: string[] = [];
  const browserErrors: string[] = [];
  page.on("request", (request) => {
    const pathname = new URL(request.url()).pathname;
    if (pathname.startsWith("/api/") || pathname.startsWith(`${BASE_PATH}/api/`)) {
      apiRequests.push(`${request.method()} ${pathname}`);
    }
  });
  page.on("console", (message) => {
    if (message.type() === "error") browserErrors.push(`console: ${message.text()}`);
  });
  page.on("pageerror", (error) => browserErrors.push(`pageerror: ${error.message}`));
  await openPreviewHome(page);
  const projectSteps = page.getByRole("navigation", { name: "项目步骤" });

  await expect(page.getByText("GitHub Pages · 浏览器内回放", { exact: true })).toBeVisible();
  await expect(
    page.getByText("无 FastAPI · 无 SQLite · 无 DeepSeek · 状态仅存当前浏览器", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(page.getByText("浏览器内运行 · 无 API", { exact: true })).toBeVisible();

  const scenario = page.locator(".scenario-card").filter({ hasText: "Pivot：配色分化" });
  await expect(scenario).toBeVisible();
  await scenario.getByRole("button", { name: "启动场景" }).click();
  await expect(page).toHaveURL(new RegExp(`${BASE_PATH}/projects/${PROJECT_ID}/brief/?$`));
  await expect(page.getByRole("heading", { name: "先把经营问题说清楚" })).toBeVisible();

  await expect(page.getByText("公开预览 · 上传关闭", { exact: true })).toBeVisible();
  await expect(page.getByLabel("图片文件")).toBeDisabled();
  await expect(page.getByLabel("图片权属声明")).toBeDisabled();
  await expect(
    page.getByText("公开预览只接受合成数据，不保存访客附件；请勿输入真实企业信息。", {
      exact: true,
    }),
  ).toBeVisible();

  await projectSteps.getByRole("link", { name: /^实验计划/ }).click();
  await expect(page).toHaveURL(new RegExp(`${BASE_PATH}/projects/${PROJECT_ID}/experiment/?$`));
  await expect(page.getByRole("heading", { name: "把假设变成可审计实验" })).toBeVisible();
  await expect(page.getByText(/不采集姓名或审批意见/)).toBeVisible();
  await expect(page.locator(`#EXPERIMENT_PLAN-actor`)).toHaveCount(0);
  await expect(page.locator(`#EXPERIMENT_PLAN-comment`)).toHaveCount(0);
  await page.getByRole("button", { name: "人工批准", exact: true }).click();
  await expect(page.getByText("审批已记录，流程可以继续。", { exact: true })).toBeVisible();

  await projectSteps.getByRole("link", { name: /^试销回放/ }).click();
  await expect(page).toHaveURL(new RegExp(`${BASE_PATH}/projects/${PROJECT_ID}/simulation/?$`));
  await expect(page.getByText("实验计划已批准", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "运行至结束" }).click();
  await expect(page.getByText("剩余试销周期已完成回放。", { exact: true })).toBeVisible();
  await expect(page.getByRole("progressbar", { name: "试销回放进度" })).toHaveAttribute(
    "aria-valuenow",
    "7",
  );

  await projectSteps.getByRole("link", { name: /^质检与证据/ }).click();
  await expect(page).toHaveURL(new RegExp(`${BASE_PATH}/projects/${PROJECT_ID}/evidence/?$`));
  await page.getByRole("button", { name: "执行质检与分析" }).click();
  await expect(
    page.getByText("确定性质检、指标计算和证据归纳已完成。", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText("DATA QUALITY GATE", { exact: true })).toBeVisible();

  await projectSteps.getByRole("link", { name: /^决策卡/ }).click();
  await expect(page).toHaveURL(new RegExp(`${BASE_PATH}/projects/${PROJECT_ID}/decision/?$`));
  await expect(page.getByText("PIVOT · 调整复测", { exact: true })).toBeVisible();
  await expect(page.getByText("支持证据", { exact: true })).toBeVisible();
  await expect(page.getByText("命中的规则原因", { exact: true })).toBeVisible();
  await expect(page.getByText("这是一项可审计建议，不是自动执行指令。", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "人工批准", exact: true }).click();
  await expect(page.getByText("审批已记录，流程可以继续。", { exact: true })).toBeVisible();
  await expect(page.getByText("APPROVED", { exact: true })).toBeVisible();

  const directDecisionUrl = previewPath(`projects/${PROJECT_ID}/decision/`);
  const deepLinkResponse = await page.goto(directDecisionUrl);
  expect(deepLinkResponse?.status()).toBe(200);
  await expect(page.getByText("PIVOT · 调整复测", { exact: true })).toBeVisible();
  await page.reload();
  await expect(page).toHaveURL(new RegExp(`${BASE_PATH}/projects/${PROJECT_ID}/decision/?$`));
  await expect(page.getByText("PIVOT · 调整复测", { exact: true })).toBeVisible();
  await expect(
    page.getByText(/GitHub Pages 浏览器内静态回放 · 无 FastAPI \/ SQLite \/ DeepSeek/),
  ).toBeVisible();

  await projectSteps.getByRole("link", { name: /^工厂交接/ }).click();
  await expect(page).toHaveURL(new RegExp(`${BASE_PATH}/projects/${PROJECT_ID}/handoff/?$`));
  await expect(page.getByText("当前决策已批准", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "生成 Pivot 修订草稿", exact: true }).click();
  await expect(page.getByRole("heading", { name: "PivotRevision v1", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "人工批准", exact: true }).click();
  await expect(page.getByText("修订方案已针对精确版本批准，可生成条件式打样与首单情景草稿。", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "确认当前版本假设", exact: true }).click();
  await expect(page.getByText(/已于.*确认 Brief v1/)).toBeVisible();
  await page.getByRole("button", { name: "生成条件式交接", exact: true }).click();
  await expect(page.getByText("条件式交接草稿已生成。", { exact: true })).toBeVisible();
  await expect(page.getByText("条件式情景 · 需复测 · 非生产指令", { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "复测任务草稿" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "首单三情景" })).toBeVisible();
  await expect(page.getByRole("heading", { name: /TechPack/i })).toHaveCount(0);

  await projectSteps.getByRole("link", { name: /^审计回放/ }).click();
  await expect(page).toHaveURL(new RegExp(`${BASE_PATH}/projects/${PROJECT_ID}/audit/?$`));
  await expect(page.getByRole("heading", { name: "沿着证据链回到每一步" })).toBeVisible();
  const reportPagePromise = page.context().waitForEvent("page");
  await page.getByRole("link", { name: "打开评审快照" }).click();
  const reportPage = await reportPagePromise;
  await reportPage.waitForLoadState();
  await expect(reportPage).toHaveTitle("试销官浏览器评审快照");
  await expect(reportPage.locator("body")).toContainText("非生产指令");
  await expect(reportPage.locator("body")).toContainText(PROJECT_ID);
  await expect(reportPage.locator("body")).toContainText("PIVOT_DESIGN");
  await expect(reportPage.locator("body")).toContainText("PIVOT");
  await reportPage.close();

  expect(apiRequests).toEqual([]);
  expect(browserErrors).toEqual([]);
});
