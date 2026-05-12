import fs from "node:fs/promises";
import path from "node:path";
import { taskWorkspaceDir } from "./paths.js";
import type { TaskManifest } from "./types.js";

export interface LlmResult {
  provider: "openai" | "mock";
  model: string;
  payload: Record<string, unknown>;
  rawPath: string;
  casePath: string;
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
  return Boolean(process.env.OPENAI_API_KEY || process.env.LLM_PROVIDER === "mock");
}

export async function generateWorkbookCaseWithLlm(taskId: string, manifest: TaskManifest): Promise<LlmResult> {
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
  const payload = JSON.parse(outputText) as Record<string, unknown>;
  const rawPath = path.join(workspace, "llm-analysis.json");
  const casePath = path.join(workspace, "llm-case.json");
  await fs.writeFile(rawPath, JSON.stringify(raw, null, 2), "utf8");
  await fs.writeFile(casePath, JSON.stringify(payload, null, 2), "utf8");
  return { provider: "openai", model, payload, rawPath, casePath };
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
