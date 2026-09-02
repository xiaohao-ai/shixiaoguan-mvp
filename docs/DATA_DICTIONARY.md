# 试销官 MVP 数据字典

> 版本：v1.1
> 冻结日期：2026-09-03
> 适用范围：男士轻量休闲鞋 Demo，1 个基础款＋2 个配色变体，预置场景控制台，每日聚合合成数据。
> 契约优先级：Pydantic Schema 与运行时 OpenAPI 是接口事实来源；本文解释字段语义和跨对象不变式。

## 1. 全局约定

- 字段使用 `snake_case`，枚举值使用大写 `SCREAMING_SNAKE_CASE`。
- 持久化时间按 UTC 解释并通过带时区 ISO 8601 输出；界面按 `Asia/Shanghai` 展示。业务日期为 `YYYY-MM-DD`。
- 金额字段以整数分保存（字段后缀 `_fen`）；Brief、变体、计划预算和观测金额的后端上限为 SQLite 有符号 `INTEGER` 最大值 `2^63-1`。Web 表单还限制为 JavaScript `Number.MAX_SAFE_INTEGER` 可安全换算的元/分范围，金额按两位小数展示。计数为非负整数；比率在 API 中使用 `[0,1]` 小数。
- Pydantic 模型统一 `extra="forbid"`。类型、必填项或数值范围不合法的请求在进入领域质检前返回 `422`，不能伪装成一条 `QualityIssue`。
- 未知鞋类与工艺字段使用 `null`，交接界面显示“待确认”；模型不得猜测填充。
- 并非所有对象都拥有同一组 `version/created_by/updated_at` 字段。版本、时间和操作者以各对象实际 Schema 为准。
- `ObjectVersionRecord` 只覆盖八类规范化业务快照：`ProductBrief`、`DemoPolicy`、`ExperimentPlan`、`QualityReport`、`MetricBundle`、`EvidenceCard`、`DecisionCard`、`HandoffPackage`。Dataset、Observation、Approval、PivotRevision、AgentRun 和 AuditEvent 使用各自历史表。
- 本轮没有 CSV/Excel、手工试销观测或平台 API 导入，也没有销量、售罄、爆款或类别概率预测；相关能力和指标均为 P1 或 `N/A`。

## 2. 关系总览

```text
ProjectDetail（ProjectRecord 的当前投影）
├── ProductBriefDraft / ProductBrief（内嵌 CandidateVariant[]）
├── DemoPolicy ── ExperimentPlan ── Approval(EXPERIMENT_PLAN)
├── SimulationRun ── DatasetSummary/DatasetRecord ── TrialObservation（每日聚合）
├── QualityReport ── MetricBundle ── EvidenceCard ── DecisionCard
│                                                     └── Approval(DECISION)
├── PivotRevision ── Approval(PIVOT_REVISION，仅 Pivot)
├── Approval(FIRST_ORDER_ASSUMPTIONS，绑定 Brief 版本)
└── HandoffPackage ── TechPackLite / SampleTask / FirstOrderScenario[]

八类业务快照 ── ObjectVersionRecord（追加式）
所有流程变化 ── AuditEvent；模型/回放调用 ── AgentRun
```

`ProjectRecord` 的 JSON 字段是快速读取的当前投影，不是历史唯一来源。Brief/Policy 重开或模拟重置可以清空当前下游投影，但不会删除独立历史表和已经追加的对象快照。

## 3. 枚举与状态

### 3.1 数据来源 `DataStatus`

API 在不同视图中使用 `data_status` 或兼容别名 `data_origin`，语义均来自同一枚举：

| 值 | 定义 | P0 可产生 |
| --- | --- | --- |
| `SYNTHETIC` | 内置场景生成，只验证流程与规则 | 是 |
| `PUBLIC_SAMPLE` | 有来源与许可边界的公开样例 | 否，P1 |
| `USER_PROVIDED` | 用户提供但未完成企业授权校验 | 否，P1 |
| `ENTERPRISE_AUTHORIZED` | 企业明确授权用于约定范围 | 否，P1 |

不再增加 `is_real`、`is_simulated` 或 `SIMULATED`。

P0 创建或更新 Brief 时，服务端强制 `data_status=SYNTHETIC`；提交其他枚举返回 `422`。这不是仅靠 UI 的标签约定。上传一张用户图片不会改变试销观测来源，图片敏感性由独立字段表达。

### 3.2 三个核心正交维度

`workflow_state` 使用 `ProjectStatus`：

```text
DRAFT
BRIEF_READY
PLAN_PROPOSED
PLAN_APPROVED
SIMULATION_READY
SIMULATION_RUNNING
DATA_READY
DATA_VALIDATED
DATA_BLOCKED
ANALYZED
DECISION_PROPOSED
DECISION_APPROVED
HANDOFF_DRAFT_READY
ARCHIVED
NEEDS_INPUT
TOOL_FAILED
CANCELLED
```

`ProjectDetail.status` 与 `workflow_state` 是同一当前值的兼容字段。`NEEDS_INPUT / TOOL_FAILED / CANCELLED` 已在枚举预留，当前没有将其单独持久化为中间状态的专用接口。

主链路为：Brief 齐备后提出并批准计划，进入模拟；数据完成后经 `DATA_VALIDATED` 或 `DATA_BLOCKED` 进入分析和 `DECISION_PROPOSED`。GO/PIVOT/NO_GO 可按 Gate 规则批准为 `DECISION_APPROVED`；Evidence Insufficient 不能批准交接，可 `REQUEST_MORE_DATA` 回到 `DATA_READY`，或显式取消活跃工作后归档。

`quality_status`：`PASS / WARN / BLOCK`。评估前不存在值；`BLOCK` 时 `decision_outcome` 必须是 `EVIDENCE_INSUFFICIENT`。

`decision_outcome`：`GO / PIVOT / NO_GO / EVIDENCE_INSUFFICIENT`。它是业务结果，不是流程位置。

### 3.3 证据字段

| 字段 | 枚举 | 含义 |
| --- | --- | --- |
| `kind` | `OBSERVED / INFERRED / RECOMMENDED` | 兼容性的证据类别 |
| `statement_type` | `OBSERVED / INFERRED / RECOMMENDED` | 陈述类型 |
| `inference_strength` | `CAUSAL / QUASI_EXPERIMENTAL / ASSOCIATIONAL / UNDETERMINED` | 最强可支持推断语义 |
| `evidence_grade` | `A / B / C / D` | 证据充分度，不是预测准确率 |
| `stance` | `SUPPORTS / OPPOSES / NEUTRAL` | 对当前结论的方向 |

`OBSERVED` 不自动意味着因果。`SYNTHETIC` 的证据等级最高为 B、推断强度最高为 `ASSOCIATIONAL`；质量阻断时等级为 D。Agent 解释不是新证据，不能提高等级。

### 3.4 审批、Agent 与产物状态

- `ApprovalGate`：`EXPERIMENT_PLAN / DECISION / PIVOT_REVISION / FIRST_ORDER_ASSUMPTIONS`。
- `ApprovalDecision`：`APPROVE / REJECT / REQUEST_CHANGES / REQUEST_MORE_DATA`。
- 对象投影中的 `ApprovalStatus`：`PENDING / APPROVED / REJECTED / CHANGES_REQUESTED / MORE_DATA_REQUESTED`。
- `AgentMode`：`LIVE / OFFLINE_REPLAY`。
- `DataSensitivityLevel`：无用户附件时为 `SYNTHETIC_ONLY`；项目存在用户图片附件后动态返回 `USER_CONTENT_RESTRICTED`。它与试销 `data_origin` 正交。
- `DemoScenarioId`：`GO / PIVOT_PRICE / PIVOT_DESIGN / NO_GO / INSUFFICIENT_DATA / INVALID_EXPERIMENT / SUPPLY_CONSTRAINT / CONFLICTING_SIGNALS`。
- `TechPackField.status`：`CONFIRMED / USER_PROVIDED / PENDING_CONFIRMATION / UNKNOWN`。
- `FirstOrderScenario.status`：`READY / CONFLICT / NOT_READY / CONDITIONAL_RETEST_REQUIRED`。`NOT_READY` 是 Schema 允许值；当前交接入口在假设未确认时直接返回 `409`，不会持久化一个 NOT_READY 包。
- `HandoffPackage.status`、`TechPackLite.status`、`SampleTask.status` 是有明确默认文案的字符串字段，不另宣称为未实现的全局枚举。

## 4. 当前 API 对象

### 4.1 `ProjectCreate`、`ProductBriefDraft` 与 `ProductBrief`

`ProjectCreate`：`name`（必填）和 `brief`（缺省为空草稿）。不完整负载可以持久化为 `DRAFT`；只有相同负载通过严格 `ProductBrief` 校验才进入 `BRIEF_READY`。

`ProductBriefDraft` 与严格 Brief 使用相同字段名：

| 字段 | 草稿 | 严格 Brief 约束 |
| --- | --- | --- |
| `product_name`, `candidate_id` | 可空 | 非空字符串 |
| `category` | 默认 `MEN_LIGHTWEIGHT_CASUAL` | 非空 |
| `target_audience`, `usage_scenario`, `channel` | 可空 | 非空 |
| `season` | 默认 `ALL_SEASON` | 非空 |
| `core_selling_points` | 默认 `[]` | 最多 8 项 |
| `target_price_fen`, `estimated_cost_fen` | 可空 | `>0` |
| `gross_margin_floor_bps` | 默认 4000 | `0..10000` |
| `moq`, `expected_lead_time_days` | 可空 | `>0`，交期最多 365 天 |
| `target_launch_days` | 默认 60 | `1..730` |
| `trial_budget_fen`, `production_budget_fen` | 可空 | `>0` |
| `business_goal` | 可空 | 非空，最多 1000 字符 |
| `known_risks` | 默认 `[]` | 最多 20 项 |
| `variants` | 默认 `[]`，最多 6 项 | 2..6 项，ID 唯一 |
| `first_order_assumptions` | 可空 | 可选嵌套对象 |
| `data_status` | 默认 `SYNTHETIC` | P0 服务端只接受 `SYNTHETIC` |

`CandidateVariant` 内嵌于 Brief，字段为 `id/label/color_name/color_hex/material_notes/image_url/target_price_fen`；P0 没有独立 `CandidateStyle` 或 `VariantVersion` API/数据表。`FirstOrderAssumptions` 为 `intent_to_order_rate(0,1] / planned_reach>0 / packing_step>0 / source=DEMO_PROPOSAL|USER_PROPOSAL`。它的当前确认投影 `FirstOrderAssumptionsConfirmation` 为 `target_id/brief_version/intent_to_order_rate/planned_reach/packing_step/proposal_source/actor/comment/confirmed_at`。

`ProjectDetail` 返回 `id/name/scenario_id/status/workflow_state/data_status/data_origin/data_sensitivity_level/brief_version/brief/brief_missing_fields/first_order_assumptions_confirmation/experiment_plan/current_day/total_days/policy_version/policy_revision/current_policy/scenario_version/fixed_seed/generator_version/agent_mode/datasets/artifacts/created_at/updated_at`；`ProjectListItem` 也返回 `data_sensitivity_level`。

每次 `PUT /projects/{id}/brief-versions` 通过 `If-Match-Version` 校验当前版本，并向 ProductBrief 对象账本追加下一版。任何非归档状态都可重开；系统停用活跃 Dataset、清空当前计划和下游投影，再按完整度回到 `DRAFT` 或 `BRIEF_READY`。旧观测、对象版本、审批和审计不删除。

### 4.2 `DemoPolicy` 与 `ExperimentPlan`

`DemoPolicy` 实际字段：

```text
version, revision, primary_metric,
min_exposure_per_arm, min_purchase_intent_events_per_arm,
expected_arm_share, srm_block_p_value,
purchase_intent_rate_threshold, relative_uplift_threshold,
gross_margin_floor_bps, interest_ctr_floor, cart_per_click_floor,
clearly_low_intent_rate_ceiling, clearly_low_ctr_ceiling,
conflicting_return_and_refund_rate,
modifiable_supply_budget_gap_ratio, modifiable_lead_time_gap_days,
modifiable_margin_gap_bps
```

`DemoPolicy` Pydantic 实例配置为 `frozen` 并拒绝额外字段。修改请求必须携带当前 `version/revision`，主指标和 50/50 分流在 MVP 固定；服务端生成新的项目策略版本与 revision，失效当前下游投影。

`ExperimentPlan`：

```text
id, version, approval_status,
decision_question, hypotheses[1..5], controlled_variable, invariants,
primary_metric, secondary_metrics, arms[2..6], target_audience, channel,
duration_days, min_exposure_per_arm, min_intent_per_arm, budget_cap_fen,
stop_rules, quality_requirements, potential_biases,
policy_version, policy_snapshot, generated_by, generated_at
```

`ExperimentArm` 是 `id/label/variant_id/expected_share`，臂 ID 与变体 ID 不重复且份额总和为 1。P0 审批额外强制刚好两臂、各 0.5，并核对计划数值和完整 `policy_snapshot` 与当前策略一致。实验计划审批绑定 `plan.id + plan.version`。

### 4.3 场景、运行、Dataset 与每日观测

`DemoScenarioSummary`：`id/name/description/expected_outcome/total_days/scenario_version/fixed_seed/generator_version`。

`SimulationRun` 是项目承载的当前运行视图，run ID 等于 project ID：

```text
id, project_id, experiment_plan_id, experiment_plan_version,
status, current_day, total_days, dataset_id,
scenario_id, scenario_version, fixed_seed, generator_version,
schema_version, dataset_sha256
```

`status` 直接使用 `ProjectStatus`。前端暂停只停止定时推进，不回滚服务端已经写入的观测。

`DatasetSummary`：

```text
id, project_id, data_status, source_label, authorization_note, file_name,
sha256, schema_version, row_count,
scenario_id, scenario_version, fixed_seed, generator_version,
plan_version, active, imported_at
```

Dataset SHA-256 覆盖全部 TrialObservation 和 `scenario_id/scenario_version/fixed_seed/generator_version/plan_version/schema_version`。同计划版本与相同来源元数据的完整重放必须得到同一哈希。

`TrialObservation` 为按日聚合，P0 不保存个人或会话级数据：

```text
date, candidate_id, variant_id, arm_id, channel, audience_segment,
exposure, click, favorite, inquiry, add_to_cart, purchase_intent,
preorder, order, refund, return_count, price_fen, spend_fen
```

在一个 Dataset 内，质检用 `date + variant_id + arm_id + channel + audience_segment` 检测重复。实验与数据来源通过父级 Dataset/Plan 关联，Observation 本身没有 `dataset_id`、`experiment_plan_version_id`、`data_origin` 或 `schema_version` API 字段（数据库记录内部另有 `dataset_id` 外键）。

语义约束包括：`click<=exposure`；`favorite/inquiry/add_to_cart<=click`；`purchase_intent<=add_to_cart`；`order<=purchase_intent`；`refund+return_count<=order`。`preorder/order/refund/return_count` 是合成后序辅助信号，不是主指标，也不能称为真实成交或退货。

`POST /projects/{id}/simulation/replay-reset` 仅在计划已批准且决策尚未批准、未生成交接时可用。它将活跃 Dataset 置为非活跃，清除当前派生投影并回到 `SIMULATION_READY`；旧 Dataset、Observation、ObjectVersion、AgentRun 与 AuditEvent 均保留。

### 4.4 `QualityReport` 与 `MetricBundle`

`QualityReport`：`status/can_make_strong_decision/row_count/observation_days/issues/dataset_sha256/rule_version/generated_at`。

`QualityIssue`：`issue_id/code/rule_code/severity/message/affected_rows/affected_fields/record_refs/observed/expected/handling_status/impact`；当前 `rule_code` 与 `code` 同值，`issue_id` 由规则码、消息和受影响行的规范内容确定性派生。severity 为 `BLOCK/WARN/INFO`，handling_status 为 `OPEN/ACKNOWLEDGED/RESOLVED`。Schema 层已经拒绝的请求不会进入该列表。

领域质检检查：两臂 50/50 计划、候选/变体/臂映射、渠道、漏斗关系、重复粒度、每臂最小曝光、SRM、预算上限、配色实验的非颜色变量、日期窗口/完成度和每臂最小购买意向。`EXPERIMENT_INCOMPLETE` 为 WARN；任一 BLOCK 使 `can_make_strong_decision=false`。

`MetricBundle`：

```text
variants[], total_exposure, total_purchase_intent, total_intent,
overall_purchase_intent_rate, overall_intent_rate,
best_variant_id, worst_variant_id,
relative_purchase_intent_uplift, relative_intent_uplift,
metric_version, generated_at
```

每个 `VariantMetric` 含 `id/variant_id/arm_id`、各漏斗与后序计数、`spend_fen`、CTR/收藏/询单/加购/购买意向/订单/退退合计比率，以及购买意向率的 Wilson 区间。`intent_*` 字段是购买意向指标的兼容别名。P0 没有独立通用 `MetricResult` 数据表。

### 4.5 `EvidenceCard` 与 `DecisionCard`

`EvidenceCard`：`id/version/data_status/quality_status/evidence_grade/claims/limitations/dataset_refs/policy_version/generated_at`。

`EvidenceClaim`：`id/kind/statement_type/inference_strength/evidence_grade/stance/statement/metric_refs/source_refs/counterexamples/limitations`。每项必须能引用现有 Dataset、Product Brief 或 VariantMetric；模型不能创建新 claim。

`DecisionCard`：

```text
id, version, outcome, one_sentence, evidence_grade,
reason_codes, key_evidence_ids, opposing_evidence_ids,
limitations, risks, next_actions, policy_version,
agent_narrative, approval_status, generated_at
```

`outcome/reason_codes` 由确定性 DemoPolicy 代码产生。`agent_narrative` 为可空的 `headline/interpretation/evidence_refs/limitations/generated_by/prompt_version`，只允许引用现有 EvidenceClaim ID 和已有数值，不改变类别。

### 4.6 `Approval` 与 `PivotRevision`

`ApprovalRequest`：`gate/decision/object_version/actor/comment/request_id`；路由从 `Idempotency-Key` 写入 request_id。响应为：

```text
id, project_id, gate, target_type, target_id, decision,
object_version, actor, comment, created_at, project_status
```

四个 Gate 都在服务端核对当前状态、目标 ID 与精确版本。Approval 记录只追加；对象生成新版本后旧批准不自动生效。`FIRST_ORDER_ASSUMPTIONS` 当前只接受 `APPROVE`，其 target ID 由 project ID 与当前 Brief version 派生，并再次核对提案确实存在。

`PivotRevision`：`id/decision_id/target_variant_id/version/approval_status/change_variable/change_list/retest_plan/created_by/created_at`。它有独立追加表；只有当前已批准 Pivot DecisionCard 下最新、仍为 PENDING 的修订可以审批，生成交接时再次核对同一 `target_id + object_version` 的 APPROVE 记录。

### 4.7 `HandoffPackage`、`TechPackLite`、`SampleTask` 与 `FirstOrderScenario`

`HandoffPackage`：

```text
id, decision_id, outcome, pivot_revision_id,
techpack, sample_task, first_order_scenarios, retest_plan,
blocked_reason, watermark, status, generated_at
```

`TechPackLite`：`id/candidate_id/variant_id/decision_id/title/fields/warnings/status`。`fields[]` 每项为 `name/value/status/source_ref`；通用鞋类及男士休闲鞋扩展字段未知时 `value=null`、`status=PENDING_CONFIRMATION`，页面显示“待确认”。

`SampleTask`：`id/candidate_id/variant_id/pivot_revision_id/objective/change_list/acceptance_points/risks/status`。

`FirstOrderScenario`：`name/quantity_low/quantity_high/assumptions/constraint_notes/status`。当前实现的保守、基准、进取各是一个离散数量点，所以每项 `quantity_low == quantity_high`；三个点整体形成情景范围，不是每点的统计区间。

交接矩阵：

| 决策 | 必要审批 | TechPack | SampleTask | 首单情景 |
| --- | --- | --- | --- | --- |
| GO | DecisionCard＋当前 Brief 首单假设 | 生成草稿 | 生成草稿 | 三个 `READY` 离散点 |
| PIVOT | DecisionCard＋精确 PivotRevision＋当前 Brief 首单假设 | 不生成 | 生成改款草稿 | 三个 `CONDITIONAL_RETEST_REQUIRED` 点，包带条件式水印 |
| NO_GO | 无交接路径 | 不生成 | 不生成 | 不生成 |
| EVIDENCE_INSUFFICIENT | 不允许 APPROVE 交接 | 不生成 | 不生成 | 不生成 |

缺少首单提案或当前 Brief 版本的人工确认时，handoff 请求返回 `409`，不会生成 NOT_READY 包。预算上限低于 MOQ，或保守/基准/进取任一点低于 MOQ 时，只返回一个 `BASE`、数量 0、`status=CONFLICT` 的冲突场景，不输出可执行量。

### 4.8 附件、运行记录与追加账本

`Attachment`：`id/project_id/object_key/original_filename/mime_type/size_bytes/sha256/rights_declaration/source/created_at`。仅接受通过 magic bytes 校验的 PNG/JPEG/WebP、最大 5 MiB；不做识图。

`AgentRun`：`id/project_id/mode/operation/model_name/reasoning_effort/prompt_version/output_schema_version/recording_id/duration_ms/input_sha256/output_sha256/input_tokens/output_tokens/tracing_disabled/api_store_disabled/success/fallback_reason/created_at`。

离线回放先规范化允许变化的身份引用，再以 `(input_sha256, prompt_version, output_schema_version)` 精确查找应用内固定录制；命中时记录 `recording_id`。未命中返回 `422 REPLAY_RECORDING_MISS`，不动态构造录制，不写入伪成功 AgentRun，也不推进业务状态。

`AuditEvent`：`id/project_id/action/object_type/from_state/to_state/actor/request_id/summary/created_at`，只追加。确定性质检、指标、规则、首单、交接和状态转换通过 actor 与 summary 留痕，P0 不另建 ToolRun 表。

`ObjectVersionSummary`：`project_id/object_type/object_id/object_version/payload/sha256/created_at`。唯一键为 `project_id + object_type + object_id + object_version`；相同身份/版本且相同内容可幂等复用，不同内容拒绝覆盖。

所有 `/api/v1` 写请求都要求 `Idempotency-Key`。中间件在单应用进程内按 key 加锁，把“查重→执行业务→保存响应”串行化；同 key、同请求指纹直接回放原响应，同 key 被用于不同方法/路径/查询/Content-Type/请求体时返回 `409`。这不宣称提供跨多进程的分布式锁。

显式归档通过 `POST /projects/{id}:archive`：`DECISION_APPROVED / HANDOFF_DRAFT_READY / CANCELLED` 可直接归档；其他活跃状态需 `cancel_active_work=true`。归档只转换状态并写 AuditEvent，不删除历史；归档后 Brief/Policy、模拟运行与其他变更请求均被拒绝。

## 5. `DemoPolicy v1`

### 5.1 默认参数

| 实际字段 | 默认值 | 语义 |
| --- | --- | --- |
| `version / revision` | `demo-policy-v1 / 1` | 项目策略身份与 revision |
| `primary_metric` | `purchase_intent_count/exposure` | 购买意向/曝光 |
| `min_exposure_per_arm` | 300 | 每臂最小曝光 |
| `min_purchase_intent_events_per_arm` | 10 | 每臂最小购买意向事件 |
| `expected_arm_share` | 0.5 | 每臂预期份额 |
| `srm_block_p_value` | 0.01 | SRM 严格小于此值时阻断 |
| `purchase_intent_rate_threshold` | 0.03 | 绝对需求门 |
| `relative_uplift_threshold` | 0.15 | 配色分化门 |
| `gross_margin_floor_bps` | 4000 | 演示毛利底线 |
| `interest_ctr_floor` | 0.10 | 兴趣信号 CTR 门 |
| `cart_per_click_floor` | 0.20 | 点击后加购门 |
| `clearly_low_intent_rate_ceiling` | 0.01 | 明显低意向上限 |
| `clearly_low_ctr_ceiling` | 0.06 | 明显低 CTR 上限 |
| `conflicting_return_and_refund_rate` | 0.20 | 合成后序冲突门 |
| `modifiable_supply_budget_gap_ratio` | 0.35 | MOQ/预算可修改缺口上限 |
| `modifiable_lead_time_gap_days` | 14 | 可修改交期缺口上限 |
| `modifiable_margin_gap_bps` | 500 | 可修改毛利缺口上限 |

以上均是合成 Demo 契约，不是男鞋行业标准。

### 5.2 公式

```text
purchase_intent_rate(arm)
  = sum(purchase_intent) / sum(exposure)

relative_uplift
  = (best_rate - worst_rate) / worst_rate

gross_margin_bps
  = integer_round_half_away_from_zero(
      (target_price_fen - estimated_cost_fen) * 10000 / target_price_fen
    )

minimum_cash_commitment
  = moq * estimated_cost_fen
```

零分母比率返回 0；质量门会在进入可用决策前阻断曝光或事件不足。

### 5.3 质检顺序

请求级 Schema 错误先返回 `422`。对已持久化的场景观测，QualityReport 依次检查计划 50/50、对象映射、渠道、漏斗、重复粒度、样本、SRM、预算、唯一变量、日期窗口和购买意向事件。任一 `BLOCK` 令 `quality_status=BLOCK`、`decision_outcome=EVIDENCE_INSUFFICIENT`；只有实验天数未完成时可产生 `WARN`。

活动 Dataset、已批准计划、Plan version 和冻结策略快照属于服务前置条件；不满足时返回 `404/409`，而不是让模型补救。

### 5.4 当前确定性决策顺序

按代码顺序评估：

1. 质量阻断或无可计算指标 → `EVIDENCE_INSUFFICIENT`。
2. 后序退款＋退货合成信号超过 20% → `EVIDENCE_INSUFFICIENT`＋人工复核。
3. 两臂均不高于 1%，或加权 CTR 不高于 6% 且需求未全通过 → 明确低需求 `NO_GO`。该结论优先于轻微可修改的 MOQ、毛利或交期失败，不能被升级为 Pivot。
4. 计算三类经营失败：MOQ/预算、交期、毛利。任一缺口超过其可修改上限 → `NO_GO`。
5. 判断需求失败是否能唯一定位为配色分化，或高兴趣但购买摩擦；无法定位 → `EVIDENCE_INSUFFICIENT`。
6. 把需求失败与可修改经营失败合并：恰好一个可修改变量 → `PIVOT`；多于一个 → `EVIDENCE_INSUFFICIENT`，原因码含 `MULTIPLE_MODIFIABLE_CONSTRAINTS / ONE_VARIABLE_PIVOT_REQUIRED`。
7. 无需求失败且无经营失败 → `GO`。

边界比较按代码中的 `>= / <=` 通过；SRM 只有严格 `p<0.01` 阻断。模型不参与类别、原因码、阈值或数值计算。

### 5.5 策略版本

项目创建时把默认 DemoPolicy 写入对象账本。策略修改必须提交当前 `version/revision`；服务端生成新的项目专属 version 和递增 revision，清空当前计划与下游投影。ExperimentPlan 批准时冻结完整 `policy_snapshot`，以后不能被新策略覆盖。

## 6. 固定场景

八个内置场景使用 `scenario_version=mens-casual-demo-scenarios-v1`、`fixed_seed=20260903`、`generator_version=daily-aggregate-generator-v1`。参数是应用内冻结定义，P0 不暴露自由调参。

| 场景 | 预期结果 | 用途 |
| --- | --- | --- |
| `GO` | `GO` | 需求、毛利、MOQ/预算、交期通过 |
| `PIVOT_PRICE` | `PIVOT` | 高兴趣但购买意向不足，价格/offer 待复测 |
| `PIVOT_DESIGN` | `PIVOT` | 一个配色过门、另一个未过且差异足够 |
| `NO_GO` | `NO_GO` | 两臂需求明显低 |
| `INSUFFICIENT_DATA` | `EVIDENCE_INSUFFICIENT` | 曝光或意向事件不足 |
| `INVALID_EXPERIMENT` | `EVIDENCE_INSUFFICIENT` | 50/50 分流严重失衡并伴随质量阻断 |
| `SUPPLY_CONSTRAINT` | `PIVOT` | 可修改的 MOQ/预算缺口；不可修改缺口的 NO_GO 由单元测试覆盖 |
| `CONFLICTING_SIGNALS` | `EVIDENCE_INSUFFICIENT` | 合成高兴趣与高退退后序信号冲突 |

固定 seed 是快照来源元数据的一部分；当前生成器本身采用冻结日因子和四舍五入逻辑，不声称为随机抽样或真实渠道模拟。

## 7. 首单三点情景

只有已批准 GO，或 DecisionCard 与精确 PivotRevision 均已批准的 PIVOT，并且当前 Brief 版本的首单假设已由具名操作者 `APPROVE`，才可生成交接：

```text
demand_anchor
  = total_purchase_intent
    * intent_to_order_rate
    * planned_reach / total_exposure

conservative / base / aggressive
  = demand_anchor * 0.8 / 1.0 / 1.2

budget_ceiling
  = floor(production_budget_fen / estimated_cost_fen / packing_step)
    * packing_step
```

每个情景按包装步长取整并取 `min(情景量, budget_ceiling)`。三个结果是离散点，合起来才构成保守到进取的“情景范围”；它们不是销量预测、概率区间或可直接下单指令。

如预算上限低于 MOQ，或任一情景点低于 MOQ，只返回 `CONFLICT` 和数量 0。Pivot 始终标记 `CONDITIONAL_RETEST_REQUIRED`，HandoffPackage 强制显示“条件式、需复测、尚待复测，不得下单 / 非生产指令”。

## 8. 最小不变式

1. 不完整 ProductBrief 可持久化，但只能处于 `DRAFT`；完整 Schema 才进入 `BRIEF_READY`。
2. P0 种子 Brief 是 1 个基础款 ID、2 个内嵌配色变体；已批准首实验只有颜色一个变量和购买意向率一个主指标。
3. TrialObservation 是每日聚合，来源状态保存在父 Dataset，P0 只能为 `SYNTHETIC`。
4. `quality_status=BLOCK` 时结果一定为 `EVIDENCE_INSUFFICIENT`。
5. 决策类别、原因码和所有业务数值来自确定性代码，不来自 Agent 文本或工具选择。
6. 单一逻辑 Agent 无 handoff；只有在线决策解释拥有一个调用级无参数只读证据工具。
7. 离线录制只按三元键精确命中；miss 为 `422 REPLAY_RECORDING_MISS`，状态不推进。
8. 四个 Approval Gate 均绑定精确对象 ID/版本；GO/Pivot 交接还必须确认当前 Brief 版本的首单假设。
9. 前端依据对象返回的 `approval_status` 与首单确认对象显示门禁，不从 `workflow_state` 猜测“已批准”；服务端始终再次校验 Approval 记录。
10. Brief/Policy 重开和模拟重置只失效当前投影，历史 Dataset/Observation/ObjectVersion/Approval/AgentRun/AuditEvent 按各自规则保留。
11. `ARCHIVED` 是显式终点；活跃项目归档需确认取消，归档后禁止变更或再次运行模拟。
12. GO 的三点首单场景、Pivot 的条件式三点场景都只是草稿；P0 不发往工厂、不下单、不写 ERP/MES。
