# Pi Agent 通用底座与 Harness 改造说明

## 改造边界

本次改造没有修改 Pi agent 原生主框架，也没有改动 `node_modules/@earendil-works/*`。项目仍以 Pi CLI 作为执行内核，通过 `npx pi` 启动原生 agent loop。

改造集中在项目外围：

- `src/server/pi-runner.ts`：新增通用 `PiAgentRunner`，负责写入 task manifest、加载 Pi package 资源、注入任务环境变量、启动 `npx pi`、收集 transcript 和 artifact。
- `pi/extensions/patrol-session-bridge.ts`：通过 Pi extension API 注册受控工具，包括任务文件读取、skill 文件读取、终端命令、Web ask、事件上报、artifact 注册。
- `package.json`：声明 Pi package 资源，包括 bridge extension、当前巡检标准 skill、Excel 质量 skill 和追加 system prompt。
- `harness/`：新增持续观测 harness，用 fixture 跑本地 mock 回归，也支持 OpenRouter 真实模型路径。
- `src/server/env.ts` 和 `scripts/load_local_env.mjs`：加载 `.env.local`、`.env`、`data/secrets/openrouter.env`，但不覆盖已有环境变量。

## 安全策略

- 默认 `PiAgentRunner` 使用 `--no-builtin-tools`，避免 Pi 内置 shell/read/write 绕过项目边界。
- `run_terminal_command` 只允许在 task workspace 内执行非 shell 命令。
- 命令 denylist 覆盖 `rm`、`git`、`npm`、`npx`、`curl`、`bash`、`sudo` 等高风险命令。
- 文件路径限制在 task inputs/workspace/outputs 或 skill resources 内。
- OpenRouter key 只允许放在 `.env.local` 或 `data/secrets/openrouter.env`，并由 `.gitignore` 排除。

## 验证结果

CLI/harness 验证：

- `npm run smoke`：通过。
- `git diff --check`：通过。
- secret scan：未在 tracked 文件中发现 OpenRouter key。

真实材料 + OpenRouter 自测：

- 原始材料：`manager_review.docx`，解析出约 27k 字。
- 模型：`deepseek/deepseek-v4-pro` via OpenRouter。
- 执行状态：`boundary-confirmation -> execution-plan-approval -> completed`。
- 产物：8 个，包括材料摘要、执行计划、LLM 原始响应、工作簿 JSON、Excel 工作簿、校验报告和 manifest。
- 工作簿校验：`errors=0, warnings=0`。

网页页面自测：

- 页面创建任务成功。
- 页面启动后进入职责边界确认。
- 页面提交确认后进入执行计划确认。
- 页面批准计划后完成任务。
- 页面最终显示 `完成`、`61` 个事件、`8` 个产物，并展示 `巡检标准工作簿` 和 `工作簿校验报告`。

## 影响说明

本次改造影响的是本项目的 Pi 启动方式、工具边界和观测链路，不影响 Pi agent 原生主框架。默认运行更接近企业受控模式：Pi 负责推理与 agent loop，项目 bridge 负责文件、终端、ask、artifact、审计和边界控制。
