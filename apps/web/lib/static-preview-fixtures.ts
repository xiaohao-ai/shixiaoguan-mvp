import type {
  DecisionOutcome,
  DemoPolicy,
  DemoScenario,
  ExperimentPlan,
  MetricsReport,
  ProductBrief,
  QualityIssue,
  QualityReport,
  TrialObservation,
} from "@/lib/types";

export const STATIC_PREVIEW_PROJECT_ID = "github-pages-demo";
export const STATIC_PREVIEW_SCENARIO_VERSION = "mens-casual-demo-scenarios-v1";
export const STATIC_PREVIEW_GENERATOR_VERSION = "browser-static-fixture-v1";
export const STATIC_PREVIEW_FIXED_SEED = 20260903;
export const STATIC_PREVIEW_TIMESTAMP = "2026-09-03T08:00:00.000Z";

export const STATIC_PREVIEW_POLICY: DemoPolicy = {
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

interface VariantFixture {
  exposurePerDay: number;
  ctr: number;
  favoritePerClick: number;
  inquiryPerClick: number;
  cartPerClick: number;
  intentPerExposure: number;
  orderPerExposure: number;
  refundPerOrder?: number;
  returnPerOrder?: number;
}

export interface StaticScenarioFixture extends DemoScenario {
  priceFen: number;
  estimatedCostFen: number;
  moq: number;
  productionBudgetFen: number;
  variantA: VariantFixture;
  variantB: VariantFixture;
  reasonCodes: string[];
}

const standardSupply = {
  priceFen: 39_900,
  estimatedCostFen: 17_900,
  moq: 300,
  productionBudgetFen: 8_000_000,
};

export const STATIC_PREVIEW_SCENARIOS: StaticScenarioFixture[] = [
  {
    id: "GO",
    name: "GO：需求、毛利与供应约束通过",
    description: "两个配色都获得足够的试销意向，且 MOQ 与生产预算可行。",
    expected_outcome: "GO",
    total_days: 7,
    ...standardSupply,
    variantA: { exposurePerDay: 220, ctr: 0.14, favoritePerClick: 0.28, inquiryPerClick: 0.18, cartPerClick: 0.27, intentPerExposure: 0.032, orderPerExposure: 0.018 },
    variantB: { exposurePerDay: 210, ctr: 0.12, favoritePerClick: 0.25, inquiryPerClick: 0.16, cartPerClick: 0.3, intentPerExposure: 0.033, orderPerExposure: 0.015 },
    reasonCodes: ["PURCHASE_INTENT_THRESHOLD_MET", "MARGIN_OK", "MOQ_BUDGET_OK", "LEAD_TIME_OK"],
  },
  {
    id: "PIVOT_PRICE",
    name: "Pivot：价格摩擦",
    description: "点击和加购信号较强，但购买意向在当前价格下明显偏低。",
    expected_outcome: "PIVOT",
    total_days: 7,
    priceFen: 49_900,
    estimatedCostFen: 18_500,
    moq: 300,
    productionBudgetFen: 8_000_000,
    variantA: { exposurePerDay: 220, ctr: 0.16, favoritePerClick: 0.3, inquiryPerClick: 0.21, cartPerClick: 0.29, intentPerExposure: 0.012, orderPerExposure: 0.005 },
    variantB: { exposurePerDay: 215, ctr: 0.14, favoritePerClick: 0.27, inquiryPerClick: 0.19, cartPerClick: 0.26, intentPerExposure: 0.011, orderPerExposure: 0.005 },
    reasonCodes: ["INTEREST_WITH_PURCHASE_FRICTION", "MODIFIABLE_PRICE_OR_OFFER_VARIABLE"],
  },
  {
    id: "PIVOT_DESIGN",
    name: "Pivot：配色分化",
    description: "深灰蓝配色信号达标，米白配色明显较弱，建议保留主体并改配色复测。",
    expected_outcome: "PIVOT",
    total_days: 7,
    ...standardSupply,
    variantA: { exposurePerDay: 220, ctr: 0.14, favoritePerClick: 0.28, inquiryPerClick: 0.18, cartPerClick: 0.27, intentPerExposure: 0.032, orderPerExposure: 0.017 },
    variantB: { exposurePerDay: 220, ctr: 0.055, favoritePerClick: 0.12, inquiryPerClick: 0.08, cartPerClick: 0.2, intentPerExposure: 0.009, orderPerExposure: 0.003 },
    reasonCodes: ["VARIANT_DIVERGENCE", "MODIFIABLE_DESIGN_VARIABLE"],
  },
  {
    id: "NO_GO",
    name: "No-Go：核心信号均不达标",
    description: "两个配色的点击、加购和购买意向均低于演示阈值。",
    expected_outcome: "NO_GO",
    total_days: 7,
    ...standardSupply,
    variantA: { exposurePerDay: 350, ctr: 0.04, favoritePerClick: 0.1, inquiryPerClick: 0.07, cartPerClick: 0.4, intentPerExposure: 0.005, orderPerExposure: 0.003 },
    variantB: { exposurePerDay: 340, ctr: 0.035, favoritePerClick: 0.09, inquiryPerClick: 0.06, cartPerClick: 0.4, intentPerExposure: 0.005, orderPerExposure: 0.003 },
    reasonCodes: ["ALL_ARMS_PURCHASE_INTENT_CLEARLY_LOW", "DEMAND_BELOW_FLOOR"],
  },
  {
    id: "INSUFFICIENT_DATA",
    name: "Evidence Insufficient：样本不足",
    description: "漏斗表现看似积极，但每个实验臂的曝光数远低于预先锁定的最低要求。",
    expected_outcome: "EVIDENCE_INSUFFICIENT",
    total_days: 7,
    ...standardSupply,
    variantA: { exposurePerDay: 18, ctr: 0.17, favoritePerClick: 0.3, inquiryPerClick: 0.2, cartPerClick: 0.5, intentPerExposure: 0.04, orderPerExposure: 0.025 },
    variantB: { exposurePerDay: 20, ctr: 0.15, favoritePerClick: 0.28, inquiryPerClick: 0.18, cartPerClick: 0.5, intentPerExposure: 0.035, orderPerExposure: 0.02 },
    reasonCodes: ["MIN_EXPOSURE_PER_ARM", "MIN_PURCHASE_INTENT_EVENTS_PER_ARM"],
  },
  {
    id: "INVALID_EXPERIMENT",
    name: "Evidence Insufficient：分流严重失衡",
    description: "预设 50/50 分流，实际接近 90/10，不允许得出强结论。",
    expected_outcome: "EVIDENCE_INSUFFICIENT",
    total_days: 7,
    ...standardSupply,
    variantA: { exposurePerDay: 270, ctr: 0.13, favoritePerClick: 0.25, inquiryPerClick: 0.16, cartPerClick: 0.3, intentPerExposure: 0.032, orderPerExposure: 0.015 },
    variantB: { exposurePerDay: 25, ctr: 0.12, favoritePerClick: 0.24, inquiryPerClick: 0.15, cartPerClick: 0.4, intentPerExposure: 0.032, orderPerExposure: 0.014 },
    reasonCodes: ["MIN_EXPOSURE_PER_ARM", "SRM_BLOCK"],
  },
  {
    id: "SUPPLY_CONSTRAINT",
    name: "Pivot：供应约束冲突",
    description: "试销需求信号通过，但 MOQ 对应的资金占用超过生产预算。",
    expected_outcome: "PIVOT",
    total_days: 7,
    priceFen: 39_900,
    estimatedCostFen: 19_000,
    moq: 400,
    productionBudgetFen: 6_000_000,
    variantA: { exposurePerDay: 220, ctr: 0.14, favoritePerClick: 0.28, inquiryPerClick: 0.18, cartPerClick: 0.27, intentPerExposure: 0.032, orderPerExposure: 0.018 },
    variantB: { exposurePerDay: 210, ctr: 0.12, favoritePerClick: 0.25, inquiryPerClick: 0.16, cartPerClick: 0.3, intentPerExposure: 0.033, orderPerExposure: 0.015 },
    reasonCodes: ["MOQ_BUDGET_CONFLICT", "MODIFIABLE_SUPPLY_VARIABLE"],
  },
  {
    id: "CONFLICTING_SIGNALS",
    name: "Evidence Insufficient：高兴趣与高退款风险冲突",
    description: "点击和购买意向较强，但后序退款/退货信号过高，要求人工复核。",
    expected_outcome: "EVIDENCE_INSUFFICIENT",
    total_days: 7,
    ...standardSupply,
    variantA: { exposurePerDay: 220, ctr: 0.15, favoritePerClick: 0.29, inquiryPerClick: 0.2, cartPerClick: 0.28, intentPerExposure: 0.032, orderPerExposure: 0.017, refundPerOrder: 0.45, returnPerOrder: 0.25 },
    variantB: { exposurePerDay: 215, ctr: 0.13, favoritePerClick: 0.26, inquiryPerClick: 0.18, cartPerClick: 0.25, intentPerExposure: 0.031, orderPerExposure: 0.015, refundPerOrder: 0.4, returnPerOrder: 0.25 },
    reasonCodes: ["CONFLICTING_POST_ORDER_SIGNAL", "HUMAN_REVIEW_REQUIRED"],
  },
];

export function getStaticScenario(scenarioId: string): StaticScenarioFixture | undefined {
  return STATIC_PREVIEW_SCENARIOS.find((scenario) => scenario.id === scenarioId);
}

export function makeStaticBrief(scenario: StaticScenarioFixture): ProductBrief {
  return {
    id: `brief-${STATIC_PREVIEW_PROJECT_ID}-v1`,
    version: 1,
    product_name: "轻量通勤休闲男鞋",
    candidate_id: "CASUAL-001",
    category: "MEN_LIGHTWEIGHT_CASUAL",
    target_audience: "25–40 岁城市通勤男性",
    usage_scenario: "通勤、日常步行与轻商务休闲",
    season: "SPRING_AUTUMN",
    channel: "AUTHORIZED_PRIVATE_DOMAIN_DEMO",
    core_selling_points: ["轻量", "通勤易搭", "步行缓震"],
    target_price_fen: scenario.priceFen,
    estimated_cost_fen: scenario.estimatedCostFen,
    gross_margin_floor_bps: 4000,
    moq: scenario.moq,
    expected_lead_time_days: 30,
    target_launch_days: 60,
    trial_budget_fen: 300_000,
    production_budget_fen: scenario.productionBudgetFen,
    business_goal: "在打样和备料前，判断主体鞋型及配色是否值得继续。",
    known_risks: ["数据为浏览器内合成演示", "单渠道信号不可直接外推"],
    first_order_assumptions: {
      intent_to_order_rate: 0.25,
      planned_reach: 160_000,
      packing_step: 12,
      source: "DEMO_PROPOSAL",
    },
    variants: [
      { id: "COLOR-GRAY-BLUE", label: "配色 A", color_name: "深灰蓝", color_hex: "#24364B", material_notes: undefined, target_price_fen: scenario.priceFen },
      { id: "COLOR-IVORY", label: "配色 B", color_name: "米白", color_hex: "#F2E9D8", material_notes: undefined, target_price_fen: scenario.priceFen },
    ],
    data_status: "SYNTHETIC",
  };
}

export function makeStaticPlan(scenario: StaticScenarioFixture, version = 1): ExperimentPlan {
  return {
    id: `plan-${STATIC_PREVIEW_PROJECT_ID}-v${version}`,
    version,
    decision_question: "在其他条件不变时，哪个配色获得更可信的购买意向，是否达到进入打样的演示门槛？",
    hypotheses: [
      "两个配色的购买意向率存在可观测差异。",
      "目标价格下的兴趣信号能向加购和购买意向传递。",
      "MOQ、毛利底线与生产预算不构成硬冲突。",
    ],
    controlled_variable: "COLOR",
    invariants: ["鞋型", "价格", "素材版式", "人群", "渠道", "投放时段"],
    arms: [
      { id: "ARM-A", label: "深灰蓝配色", variant_id: "COLOR-GRAY-BLUE", expected_share: 0.5 },
      { id: "ARM-B", label: "米白配色", variant_id: "COLOR-IVORY", expected_share: 0.5 },
    ],
    target_audience: "25–40 岁城市通勤男性",
    audience_segment: "URBAN_COMMUTER_MEN_25_40",
    channel: "AUTHORIZED_PRIVATE_DOMAIN_DEMO",
    duration_days: scenario.total_days,
    min_exposure_per_arm: 300,
    budget_cap_fen: 300_000,
    primary_metric: "purchase_intent_count/exposure",
    secondary_metrics: ["CTR", "ADD_TO_CART_RATE", "INQUIRY_RATE"],
    stop_rules: [
      { code: "BUDGET_CAP", description: "累计消耗不得超过已批准试销预算。" },
      { code: "QUALITY_BLOCK", description: "漏斗异常或分流严重失衡时停止强结论。" },
    ],
    quality_requirements: ["每臂曝光不少于 300", "每臂购买意向事件不少于 10", "实际分流不得严重偏离 50/50"],
    potential_biases: ["浏览器内合成数据仅验证流程", "单一渠道不代表整体市场"],
    policy_version: STATIC_PREVIEW_POLICY.version,
    generated_by: "browser-static-replay",
    approval_status: "PENDING",
    status: "PENDING",
  };
}

const factors = [0.94, 1.02, 0.98, 1.06, 1, 0.96, 1.04];

function boundedCount(base: number, rate: number, upper: number): number {
  return Math.max(0, Math.min(upper, Math.round(base * rate)));
}

function makeDailyRow(
  scenario: StaticScenarioFixture,
  fixture: VariantFixture,
  dayIndex: number,
  variantId: string,
  armId: string,
): TrialObservation {
  const exposure = Math.max(1, Math.round(fixture.exposurePerDay * factors[dayIndex % factors.length]));
  const click = boundedCount(exposure, fixture.ctr, exposure);
  const favorite = boundedCount(click, fixture.favoritePerClick, click);
  const inquiry = boundedCount(click, fixture.inquiryPerClick, click);
  const addToCart = boundedCount(click, fixture.cartPerClick, click);
  const purchaseIntent = boundedCount(exposure, fixture.intentPerExposure, addToCart);
  const order = boundedCount(exposure, fixture.orderPerExposure, purchaseIntent);
  const refund = boundedCount(order, fixture.refundPerOrder ?? 0, order);
  const returnCount = boundedCount(order, fixture.returnPerOrder ?? 0, Math.max(0, order - refund));
  const date = new Date(Date.UTC(2026, 7, 18 + dayIndex)).toISOString().slice(0, 10);
  return {
    date,
    candidate_id: "CASUAL-001",
    variant_id: variantId,
    arm_id: armId,
    channel: "AUTHORIZED_PRIVATE_DOMAIN_DEMO",
    audience_segment: "URBAN_COMMUTER_MEN_25_40",
    exposure,
    click,
    favorite,
    inquiry,
    add_to_cart: addToCart,
    purchase_intent: purchaseIntent,
    preorder: 0,
    order,
    refund,
    return_count: returnCount,
    price_fen: scenario.priceFen,
    spend_fen: Math.round(exposure * 50),
  };
}

export function makeStaticObservations(scenario: StaticScenarioFixture): TrialObservation[] {
  return Array.from({ length: scenario.total_days }, (_, dayIndex) => [
    makeDailyRow(scenario, scenario.variantA, dayIndex, "COLOR-GRAY-BLUE", "ARM-A"),
    makeDailyRow(scenario, scenario.variantB, dayIndex, "COLOR-IVORY", "ARM-B"),
  ]).flat();
}

function wilsonInterval(success: number, total: number): [number, number] {
  if (total <= 0) return [0, 0];
  const z = 1.96;
  const proportion = success / total;
  const denominator = 1 + z * z / total;
  const centre = (proportion + z * z / (2 * total)) / denominator;
  const spread = z * Math.sqrt((proportion * (1 - proportion) + z * z / (4 * total)) / total) / denominator;
  return [Math.max(0, centre - spread), Math.min(1, centre + spread)];
}

export function makeStaticMetrics(observations: TrialObservation[]): MetricsReport {
  const variantIds = ["COLOR-GRAY-BLUE", "COLOR-IVORY"];
  const variants = variantIds.map((variantId) => {
    const rows = observations.filter((row) => row.variant_id === variantId);
    const sum = (key: keyof TrialObservation) => rows.reduce((total, row) => total + Number(row[key]), 0);
    const exposure = sum("exposure");
    const click = sum("click");
    const purchaseIntent = sum("purchase_intent");
    const order = sum("order");
    const interval = wilsonInterval(purchaseIntent, exposure);
    const intentRate = purchaseIntent / Math.max(1, exposure);
    return {
      id: `metric-${STATIC_PREVIEW_PROJECT_ID}-${variantId}-v1`,
      variant_id: variantId,
      arm_id: variantId === "COLOR-GRAY-BLUE" ? "ARM-A" : "ARM-B",
      exposure,
      click,
      favorite: sum("favorite"),
      inquiry: sum("inquiry"),
      add_to_cart: sum("add_to_cart"),
      purchase_intent: purchaseIntent,
      preorder: sum("preorder"),
      order,
      refund: sum("refund"),
      return_count: sum("return_count"),
      spend_fen: sum("spend_fen"),
      ctr: click / Math.max(1, exposure),
      favorite_rate: sum("favorite") / Math.max(1, click),
      inquiry_rate: sum("inquiry") / Math.max(1, click),
      add_to_cart_rate: sum("add_to_cart") / Math.max(1, click),
      purchase_intent_rate: intentRate,
      intent_rate: intentRate,
      order_rate: order / Math.max(1, exposure),
      return_and_refund_rate: (sum("refund") + sum("return_count")) / Math.max(1, order),
      purchase_intent_rate_ci_low: interval[0],
      purchase_intent_rate_ci_high: interval[1],
      intent_rate_ci_low: interval[0],
      intent_rate_ci_high: interval[1],
    };
  });
  const totalExposure = variants.reduce((total, row) => total + Number(row.exposure), 0);
  const totalIntent = variants.reduce((total, row) => total + Number(row.purchase_intent), 0);
  const sorted = [...variants].sort((left, right) => Number(right.purchase_intent_rate) - Number(left.purchase_intent_rate));
  const bestRate = Number(sorted[0]?.purchase_intent_rate ?? 0);
  const worstRate = Number(sorted[1]?.purchase_intent_rate ?? 0);
  const uplift = worstRate > 0 ? (bestRate - worstRate) / worstRate : null;
  return {
    variants,
    total_exposure: totalExposure,
    total_intent: totalIntent,
    total_purchase_intent: totalIntent,
    overall_intent_rate: totalIntent / Math.max(1, totalExposure),
    overall_purchase_intent_rate: totalIntent / Math.max(1, totalExposure),
    best_variant_id: String(sorted[0]?.variant_id ?? "") || null,
    worst_variant_id: String(sorted[1]?.variant_id ?? "") || null,
    relative_intent_uplift: uplift,
    relative_purchase_intent_uplift: uplift,
    metric_version: "metrics-v1",
    generated_at: STATIC_PREVIEW_TIMESTAMP,
  };
}

function issue(code: string, message: string, observed: unknown, expected: unknown): QualityIssue {
  return {
    issue_id: `quality-${STATIC_PREVIEW_PROJECT_ID}-${code.toLowerCase()}`,
    code,
    rule_code: code,
    severity: "BLOCK",
    message,
    affected_rows: [],
    affected_fields: ["exposure", "purchase_intent"],
    record_refs: [`dataset-${STATIC_PREVIEW_PROJECT_ID}`],
    observed: observed as never,
    expected: expected as never,
    handling_status: "OPEN",
    impact: "未满足预注册质量门，不得生成强结论。",
  };
}

export function makeStaticQuality(
  scenario: StaticScenarioFixture,
  metrics: MetricsReport,
  datasetSha256: string,
): QualityReport {
  const issues: QualityIssue[] = [];
  if (scenario.id === "INSUFFICIENT_DATA") {
    issues.push(issue("MIN_EXPOSURE_PER_ARM", "每臂曝光未达 300。", metrics.variants?.map((row) => row.exposure), 300));
    issues.push(issue("MIN_PURCHASE_INTENT_EVENTS_PER_ARM", "每臂购买意向事件未达 10。", metrics.variants?.map((row) => row.purchase_intent), 10));
  }
  if (scenario.id === "INVALID_EXPERIMENT") {
    issues.push(issue("SRM_BLOCK", "实际分流严重偏离锁定的 50/50。", metrics.variants?.map((row) => row.exposure), "50/50; p >= 0.01"));
    issues.push(issue("MIN_EXPOSURE_PER_ARM", "小流量实验臂曝光未达 300。", metrics.variants?.map((row) => row.exposure), 300));
  }
  const blocked = issues.length > 0;
  return {
    status: blocked ? "BLOCK" : scenario.id === "CONFLICTING_SIGNALS" ? "WARN" : "PASS",
    quality_status: blocked ? "BLOCK" : scenario.id === "CONFLICTING_SIGNALS" ? "WARN" : "PASS",
    summary: blocked
      ? "当前合成数据未通过预注册质量门。"
      : "当前合成数据通过结构、漏斗与样本检查。",
    can_make_strong_decision: !blocked,
    row_count: scenario.total_days * 2,
    observation_days: scenario.total_days,
    issues,
    dataset_sha256: datasetSha256,
    rule_version: "quality-rules-v1",
    schema_version: "trial-dataset-v1",
    generated_at: STATIC_PREVIEW_TIMESTAMP,
  };
}

export function outcomeCopy(outcome: DecisionOutcome): { sentence: string; nextActions: string[] } {
  if (outcome === "GO") return { sentence: "演示规则支持进入人工审批后的打样草案阶段。", nextActions: ["确认候选配色与未知工艺字段", "审批决策后生成交接草案"] };
  if (outcome === "PIVOT") return { sentence: "当前证据支持定位一个可修改变量并在修改后复测。", nextActions: ["按 reason code 锁定一个主要修改变量", "新建版本化复测计划并重新审批"] };
  if (outcome === "NO_GO") return { sentence: "在当前演示目标与约束下，不建议继续投入。", nextActions: ["记录停止原因", "归档并保留复盘条件"] };
  return { sentence: "证据或信号不足以支持 Go、Pivot 或 No-Go。", nextActions: ["按质量报告补数或修复实验", "重新验证后再运行决策"] };
}
