import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

const OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses";
const OPENROUTER_CHAT_COMPLETIONS_URL = "https://openrouter.ai/api/v1/chat/completions";

export interface OpenRouterBridgeOptions {
  runDir: string;
  apiKey: string;
  model: string;
  appTitle?: string;
  siteUrl?: string;
}

interface ResponsesRequestBody {
  model?: string;
  instructions?: string;
  input?: unknown;
  text?: {
    format?: {
      schema?: unknown;
    };
  };
}

export function installOpenRouterFetchBridge(options: OpenRouterBridgeOptions): void {
  const nativeFetch = globalThis.fetch.bind(globalThis);
  let callIndex = 0;

  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = requestUrl(input);
    if (url !== OPENAI_RESPONSES_URL) {
      return nativeFetch(input, init);
    }

    callIndex += 1;
    const requestBody = parseBody(init?.body);
    const openRouterBody = {
      model: options.model,
      messages: [
        {
          role: "system",
          content: [
            "You are adapting an OpenAI Responses JSON-schema request for a patrol-standard workbook harness.",
            "Return only one JSON object. Do not include Markdown fences or commentary.",
            "The object must include these array fields: hierarchy_rows, organization_rows, coverage_rows, clarification_rows, reference_rows, standard_rows.",
            "Use the Chinese workbook contract headers that appear in the input schema and examples."
          ].join("\n")
        },
        {
          role: "user",
          content: buildPrompt(requestBody)
        }
      ],
      temperature: Number(process.env.OPENROUTER_TEMPERATURE ?? 0),
      response_format: { type: "json_object" },
      max_tokens: Number(process.env.OPENROUTER_MAX_TOKENS ?? 5000)
    };

    let response: Response;
    try {
      response = await nativeFetch(OPENROUTER_CHAT_COMPLETIONS_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${options.apiKey}`,
          "Content-Type": "application/json",
          "HTTP-Referer": options.siteUrl ?? "https://local.patrol-stand-agent",
          "X-Title": options.appTitle ?? "Patrol Stand Agent Harness"
        },
        body: JSON.stringify(openRouterBody)
      });
    } catch (error) {
      await writeBridgeTrace(options.runDir, callIndex, {
        request: redactRequest(openRouterBody),
        status: "network_error",
        error: (error as Error).message
      });
      return new Response(JSON.stringify({ error: (error as Error).message }), {
        status: 502,
        headers: { "Content-Type": "application/json" }
      });
    }

    const responseText = await response.text();
    if (!response.ok) {
      await writeBridgeTrace(options.runDir, callIndex, {
        request: redactRequest(openRouterBody),
        status: response.status,
        error: responseText
      });
      return new Response(responseText, {
        status: response.status,
        headers: { "Content-Type": response.headers.get("Content-Type") ?? "text/plain" }
      });
    }

    const raw = parseJson(responseText);
    const content = extractMessageContent(raw);
    if (!content) {
      const error = JSON.stringify({ error: "OpenRouter response did not include choices[0].message.content." });
      await writeBridgeTrace(options.runDir, callIndex, {
        request: redactRequest(openRouterBody),
        status: 502,
        raw
      });
      return new Response(error, { status: 502, headers: { "Content-Type": "application/json" } });
    }

    let outputText: string;
    try {
      outputText = extractJsonObject(content);
    } catch (error) {
      await writeBridgeTrace(options.runDir, callIndex, {
        request: redactRequest(openRouterBody),
        status: 502,
        raw,
        content,
        error: (error as Error).message
      });
      return new Response(JSON.stringify({ error: (error as Error).message, content }), {
        status: 502,
        headers: { "Content-Type": "application/json" }
      });
    }

    const wrapped = {
      id: raw.id ?? `openrouter-${randomUUID()}`,
      object: "response",
      model: raw.model ?? options.model,
      output_text: outputText,
      output: [
        {
          type: "message",
          content: [
            {
              type: "output_text",
              text: outputText
            }
          ]
        }
      ],
      openrouter: {
        id: raw.id,
        model: raw.model,
        usage: raw.usage,
        finish_reason: raw.choices?.[0]?.finish_reason
      }
    };

    await writeBridgeTrace(options.runDir, callIndex, {
      request: redactRequest(openRouterBody),
      status: response.status,
      raw,
      wrapped
    });
    return new Response(JSON.stringify(wrapped), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  };
}

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

function parseBody(body: BodyInit | null | undefined): ResponsesRequestBody {
  if (!body) return {};
  if (typeof body === "string") return parseJson(body) as ResponsesRequestBody;
  if (body instanceof Uint8Array) return parseJson(Buffer.from(body).toString("utf8")) as ResponsesRequestBody;
  throw new Error("OpenRouter harness bridge only supports string or Uint8Array fetch bodies.");
}

function parseJson(text: string): any {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`Invalid JSON payload: ${(error as Error).message}`);
  }
}

function buildPrompt(body: ResponsesRequestBody): string {
  return [
    "Original instructions:",
    body.instructions ?? "",
    "",
    "Original input:",
    stringify(body.input ?? {}),
    "",
    "Expected JSON schema:",
    stringify(body.text?.format?.schema ?? {}),
    "",
    "Output requirements:",
    "- Keep top-level keys exactly as required by the schema.",
    "- Each top-level value must be an array.",
    "- Keep the output compact: hierarchy_rows 3-8 rows, organization_rows 2-5 rows, coverage_rows 3-8 rows, clarification_rows 2-6 rows, reference_rows 1-5 rows, standard_rows 5-10 rows.",
    "- Keep every cell concise so the full JSON fits in the response.",
    "- Use needs_review, assumed, or sample_only for uncertain content.",
    "- The JSON must be directly parseable by JSON.parse."
  ].join("\n");
}

function stringify(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value, null, 2);
}

function extractMessageContent(raw: any): string {
  return raw?.choices?.[0]?.message?.content ?? "";
}

function extractJsonObject(text: string): string {
  const trimmed = text.trim();
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) return trimmed;
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) return fenced[1].trim();
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) return trimmed.slice(start, end + 1);
  throw new Error("OpenRouter output did not contain a JSON object.");
}

function redactRequest(body: unknown): unknown {
  return JSON.parse(JSON.stringify(body));
}

async function writeBridgeTrace(runDir: string, callIndex: number, payload: unknown): Promise<void> {
  const file = path.join(runDir, `openrouter-response-${String(callIndex).padStart(2, "0")}.json`);
  await fs.writeFile(file, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}
