# 参与贡献

感谢你参与“试销官”。提交改动前请先阅读根目录 `AGENTS.md` 及其中列出的项目文档。

## 本地开发

```bash
cp .env.example .env
pnpm install
python3 -m uv --directory apps/api sync --locked --dev
pnpm dev
```

默认使用 `MODEL_MODE=replay` 即可完成固定场景演示，不需要任何模型密钥。

## 提交要求

- 从短分支提交范围单一的 Pull Request，并说明行为变化、风险和验证结果。
- 运行 `pnpm check`；影响主链路时同时运行 `pnpm test:e2e`。
- 新增或修改接口时同步生成 OpenAPI 与前端类型，并通过契约漂移检查。
- 新增重要范围、架构或安全选择时，在 `docs/DECISIONS.md` 追加决策，不覆盖历史。
- 保留 `SYNTHETIC`、证据等级、人工审批和“非生产指令”等产品护栏。

## 数据与安全

- 不提交 `.env`、API Key、数据库、附件、报告、个人信息或企业数据。
- 测试和示例只使用固定种子的合成数据或具有明确许可的公开样例。
- 不在 Issue、Pull Request、日志或截图中粘贴密钥。
- 不把模型生成内容作为数值计算、因果证据或生产授权。

提交贡献即表示你同意按照项目的 MIT 许可证提供该贡献。
