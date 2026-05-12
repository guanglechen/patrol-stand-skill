const openai = Boolean(process.env.OPENAI_API_KEY);
const kimi = Boolean(process.env.KIMI_API_KEY);
const mock = process.env.LLM_PROVIDER === "mock";
const required = process.env.LLM_REQUIRED === "true";

if (required && !openai && !kimi && !mock) {
  throw new Error("LLM_REQUIRED=true but no LLM provider is configured.");
}

console.log(JSON.stringify({
  ok: true,
  llmConfigured: openai || kimi || mock,
  provider: kimi ? "kimi-coding" : openai ? "openai" : mock ? "mock" : "none",
  required,
  note: openai || kimi || mock ? "LLM analysis path can run." : "Local runner will explicitly fall back to deterministic skeleton."
}, null, 2));
