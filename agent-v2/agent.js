// ── AGENT V2: CONTEXT + LLM ─────────────────────────

const https = require("https");

const PUTER_URL = "https://api.puter.com/puterai/openai/v1/chat/completions";
const PUTER_KEY = process.env.PUTER_AUTH_TOKEN;

// ── SYSTEM RULES ────────────────────────────────────

const STANDING_RULES = `
You are an autonomous coding agent.

Rules:
- Be precise
- Do not guess
- Fix root problems only
- Do not create new bugs
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
    task: taskMemory,
    history: recentHistory,
    input: userInput
  };
}

// ── LLM CALL ────────────────────────────────────────

function callLLM(context) {
  return new Promise((resolve, reject) => {

    const messages = [
      { role: "system", content: context.system },
      ...context.history,
      { role: "user", content: context.input }
    ];

    const body = JSON.stringify({
      model: "minimax/minimax-m2.7",
      messages,
      max_tokens: 500,
      temperature: 0.7
    });

    const url = new URL(PUTER_URL);

    const req = https.request({
      hostname: url.hostname,
      path: url.pathname,
      method: "POST",
      headers: {
        "Authorization": "Bearer " + PUTER_KEY,
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body)
      }
    }, (res) => {

      let data = "";

      res.on("data", chunk => data += chunk);

      res.on("end", () => {
        try {
          const parsed = JSON.parse(data);
          const text = parsed?.choices?.[0]?.message?.content;
          resolve(text || "No response");
        } catch (e) {
          reject(e);
        }
      });
    });

    req.on("error", reject);

    req.write(body);
    req.end();
  });
}

// ── TEST RUN ────────────────────────────────────────

async function run() {

  const history = [
    { role: "user", content: "hello" },
    { role: "assistant", content: "hi" }
  ];

  const context = buildContext("How to fix login timeout bug?", history);

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
