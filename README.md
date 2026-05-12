# Patrol Stand Pi Agent

本仓库把巡检标准 skill 包扩展成本地可运行的 Pi Agent 原型：

- WebChat/任务台：文本输入、附件上传、任务事件流、阻塞式 ask、产物下载。
- 本地任务会话：`data/tasks/<taskId>/inputs|workspace|outputs`。
- Pi 原生适配：`package.json` 中声明 Pi `skills`、`extensions`、`prompts`。
- 沙箱执行：runner 优先使用 Docker per-task container；`SANDBOX_MODE=host` 可用于本地调试。
- Excel 输出：复用 `scripts/render_workbook.py` 和 `scripts/validate_workbook.py`，最终产物为 `.xlsx`。
- LLM 分析：材料解析后进入 `llm_analysis` 阶段；配置 `KIMI_API_KEY` 后会通过 Pi CLI 调用 Kimi For Coding，配置 `OPENAI_API_KEY` 后会调用 OpenAI Responses API。
- Agent 节奏：本地 runner 不再一次性批处理；默认先 ask 职责边界，再给出分析计划与执行模式，用户批准后才进入 LLM 分析和 Excel 生成。

## Local Run

```bash
npm install
npm run build
SANDBOX_MODE=host PATROL_RUNNER=local npm start
```

打开：

```text
http://127.0.0.1:8787
```

开发模式：

```bash
npm run dev
```

## Docker Run

```bash
docker compose up --build
```

`docker-compose.yml` 会把 Docker socket 挂到 Web/orchestrator 容器，用于启动每个任务的沙箱容器。内部 bridge 默认设置 `PATROL_BRIDGE_TOKEN`，用于阻止未授权页面直接调用 `/api/internal/*`。

任务沙箱容器本身只挂载：

- `/skill/SKILL.md`：巡检标准 skill 入口，只读
- `/skill/scripts`：工作簿脚本，只读
- `/skill/references`：领域参考资料，只读
- `/skill/pi`：Pi package 适配文件，只读
- `/workspace`：当前任务 workspace，可读写

任务沙箱不挂载宿主 HOME、SSH key、云凭证、Docker socket 或 repo 下的 `data/` 目录。

## Pi Package

Pi package manifest 在根 `package.json` 的 `pi` 字段中：

- `pi/extensions/patrol-session-bridge.ts`
- 当前目录的 `SKILL.md`
- `pi/skills/excel-workbook-quality/SKILL.md`
- `pi/prompts/patrol-agent.md`

本机安装 Pi CLI 后，可按 Pi 本地 package 方式加载该目录。当前本地 Web runner 在 Pi CLI 不可用时仍可完成端到端验证。

## Runner Modes

默认使用本地 fallback runner，便于无模型密钥时验证 Web、ask、沙箱和 Excel 闭环：

```bash
PATROL_RUNNER=local KIMI_API_KEY=... npm start
```

未配置模型 key 时，本地 runner 会明确记录 `llm_analysis` 降级事件，并使用规则骨架继续生成 Excel。若希望无 LLM 时直接失败：

```bash
LLM_REQUIRED=true PATROL_RUNNER=local npm start
```

验证 LLM 接入链路但不调用真实模型：

```bash
LLM_PROVIDER=mock npm run smoke
```

Kimi For Coding 验证：

```bash
KIMI_API_KEY=... npx pi --provider kimi-coding --model kimi-for-coding --no-session --no-tools -p "请只输出 OK"
KIMI_API_KEY=... PATROL_RUNNER=local LLM_REQUIRED=true npm start
```

启用 Pi runner：

```bash
PATROL_RUNNER=pi \
PATROL_BRIDGE_TOKEN=local-dev-bridge-token \
OPENAI_API_KEY=... \
npm start
```

Pi runner 会通过 `npx pi` 加载：

- `--extension pi/extensions/patrol-session-bridge.ts`
- `--skill SKILL.md`
- `--skill pi/skills/excel-workbook-quality`
- `--append-system-prompt pi/prompts/patrol-agent.md`

如果 Agent 触发 `ask_user_web`，任务会停在 `waiting_user`，用户在 WebChat 回答后再次点击“启动/继续”恢复。

## Verification

```bash
npm run smoke
docker compose config
```

Pi package 结构检查：

```bash
npm run check:pi
```

工作簿契约校验：

```bash
python3 scripts/validate_workbook.py data/tasks/<taskId>/outputs/inspection-standard-workbook.xlsx
```
