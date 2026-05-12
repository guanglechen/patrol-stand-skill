import fs from "node:fs/promises";
import { readFileSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { AppDatabase } from "./db.js";
import { eventBus } from "./events.js";
import { writeManifest } from "./manifest.js";
import { repoRoot, taskOutputsDir, taskWorkspaceDir } from "./paths.js";
import { Sandbox } from "./sandbox.js";
import type { AgentAsk, TaskArtifact, TaskManifest } from "./types.js";
import { generatePlanningTraceWithLlm, generateWorkbookCaseWithLlm, hasLlmConfig } from "./llm-client.js";

const BOUNDARY_ASK_ID = "boundary-confirmation";
const PLAN_ASK_ID = "execution-plan-approval";
const APPROVE_EXECUTION = "approve_execute";

export class LocalPatrolRunner {
  private readonly running = new Set<string>();

  constructor(private readonly db: AppDatabase) {}

  async run(taskId: string): Promise<void> {
    if (this.running.has(taskId)) return;
    this.running.add(taskId);
    try {
      await this.execute(taskId);
    } finally {
      this.running.delete(taskId);
    }
  }

  private async execute(taskId: string): Promise<void> {
    const task = this.db.getTask(taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);
    this.db.updateTaskStatus(taskId, "running");
    await eventBus.emitTaskEvent({ taskId, type: "run_started", message: "Agent run started.", level: "info" });

    const manifest = await this.buildManifest(taskId);
    await writeManifest(manifest);

    await this.stage(taskId, "intake", "材料接收", async () => {
      await this.tool(taskId, "read_task_manifest", `Registered ${manifest.files.length} file(s) and ${manifest.messages.length} message(s).`);
      if (!manifest.files.length && !manifest.messages.some((message) => message.role === "user" && !message.askId)) {
        throw new Error("请先上传材料或输入分析说明。");
      }
    });

    await this.stage(taskId, "material_parse", "材料解析", async () => {
      await this.extractMaterials(taskId);
    });

    const boundaryAnswer = [...manifest.answers].reverse().find((answer) => answer.askId === BOUNDARY_ASK_ID);
    if (!boundaryAnswer) {
      await this.askBoundary(taskId);
      return;
    }
    if (boundaryAnswer.content === "need_more_upload" && !this.hasSupplementAfter(manifest, boundaryAnswer.createdAt)) {
      await this.askForSupplement(taskId);
      return;
    }

    const planAnswer = [...manifest.answers].reverse().find((answer) => answer.askId === PLAN_ASK_ID);
    if (planAnswer?.content === "need_more_upload" && !this.hasSupplementAfter(manifest, planAnswer.createdAt)) {
      await this.askPlanSupplement(taskId);
      return;
    }
    if (planAnswer?.content === "revise_plan") {
      await this.askPlanRevision(taskId);
      return;
    }
    if (!planAnswer || planAnswer.content !== APPROVE_EXECUTION) {
      await this.stage(taskId, "analysis_plan", "分析与执行计划", async () => {
        await this.askExecutionPlan(taskId, manifest, boundaryAnswer.content, planAnswer?.content);
      });
      return;
    }

    await this.stage(taskId, "boundary_design", "职责边界与对象层级设计", async () => {
      await this.runLlmAnalysis(taskId, manifest);
    });
    await this.stage(taskId, "workbook_build", "Excel 工作簿生成", async () => {
      await this.buildWorkbook(taskId, manifest);
    });

    this.db.updateTaskStatus(taskId, "completed");
    await eventBus.emitTaskEvent({ taskId, type: "task_completed", message: "巡检标准分析任务已完成。", level: "success" });
  }

  private async buildManifest(taskId: string): Promise<TaskManifest> {
    const task = this.db.getTask(taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);
    return {
      task,
      files: this.db.listFiles(taskId),
      messages: this.db.listMessages(taskId),
      answers: this.db.listAnswers(taskId)
    };
  }

  private async stage(taskId: string, stage: string, label: string, fn: () => Promise<void>): Promise<void> {
    await eventBus.emitTaskEvent({ taskId, type: "stage_started", stage, message: label, level: "info" });
    try {
      await fn();
      await eventBus.emitTaskEvent({ taskId, type: "stage_completed", stage, message: `${label}完成`, level: "success" });
    } catch (error) {
      this.db.updateTaskStatus(taskId, "failed");
      await eventBus.emitTaskEvent({
        taskId,
        type: "task_failed",
        stage,
        message: (error as Error).message,
        level: "error"
      });
      throw error;
    }
  }

  private async tool(taskId: string, tool: string, message: string): Promise<void> {
    await eventBus.emitTaskEvent({ taskId, type: "tool_started", tool, message: `${tool} started`, level: "info" });
    await eventBus.emitTaskEvent({ taskId, type: "tool_completed", tool, message, level: "success" });
  }

  private async askBoundary(taskId: string): Promise<void> {
    const digest = this.tryReadDigest(taskId);
    const gaps = this.askGaps(digest);
    const body = gaps.length
      ? `材料解析后仍存在这些阻塞点：${gaps.join("；")}。请选择本轮如何继续。`
      : "材料已有部分职责、对象或标准信号，但仍需确认第一版边界处理方式。请选择本轮如何继续。";
    const ask: AgentAsk = {
      id: BOUNDARY_ASK_ID,
      title: "确认第一版职责边界处理方式",
      body,
      inputKind: "single_select",
      required: true,
      options: [
        {
          label: "先形成候选边界",
          value: "candidate_boundary",
          description: "继续生成可审阅的候选架构，并把弱证据标记为 needs_review。",
          recommended: true
        },
        {
          label: "仅整理待确认项",
          value: "clarification_only",
          description: "先不生成完整工作簿，只沉淀需要补充的问题。"
        },
        {
          label: "我会补充材料",
          value: "need_more_upload",
          description: "暂停任务，继续上传职责或标准材料后再运行。"
        }
      ],
      defaultValue: "candidate_boundary"
    };
    this.db.updateTaskStatus(taskId, "waiting_user", ask.id);
    await eventBus.emitTaskEvent({
      taskId,
      type: "agent_ask",
      message: ask.title,
      level: "warning",
      ask
    });
  }

  private async askForSupplement(taskId: string): Promise<void> {
    this.db.updateTaskStatus(taskId, "waiting_user", BOUNDARY_ASK_ID);
    await eventBus.emitTaskEvent({
      taskId,
      type: "agent_ask",
      message: "等待补充职责或标准材料",
      level: "warning",
      ask: {
        id: BOUNDARY_ASK_ID,
        title: "等待补充职责或标准材料",
        body: "你选择了继续补充材料。请上传职责边界、对象清单、历史标准或频次规则后，再点击启动/继续。",
        inputKind: "attachment",
        required: true
      }
    });
  }

  private async askExecutionPlan(
    taskId: string,
    manifest: TaskManifest,
    boundaryMode: string,
    revisionNote?: string
  ): Promise<void> {
    const workspace = taskWorkspaceDir(taskId);
    await fs.mkdir(workspace, { recursive: true });
    const planningTrace = await this.runPlanningTrace(taskId, manifest);
    const planPath = path.join(workspace, "agent-execution-plan.md");
    const planText = this.buildExecutionPlan(manifest, boundaryMode, revisionNote, planningTrace.summary);
    await fs.writeFile(planPath, planText, "utf8");
    await this.registerArtifact(taskId, "Agent 执行计划", "trace", planPath);
    await this.registerArtifact(taskId, "Agent 多轮分析轨迹", "trace", planningTrace.tracePath);

    const ask: AgentAsk = {
      id: PLAN_ASK_ID,
      title: "确认分析计划与执行模式",
      body: planText,
      inputKind: "single_select",
      required: true,
      options: [
        {
          label: "按计划执行",
          value: APPROVE_EXECUTION,
          description: "进入 Kimi/LLM 分析、工作簿结构生成、Excel 渲染和校验。",
          recommended: true
        },
        {
          label: "调整计划",
          value: "revise_plan",
          description: "先暂停，不生成 Excel；你可以补充计划调整意见后再运行。"
        },
        {
          label: "继续补充材料",
          value: "need_more_upload",
          description: "暂停任务，继续上传职责边界、对象清单或标准依据。"
        }
      ],
      defaultValue: APPROVE_EXECUTION
    };
    this.db.updateTaskStatus(taskId, "waiting_user", ask.id);
    await eventBus.emitTaskEvent({
      taskId,
      type: "agent_ask",
      message: ask.title,
      level: "warning",
      ask
    });
  }

  private async runPlanningTrace(taskId: string, manifest: TaskManifest): Promise<{ summary: string; tracePath: string }> {
    await eventBus.emitTaskEvent({
      taskId,
      type: "tool_started",
      tool: "agent_material_inventory",
      message: "agent_material_inventory started",
      level: "info"
    });
    await eventBus.emitTaskEvent({
      taskId,
      type: "tool_completed",
      tool: "agent_material_inventory",
      message: `Indexed ${manifest.files.length} file(s), ${manifest.messages.length} message(s), and ${manifest.answers.length} answer(s).`,
      level: "success"
    });

    await eventBus.emitTaskEvent({
      taskId,
      type: "tool_started",
      tool: "agent_planning_loop",
      message: "agent_planning_loop started",
      level: "info"
    });
    const result = await generatePlanningTraceWithLlm(taskId, manifest);
    for (const round of result.rounds) {
      await eventBus.emitTaskEvent({
        taskId,
        type: "tool_completed",
        tool: "agent_planning_loop",
        message: `${round.label} completed via ${result.provider}/${result.model}.`,
        level: "success",
        data: { path: round.path }
      });
    }
    await eventBus.emitTaskEvent({
      taskId,
      type: "tool_completed",
      tool: "agent_planning_loop",
      message: `Planning trace completed via ${result.provider}/${result.model}.`,
      level: "success",
      data: { tracePath: result.tracePath }
    });
    return { summary: result.summary, tracePath: result.tracePath };
  }

  private async askPlanRevision(taskId: string): Promise<void> {
    this.db.updateTaskStatus(taskId, "waiting_user", PLAN_ASK_ID);
    await eventBus.emitTaskEvent({
      taskId,
      type: "agent_ask",
      message: "请补充计划调整意见",
      level: "warning",
      ask: {
        id: PLAN_ASK_ID,
        title: "请补充计划调整意见",
        body: "请说明需要调整的职责边界、对象层级、输出范围或执行模式。提交后 Agent 会重新给出执行计划，不会直接生成 Excel。",
        inputKind: "text",
        required: true
      }
    });
  }

  private async askPlanSupplement(taskId: string): Promise<void> {
    this.db.updateTaskStatus(taskId, "waiting_user", PLAN_ASK_ID);
    await eventBus.emitTaskEvent({
      taskId,
      type: "agent_ask",
      message: "等待补充计划所需材料",
      level: "warning",
      ask: {
        id: PLAN_ASK_ID,
        title: "等待补充计划所需材料",
        body: "请继续上传职责边界、对象清单、历史标准或频次规则。上传后点击启动/继续，Agent 会重新分析并给出执行计划。",
        inputKind: "attachment",
        required: true
      }
    });
  }

  private buildExecutionPlan(
    manifest: TaskManifest,
    boundaryMode: string,
    revisionNote?: string,
    planningSummary?: string
  ): string {
    const digest = this.tryReadDigest(manifest.task.id);
    const fileNames = manifest.files.map((file) => file.originalName).join("、") || "无附件";
    const responsibility = digest?.signals.responsibility.join("、") || "待确认";
    const objects = digest?.signals.objects.join("、") || "待确认";
    const standards = digest?.signals.standards.join("、") || "待确认";
    const gaps = this.askGaps(digest);
    const revision = revisionNote && revisionNote !== "revise_plan" && revisionNote !== "need_more_upload"
      ? `\n已收到的计划调整意见：${revisionNote}`
      : "";
    return [
      "我先不直接生成 Excel。下面是本轮分析计划，请确认后再进入执行。",
      "",
      `材料概况：${digest?.material_count ?? 0} 份材料；附件：${fileNames}`,
      `边界处理选择：${boundaryMode}`,
      `职责/专业信号：${responsibility}`,
      `对象类型信号：${objects}`,
      `标准/闭环信号：${standards}`,
      gaps.length ? `当前缺口：${gaps.join("；")}` : "当前缺口：未发现硬阻塞，但仍按 needs_review 输出候选版本。",
      revision,
      "",
      "执行计划：",
      "1. 先按职责/专业覆盖边界形成 L1 候选边界，不直接铺开巡检项。",
      "2. 再把对象类型整理成 L2/L3 骨架，并标记证据不足的节点。",
      "3. 使用 Kimi/LLM 抽取对象、风险、频次和待确认项。",
      "4. 用本地固定 workbook contract 展开 6 个 sheet。",
      "5. 渲染 Excel 后运行校验，失败则停止并暴露错误。",
      planningSummary ? `\nAgent 多轮分析摘要：\n${planningSummary.slice(0, 1600)}` : "",
      "",
      "执行模式：批准后生成可审阅 Excel；不确定项保持 needs_review，不写 confirmed。"
    ].filter(Boolean).join("\n");
  }

  private askGaps(digest: ReturnType<LocalPatrolRunner["tryReadDigest"]>): string[] {
    if (!digest) return ["未形成材料解析摘要"];
    const gaps = [];
    if (!digest.signals.responsibility.length) gaps.push("缺少责任部门/角色/外包边界信号");
    if (!digest.signals.objects.length) gaps.push("缺少设施设备/系统/区域对象信号");
    if (!digest.signals.standards.length) gaps.push("缺少标准依据/频次/风险/异常闭环信号");
    return gaps;
  }

  private hasSupplementAfter(manifest: TaskManifest, timestamp: string): boolean {
    return (
      manifest.files.some((file) => file.createdAt > timestamp) ||
      manifest.messages.some((message) => !message.askId && message.createdAt > timestamp)
    );
  }

  private async buildWorkbook(taskId: string, manifest: TaskManifest): Promise<void> {
    const workspace = taskWorkspaceDir(taskId);
    const outputs = taskOutputsDir(taskId);
    await fs.mkdir(workspace, { recursive: true });
    await fs.mkdir(outputs, { recursive: true });

    const casePath = path.join(workspace, "inspection-case.json");
    const workbookPath = path.join(outputs, "inspection-standard-workbook.xlsx");
    const validationPath = path.join(outputs, "validation.txt");
    const payload = await this.loadWorkbookPayload(taskId, manifest);
    await fs.writeFile(casePath, JSON.stringify(payload, null, 2), "utf8");

    const sandbox = new Sandbox(taskId);
    const render = await sandbox.runPython(["scripts/render_workbook.py", "--input", casePath, "--output", workbookPath]);
    await eventBus.emitTaskEvent({
      taskId,
      type: "tool_completed",
      tool: "render_workbook.py",
      message: `Workbook rendered via ${render.mode} sandbox.`,
      level: "success",
      data: { stdout: render.stdout, stderr: render.stderr, command: render.command }
    });

    const validate = await sandbox.runPython(["scripts/validate_workbook.py", workbookPath]);
    await fs.writeFile(validationPath, `${validate.stdout}\n${validate.stderr}`, "utf8");
    await eventBus.emitTaskEvent({
      taskId,
      type: "tool_completed",
      tool: "validate_workbook.py",
      message: `Workbook validation completed via ${validate.mode} sandbox.`,
      level: "success",
      data: { stdout: validate.stdout, stderr: validate.stderr, command: validate.command }
    });

    await this.registerArtifact(taskId, "巡检标准工作簿", "workbook", workbookPath);
    await this.registerArtifact(taskId, "工作簿校验报告", "validation", validationPath);
    await this.registerArtifact(taskId, "任务 Manifest", "manifest", path.join(workspace, "task-manifest.json"));
  }

  private async extractMaterials(taskId: string): Promise<void> {
    const workspace = taskWorkspaceDir(taskId);
    const manifestPath = path.join(workspace, "task-manifest.json");
    const digestPath = path.join(workspace, "source-digest.json");
    const sandbox = new Sandbox(taskId);
    await eventBus.emitTaskEvent({ taskId, type: "tool_started", tool: "extract_materials.py", message: "extract_materials.py started", level: "info" });
    const result = await sandbox.runPython(["scripts/extract_materials.py", "--manifest", manifestPath, "--output", digestPath]);
    await eventBus.emitTaskEvent({
      taskId,
      type: "tool_completed",
      tool: "extract_materials.py",
      message: `Source digest generated via ${result.mode} sandbox.`,
      level: "success",
      data: { stdout: result.stdout, stderr: result.stderr, command: result.command }
    });
    await this.registerArtifact(taskId, "材料解析摘要", "trace", digestPath);
  }

  private buildWorkbookPayload(manifest: TaskManifest): Record<string, unknown> {
    const fileNames = manifest.files.map((file) => file.originalName).join("、") || "用户文本输入";
    const digest = this.tryReadDigest(manifest.task.id);
    const signalSummary = digest
      ? `材料数 ${digest.material_count}；责任信号 ${digest.signals.responsibility.join("、") || "待确认"}；对象信号 ${digest.signals.objects.join("、") || "待确认"}`
      : "";
    const userText = manifest.messages
      .filter((message) => message.role === "user" && !message.askId)
      .map((message) => message.content)
      .join("；")
      .slice(0, 500);
    const source = [fileNames, userText, signalSummary].filter(Boolean).join("；");
    return {
      hierarchy_rows: [
        {
          "层级": "L0",
          "父节点": "",
          "节点名称": "本地巡检标准分析任务",
          "节点代号": "LOCAL",
          "节点类型": "行业/场景包",
          "覆盖对象": "用户上传材料",
          "设计理由": "基于本地任务材料形成第一版可审阅骨架",
          "纳入边界": "上传文本与附件中可识别的巡检对象",
          "排除边界": "未上传或未说明的第三方责任",
          "责任专业": "待确认",
          "参考依据": source,
          "确认状态": "needs_review"
        },
        {
          "层级": "L1",
          "父节点": "本地巡检标准分析任务",
          "节点名称": "设施设备巡检",
          "节点代号": "L1-FAC",
          "节点类型": "职责/专业覆盖边界",
          "覆盖对象": "设施、设备、系统运行状态",
          "设计理由": "巡检标准通常先按责任专业和对象域冻结边界",
          "纳入边界": "可由运维或专业人员定期检查的对象",
          "排除边界": "纯管理制度、一次性工程建设内容",
          "责任专业": "运维/设备专业",
          "参考依据": source,
          "确认状态": "needs_review"
        },
        {
          "层级": "L2",
          "父节点": "设施设备巡检",
          "节点名称": "通用设备状态",
          "节点代号": "L2-GEN",
          "节点类型": "对象类型第一层",
          "覆盖对象": "设备外观、运行、告警、环境",
          "设计理由": "作为缺少明确行业分类时的保守对象类型",
          "纳入边界": "可现场观察、记录和复核的设备状态",
          "排除边界": "深度检修、专项检测和改造设计",
          "责任专业": "运维/设备专业",
          "参考依据": source,
          "确认状态": "needs_review"
        }
      ],
      organization_rows: [
        {
          "部门/角色": "运维/设备专业",
          "职责边界": "负责设施设备日常巡检、异常记录和初步处置",
          "对应一级分类": "设施设备巡检",
          "对应二级类别": "通用设备状态",
          "巡检责任": "执行定期巡检并记录结果",
          "整改责任": "按异常等级发起整改或移交",
          "审核责任": "复核巡检记录和闭环状态",
          "来源": source
        }
      ],
      coverage_rows: [
        {
          "业务域": "巡检标准",
          "专业": "运维/设备专业",
          "对象域": "通用设备状态",
          "风险场景": "状态异常未及时发现",
          "对应L1": "设施设备巡检",
          "对应L2": "通用设备状态",
          "覆盖状态": "候选覆盖",
          "缺口说明": "需用户补充行业、责任部门和对象清单后冻结"
        }
      ],
      clarification_rows: [
        {
          "问题类型": "职责边界",
          "问题描述": "上传材料尚未完全确认各专业责任归口",
          "影响层级": "L1/L2",
          "当前假设": "由运维/设备专业先承担候选边界",
          "需要用户补充": "部门职责、外包边界、租户/第三方责任",
          "优先级": "高",
          "状态": "open"
        }
      ],
      reference_rows: [
        {
          "标准编号": "LOCAL-SOURCE",
          "标准名称": "用户上传材料",
          "关联系统": "本地 Pi 巡检标准 Agent",
          "关联系统/对象": fileNames,
          "来源URL": "",
          "说明": "第一版本地任务输入"
        }
      ],
      standard_rows: [
        {
          "一级分类": "设施设备巡检",
          "系统属性": "通用",
          "适用设备类别": "通用设备",
          "适用代号": "GEN",
          "巡检对象类型": "通用设备状态",
          "类别代号": "GEN-STATE",
          "一级系统": "待确认",
          "二级部位组": "设备本体",
          "三级关键部件/典型部位": "外观、运行状态、告警状态",
          "部件介绍描述": "用于第一版样例行，后续由用户材料确认",
          "四级巡检项-典型巡检项（看什么/查什么）": "检查设备外观、运行状态、告警信息和现场环境",
          "巡检维度": "状态/环境/安全",
          "巡检方式": "现场观察/系统核查",
          "巡检依据（标准）": "用户上传材料",
          "参考章节（编号）": "待确认",
          "推荐巡检频次（建议）": "每日/每班，待确认",
          "点位等级（1-3，1最高）": "2",
          "巡检执行部门": "运维/设备专业",
          "整改部门": "运维/设备专业",
          "所属区域": "待确认",
          "确认状态": "sample_only"
        }
      ]
    };
  }

  private async runLlmAnalysis(taskId: string, manifest: TaskManifest): Promise<void> {
    await eventBus.emitTaskEvent({ taskId, type: "tool_started", tool: "llm_analysis", message: "llm_analysis started", level: "info" });
    if (!hasLlmConfig()) {
      const message = "No LLM provider configured. Set OPENAI_API_KEY for real analysis or LLM_PROVIDER=mock for chain testing.";
      await eventBus.emitTaskEvent({ taskId, type: "tool_failed", tool: "llm_analysis", message, level: "warning" });
      if (process.env.LLM_REQUIRED === "true") {
        throw new Error(message);
      }
      await eventBus.emitTaskEvent({
        taskId,
        type: "tool_completed",
        tool: "inspection-standard-hierarchy-consultant",
        message: "Falling back to deterministic workbook skeleton because LLM is unavailable.",
        level: "warning"
      });
      return;
    }

    try {
      const result = await generateWorkbookCaseWithLlm(taskId, manifest);
      await eventBus.emitTaskEvent({
        taskId,
        type: "tool_completed",
        tool: "llm_analysis",
        message: `LLM generated workbook case via ${result.provider}/${result.model}.`,
        level: "success",
        data: { casePath: result.casePath, rawPath: result.rawPath }
      });
      await this.registerArtifact(taskId, "LLM 分析原始响应", "trace", result.rawPath);
      await this.registerArtifact(taskId, "LLM 工作簿结构 JSON", "trace", result.casePath);
    } catch (error) {
      const message = (error as Error).message;
      await eventBus.emitTaskEvent({ taskId, type: "tool_failed", tool: "llm_analysis", message, level: "error" });
      if (process.env.LLM_REQUIRED === "true") {
        throw error;
      }
      await eventBus.emitTaskEvent({
        taskId,
        type: "tool_completed",
        tool: "inspection-standard-hierarchy-consultant",
        message: "LLM failed; falling back to deterministic workbook skeleton.",
        level: "warning"
      });
    }
  }

  private async loadWorkbookPayload(taskId: string, manifest: TaskManifest): Promise<Record<string, unknown>> {
    const llmCasePath = path.join(taskWorkspaceDir(taskId), "llm-case.json");
    try {
      return JSON.parse(await fs.readFile(llmCasePath, "utf8")) as Record<string, unknown>;
    } catch {
      return this.buildWorkbookPayload(manifest);
    }
  }

  private async registerArtifact(taskId: string, label: string, kind: TaskArtifact["kind"], artifactPath: string): Promise<void> {
    const stat = await fs.stat(artifactPath);
    const existing = this.db
      .listArtifacts(taskId)
      .find((artifact) => artifact.label === label && artifact.path === artifactPath);
    if (existing) return;
    const artifact: TaskArtifact = {
      id: randomUUID(),
      taskId,
      label,
      kind,
      path: artifactPath,
      size: stat.size,
      createdAt: new Date().toISOString()
    };
    this.db.addArtifact(artifact);
    await eventBus.emitTaskEvent({
      taskId,
      type: "artifact_ready",
      message: `${label} ready`,
      level: "success",
      artifact
    });
  }

  private tryReadDigest(taskId: string): null | {
    material_count: number;
    signals: { responsibility: string[]; objects: string[]; standards: string[] };
  } {
    try {
      const digestPath = path.join(taskWorkspaceDir(taskId), "source-digest.json");
      const data = JSON.parse(readFileSync(digestPath, "utf8")) as {
        material_count: number;
        signals: { responsibility: string[]; objects: string[]; standards: string[] };
      };
      return data;
    } catch {
      return null;
    }
  }
}
