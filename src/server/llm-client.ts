import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { taskWorkspaceDir } from "./paths.js";
import type { TaskManifest } from "./types.js";

export interface LlmResult {
  provider: "openai" | "kimi-coding" | "mock";
  model: string;
  payload: Record<string, unknown>;
  rawPath: string;
  casePath: string;
}

export interface PlanningTraceResult {
  provider: "kimi-coding" | "mock" | "none";
  model: string;
  tracePath: string;
  summary: string;
  rounds: Array<{
    label: string;
    path: string;
  }>;
}

interface SourceDigest {
  material_count: number;
  materials: Array<{
    kind: string;
    name: string;
    status: string;
    text_preview: string;
  }>;
  signals: {
    responsibility: string[];
    objects: string[];
    standards: string[];
  };
}

const workbookSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "hierarchy_rows",
    "organization_rows",
    "coverage_rows",
    "clarification_rows",
    "reference_rows",
    "standard_rows"
  ],
  properties: {
    hierarchy_rows: { type: "array", items: { type: "object", additionalProperties: true } },
    organization_rows: { type: "array", items: { type: "object", additionalProperties: true } },
    coverage_rows: { type: "array", items: { type: "object", additionalProperties: true } },
    clarification_rows: { type: "array", items: { type: "object", additionalProperties: true } },
    reference_rows: { type: "array", items: { type: "object", additionalProperties: true } },
    standard_rows: { type: "array", items: { type: "object", additionalProperties: true } }
  }
};

export function hasLlmConfig(): boolean {
  return Boolean(process.env.OPENAI_API_KEY || process.env.KIMI_API_KEY || process.env.LLM_PROVIDER === "mock");
}

export async function generatePlanningTraceWithLlm(taskId: string, manifest: TaskManifest): Promise<PlanningTraceResult> {
  const workspace = taskWorkspaceDir(taskId);
  const digest = await readDigest(taskId);
  await fs.mkdir(workspace, { recursive: true });

  if (!process.env.KIMI_API_KEY || (process.env.LLM_PROVIDER && process.env.LLM_PROVIDER !== "kimi")) {
    return generateMockPlanningTrace(taskId, manifest, digest, process.env.LLM_PROVIDER === "mock" ? "mock" : "none");
  }

  const model = process.env.KIMI_MODEL ?? "kimi-for-coding";
  const baseInput = buildPlanningInput(manifest, digest);
  const roundSpecs = [
    {
      label: "材料证据扫描",
      file: "agent-planning-round-1-evidence.md",
      prompt: [
        "你是巡检标准 Agent 的材料检索与证据扫描子步骤。",
        "只基于输入材料，输出简洁 Markdown。",
        "请列出：1. 已读取材料；2. 明确证据；3. 弱证据；4. 需要追问的问题。",
        baseInput
      ].join("\n\n")
    },
    {
      label: "职责边界假设",
      file: "agent-planning-round-2-boundary.md",
      prompt: [
        "你是巡检标准 Agent 的职责/专业边界分析子步骤。",
        "只基于输入材料，输出简洁 Markdown。",
        "请给出候选职责边界、对象类型骨架、不能确认的边界，不要直接生成巡检项。",
        baseInput
      ].join("\n\n")
    },
    {
      label: "执行计划合成",
      file: "agent-planning-round-3-plan.md",
      prompt: [
        "你是巡检标准 Agent 的执行计划合成子步骤。",
        "只基于输入材料，输出可给用户确认的简洁 Markdown。",
        "计划必须说明：分析顺序、是否需要 ask、生成哪些产物、哪些内容保持 needs_review。",
        baseInput
      ].join("\n\n")
    }
  ];

  const rounds: PlanningTraceResult["rounds"] = [];
  const roundOutputs: string[] = [];
  for (const [index, spec] of roundSpecs.entries()) {
    const promptPath = path.join(workspace, `agent-planning-round-${index + 1}-prompt.md`);
    await fs.writeFile(promptPath, spec.prompt, "utf8");
    const { stdout, stderr } = await runPiCli(
      [
        "--provider",
        "kimi-coding",
        "--model",
        model,
        "--thinking",
        process.env.KIMI_THINKING ?? "off",
        "--no-session",
        "--no-tools",
        "--no-context-files",
        "--no-extensions",
        "--no-skills",
        "--no-prompt-templates",
        "--no-themes",
        "--system-prompt",
        "你是巡检标准分析 Agent 的一个中间分析步骤。不要生成最终 Excel，只输出当前步骤结论。",
        "--print",
        `@${promptPath}`
      ],
      {
        cwd: workspace,
        env: process.env,
        timeout: Number(process.env.KIMI_PLANNING_TIMEOUT_MS ?? 90_000),
        maxBuffer: 10 * 1024 * 1024
      }
    );
    const output = (stdout || stderr).trim();
    const outputPath = path.join(workspace, spec.file);
    await fs.writeFile(outputPath, output, "utf8");
    rounds.push({ label: spec.label, path: outputPath });
    roundOutputs.push(`## ${spec.label}\n\n${output}`);
  }

  const tracePath = path.join(workspace, "agent-planning-trace.md");
  const summary = roundOutputs.join("\n\n");
  await fs.writeFile(tracePath, summary, "utf8");
  return { provider: "kimi-coding", model, tracePath, summary, rounds };
}

export async function generateWorkbookCaseWithLlm(taskId: string, manifest: TaskManifest): Promise<LlmResult> {
  if (process.env.KIMI_API_KEY && (process.env.LLM_PROVIDER === "kimi" || !process.env.OPENAI_API_KEY)) {
    return generateKimiCodingResult(taskId, manifest);
  }
  const provider = process.env.LLM_PROVIDER === "mock" ? "mock" : "openai";
  if (provider === "mock") return generateMockResult(taskId, manifest);
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY is not configured; LLM analysis cannot run.");
  }

  const workspace = taskWorkspaceDir(taskId);
  const digest = await readDigest(taskId);
  const model = process.env.OPENAI_MODEL ?? "gpt-5.2";
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model,
      instructions: buildInstructions(),
      input: buildInput(manifest, digest),
      text: {
        format: {
          type: "json_schema",
          name: "patrol_workbook_case",
          strict: false,
          schema: workbookSchema
        }
      }
    })
  });

  if (!response.ok) {
    throw new Error(`OpenAI Responses API failed: ${response.status} ${await response.text()}`);
  }

  const raw = (await response.json()) as { output_text?: string; output?: unknown };
  const outputText = raw.output_text ?? extractOutputText(raw);
  if (!outputText) throw new Error("OpenAI response did not include output_text.");
  const parsed = JSON.parse(outputText) as Record<string, unknown>;
  const payload = normalizeWorkbookPayload(parsed, manifest, digest);
  const rawPath = path.join(workspace, "llm-analysis.json");
  const casePath = path.join(workspace, "llm-case.json");
  await fs.writeFile(rawPath, JSON.stringify(raw, null, 2), "utf8");
  await fs.writeFile(casePath, JSON.stringify(payload, null, 2), "utf8");
  return { provider: "openai", model, payload, rawPath, casePath };
}

async function generateKimiCodingResult(taskId: string, manifest: TaskManifest): Promise<LlmResult> {
  const workspace = taskWorkspaceDir(taskId);
  const digest = await readDigest(taskId);
  const model = process.env.KIMI_MODEL ?? "kimi-for-coding";
  const promptPath = path.join(workspace, "llm-prompt.md");
  const prompt = buildCompactKimiPrompt(manifest, digest);
  await fs.writeFile(promptPath, prompt, "utf8");
  const args = [
    "--provider",
    "kimi-coding",
    "--model",
    model,
    "--thinking",
    process.env.KIMI_THINKING ?? "off",
    "--no-session",
    "--no-tools",
    "--no-context-files",
    "--no-extensions",
    "--no-skills",
    "--no-prompt-templates",
    "--no-themes",
    "--system-prompt",
    "你是巡检标准分析器。只输出紧凑 JSON，不输出解释或 Markdown。",
    "--print",
    `@${promptPath}`
  ];
  const { stdout, stderr } = await runPiCli(args, {
    cwd: workspace,
    env: process.env,
    timeout: Number(process.env.KIMI_RUNNER_TIMEOUT_MS ?? 180_000),
    maxBuffer: 20 * 1024 * 1024
  });
  const compactPayload = JSON.parse(extractJson(stdout || stderr)) as Record<string, unknown>;
  const payload = normalizeWorkbookPayload(
    isWorkbookPayload(compactPayload)
      ? compactPayload
      : compactAnalysisToWorkbookPayload(compactPayload, manifest, digest),
    manifest,
    digest
  );
  const rawPath = path.join(workspace, "llm-analysis.json");
  const casePath = path.join(workspace, "llm-case.json");
  await fs.writeFile(
    rawPath,
    JSON.stringify({ provider: "kimi-coding", model, promptPath, compactPayload, stdout, stderr }, null, 2),
    "utf8"
  );
  await fs.writeFile(casePath, JSON.stringify(payload, null, 2), "utf8");
  return { provider: "kimi-coding", model, payload, rawPath, casePath };
}

function runPiCli(
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; timeout: number; maxBuffer: number }
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn("npx", ["pi", ...args], {
      cwd: options.cwd,
      env: options.env,
      stdio: ["pipe", "pipe", "pipe"]
    });
    child.stdin.end();

    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutSize = 0;
    let stderrSize = 0;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, options.timeout);

    child.stdout.on("data", (chunk: Buffer) => {
      stdoutSize += chunk.length;
      if (stdoutSize > options.maxBuffer) {
        child.kill("SIGTERM");
        reject(new Error("Pi CLI stdout exceeded maxBuffer."));
        return;
      }
      stdout.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrSize += chunk.length;
      if (stderrSize > options.maxBuffer) {
        child.kill("SIGTERM");
        reject(new Error("Pi CLI stderr exceeded maxBuffer."));
        return;
      }
      stderr.push(chunk);
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      const out = Buffer.concat(stdout).toString("utf8");
      const err = Buffer.concat(stderr).toString("utf8");
      if (code === 0) {
        resolve({ stdout: out, stderr: err });
        return;
      }
      const reason = timedOut ? `timed out after ${options.timeout}ms` : `exited with code ${code ?? "null"}`;
      reject(new Error(`Pi CLI ${reason}${signal ? ` (${signal})` : ""}.\nstdout:\n${out}\nstderr:\n${err}`));
    });
  });
}

function buildCompactKimiPrompt(manifest: TaskManifest, digest: SourceDigest): string {
  const userMaterials = digest.materials
    .filter((material) => material.status === "extracted")
    .map((material) => material.text_preview)
    .join("\n")
    .slice(0, 4000);
  return [
    "从材料抽取巡检标准分析信号，只输出 JSON。",
    "字段固定为 departments, object_types, inspection_items, risks, frequency, assumptions, clarification_questions。",
    "每个数组最多 6 项，数组元素必须是短中文短语。",
    "优先识别职责/专业覆盖边界，其次识别对象类型，最后识别标准项。",
    "证据不足的内容放入 assumptions 或 clarification_questions。",
    "",
    `任务标题：${manifest.task.title}`,
    `附件数量：${manifest.files.length}`,
    `材料：${userMaterials || buildInput(manifest, digest)}`
  ].join("\n");
}

function buildPlanningInput(manifest: TaskManifest, digest: SourceDigest): string {
  return JSON.stringify(
    {
      task: {
        id: manifest.task.id,
        title: manifest.task.title,
        status: manifest.task.status
      },
      files: manifest.files.map((file) => ({
        originalName: file.originalName,
        mimeType: file.mimeType,
        size: file.size
      })),
      user_messages: manifest.messages
        .filter((message) => message.role === "user" && !message.askId)
        .map((message) => message.content),
      source_digest: digest
    },
    null,
    2
  );
}

async function generateMockPlanningTrace(
  taskId: string,
  manifest: TaskManifest,
  digest: SourceDigest,
  provider: "mock" | "none"
): Promise<PlanningTraceResult> {
  const workspace = taskWorkspaceDir(taskId);
  const source = digest.materials.map((material) => material.text_preview).join("；").slice(0, 800);
  const sections = [
    {
      label: "材料证据扫描",
      text: [
        `已读取 ${digest.material_count} 份材料，附件 ${manifest.files.length} 个。`,
        `责任信号：${digest.signals.responsibility.join("、") || "待确认"}`,
        `对象信号：${digest.signals.objects.join("、") || "待确认"}`,
        `标准信号：${digest.signals.standards.join("、") || "待确认"}`
      ].join("\n")
    },
    {
      label: "职责边界假设",
      text: [
        "先按职责/专业覆盖边界形成候选 L1，不直接铺开巡检项。",
        `当前证据摘要：${source || "无可用摘要"}`,
        "证据不足的职责、对象和频次保持 needs_review。"
      ].join("\n")
    },
    {
      label: "执行计划合成",
      text: [
        "执行顺序：材料复核 -> 职责边界 -> 对象骨架 -> LLM 抽取 -> Excel 渲染 -> 校验。",
        "如用户不批准计划，不进入 Excel 生成。"
      ].join("\n")
    }
  ];
  const rounds: PlanningTraceResult["rounds"] = [];
  const body: string[] = [];
  for (const [index, section] of sections.entries()) {
    const roundPath = path.join(workspace, `agent-planning-round-${index + 1}-mock.md`);
    await fs.writeFile(roundPath, section.text, "utf8");
    rounds.push({ label: section.label, path: roundPath });
    body.push(`## ${section.label}\n\n${section.text}`);
  }
  const tracePath = path.join(workspace, "agent-planning-trace.md");
  const summary = body.join("\n\n");
  await fs.writeFile(tracePath, summary, "utf8");
  return { provider, model: provider, tracePath, summary, rounds };
}

function isWorkbookPayload(payload: Record<string, unknown>): boolean {
  return [
    "hierarchy_rows",
    "organization_rows",
    "coverage_rows",
    "clarification_rows",
    "reference_rows",
    "standard_rows"
  ].every((key) => Array.isArray(payload[key]));
}

function normalizeWorkbookPayload(
  payload: Record<string, unknown>,
  manifest: TaskManifest,
  digest: SourceDigest
): Record<string, unknown> {
  if (!isWorkbookPayload(payload)) {
    return compactAnalysisToWorkbookPayload(payload, manifest, digest);
  }
  if (hasContractHierarchy(payload) && hasContractRows(payload.standard_rows, ["一级分类", "巡检对象类型"])) {
    return payload;
  }
  return repairWorkbookPayload(payload, manifest, digest);
}

function hasContractHierarchy(payload: Record<string, unknown>): boolean {
  const rows = toRows(payload.hierarchy_rows);
  return rows.some((row) => textFrom(row, ["层级"]) === "L1" && textFrom(row, ["节点名称"]));
}

function hasContractRows(value: unknown, requiredKeys: string[]): boolean {
  return toRows(value).some((row) => requiredKeys.every((key) => textFrom(row, [key])));
}

function repairWorkbookPayload(
  payload: Record<string, unknown>,
  manifest: TaskManifest,
  digest: SourceDigest
): Record<string, unknown> {
  const hierarchyInput = toRows(payload.hierarchy_rows);
  const organizationInput = toRows(payload.organization_rows);
  const coverageInput = toRows(payload.coverage_rows);
  const clarificationInput = toRows(payload.clarification_rows);
  const referenceInput = toRows(payload.reference_rows);
  const standardInput = toRows(payload.standard_rows);
  const rootName = manifest.task.title || "巡检标准分析任务";
  const source = digest.materials.map((material) => `${material.name}: ${material.text_preview}`).join("；").slice(0, 520);
  const categories = uniqueText([
    ...hierarchyInput.map((row) => textFrom(row, ["一级分类", "节点名称", "专业", "专业/区域"])),
    ...standardInput.map((row) => textFrom(row, ["一级分类", "专业"])),
    ...coverageInput.map((row) => textFrom(row, ["对应L1", "专业", "专业/区域"]))
  ]).slice(0, 8);
  const l1Names = categories.length ? categories : ["综合巡检"];

  const hierarchyRows = [
    {
      "层级": "L0",
      "父节点": "",
      "节点名称": rootName,
      "节点代号": "ROOT",
      "节点类型": "行业/场景包",
      "覆盖对象": l1Names.join("、"),
      "设计理由": "由真实模型输出经工作簿契约归一化后形成",
      "纳入边界": "用户材料中可识别的巡检职责、系统和对象",
      "排除边界": "材料未提供证据的专项检测、工程改造和第三方责任",
      "责任专业": l1Names.join("、"),
      "参考依据": source,
      "确认状态": "needs_review"
    },
    ...l1Names.map((name, index) => ({
      "层级": "L1",
      "父节点": rootName,
      "节点名称": name,
      "节点代号": `L1-${index + 1}`,
      "节点类型": "职责/专业覆盖边界",
      "覆盖对象": relatedCoverage(hierarchyInput, name) || name,
      "设计理由": "模型从材料中识别出的一级专业/职责边界",
      "纳入边界": relatedCoverage(hierarchyInput, name) || "日常巡检、异常记录和整改闭环",
      "排除边界": "未在材料中明确的专项检测、深度检修和改造设计",
      "责任专业": name,
      "参考依据": relatedSource(hierarchyInput, name) || source,
      "确认状态": "needs_review"
    })),
    ...normalizeL2Rows(hierarchyInput, l1Names, source)
  ];

  const organizationRows = (organizationInput.length ? organizationInput : [{ "部门/角色": "待确认责任部门" }]).map((row) => ({
    "部门/角色": textFrom(row, ["部门/角色", "角色", "部门"]) || "待确认责任部门",
    "职责边界": textFrom(row, ["职责边界", "职责", "责任"]) || "负责巡检执行、异常记录、整改跟踪和审核闭环",
    "对应一级分类": textFrom(row, ["对应一级分类"]) || "全部",
    "对应二级类别": textFrom(row, ["对应二级类别", "覆盖设备/点位", "覆盖对象"]) || "",
    "巡检责任": textFrom(row, ["巡检责任"]) || "执行巡检并记录结果",
    "整改责任": textFrom(row, ["整改责任"]) || "对异常发起整改或移交",
    "审核责任": textFrom(row, ["审核责任"]) || "复核记录完整性和闭环状态",
    "来源": textFrom(row, ["来源", "依据", "来源/备注"]) || source
  }));

  const coverageRows = l1Names.map((name, index) => {
    const row = coverageInput[index] ?? {};
    const l2Name = hierarchyRows.find((item) => item["层级"] === "L2" && item["父节点"] === name)?.["节点名称"] ?? "";
    return {
      "业务域": "巡检标准",
      "专业": textFrom(row, ["专业", "专业/区域"]) || name,
      "对象域": textFrom(row, ["对象域", "覆盖设备/点位"]) || relatedCoverage(hierarchyInput, name) || name,
      "风险场景": textFrom(row, ["风险场景"]) || "异常未及时发现或未闭环",
      "对应L1": name,
      "对应L2": l2Name,
      "覆盖状态": textFrom(row, ["覆盖状态", "确认状态", "状态"]) || "候选覆盖",
      "缺口说明": textFrom(row, ["缺口说明", "计划变更", "建议动作"]) || "需补充责任边界、频次阈值和验收口径"
    };
  });

  const clarificationRows = (clarificationInput.length ? clarificationInput : [{ "问题类型": "材料缺口" }]).map((row) => ({
    "问题类型": textFrom(row, ["问题类型", "待确认项"]) || "待确认项",
    "问题描述": textFrom(row, ["问题描述", "描述", "说明", "问题说明"]) || "需确认材料中未明确的边界、标准或责任",
    "影响层级": textFrom(row, ["影响层级", "影响范围"]) || "L1/L2/标准清单",
    "当前假设": textFrom(row, ["当前假设"]) || "按模型识别结果生成 needs_review 候选版本",
    "需要用户补充": textFrom(row, ["需要用户补充", "建议动作", "建议确认人", "说明"]) || "补充责任部门、标准依据、频次和异常闭环口径",
    "优先级": textFrom(row, ["优先级"]) || "高",
    "状态": confirmationState(textFrom(row, ["状态", "确认状态"])) || "open"
  }));

  const referenceRows = (referenceInput.length ? referenceInput : [{ "标准名称": "用户上传材料" }]).map((row, index) => ({
    "标准编号": textFrom(row, ["标准编号"]) || `SOURCE-${index + 1}`,
    "标准名称": textFrom(row, ["标准名称", "依据名称", "依据", "来源/备注"]) || "用户上传材料",
    "关联系统": textFrom(row, ["关联系统"]) || "本地 Pi 巡检标准 Agent",
    "关联系统/对象": textFrom(row, ["关联系统/对象", "覆盖对象"]) || l1Names.join("、"),
    "来源URL": textFrom(row, ["来源URL"]) || "",
    "说明": textFrom(row, ["说明", "描述", "状态"]) || source
  }));

  const standardRows = (standardInput.length ? standardInput : l1Names.map((name) => ({ "专业": name }))).map((row, index) => {
    const category = textFrom(row, ["一级分类", "专业"]) || l1Names[index % l1Names.length] || "综合巡检";
    const item = textFrom(row, ["四级巡检项-典型巡检项（看什么/查什么）", "巡检项"]) || "检查运行状态、现场环境、异常告警和闭环记录";
    return {
      "一级分类": category,
      "系统属性": textFrom(row, ["系统属性"]) || "商业综合体",
      "适用设备类别": textFrom(row, ["适用设备类别", "巡检对象类型", "二级部位组", "系统"]) || category,
      "适用代号": textFrom(row, ["适用代号"]) || `OBJ-${index + 1}`,
      "巡检对象类型": textFrom(row, ["巡检对象类型", "适用设备类别"]) || category,
      "类别代号": textFrom(row, ["类别代号"]) || `STD-${index + 1}`,
      "一级系统": textFrom(row, ["一级系统", "系统"]) || category,
      "二级部位组": textFrom(row, ["二级部位组"]) || category,
      "三级关键部件/典型部位": textFrom(row, ["三级关键部件/典型部位"]) || textFrom(row, ["巡检项"]) || category,
      "部件介绍描述": textFrom(row, ["部件介绍描述", "检查标准/依据", "标准要求"]) || `材料识别出的${category}巡检对象`,
      "四级巡检项-典型巡检项（看什么/查什么）": item,
      "巡检维度": textFrom(row, ["巡检维度"]) || "状态/安全/闭环",
      "巡检方式": textFrom(row, ["巡检方式"]) || "现场观察/系统核查/记录复核",
      "巡检依据（标准）": textFrom(row, ["巡检依据（标准）", "检查标准/依据", "标准要求"]) || "用户上传材料",
      "参考章节（编号）": textFrom(row, ["参考章节（编号）"]) || "待确认",
      "推荐巡检频次（建议）": textFrom(row, ["推荐巡检频次（建议）", "频次"]) || "待确认",
      "点位等级（1-3，1最高）": textFrom(row, ["点位等级（1-3，1最高）"]) || "2",
      "巡检执行部门": textFrom(row, ["巡检执行部门", "责任人"]) || "待确认责任部门",
      "整改部门": textFrom(row, ["整改部门", "责任人"]) || "待确认责任部门",
      "所属区域": textFrom(row, ["所属区域"]) || "商业综合体",
      "确认状态": confirmationState(textFrom(row, ["确认状态", "状态", "status", "备注"])) || "needs_review"
    };
  });

  return {
    hierarchy_rows: hierarchyRows,
    organization_rows: organizationRows,
    coverage_rows: coverageRows,
    clarification_rows: clarificationRows,
    reference_rows: referenceRows,
    standard_rows: standardRows
  };
}

function normalizeL2Rows(rows: Record<string, unknown>[], l1Names: string[], source: string): Record<string, string>[] {
  const output: Record<string, string>[] = [];
  for (const [index, row] of rows.entries()) {
    const parent = textFrom(row, ["一级分类", "父节点"]) || l1Names[index % l1Names.length] || "综合巡检";
    const name = [textFrom(row, ["二级分类"]), textFrom(row, ["三级分类"])].filter(Boolean).join("/") ||
      textFrom(row, ["节点名称", "覆盖设备/点位", "覆盖边界"]) ||
      `${parent}对象`;
    output.push({
      "层级": "L2",
      "父节点": parent,
      "节点名称": name,
      "节点代号": `L2-${index + 1}`,
      "节点类型": "对象类型骨架",
      "覆盖对象": textFrom(row, ["覆盖对象", "覆盖设备/点位", "覆盖边界"]) || name,
      "设计理由": "模型从材料中识别出的二级对象/部位边界",
      "纳入边界": textFrom(row, ["纳入边界", "覆盖边界"]) || name,
      "排除边界": textFrom(row, ["排除边界"]) || "未提供证据的专项检测和工程改造",
      "责任专业": parent,
      "参考依据": textFrom(row, ["参考依据", "来源/备注", "来源"]) || source,
      "确认状态": confirmationState(textFrom(row, ["确认状态", "状态"])) || "needs_review"
    });
  }
  return output;
}

function toRows(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item));
}

function textFrom(row: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = row[key];
    if (value === null || value === undefined) continue;
    const text = String(value).replace(/\s+/g, " ").trim();
    if (text) return text;
  }
  return "";
}

function uniqueText(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function relatedCoverage(rows: Record<string, unknown>[], category: string): string {
  return rows
    .filter((row) => textFrom(row, ["一级分类", "节点名称", "专业"]).includes(category))
    .map((row) => textFrom(row, ["覆盖边界", "覆盖对象", "覆盖设备/点位"]))
    .filter(Boolean)
    .slice(0, 3)
    .join("、");
}

function relatedSource(rows: Record<string, unknown>[], category: string): string {
  return rows
    .filter((row) => textFrom(row, ["一级分类", "节点名称", "专业"]).includes(category))
    .map((row) => textFrom(row, ["来源/备注", "来源", "参考依据"]))
    .filter(Boolean)
    .slice(0, 3)
    .join("、");
}

function confirmationState(value: string): string {
  if (["confirmed", "seeded", "assumed", "needs_review", "sample_only"].includes(value)) return value;
  if (value.includes("assumed")) return "assumed";
  if (value.includes("sample_only")) return "sample_only";
  if (value.includes("confirmed")) return "confirmed";
  if (value.includes("seeded")) return "seeded";
  if (value.includes("needs_review")) return "needs_review";
  return "";
}

function compactAnalysisToWorkbookPayload(
  compact: Record<string, unknown>,
  manifest: TaskManifest,
  digest: SourceDigest
): Record<string, unknown> {
  const departments = toTextArray(compact.departments).slice(0, 6);
  const objects = toTextArray(compact.object_types).slice(0, 8);
  const items = toTextArray(compact.inspection_items).slice(0, 12);
  const risks = toTextArray(compact.risks).slice(0, 8);
  const frequency = toTextArray(compact.frequency).slice(0, 4);
  const assumptions = toTextArray(compact.assumptions).slice(0, 8);
  const questions = toTextArray(compact.clarification_questions).slice(0, 8);

  const source = [
    `Kimi 分析：${JSON.stringify(compact)}`,
    digest.materials.map((material) => material.text_preview).join("；")
  ]
    .filter(Boolean)
    .join("；")
    .slice(0, 1200);
  const primaryDepartment = departments[0] ?? digest.signals.responsibility[0] ?? "待确认责任部门";
  const primaryObject = objects[0] ?? digest.signals.objects[0] ?? "待确认对象";
  const primaryFrequency = frequency[0] ?? "待确认";
  const objectRows = objects.length ? objects : [primaryObject];
  const riskSummary = risks.join("、") || "异常未识别或未闭环";

  return {
    hierarchy_rows: [
      {
        "层级": "L0",
        "父节点": "",
        "节点名称": manifest.task.title || "Kimi巡检标准分析任务",
        "节点代号": "KIMI",
        "节点类型": "行业/场景包",
        "覆盖对象": objectRows.join("、"),
        "设计理由": "由 Kimi 先抽取职责、对象、风险和频次信号，再按固定工作簿契约展开",
        "纳入边界": departments.length ? departments.join("、") : "用户材料中可识别的职责边界",
        "排除边界": "未提供证据的专项检测、工程改造和第三方责任",
        "责任专业": departments.join("、") || primaryDepartment,
        "参考依据": source,
        "确认状态": "needs_review"
      },
      ...departments.map((department, index) => ({
        "层级": "L1",
        "父节点": manifest.task.title || "Kimi巡检标准分析任务",
        "节点名称": department,
        "节点代号": `L1-${index + 1}`,
        "节点类型": "职责/专业覆盖边界",
        "覆盖对象": objectRows.join("、"),
        "设计理由": "Kimi 从材料中识别出的责任主体",
        "纳入边界": "日常巡检、异常记录、整改和审核闭环",
        "排除边界": "未在材料中明确归口的专业事项",
        "责任专业": department,
        "参考依据": source,
        "确认状态": "needs_review"
      })),
      ...objectRows.map((objectName, index) => ({
        "层级": "L2",
        "父节点": departments[index % Math.max(departments.length, 1)] ?? primaryDepartment,
        "节点名称": objectName,
        "节点代号": `L2-${index + 1}`,
        "节点类型": "对象类型骨架",
        "覆盖对象": objectName,
        "设计理由": "Kimi 从材料中识别出的巡检对象类型",
        "纳入边界": matchingItems(items, objectName).join("、") || "状态、环境、告警和闭环检查",
        "排除边界": "深度检修、专项试验和设计变更",
        "责任专业": departments[index % Math.max(departments.length, 1)] ?? primaryDepartment,
        "参考依据": source,
        "确认状态": "needs_review"
      }))
    ],
    organization_rows: (departments.length ? departments : [primaryDepartment]).map((department, index) => ({
      "部门/角色": department,
      "职责边界": `负责${objectRows.filter((_, objectIndex) => objectIndex % Math.max(departments.length, 1) === index).join("、") || primaryObject}的日常巡检、异常记录和闭环跟踪`,
      "对应一级分类": department,
      "对应二级类别": objectRows.join("、"),
      "巡检责任": "执行巡检并记录结果",
      "整改责任": "对异常发起整改或移交",
      "审核责任": "复核整改闭环和记录完整性",
      "来源": source
    })),
    coverage_rows: objectRows.map((objectName, index) => ({
      "业务域": "巡检标准",
      "专业": departments[index % Math.max(departments.length, 1)] ?? primaryDepartment,
      "对象域": objectName,
      "风险场景": risks[index % Math.max(risks.length, 1)] ?? riskSummary,
      "对应L1": departments[index % Math.max(departments.length, 1)] ?? primaryDepartment,
      "对应L2": objectName,
      "覆盖状态": "候选覆盖",
      "缺口说明": assumptions[index % Math.max(assumptions.length, 1)] ?? "需补充阈值、责任时限和验收口径"
    })),
    clarification_rows: (questions.length ? questions : ["请确认责任部门、频次阈值、异常分级和整改时限。"]).map((question) => ({
      "问题类型": "待确认项",
      "问题描述": question,
      "影响层级": "L1/L2/标准清单",
      "当前假设": assumptions.join("；") || "按材料候选边界先生成 needs_review 版本",
      "需要用户补充": question,
      "优先级": "高",
      "状态": "open"
    })),
    reference_rows: [
      {
        "标准编号": "KIMI-SOURCE",
        "标准名称": "Kimi For Coding 巡检标准分析结果",
        "关联系统": "本地 Pi 巡检标准 Agent",
        "关联系统/对象": manifest.task.id,
        "来源URL": "",
        "说明": source
      }
    ],
    standard_rows: objectRows.map((objectName, index) => ({
      "一级分类": departments[index % Math.max(departments.length, 1)] ?? primaryDepartment,
      "系统属性": "产业园",
      "适用设备类别": objectName,
      "适用代号": `OBJ-${index + 1}`,
      "巡检对象类型": objectName,
      "类别代号": `KIMI-${index + 1}`,
      "一级系统": departments[index % Math.max(departments.length, 1)] ?? primaryDepartment,
      "二级部位组": objectName,
      "三级关键部件/典型部位": objectName,
      "部件介绍描述": `由 Kimi 从材料中识别的巡检对象：${objectName}`,
      "四级巡检项-典型巡检项（看什么/查什么）": matchingItems(items, objectName).join("；") || items[index % Math.max(items.length, 1)] || "检查状态、环境、告警和闭环记录",
      "巡检维度": "状态/安全/闭环",
      "巡检方式": "现场观察/系统核查/记录复核",
      "巡检依据（标准）": "用户上传材料 + Kimi 分析",
      "参考章节（编号）": "待确认",
      "推荐巡检频次（建议）": primaryFrequency,
      "点位等级（1-3，1最高）": index < 2 ? "1" : "2",
      "巡检执行部门": departments[index % Math.max(departments.length, 1)] ?? primaryDepartment,
      "整改部门": departments[index % Math.max(departments.length, 1)] ?? primaryDepartment,
      "所属区域": "产业园",
      "确认状态": "needs_review"
    }))
  };
}

function toTextArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => (typeof item === "string" ? item.trim() : ""))
    .filter((item) => item.length > 0);
}

function matchingItems(items: string[], objectName: string): string[] {
  const matched = items.filter((item) => item.includes(objectName) || objectName.includes(item));
  return matched.length ? matched : items.slice(0, 3);
}

async function generateMockResult(taskId: string, manifest: TaskManifest): Promise<LlmResult> {
  const workspace = taskWorkspaceDir(taskId);
  const digest = await readDigest(taskId);
  const source = digest.materials.map((material) => material.text_preview).join("；").slice(0, 800);
  const payload = {
    hierarchy_rows: [
      {
        "层级": "L0",
        "父节点": "",
        "节点名称": "LLM模拟巡检标准任务",
        "节点代号": "LLM-MOCK",
        "节点类型": "行业/场景包",
        "覆盖对象": "用户材料",
        "设计理由": "用于验证 LLM case JSON 接入链路",
        "纳入边界": "材料中识别到的对象和职责线索",
        "排除边界": "未提供证据的边界",
        "责任专业": "待确认",
        "参考依据": source,
        "确认状态": "needs_review"
      },
      {
        "层级": "L1",
        "父节点": "LLM模拟巡检标准任务",
        "节点名称": "综合巡检",
        "节点代号": "L1-LLM",
        "节点类型": "职责/专业覆盖边界",
        "覆盖对象": digest.signals.objects.join("、") || "待确认对象",
        "设计理由": "由 LLM 模拟链路按材料信号生成",
        "纳入边界": "日常巡检与异常发现",
        "排除边界": "专项检修和工程改造",
        "责任专业": digest.signals.responsibility.join("、") || "待确认",
        "参考依据": source,
        "确认状态": "needs_review"
      }
    ],
    organization_rows: [
      {
        "部门/角色": digest.signals.responsibility.join("、") || "待确认角色",
        "职责边界": "负责巡检执行、异常记录和闭环跟踪",
        "对应一级分类": "综合巡检",
        "对应二级类别": "",
        "巡检责任": "执行巡检",
        "整改责任": "按异常闭环整改",
        "审核责任": "复核记录",
        "来源": source
      }
    ],
    coverage_rows: [
      {
        "业务域": "巡检标准",
        "专业": digest.signals.responsibility.join("、") || "待确认",
        "对象域": digest.signals.objects.join("、") || "待确认",
        "风险场景": "异常未识别或未闭环",
        "对应L1": "综合巡检",
        "对应L2": "",
        "覆盖状态": "候选覆盖",
        "缺口说明": "mock 模式仅验证链路，真实模型输出后需复核"
      }
    ],
    clarification_rows: [
      {
        "问题类型": "模型验证",
        "问题描述": "当前为 LLM mock 输出，不代表真实分析质量",
        "影响层级": "全局",
        "当前假设": "链路可运行",
        "需要用户补充": "配置 OPENAI_API_KEY 后运行真实模型",
        "优先级": "高",
        "状态": "open"
      }
    ],
    reference_rows: [
      {
        "标准编号": "LLM-MOCK",
        "标准名称": "LLM mock source digest",
        "关联系统": "本地 Pi 巡检标准 Agent",
        "关联系统/对象": manifest.task.id,
        "来源URL": "",
        "说明": "用于自动化测试"
      }
    ],
    standard_rows: [
      {
        "一级分类": "综合巡检",
        "系统属性": "通用",
        "适用设备类别": digest.signals.objects.join("、") || "待确认对象",
        "适用代号": "LLM",
        "巡检对象类型": "综合对象",
        "类别代号": "LLM-GEN",
        "一级系统": "待确认",
        "二级部位组": "待确认",
        "三级关键部件/典型部位": "待确认",
        "部件介绍描述": "LLM mock 样例行",
        "四级巡检项-典型巡检项（看什么/查什么）": "根据材料摘要检查对象状态、异常和闭环",
        "巡检维度": "状态/责任/闭环",
        "巡检方式": "现场/系统",
        "巡检依据（标准）": "用户材料",
        "参考章节（编号）": "待确认",
        "推荐巡检频次（建议）": "待确认",
        "点位等级（1-3，1最高）": "2",
        "巡检执行部门": digest.signals.responsibility.join("、") || "待确认",
        "整改部门": digest.signals.responsibility.join("、") || "待确认",
        "所属区域": "待确认",
        "确认状态": "sample_only"
      }
    ]
  };
  const rawPath = path.join(workspace, "llm-analysis.json");
  const casePath = path.join(workspace, "llm-case.json");
  await fs.writeFile(rawPath, JSON.stringify({ provider: "mock", payload }, null, 2), "utf8");
  await fs.writeFile(casePath, JSON.stringify(payload, null, 2), "utf8");
  return { provider: "mock", model: "mock", payload, rawPath, casePath };
}

async function readDigest(taskId: string): Promise<SourceDigest> {
  const digestPath = path.join(taskWorkspaceDir(taskId), "source-digest.json");
  return JSON.parse(await fs.readFile(digestPath, "utf8")) as SourceDigest;
}

function buildInstructions(): string {
  return [
    "你是私有化巡检标准分析 Agent。",
    "必须按职责/专业覆盖边界优先设计巡检标准，而不是直接罗列巡检项。",
    "输出必须是 render_workbook.py 可消费的 JSON。",
    "字段名必须使用 workbook contract 中的中文表头。",
    "证据不足时使用 needs_review、assumed 或 sample_only，不能静默 confirmed。",
    "如果材料不足，仍输出可审阅的小骨架，并把缺口写入 待确认项。"
  ].join("\n");
}

function buildInput(manifest: TaskManifest, digest: SourceDigest): string {
  return JSON.stringify(
    {
      task: manifest.task,
      messages: manifest.messages,
      files: manifest.files.map((file) => ({
        originalName: file.originalName,
        mimeType: file.mimeType,
        size: file.size
      })),
      source_digest: digest
    },
    null,
    2
  );
}

function extractOutputText(raw: { output?: unknown }): string {
  const output = Array.isArray(raw.output) ? raw.output : [];
  const chunks: string[] = [];
  for (const item of output) {
    if (!item || typeof item !== "object") continue;
    const content = (item as { content?: unknown }).content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (!part || typeof part !== "object") continue;
      const text = (part as { text?: unknown }).text;
      if (typeof text === "string") chunks.push(text);
    }
  }
  return chunks.join("");
}

function extractJson(text: string): string {
  const trimmed = text.trim();
  if (trimmed.startsWith("{")) return trimmed;
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) return fenced[1].trim();
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) return trimmed.slice(start, end + 1);
  throw new Error("LLM output did not contain a JSON object.");
}
