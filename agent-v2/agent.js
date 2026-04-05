// ── AGENT V2: CONTEXT + LLM ─────────────────────────

"use strict";

const https = require("https");
const fs    = require("fs");

// ── FILE READER ──────────────────────────────────────

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

// ── SYSTEM RULES ────────────────────────────────────

const STANDING_RULES = `
You are an autonomous coding agent.

You MUST respond in JSON format only — no markdown fences, no commentary.

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
- Always respond with raw JSON — no backticks, no markdown
- After inspecting 2–3 files, you MUST choose "fix_bug"
- Do NOT keep inspecting indefinitely
- Prefer action over exploration
`;

// ── TASK MEMORY ──────────────────────────────────────

let taskMemory = {
  goal:           "",
  notes:          [],
  inspectedFiles: []
};

// ── CONTEXT BUILDER ──────────────────────────────────

function buildContext(userInput, history) {
  const recentHistory = history.slice(-5);

  let dynamicSystem = STANDING_RULES;

  if (taskMemory.inspectedFiles.length >= 2) {
    dynamicSystem += `
IMPORTANT: You have already inspected enough files.
You MUST now choose action "fix_bug". Do NOT inspect more files.
`;
  }

  const inspectedList = taskMemory.inspectedFiles.length > 0
    ? taskMemory.inspectedFiles.join(", ")
    : "(none)";

  return {
    system:  dynamicSystem,
    history: recentHistory,
    input:   userInput + `\n\nAlready inspected files: ${inspectedList}\nDo NOT inspect the same file again.`
  };
}

// ── JSON EXTRACTOR ───────────────────────────────────
// Strips markdown fences that LLMs sometimes wrap around JSON.

function extractJSON(raw) {
  if (!raw || typeof raw !== "string") return null;

  // Strip ```json ... ``` or ``` ... ``` wrappers
  const stripped = raw
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```\s*$/, "")
    .trim();

  // Find the first { ... } block in case there is leading text
  const start = stripped.indexOf("{");
  const end   = stripped.lastIndexOf("}");

  if (start === -1 || end === -1 || end < start) return null;

  return stripped.slice(start, end + 1);
}

// ── LLM CALL ────────────────────────────────────────

async function callLLM(context) {

  const providers = [
    {
      name:  "Puter M2.7",
      url:   "https://api.puter.com/puterai/openai/v1/chat/completions",
      key:   process.env.PUTER_AUTH_TOKEN,
      model: "minimax/minimax-m2.7"
    },
    {
      name:  "Cerebras Qwen",
      url:   "https://api.cerebras.ai/v1/chat/completions",
      key:   process.env.CEREBRAS_API_KEY_CHAT,
      model: "qwen-3-235b-a22b-instruct-2507"
    }
  ];

  const messages = [
    { role: "system", content: context.system },
    ...context.history,
    { role: "user",   content: context.input  }
  ];

  for (const p of providers) {

    if (!p.key) {
      console.log(`Skipping ${p.name}: no API key`);
      continue;
    }

    try {
      console.log(`Trying provider: ${p.name}`);

      const body = JSON.stringify({
        model:       p.model,
        messages,
        max_tokens:  500,
        temperature: 0.7
      });

      const url = new URL(p.url);

      const rawResponse = await new Promise((resolve, reject) => {
        const req = https.request(
          {
            hostname: url.hostname,
            path:     url.pathname,
            method:   "POST",
            headers: {
              "Authorization":  "Bearer " + p.key,
              "Content-Type":   "application/json",
              "Content-Length": Buffer.byteLength(body)
            }
          },
          (res) => {
            let data = "";
            res.on("data", chunk => (data += chunk));
            res.on("end",  ()    => resolve(data));
          }
        );

        req.on("error", reject);
        req.write(body);
        req.end();
      });

      console.log("RAW RESPONSE:", rawResponse);

      let parsed;
      try {
        parsed = JSON.parse(rawResponse);
      } catch (parseErr) {
        console.log(`${p.name}: malformed HTTP response JSON — skipping`);
        continue;
      }

      // Detect Puter-specific quota failure
      if (parsed?.code === "insufficient_funds") {
        console.log("Puter exhausted → switching to next provider...");
        continue;
      }

      const msg  = parsed?.choices?.[0]?.message;
      const text =
        msg?.content           ||
        msg?.reasoning_content ||
        parsed?.choices?.[0]?.text;

      if (text) return text;

      console.log(`${p.name}: empty text in response — skipping`);

    } catch (e) {
      console.log(`Provider ${p.name} failed:`, e.message);
    }
  }

  return null; // All providers failed — caller handles this
}

// ── ACTION EXECUTOR ──────────────────────────────────

function executeAction(actionObj) {
  console.log("\n=== ACTION EXECUTION ===");
  console.log("Action :", actionObj.action);
  console.log("Data   :", actionObj.data);
  console.log("Thought:", actionObj.thought || "(none)");
  console.log("========================\n");

  switch (actionObj.action) {

    case "request_information": {
      console.log("Agent requests information:", actionObj.data);
      return null;
    }

    case "inspect_file": {
      // BUG FIX: block scope `{}` required for `const` inside switch cases
      const filePath = actionObj.data;

      // Validate path: must have extension, reasonable length, no traversal
      if (
        typeof filePath !== "string"   ||
        !filePath.includes(".")        ||
        filePath.length > 100          ||
        filePath.includes("..")
      ) {
        console.log("Invalid or unsafe file path:", filePath);
        return null;
      }

      if (taskMemory.inspectedFiles.includes(filePath)) {
        console.log("Duplicate inspection blocked:", filePath);
        return null;
      }

      taskMemory.inspectedFiles.push(filePath);
      console.log("Inspecting file:", filePath);

      const fileContent = readLocalFile(filePath);

      console.log("\n=== FILE CONTENT ===");
      console.log(fileContent);
      console.log("====================\n");

      if (fileContent.startsWith("File not found")) {
        return "FILE_NOT_FOUND";
      }

      return fileContent;
    }

    case "fix_bug": {
      console.log("Applying fix for:", actionObj.data);
      // TODO: wire to patch writer / code executor
      return null;
    }

    default: {
      console.log("Unknown action received:", actionObj.action);
      return null;
    }
  }
}

// ── MAIN AGENT LOOP ──────────────────────────────────

async function run() {

  const MAX_ITERATIONS    = 5;   // hard ceiling — agent cannot run forever
  const FORCE_FIX_AFTER   = 2;   // iteration index (0-based) after which fix_bug is mandatory

  let history = [
    { role: "user", content: "Fix login timeout bug" }
  ];

  for (let i = 0; i < MAX_ITERATIONS; i++) {

    console.log(`\n${"═".repeat(40)}`);
    console.log(`  AGENT LOOP — ITERATION ${i + 1} / ${MAX_ITERATIONS}`);
    console.log(`${"═".repeat(40)}\n`);

    // ── Build instruction ────────────────────────────
    let instruction = "Continue solving the task.";
    if (taskMemory.inspectedFiles.length >= 2) {
      instruction = "You have inspected enough files. You MUST now choose fix_bug.";
    }

    const context  = buildContext(instruction, history);
    const response = await callLLM(context);

    // ── Provider failure guard ────────────────────────
    if (!response) {
      console.log("All LLM providers failed. Aborting agent loop.");
      break;
    }

    console.log("\n=== LLM RESPONSE ===");
    console.log(response);
    console.log("====================\n");

    // ── Parse JSON from LLM ───────────────────────────
    let actionObj;
    const jsonText = extractJSON(response);

    try {
      actionObj = JSON.parse(jsonText);
    } catch (e) {
      console.log("Failed to parse action JSON:", e.message);
      console.log("Raw extracted text:", jsonText);
      // Feed parse failure back so model can self-correct
      history.push({ role: "assistant", content: response });
      history.push({
        role:    "user",
        content: "Your last response was not valid JSON. Respond ONLY with a raw JSON object, no markdown."
      });
      continue;
    }

    // ── HARD ACTION OVERRIDE (deterministic, iteration-based) ────────────
    // This executes at the CODE level — the LLM decision is discarded.
    // Triggers when: iteration index >= FORCE_FIX_AFTER  OR  inspected >= 2
    const shouldForce =
      i >= FORCE_FIX_AFTER ||
      taskMemory.inspectedFiles.length >= 2;

    if (shouldForce && actionObj.action !== "fix_bug") {
      console.log(`⚠️  HARD OVERRIDE [iter=${i + 1}]: forcing fix_bug (was: ${actionObj.action})`);

      // Replace object entirely — do NOT mutate the original
      actionObj = {
        thought: "Forced by execution controller after sufficient inspection.",
        action:  "fix_bug",
        data:    "Fix login timeout based on patterns found during inspection."
      };
    }

    // ── Execute action ────────────────────────────────
    const result = executeAction(actionObj);

    // ── Append assistant turn first ──────────────────
    // The assistant's action must appear in history BEFORE any tool-result
    // feedback, so the model reads: action → consequence (not the reverse).
    history.push({ role: "assistant", content: response });

    // ── Feed FILE_NOT_FOUND signal back into history ──
    // Correct conversation order:
    //   assistant: {"action":"inspect_file", "data":"..."}   ← what the model did
    //   user:      "That file does not exist. Fix the bug."  ← tool result / consequence
    if (result === "FILE_NOT_FOUND") {
      console.log("Injecting FILE_NOT_FOUND signal into history.");
      history.push({
        role:    "user",
        content: "The file you requested does not exist. Do not search for more files. Fix the login timeout bug now using your existing knowledge and any context already gathered."
      });
    }

    // ── Terminal condition ────────────────────────────
    if (actionObj.action === "fix_bug") {
      console.log("\n✅ TASK COMPLETE — fix_bug executed on iteration", i + 1);
      break;
    }

    // Safety net: if we somehow exhaust the loop without fix_bug
    if (i === MAX_ITERATIONS - 1) {
      console.log("\n⚠️  MAX ITERATIONS REACHED without fix_bug — forcing final fix.");
      executeAction({
        thought: "Max iterations reached — forced terminal fix.",
        action:  "fix_bug",
        data:    "Emergency fix: login timeout — max agent loop reached."
      });
    }
  }
}

run();
