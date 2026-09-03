# 试销官 MVP

面向永嘉中小鞋企的 AI + OPC 新品快反决策与实验编排应用。MVP 用一条可回放、可测试、可审计的合成数据闭环，演示男士轻量休闲鞋深灰蓝/米白两个配色的单变量试销决策：

```text
Product Brief → 实验计划审批 → 模拟试销 → 数据质检
→ Evidence Card → 四态决策审批 → PivotRevision 审批（仅 Pivot）
→ 首单假设审批 → 条件式交接 → 审计报告
```

本项目不是“爆款预测器”。模型只负责理解、规划与引用式解释；指标、区间、质量门禁、`GO / PIVOT / NO_GO / EVIDENCE_INSUFFICIENT` 和业务状态均由可测试的确定性代码产生。所有内置场景均为固定种子的 `SYNTHETIC` 合成演示，不代表真实市场结果，也不是生产指令。

## 技术栈

- Web：Next.js App Router、React、TypeScript strict、Tailwind CSS、React Hook Form、Zod、Recharts
- API：Python 3.12、FastAPI、Pydantic v2、SQLAlchemy 2、Alembic、Pandas、SciPy
- 数据：SQLite WAL；运行数据库和上传物只保存在忽略提交的本地目录，HTML 报告按请求渲染。金额以整数分持久化，后端受 SQLite 64 位上限约束，Web 表单受 JavaScript 安全整数约束并以两位小数显示
- Agent：单一逻辑编排 Agent 角色（无 handoff/子 Agent）；Brief 归一化与实验文字草案不使用工具，只有在线决策解释在单次调用内挂载一个无参数、只读的锁定证据工具；质检、分析、状态与交接均由应用确定性服务执行
- 在线模型：DeepSeek OpenAI 兼容 Responses API，默认 `deepseek-v4-flash`；Brief/计划使用低推理强度，决策解释为兼容强制命名只读工具而关闭 thinking；OpenAI Agents SDK 仅作为编排层
- 回放：默认只接受 `(input_sha256, prompt_version, output_schema_version)` 与固定录制完全匹配的结果；未命中返回 `422 REPLAY_RECORDING_MISS`，不会按请求动态生成“回放”
- 契约：FastAPI OpenAPI 是后端接口事实来源，自动生成前端 TypeScript 类型，CI 拒绝未同步的契约漂移

## 快速开始

锁定的开发工具为 Node.js 24.19.0、pnpm 11.19.0、uv 0.12.9 和 Python 3.12.14。uv 会按项目锁文件准备隔离的 Python 环境。

```bash
cp .env.example .env
pnpm install
python3 -m uv --directory apps/api sync --locked --dev
pnpm dev
```

启动后访问：

- Web：<http://127.0.0.1:3000>
- API：<http://127.0.0.1:8000>
- OpenAPI：<http://127.0.0.1:8000/docs>

`.env.example` 默认使用 `MODEL_MODE=replay`，因此没有 DeepSeek API Key 也能完成已录制的核心演示。在线模式使用 DeepSeek 的 OpenAI 兼容 Responses API，默认模型为 `deepseek-v4-flash`：把密钥只写入本地、已被 Git 忽略的 `.env` 中，将 `MODEL_MODE` 改为 `live` 或 `auto` 并设置 `DEEPSEEK_API_KEY`。`DEEPSEEK_BASE_URL` 默认是 `https://api.deepseek.com`；仅有旧 `OPENAI_API_KEY` 不会启用在线模式。根启动器只把 `DEEPSEEK_API_KEY` 注入 API 子进程环境，不向任一子进程注入遗留 `OPENAI_API_KEY`，也不向 Web 子进程注入模型凭据；若误设 `NEXT_PUBLIC_DEEPSEEK_API_KEY` 或 `NEXT_PUBLIC_OPENAI_API_KEY` 会拒绝启动。密钥不会写入数据库、报告或 Git。

## 推荐 Demo 路径

1. 在首页选择 `PIVOT_DESIGN`，创建预置男士轻量休闲鞋项目。
2. 核对 Brief 和唯一变量“配色”，批准实验计划；批准后策略和计划版本冻结。
3. 在模拟控制台开始短间隔逐日自动播放，按需暂停、手动推进 1 天或一次完成固定种子场景。决策批准前可在同项目重置并重放；旧数据集与审计历史保留。
4. 执行质检与分析，查看指标引用、支持/反对证据和限制。
5. 生成确定性的 Decision Card 并审批 Pivot；再生成单变量 `PivotRevision`，对其精确 ID 与版本执行独立人工审批。完成修订审批前仍不能生成交接物。
6. 复核种子中标记为 `DEMO_PROPOSAL` 的意向转订单率、计划触达量和包装步长，由当前操作者对当前 Brief 版本执行第四个独立审批。
7. 查看打样草稿、三个离散首单情景点（整体形成保守到进取的情景范围）、“条件式、需复测”水印和完整审计报告。
8. 再运行 `INSUFFICIENT_DATA`，验证数据不足时不会进入交接。

八个预注册场景覆盖 GO、两个 Pivot、No-Go、样本不足、无效实验、供应约束和冲突信号。相同计划版本、场景版本、生成器版本与种子应得到相同的数据哈希、数值、结果和原因码。

四态分类按以下顺序执行：质量阻断 `EVIDENCE_INSUFFICIENT`→冲突信号 `EVIDENCE_INSUFFICIENT`→明确低需求 `NO_GO`→不可修改约束 `NO_GO`→恰好一个可修改失败 `PIVOT`→全部通过 `GO`→其他情况 `EVIDENCE_INSUFFICIENT`。明确低需求不会因轻微经营约束失败被升级为 Pivot，多个可修改失败也必须输出证据不足。

需要改 Brief 或 DemoPolicy 时不会覆盖已批准对象：保存新版本会将未归档项目重开到 `DRAFT` 或 `BRIEF_READY`，停用当前数据集并清空当前下游投影，历史版本、审批、观测和审计仍保留。归档项目不可再修改。

## 验证命令

```bash
pnpm check
pnpm test:e2e
```

后端可单独验证：

```bash
python3 -m uv --directory apps/api run ruff check .
python3 -m uv --directory apps/api run mypy src
python3 -m uv --directory apps/api run pytest
```

`pnpm check` 包含前后端 lint、类型检查、单元/集成测试、生产构建与 OpenAPI 契约漂移检查。CI 的黄金回归不调用付费模型；在线模型契约测试属于显式启用的受控检查。

## 目录

```text
apps/web/                 Next.js 工作台
apps/api/                 FastAPI、领域规则、模拟器与测试
docs/PROJECT_CONTEXT.md   稳定背景与产品边界
docs/PRD.md               MVP 产品需求和页面门禁
docs/ARCHITECTURE.md      架构、状态、数据和接口契约
docs/EVALUATION.md        测试、黄金场景和验收口径
docs/DECISIONS.md         已锁定决策与复审触发条件
docs/DATA_DICTIONARY.md   对象、枚举、字段和 DemoPolicy
```

## 数据与安全边界

- 只提交固定种子的合成 fixture、Schema 和测试；数据库、附件、报告、密钥与非合成数据均被 `.gitignore` 排除。
- 图片仅上传、展示、记录哈希和权属；自动识图、相似款和趋势检索不在 MVP。
- 服务端在项目创建和 Brief 更新时强制试销来源为 `SYNTHETIC`；上传用户图片只把 `data_sensitivity_level` 从 `SYNTHETIC_ONLY` 提升为 `USER_CONTENT_RESTRICTED`，不会把合成试销数据改称用户或企业数据。
- 所有外部发布、投放、下单、打样和生产动作都必须在系统外由人确认；应用仅生成草稿与三个离散情景点（整体形成情景范围）。
- `SYNTHETIC` 证据最高为 B，推断强度最高展示为 `ASSOCIATIONAL`。

私有远程仓库：<https://github.com/xiaohao-ai/shixiaoguan-mvp>
