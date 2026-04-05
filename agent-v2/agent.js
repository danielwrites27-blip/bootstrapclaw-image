// ── AGENT V2: CONTEXT + LLM ─────────────────────────

const https = require("https");

const PUTER_URL = "https://api.puter.com/puterai/openai/v1/chat/completions";
const PUTER_KEY = process.env.PUTER_AUTH_TOKEN;

// ── SYSTEM RULES ────────────────────────────────────

const STANDING_RULES = `
You are an autonomous coding agent.

You MUST respond in JSON format only.

Format:
{
  "thought": "what you are thinking",
  "action": "what to do next",
  "data": "any details"
}

Rules:
- Be precise
- Do not guess
- Fix root problems only
- Do not create new bugs
- Always respond in JSON
`;

let taskMemory = {
  goal: "",
  notes: []
};

// ── CONTEXT BUILDER ─────────────────────────────────

function buildContext(userInput, history) {
  const recentHistory = history.slice(-5);

  return {
    system: STANDING_RULES,
    history: recentHistory,
    input: userInput
  };
}

// ── LLM CALL ────────────────────────────────────────

async function callLLM(context) {

  const providers = [
    {
      name: "Puter M2.7",
      url: "https://api.puter.com/puterai/openai/v1/chat/completions",
      key: process.env.PUTER_AUTH_TOKEN,
      model: "minimax/minimax-m2.7"
    },
    {
      name: "Cerebras Qwen",
      url: "https://api.cerebras.ai/v1/chat/completions",
      key: process.env.CEREBRAS_API_KEY_CHAT,
      model: "qwen-3-235b-a22b-instruct-2507"
    }
  ];

  const messages = [
    { role: "system", content: context.system },
    ...context.history,
    { role: "user", content: context.input }
  ];

  for (const p of providers) {

    if (!p.key) continue;

    try {

      console.log("Trying:", p.name);

      const body = JSON.stringify({
        model: p.model,
        messages,
        max_tokens: 500,
        temperature: 0.7
      });

      const url = new URL(p.url);

      const response = await new Promise((resolve, reject) => {

        const req = https.request({
          hostname: url.hostname,
          path: url.pathname,
          method: "POST",
          headers: {
            "Authorization": "Bearer " + p.key,
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(body)
          }
        }, (res) => {

          let data = "";

          res.on("data", chunk => data += chunk);

          res.on("end", () => resolve(data));
        });

        req.on("error", reject);
        req.write(body);
        req.end();
      });

      console.log("RAW RESPONSE:", response);

      const parsed = JSON.parse(response);

      // detect Puter failure
      if (parsed?.code === "insufficient_funds") {
        console.log("Puter exhausted → switching...");
        continue;
      }

      const msg = parsed?.choices?.[0]?.message;

      const text =
        msg?.content ||
        msg?.reasoning_content ||
        parsed?.choices?.[0]?.text;

      if (text) return text;

    } catch (e) {
      console.log("Provider failed:", e.message);
    }
  }

  return "All providers failed";
}

// ── TEST RUN ────────────────────────────────────────

async function run() {

  const history = [
    { role: "user", content: "hello" },
    { role: "assistant", content: "hi" }
  ];

  const context = buildContext(
  "Fix login timeout bug. Decide next step.",
  history
);

  console.log("=== THINKING ===");

  try {
    const response = await callLLM(context);
    console.log("\n=== RESPONSE ===\n");
    console.log(response);
  } catch (e) {
    console.error("Error:", e.message);
  }
}

run();
