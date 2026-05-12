# Pi 巡检标准 Agent 质量评审记录

## 当前定位

当前实现定位为本地可运行的 Pi 巡检标准 Agent 原型。它已经具备 Web 任务台、文本/附件输入、SSE 事件流、阻塞式 ask、Docker 沙箱、Pi package 适配、Excel 工作簿生成和校验链路。

## 五轮整改

1. 材料进入沙箱
   - 问题：上传附件保存在 task `inputs`，但 Docker 沙箱只挂载 `workspace`。
   - 整改：写入 manifest 时复制附件到 `workspace/inputs`，并新增 `scripts/extract_materials.py` 生成 `source-digest.json`。

2. 领域 ask 逻辑
   - 问题：原来在材料解析前固定询问职责边界，问题不够领域化。
   - 整改：先解析材料摘要，再根据职责、对象、标准信号缺口生成 ask。

3. Excel 质量
   - 问题：工作簿契约正确，但视觉上是裸表。
   - 整改：xlsx writer 增加冻结首行、筛选、表头样式、长文本换行和语义列宽。

4. 沙箱和 bridge 边界
   - 问题：任务沙箱曾挂载整个 repo，可能只读暴露 `data/` 下其他任务；内部 bridge endpoint 缺少边界约束。
   - 整改：沙箱只挂载 `SKILL.md`、`scripts/`、`references/`、`pi/` 和当前 `workspace`；bridge 增加 token 和 artifact task 路径约束。

5. Pi package 可验证性
   - 问题：真实 Pi runner 需要模型 key，不能作为默认 smoke 的强依赖。
   - 整改：新增 `npm run check:pi`，验证 Pi CLI 可用、package manifest 资源存在。

## 仍需后续增强

- 使用真实 provider key 跑一次 `PATROL_RUNNER=pi` 端到端分析。
- 使用真实 `OPENAI_API_KEY` 跑一次本地 runner 的 `llm_analysis` 端到端分析。
- 引入更强的 PDF 解析和 OCR 策略。
- 将 fallback runner 逐步退化为 smoke/demo，真实分析默认走 Pi runner。
- 加入 artifact 清理、任务超时、运行日志脱敏和生产资源配额。
