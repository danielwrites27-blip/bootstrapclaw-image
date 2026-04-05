// ── AGENT V2: CONTEXT + LLM ─────────────────────────

const https = require("https");

const fs = require("fs");

function readLocalFile(filePath) {
  try {
    const fullPath = "/root/bootstrapclaw/" + filePath;

    if (!fs.existsSync(fullPath)) {
      return "File not found: " + filePath;
    }

    const content = fs.readFileSync(fullPath, "utf-8");

    return content.slice(0, 2000);
  } catch (e) {
    return "Error reading file: " + e.message;
  }
}

const PUTER_URL = "https://api.puter.com/puterai/openai/v1/chat/completions";
const PUTER_KEY = process.env.PUTER_AUTH_TOKEN;

// ── SYSTEM RULES ────────────────────────────────────

const STANDING_RULES = `
You are an autonomous coding agent.

You MUST respond in JSON format only.

Format:
{
  "thought": "what you are thinking",
  "action": "one of: request_information, inspect_file, fix_bug",
  "data": "any details"
}

Allowed actions ONLY:
- request_information
- inspect_file
- fix_bug

Rules:
- Be precise
- Do not guess
- Fix root problems only
- Do not create new bugs
- ALWAYS use one of the allowed actions
- Always respond in JSON
`;

let taskMemory = {
  goal: "",
  notes: [],
  inspectedFiles: []
};

// ── CONTEXT BUILDER ─────────────────────────────────

function buildContext(userInput, history) {
  const recentHistory = history.slice(-5);

  return {
    system: STANDING_RULES,
    history: recentHistory,
    input: userInput + `

Already inspected files:
${taskMemory.inspectedFiles.join(", ")}

Do NOT inspect the same file again.
`
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

function executeAction(actionObj) {

  console.log("\n=== ACTION EXECUTION ===\n");

  switch (actionObj.action) {

    case "request_information":
      console.log("Agent asks:", actionObj.data);
      return;

    case "inspect_file":

  const filePath = actionObj.data;

  if (!filePath.includes(".") || filePath.length > 100) {
    console.log("Invalid file path:", filePath);
    return;
  }

  // prevent duplicate inspection
  if (taskMemory.inspectedFiles.includes(filePath)) {
    console.log("Already inspected:", filePath);
    return;
  }

  taskMemory.inspectedFiles.push(filePath);

  console.log("Inspecting file:", filePath);

  const fileContent = readLocalFile(filePath);

  console.log("\n=== FILE CONTENT ===\n");
  console.log(fileContent);

  return fileContent;

    case "fix_bug":
      console.log("Fixing bug:", actionObj.data);
      return;

    default:
      console.log("Unknown action:", actionObj.action);
  }
}

// ── TEST RUN ────────────────────────────────────────

async function run() {

  let history = [
    { role: "user", content: "Fix login timeout bug" }
  ];

  for (let i = 0; i < 3; i++) {

    console.log(`\n=== LOOP ${i + 1} ===`);

    const context = buildContext("Continue solving the task", history);

    const response = await callLLM(context);

    console.log("\n=== RESPONSE ===\n");
    console.log(response);

    let actionObj;

    try {
      actionObj = JSON.parse(response);
    } catch (e) {
      console.log("Failed to parse JSON");
      break;
    }

    executeAction(actionObj);

    // Add response to history
    history.push({
      role: "assistant",
      content: response
    });

    // Stop if bug is fixed
    if (actionObj.action === "fix_bug") {
      console.log("\n=== TASK COMPLETE ===");
      break;
    }
  }
}

run();
