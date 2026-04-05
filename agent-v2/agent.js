// ── AGENT V2: CONTEXT + LLM ─────────────────────────

"use strict";

const https = require("https");
const fs    = require("fs");
const path  = require("path");

const REPO_ROOT = "/root/bootstrapclaw";

// ── DIRECTORY SCANNER ────────────────────────────────
// Walks the repo tree ONCE at startup and returns all relative file paths.
// The full file list is injected into the agent's first message so it can
// ONLY ever request files that actually exist — eliminating hallucinated paths.

function scanDirectory(dir, baseDir, results = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    return results;
  }

  const IGNORE = new Set([
    "node_modules", ".git", ".next", "dist", "build",
    ".cache", "coverage", "__pycache__", ".DS_Store"
  ]);

  for (const entry of entries) {
    if (IGNORE.has(entry.name)) continue;

    const fullPath = path.join(dir, entry.name);
    const relPath  = path.relative(baseDir, fullPath);

    if (entry.isDirectory()) {
      scanDirectory(fullPath, baseDir, results);
    } else {
      results.push(relPath);
    }
  }

  return results;
}

// ── FILE READER ──────────────────────────────────────

function readLocalFile(filePath) {
  try {
    const fullPath = path.join(REPO_ROOT, filePath);

    // Prevent directory traversal
    if (!fullPath.startsWith(REPO_ROOT)) {
      return "Access denied: path escapes repo root";
    }

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
  "action": "one of: request_information, list_files, inspect_file, fix_bug",
  "data": "any details"
}

Allowed actions ONLY:
- request_information  — ask a clarifying question
- list_files           — filter the known file tree (data = subdirectory or keyword)
- inspect_file         — read a file (data = exact relative path from repo root)
- fix_bug              — produce the fix (data = full explanation + patch)

Rules:
- ONLY request files shown in the provided file tree — never invent paths
- Do NOT inspect the same file twice
- After inspecting 2–3 files you MUST choose fix_bug
- Always respond with raw JSON — no backticks, no markdown
`;

// ── TASK MEMORY ──────────────────────────────────────

let taskMemory = {
  goal:           "",
  notes:          [],
  inspectedFiles: [],
  knownFiles:     []   // populated from directory scan at startup
};

// ── CONTEXT BUILDER ──────────────────────────────────

function buildContext(userInput, history) {
  const recentHistory = history.slice(-6);

  let dynamicSystem = STANDING_RULES;

  if (taskMemory.inspectedFiles.length >= 2) {
    dynamicSystem += `
IMPORTANT: You have inspected enough files.
You MUST now choose action "fix_bug". Do NOT inspect more files.
`;
  }

  const inspectedList = taskMemory.inspectedFiles.length > 0
    ? taskMemory.inspectedFiles.join(", ")
    : "(none yet)";

  return {
    system:  dynamicSystem,
    history: recentHistory,
    input:   userInput +
             `\n\nAlready inspected: ${inspectedList}` +
             `\nDo NOT request those files again.`
  };
}

// ── JSON EXTRACTOR ───────────────────────────────────
// Strips markdown fences that LLMs sometimes wrap around JSON.

function extractJSON(raw) {
  if (!raw || typeof raw !== "string") return null;

  const stripped = raw
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```\s*$/, "")
    .trim();

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
        max_tokens:  600,
        temperature: 0.3    // lower = more deterministic file name choices
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

  return null;
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

    case "list_files": {
      // Returns a filtered subset of the known file tree.
      const query   = (actionObj.data || "").toLowerCase().trim();
      const matches = taskMemory.knownFiles.filter(f =>
        !query || f.toLowerCase().includes(query)
      );

      if (matches.length === 0) {
        const msg = `No files matching "${actionObj.data}" in the repository.`;
        console.log(msg);
        return "LIST_EMPTY:" + msg;
      }

      const listing = matches.join("\n");
      console.log("File listing:\n" + listing);
      return "FILE_LIST:\n" + listing;
    }

    case "inspect_file": {
      const filePath = actionObj.data;

      if (
        typeof filePath !== "string" ||
        !filePath.includes(".")      ||
        filePath.length > 200        ||
        filePath.includes("..")
      ) {
        console.log("Invalid or unsafe file path:", filePath);
        return null;
      }

      // ── PRIMARY FIX: reject paths not in the scanned tree ──
      // If the model hallucinated a path, it gets caught here BEFORE any
      // file system call, and the full real file tree is fed back so the
      // model can make a valid choice on the next iteration.
      const normalised = filePath.replace(/\\/g, "/");
      const isKnown    = taskMemory.knownFiles.some(
        f => f.replace(/\\/g, "/") === normalised
      );

      if (!isKnown) {
        console.log("Hallucinated path rejected:", filePath);
        return "FILE_NOT_IN_REPO:" +
               `"${filePath}" is not in this repository. ` +
               `Pick a file from the known tree.`;
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
        return "FILE_NOT_FOUND:" + filePath;
      }

      return "FILE_CONTENT:" + fileContent;
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

// ── RESULT → FEEDBACK MESSAGE ────────────────────────
// Translates an executeAction return value into the user-role feedback
// message pushed into history AFTER the assistant turn.
// Order: assistant (action) → user (tool result) — never reversed.

function resultToFeedback(result, knownFiles) {
  if (!result) return null;

  if (result.startsWith("FILE_CONTENT:")) {
    // Successful read — content already visible in logs, no extra signal needed.
    return null;
  }

  if (result.startsWith("FILE_NOT_FOUND:")) {
    const p = result.slice("FILE_NOT_FOUND:".length);
    return `"${p}" was not readable from disk. Stop searching. ` +
           `Fix the login timeout bug now using your existing knowledge.`;
  }

  if (result.startsWith("FILE_NOT_IN_REPO:")) {
    // Give the model the full real tree so it can self-correct.
    return result.slice("FILE_NOT_IN_REPO:".length) +
           `\n\nFull repository file tree:\n${knownFiles.join("\n")}`;
  }

  if (result.startsWith("FILE_LIST:")) {
    return `Directory listing:\n${result.slice("FILE_LIST:".length)}`;
  }

  if (result.startsWith("LIST_EMPTY:")) {
    return result.slice("LIST_EMPTY:".length) +
           `\n\nFull repository file tree:\n${knownFiles.join("\n")}`;
  }

  return null;
}

// ── MAIN AGENT LOOP ──────────────────────────────────

async function run() {

  const MAX_ITERATIONS  = 6;
  const FORCE_FIX_AFTER = 2;  // 0-based: override fires on iteration 3+

  // ── Scan the repo ONCE before the loop starts ───────
  console.log(`\nScanning repo at: ${REPO_ROOT}`);
  taskMemory.knownFiles = scanDirectory(REPO_ROOT, REPO_ROOT);

  if (taskMemory.knownFiles.length === 0) {
    console.log("⚠️  WARNING: No files found. Check that REPO_ROOT is correct.");
  } else {
    console.log(`Found ${taskMemory.knownFiles.length} file(s):`);
    console.log(taskMemory.knownFiles.join("\n"), "\n");
  }

  // Build the file tree block injected into the very first user message.
  const fileTreeBlock = taskMemory.knownFiles.length > 0
    ? `\n\nKnown files in this repository (ONLY use these exact paths for inspect_file):\n` +
      taskMemory.knownFiles.join("\n")
    : "\n\nWARNING: Repository appears to be empty or REPO_ROOT path is wrong.";

  let history = [
    {
      role:    "user",
      content: "Fix the login timeout bug." + fileTreeBlock
    }
  ];

  for (let i = 0; i < MAX_ITERATIONS; i++) {

    console.log(`\n${"═".repeat(44)}`);
    console.log(`  AGENT LOOP — ITERATION ${i + 1} / ${MAX_ITERATIONS}`);
    console.log(`${"═".repeat(44)}\n`);

    let instruction = "Continue solving the task. Only use file paths from the known file tree provided above.";

    if (taskMemory.inspectedFiles.length >= 2) {
      instruction = "You have inspected enough files. You MUST now choose fix_bug.";
    }

    const context  = buildContext(instruction, history);
    const response = await callLLM(context);

    if (!response) {
      console.log("All LLM providers failed. Aborting.");
      break;
    }

    console.log("\n=== LLM RESPONSE ===");
    console.log(response);
    console.log("====================\n");

    // ── Parse JSON ────────────────────────────────────
    let actionObj;
    const jsonText = extractJSON(response);

    try {
      actionObj = JSON.parse(jsonText);
    } catch (e) {
      console.log("Failed to parse action JSON:", e.message);
      history.push({ role: "assistant", content: response });
      history.push({
        role:    "user",
        content: "Your last response was not valid JSON. Reply ONLY with a raw JSON object — no markdown, no backticks."
      });
      continue;
    }

    // ── HARD ACTION OVERRIDE (deterministic, code-level) ─
    const shouldForce =
      i >= FORCE_FIX_AFTER ||
      taskMemory.inspectedFiles.length >= 2;

    if (shouldForce && actionObj.action !== "fix_bug") {
      console.log(`⚠️  HARD OVERRIDE [iter=${i + 1}]: forcing fix_bug (was: "${actionObj.action}")`);
      // Full object replacement — not a mutation
      actionObj = {
        thought: "Forced by execution controller — sufficient inspection completed.",
        action:  "fix_bug",
        data:    "Fix login timeout based on inspected files and repo context."
      };
    }

    // ── Execute ───────────────────────────────────────
    const result = executeAction(actionObj);

    // ── Push assistant turn FIRST ─────────────────────
    // Correct order: assistant (action) → user (tool result/consequence)
    history.push({ role: "assistant", content: response });

    // ── Push tool feedback AFTER ──────────────────────
    const feedback = resultToFeedback(result, taskMemory.knownFiles);
    if (feedback) {
      console.log("Injecting feedback → history");
      history.push({ role: "user", content: feedback });
    }

    // ── Terminal condition ────────────────────────────
    if (actionObj.action === "fix_bug") {
      console.log(`\n✅ TASK COMPLETE — fix_bug on iteration ${i + 1}`);
      break;
    }

    // ── Safety net ────────────────────────────────────
    if (i === MAX_ITERATIONS - 1) {
      console.log("\n⚠️  MAX ITERATIONS REACHED — forcing terminal fix.");
      executeAction({
        thought: "Max iterations reached.",
        action:  "fix_bug",
        data:    "Emergency terminal fix: login timeout."
      });
    }
  }
}

run();
