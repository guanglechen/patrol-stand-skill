const openai = Boolean(process.env.OPENAI_API_KEY);
const mock = process.env.LLM_PROVIDER === "mock";
const required = process.env.LLM_REQUIRED === "true";

if (required && !openai && !mock) {
  throw new Error("LLM_REQUIRED=true but neither OPENAI_API_KEY nor LLM_PROVIDER=mock is configured.");
}

console.log(JSON.stringify({
  ok: true,
  llmConfigured: openai || mock,
  provider: openai ? "openai" : mock ? "mock" : "none",
  required,
  note: openai || mock ? "LLM analysis path can run." : "Local runner will explicitly fall back to deterministic skeleton."
}, null, 2));
