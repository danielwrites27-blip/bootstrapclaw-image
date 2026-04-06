#!/usr/bin/env node
'use strict';

const https        = require('https');
const http         = require('http');
const fs           = require('fs');
const path         = require('path');
const { execSync } = require('child_process');

const PORT         = 3001;
const DEFAULT_DIR  = '/root/bootstrapclaw';

// ── GITHUB AUTO-FETCH (standing rules) ───────────────────────────────────────
const GITHUB_RAW   = 'https://raw.githubusercontent.com/danielwrites27-blip/bootstrapclaw-image/main/';
let autoContext    = '';

async function fetchGithubFile(filename) {
  return new Promise(resolve => {
    https.get(GITHUB_RAW + filename, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => resolve(res.statusCode === 200 ? d : null));
    }).on('error', () => resolve(null));
  });
}

async function refreshAutoFiles() {
  const files = ['bootstrapclaw-core.js', 'startup.sh', 'lint-prompts.js'];
  const results = await Promise.all(files.map(f => fetchGithubFile(f)));
  const loaded = files.map((f, i) => results[i] ? `=== ${f} ===\n${results[i]}` : null).filter(Boolean);
  autoContext = loaded.length > 0
    ? '\n\n--- LIVE GITHUB FILES ---\n' + loaded.join('\n\n') + '\n--- END ---\n'
    : '';
  console.log('[Agent] Auto-fetched ' + loaded.length + ' GitHub files');
}
refreshAutoFiles();
setInterval(refreshAutoFiles, 5 * 60 * 1000);

// ── STANDING RULES ────────────────────────────────────────────────────────────
const STANDING_RULES = `=== BOOTSTRAPCLAW STANDING RULES ===
DEPLOYMENT: GitHub edit → curl pull. NEVER heredoc. NEVER direct container edit without GitHub commit.
curl pull: curl -s -o /root/bootstrapclaw/<file> https://raw.githubusercontent.com/danielwrites27-blip/bootstrapclaw-image/main/<file>
BLOCKED PROVIDERS: Mistral, groq-70b, gpt-oss:120b, minimax-m2.7 via Ollama, NVIDIA nemotron.
ACTIVE PIPELINE: Phase1=sambanova/Meta-Llama-3.3-70B-Instruct, Phase2=sambanova/Qwen3-235B, Phase2.5+3=groq/kimi-k2, Orchestrator=cerebras/qwen-3-235b, Fallback=ollama/gemma3:27b.
CONTAINER: 2GB RAM. Persistent: /root/.openclaw. /root/bootstrapclaw/ wiped on restart.
STATE: 14 articles published. Session 35 done. Validator 7/7.
=== END RULES ===`;

// ── DIRECTORY SCANNER ─────────────────────────────────────────────────────────
function scanDirectory(dir, baseDir, results = [], depth = 0) {
  if (depth > 6) return results;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch(e) { return results; }
  const IGNORE = new Set(['node_modules','.git','.next','dist','build','.cache','coverage','__pycache__','.DS_Store','venv','.venv','vendor']);
  for (const entry of entries) {
    if (IGNORE.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    const rel  = path.relative(baseDir, full);
    if (entry.isDirectory()) scanDirectory(full, baseDir, results, depth + 1);
    else results.push(rel);
  }
  return results;
}

// ── FILE OPS ──────────────────────────────────────────────────────────────────
function safeFullPath(relPath, workdir) {
  const full = path.resolve(path.join(workdir, relPath));
  return full.startsWith(workdir) ? full : null;
}

function readFile(relPath, workdir) {
  try {
    const full = safeFullPath(relPath, workdir);
    if (!full) return 'Error: path escapes working directory';
    if (!fs.existsSync(full)) return 'File not found: ' + relPath;
    return fs.readFileSync(full, 'utf-8').slice(0, 8000);
  } catch(e) { return 'Error: ' + e.message; }
}

function writeFile(relPath, content, workdir) {
  try {
    const full = safeFullPath(relPath, workdir);
    if (!full) return 'Error: path escapes working directory';
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content, 'utf-8');
    return 'OK: wrote ' + relPath;
  } catch(e) { return 'Error: ' + e.message; }
}

function runCommand(cmd, workdir) {
  const BLOCKED = [/rm\s+-rf\s+[^.\/]/, />\s*\/etc/, />\s*\/usr/, /curl.*\|\s*sh/, /wget.*\|\s*sh/, /sudo/];
  for (const p of BLOCKED) if (p.test(cmd)) return 'Blocked: ' + cmd;
  try {
    const out = execSync(cmd, { cwd: workdir, timeout: 15000, encoding: 'utf-8', stdio: ['pipe','pipe','pipe'] });
    return ('stdout:\n' + out).slice(0, 3000);
  } catch(e) {
    return `exit ${e.status}:\nstdout: ${(e.stdout||'').slice(0,1000)}\nstderr: ${(e.stderr||e.message||'').slice(0,1000)}`;
  }
}

// ── JSON EXTRACTOR ────────────────────────────────────────────────────────────
function extractJSON(raw) {
  if (!raw) return null;
  const stripped = raw.replace(/^```(?:json)?\s*/i,'').replace(/\s*```\s*$/,'').trim();
  const start = stripped.indexOf('{');
  const end   = stripped.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) return null;
  return stripped.slice(start, end + 1);
}

// ── STREAMING LLM (for agent — collects full response for JSON parsing) ───────
async function callLLMStream(messages, onChunk) {
  const PROVIDERS = [
    { name: 'SambaNova / Qwen3-235B', url: 'https://api.sambanova.ai/v1/chat/completions', key: process.env.SAMBANOVA_API_KEY_CHAT, model: 'Qwen3-235B',                     stream: false },
    { name: 'Cerebras / Qwen3-235B',  url: 'https://api.cerebras.ai/v1/chat/completions',  key: process.env.CEREBRAS_API_KEY_CHAT,  model: 'qwen-3-235b-a22b-instruct-2507', stream: true  }
  ];

  for (const p of PROVIDERS) {
    if (!p.key) continue;
    try {
      const useStream = p.stream !== false;
      const body = JSON.stringify({ model: p.model, messages, max_tokens: 4096, temperature: 0.3, stream: useStream });
      const fullText = await new Promise((resolve, reject) => {
        const url = new URL(p.url);
        const req = https.request({
          hostname: url.hostname, path: url.pathname, method: 'POST',
          headers: { 'Authorization': 'Bearer ' + p.key, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
        }, res => {
          if (res.statusCode !== 200) { res.resume(); reject(new Error('HTTP ' + res.statusCode)); return; }
          onChunk({ type: 'provider', provider: p.name });
          if (!useStream) {
            let data = '';
            res.on('data', c => data += c);
            res.on('end', () => {
              try {
                const parsed = JSON.parse(data);
                const content = parsed?.choices?.[0]?.message?.content || '';
                if (content) onChunk({ type: 'llm_chunk', content });
                resolve(content);
              } catch(e) { reject(new Error('JSON parse failed')); }
            });
            res.on('error', reject);
            return;
          }
          let buf = '', full = '';
          res.on('data', chunk => {
            buf += chunk.toString();
            const lines = buf.split('\n');
            buf = lines.pop();
            for (const line of lines) {
              const t = line.trim();
              if (!t.startsWith('data:')) continue;
              const raw = t.slice(5).trim();
              if (raw === '[DONE]') { resolve(full); return; }
              try {
                const parsed = JSON.parse(raw);
                const content = parsed?.choices?.[0]?.delta?.content;
                if (content) {
                  full += content;
                  onChunk({ type: 'llm_chunk', content });
                }
              } catch(e) {}
            }
          });
          res.on('end', () => resolve(full));
          res.on('error', reject);
        });
        req.on('error', reject);
        req.setTimeout(60000, () => { req.destroy(); reject(new Error('Timeout')); });
        req.write(body);
        req.end();
      });
      return fullText;
    } catch(e) {
      console.error('[Agent] ' + p.name + ' failed: ' + e.message);
      onChunk({ type: 'provider_fail', provider: p.name, error: e.message });
    }
  }
  return null;
}

// ── AGENT LOOP (streaming) ────────────────────────────────────────────────────
async function runAgent(task, workdir, onEvent) {
  const MAX_ITER = 12;

  let taskMemory = { inspectedFiles: [], writtenFiles: [], commandsRun: [], knownFiles: [] };

  // Scan workdir
  if (fs.existsSync(workdir)) {
    taskMemory.knownFiles = scanDirectory(workdir, workdir);
    onEvent({ type: 'scan', count: taskMemory.knownFiles.length, files: taskMemory.knownFiles });
  } else {
    onEvent({ type: 'scan', count: 0, files: [] });
  }

  const fileTreeBlock = taskMemory.knownFiles.length > 0
    ? '\n\nProject files (use EXACT paths for inspect_file):\n' + taskMemory.knownFiles.join('\n')
    : '\n\nDirectory is empty — create files as needed.';

  const SYSTEM = `You are an autonomous senior software engineer and coding agent.

You can work on ANY coding task — fix bugs, create files, build apps, refactor code, debug tests.

${STANDING_RULES}
${autoContext}

You MUST respond with raw JSON only — no markdown, no backticks, no text outside JSON.

Response format:
{
  "thought": "your internal reasoning about what to do next",
  "action": "one of the allowed actions",
  "data": "action payload"
}

ALLOWED ACTIONS:
action         | data
─────────────────────────────────────────────────
list_files     | subdirectory or keyword to filter
inspect_file   | relative file path to read
write_file     | JSON string: {"path":"...","content":"..."}
run_command    | shell command
request_info   | question for the user
complete_task  | final summary of what was done

RULES:
- inspect_file: only use paths from the file tree
- write_file: provide complete file content, never truncate
- run_command: installs, tests, builds, scaffolding
- After 4+ explore actions with no writes, start writing
- Use complete_task when fully done
- Always raw JSON only`;

  let history = [{ role: 'user', content: 'Task: ' + task + fileTreeBlock }];

  for (let i = 0; i < MAX_ITER; i++) {
    onEvent({ type: 'iteration', n: i + 1, max: MAX_ITER });

    const totalActions = taskMemory.inspectedFiles.length + taskMemory.writtenFiles.length + taskMemory.commandsRun.length;
    let system = SYSTEM;
    if (totalActions >= 4 && !taskMemory.writtenFiles.length) {
      system += '\n\nIMPORTANT: Enough exploration done. Start writing files or running commands now.';
    }

    const messages = [
      { role: 'system', content: system },
      ...history.slice(-10),
      { role: 'user', content: 'Continue. Take the next concrete step.' }
    ];

    onEvent({ type: 'thinking' });

    let fullResponse = '';
    try {
      fullResponse = await callLLMStream(messages, onEvent);
    } catch(e) {
      onEvent({ type: 'error', message: 'LLM failed: ' + e.message });
      break;
    }

    if (!fullResponse) {
      onEvent({ type: 'error', message: 'All providers failed' });
      break;
    }

    // Parse JSON
    let actionObj;
    try {
      actionObj = JSON.parse(extractJSON(fullResponse));
    } catch(e) {
      onEvent({ type: 'parse_error', raw: fullResponse.slice(0, 200) });
      history.push({ role: 'assistant', content: fullResponse });
      history.push({ role: 'user', content: 'Invalid JSON. Reply ONLY with a raw JSON object.' });
      continue;
    }

    // Hard override
    const forceComplete = i >= 8 ||
      (taskMemory.writtenFiles.length === 0 && taskMemory.commandsRun.length === 0 && taskMemory.inspectedFiles.length >= 5);

    if (forceComplete && actionObj.action !== 'complete_task') {
      onEvent({ type: 'override', reason: `iter=${i+1}, inspected=${taskMemory.inspectedFiles.length}, written=${taskMemory.writtenFiles.length}` });
      actionObj = { thought: 'Forced completion.', action: 'complete_task', data: 'Task completed based on gathered context.' };
    }

    // Show thought
    if (actionObj.thought) {
      onEvent({ type: 'thought', text: actionObj.thought });
    }

    // Execute action
    onEvent({ type: 'action_start', action: actionObj.action, data: typeof actionObj.data === 'string' ? actionObj.data.slice(0, 100) : JSON.stringify(actionObj.data).slice(0, 100) });

    let feedback = null;

    switch (actionObj.action) {

      case 'list_files': {
        const filter = (actionObj.data || '').toLowerCase();
        const filtered = filter
          ? taskMemory.knownFiles.filter(f => f.toLowerCase().includes(filter))
          : taskMemory.knownFiles;
        const listing = filtered.length > 0 ? filtered.join('\n') : 'No files found matching: ' + filter;
        onEvent({ type: 'action_result', action: 'list_files', result: listing });
        feedback = 'Directory listing:\n' + listing;
        break;
      }

      case 'inspect_file': {
        const relPath = actionObj.data;
        if (taskMemory.inspectedFiles.includes(relPath)) {
          onEvent({ type: 'action_result', action: 'inspect_file', result: 'Already read: ' + relPath });
          feedback = 'Already inspected that file. Choose a different action.';
        } else {
          taskMemory.inspectedFiles.push(relPath);
          const content = readFile(relPath, workdir);
          onEvent({ type: 'action_result', action: 'inspect_file', result: content, file: relPath });
          feedback = content.startsWith('File not found')
            ? `File "${relPath}" not found. Use an existing file from the tree.`
            : null; // content already in event
        }
        break;
      }

      case 'write_file': {
        let parsed;
        try {
          parsed = typeof actionObj.data === 'object' ? actionObj.data : JSON.parse(actionObj.data);
        } catch(e) {
          onEvent({ type: 'action_result', action: 'write_file', result: 'Error: data must be JSON {path, content}' });
          feedback = 'write_file data must be valid JSON with path and content fields.';
          break;
        }
        const result = writeFile(parsed.path, parsed.content, workdir);
        if (result.startsWith('OK')) taskMemory.writtenFiles.push(parsed.path);
        onEvent({ type: 'action_result', action: 'write_file', result, file: parsed.path, size: (parsed.content||'').length });
        feedback = result.startsWith('OK') ? `Successfully wrote ${parsed.path}. Continue with next step.` : `Write failed: ${result}`;
        break;
      }

      case 'run_command': {
        const cmd = actionObj.data;
        const output = runCommand(cmd, workdir);
        taskMemory.commandsRun.push(cmd);
        if (/npm|yarn|npx|mkdir|touch|git|python|pip|cargo|go/i.test(cmd)) {
          taskMemory.knownFiles = scanDirectory(workdir, workdir);
        }
        onEvent({ type: 'action_result', action: 'run_command', result: output, cmd });
        feedback = 'Command output:\n' + output;
        break;
      }

      case 'request_info': {
        onEvent({ type: 'action_result', action: 'request_info', result: actionObj.data });
        feedback = 'User has not replied. Make a reasonable assumption and continue.';
        break;
      }

      case 'complete_task':
      case 'fix_bug': {
        onEvent({
          type: 'done',
          summary: actionObj.data,
          writtenFiles: taskMemory.writtenFiles,
          commandsRun: taskMemory.commandsRun,
          iterations: i + 1
        });
        return;
      }

      default: {
        onEvent({ type: 'action_result', action: actionObj.action, result: 'Unknown action' });
        feedback = 'Unknown action. Use one of: list_files, inspect_file, write_file, run_command, complete_task.';
      }
    }

    history.push({ role: 'assistant', content: fullResponse });
    if (feedback) history.push({ role: 'user', content: feedback });
  }

  onEvent({ type: 'done', summary: 'Max iterations reached.', writtenFiles: taskMemory.writtenFiles, commandsRun: taskMemory.commandsRun, iterations: MAX_ITER });
}

// ── HTML UI ───────────────────────────────────────────────────────────────────
const HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>BootstrapClaw Agent</title>
<style>
  @import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@300;400;500&family=Syne:wght@400;600;800&display=swap');
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  :root {
    --bg: #0a0a0f; --surface: #12121a; --surface2: #1a1a26; --border: #2a2a3a;
    --accent: #ff6b35; --accent2: #7c3aed; --text: #e8e8f0; --text-dim: #6b6b8a;
    --success: #22c55e; --warn: #f59e0b; --danger: #ef4444; --info: #38bdf8;
  }
  html, body { height: 100%; overflow: hidden; background: var(--bg); color: var(--text); font-family: 'Syne', sans-serif; }

  .app { display: grid; grid-template-rows: auto auto 1fr auto; height: 100vh; }

  /* Top bars */
  .top-bar {
    background: linear-gradient(135deg, #0f0f1a 0%, #1a0f2e 100%);
    border-bottom: 1px solid var(--border);
    padding: 12px 20px; display: flex; align-items: center; gap: 14px;
  }
  .logo { font-size: 20px; font-weight: 800; display: flex; align-items: center; gap: 8px; }
  .logo-badge { font-size: 10px; background: var(--accent); color: white; padding: 2px 8px; border-radius: 20px; font-weight: 600; letter-spacing: 1px; }

  .workdir-bar {
    background: var(--surface); border-bottom: 1px solid var(--border);
    padding: 8px 20px; display: flex; align-items: center; gap: 10px;
    font-family: 'JetBrains Mono', monospace; font-size: 12px;
  }
  .workdir-label { color: var(--text-dim); flex-shrink: 0; }
  .workdir-input {
    flex: 1; background: var(--surface2); border: 1px solid var(--border); border-radius: 6px;
    color: var(--text); font-family: 'JetBrains Mono', monospace; font-size: 12px;
    padding: 6px 10px; outline: none; transition: border-color 0.2s;
  }
  .workdir-input:focus { border-color: var(--accent); }
  .provider-badge { color: var(--text-dim); font-size: 11px; margin-left: auto; }
  .provider-name { color: var(--accent); }

  /* Agent output area */
  .output { flex: 1; overflow-y: auto; padding: 20px; display: flex; flex-direction: column; gap: 10px; }
  .output::-webkit-scrollbar { width: 4px; }
  .output::-webkit-scrollbar-thumb { background: var(--border); border-radius: 2px; }

  /* Welcome */
  .welcome { display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100%; gap: 14px; color: var(--text-dim); text-align: center; }
  .welcome-icon { font-size: 52px; }
  .welcome h2 { font-size: 22px; font-weight: 800; color: var(--text); }
  .welcome p { font-size: 13px; line-height: 1.6; max-width: 440px; font-family: 'JetBrains Mono', monospace; }
  .welcome-examples { display: flex; flex-direction: column; gap: 8px; margin-top: 4px; }
  .example { background: var(--surface2); border: 1px solid var(--border); border-radius: 6px; padding: 8px 14px; font-family: 'JetBrains Mono', monospace; font-size: 12px; color: var(--text-dim); cursor: pointer; text-align: left; transition: all 0.15s; }
  .example:hover { border-color: var(--accent); color: var(--accent); }

  /* User task bubble */
  .task-bubble {
    background: #1e1a2e; border: 1px solid #2d2040; border-radius: 12px; border-top-right-radius: 3px;
    padding: 12px 16px; font-family: 'JetBrains Mono', monospace; font-size: 13px; line-height: 1.6;
    align-self: flex-end; max-width: 80%; animation: fadeIn 0.2s ease;
  }

  /* Agent event cards */
  .event { border-radius: 8px; font-family: 'JetBrains Mono', monospace; font-size: 12px; line-height: 1.6; animation: fadeIn 0.15s ease; }
  @keyframes fadeIn { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: translateY(0); } }

  .event-iteration {
    color: var(--text-dim); font-size: 10px; letter-spacing: 2px; text-transform: uppercase;
    padding: 4px 0; border-bottom: 1px solid var(--border); margin: 6px 0 4px;
  }

  .event-thinking {
    display: flex; gap: 5px; padding: 8px 12px; background: var(--surface2);
    border: 1px solid var(--border); border-radius: 8px; align-items: center; color: var(--text-dim);
  }
  .dot { width: 5px; height: 5px; border-radius: 50%; background: var(--accent); animation: pulse 1.2s infinite; }
  .dot:nth-child(2) { animation-delay: 0.2s; background: var(--accent2); }
  .dot:nth-child(3) { animation-delay: 0.4s; }
  @keyframes pulse { 0%,100% { opacity: 0.3; transform: scale(0.8); } 50% { opacity: 1; transform: scale(1.1); } }

  .event-provider { color: var(--text-dim); font-size: 11px; padding: 2px 0; }
  .event-provider span { color: var(--accent); }

  .event-thought {
    background: #0f0f1a; border: 1px solid #1a1a30; border-radius: 8px;
    padding: 10px 14px; color: #8888aa; font-style: italic;
  }
  .event-thought::before { content: '💭 '; font-style: normal; }

  .event-llm { color: var(--text-dim); font-size: 11px; padding: 2px 8px; }
  .cursor { display: inline-block; width: 2px; height: 12px; background: var(--accent); margin-left: 1px; animation: blink 0.8s infinite; vertical-align: middle; }
  @keyframes blink { 0%,100% { opacity: 1; } 50% { opacity: 0; } }

  .event-action {
    display: flex; align-items: flex-start; gap: 8px;
    padding: 8px 12px; border-radius: 8px; border: 1px solid var(--border);
  }
  .action-read   { background: rgba(56,189,248,0.05); border-color: rgba(56,189,248,0.2); }
  .action-write  { background: rgba(34,197,94,0.05);  border-color: rgba(34,197,94,0.2); }
  .action-run    { background: rgba(245,158,11,0.05); border-color: rgba(245,158,11,0.2); }
  .action-info   { background: rgba(124,58,237,0.05); border-color: rgba(124,58,237,0.2); }
  .action-list   { background: rgba(100,100,150,0.05); border-color: rgba(100,100,150,0.2); }

  .action-icon { font-size: 14px; flex-shrink: 0; margin-top: 1px; }
  .action-body { flex: 1; min-width: 0; }
  .action-label { font-weight: 600; font-size: 11px; text-transform: uppercase; letter-spacing: 1px; margin-bottom: 3px; }
  .action-read .action-label   { color: var(--info); }
  .action-write .action-label  { color: var(--success); }
  .action-run .action-label    { color: var(--warn); }
  .action-info .action-label   { color: var(--accent2); }
  .action-list .action-label   { color: var(--text-dim); }
  .action-data { color: var(--text); word-break: break-all; }

  .event-result {
    background: #0a0a0e; border: 1px solid var(--border); border-radius: 6px;
    padding: 10px 12px; white-space: pre-wrap; word-break: break-all;
    color: var(--text-dim); font-size: 11px; max-height: 200px; overflow-y: auto;
    margin-top: 4px;
  }

  .event-scan {
    color: var(--text-dim); font-size: 11px; padding: 4px 8px;
    border-left: 2px solid var(--border);
  }
  .event-scan span { color: var(--text); }

  .event-done {
    background: rgba(34,197,94,0.08); border: 1px solid rgba(34,197,94,0.3);
    border-radius: 10px; padding: 16px; margin-top: 8px;
  }
  .done-title { color: var(--success); font-size: 14px; font-weight: 600; margin-bottom: 10px; }
  .done-summary { color: var(--text); margin-bottom: 10px; line-height: 1.6; }
  .done-files { color: var(--success); font-size: 11px; }
  .done-commands { color: var(--warn); font-size: 11px; margin-top: 4px; }

  .event-error {
    background: rgba(239,68,68,0.08); border: 1px solid rgba(239,68,68,0.3);
    border-radius: 8px; padding: 10px 14px; color: var(--danger);
  }

  .event-override {
    color: var(--warn); font-size: 11px; padding: 3px 8px;
    border-left: 2px solid var(--warn); background: rgba(245,158,11,0.05);
  }

  /* Input area */
  .input-area {
    padding: 14px 20px 18px; border-top: 1px solid var(--border);
    background: var(--surface); flex-shrink: 0;
  }
  .input-row { display: flex; gap: 10px; align-items: flex-end; }
  .input-wrap { flex: 1; }
  textarea#taskInput {
    width: 100%; background: var(--surface2); border: 1px solid var(--border); border-radius: 10px;
    color: var(--text); font-family: 'JetBrains Mono', monospace; font-size: 13px;
    padding: 12px 16px; resize: none; min-height: 50px; max-height: 150px; line-height: 1.5;
    outline: none; transition: border-color 0.2s; overflow-y: auto;
  }
  textarea#taskInput:focus { border-color: var(--accent); }
  textarea#taskInput::placeholder { color: var(--text-dim); }
  .send-btn {
    width: 48px; height: 48px; background: var(--accent); border: none; border-radius: 10px;
    color: white; font-size: 18px; cursor: pointer; flex-shrink: 0; transition: all 0.15s;
    display: flex; align-items: center; justify-content: center;
  }
  .send-btn:hover { background: #ff8555; transform: scale(1.05); }
  .send-btn:disabled { background: var(--border); cursor: not-allowed; transform: none; }
  .input-hint { font-family: 'JetBrains Mono', monospace; font-size: 10px; color: var(--text-dim); margin-top: 6px; }

  body::before { content: ''; position: fixed; inset: 0; pointer-events: none; z-index: 100; background-image: url("data:image/svg+xml,%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='noise'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23noise)' opacity='0.04'/%3E%3C/svg%3E"); opacity: 0.35; }
</style>
</head>
<body>
<div class="app">

  <!-- TOP BAR -->
  <div class="top-bar">
    <div class="logo">🦞 BootstrapClaw <span class="logo-badge">AGENT</span></div>
    <div style="margin-left:auto;font-family:'JetBrains Mono',monospace;font-size:10px;color:var(--text-dim);">
      Autonomous coding · Real streaming · File R/W · Shell execution
    </div>
  </div>

  <!-- WORKDIR BAR -->
  <div class="workdir-bar">
    <span class="workdir-label">📁 Working dir:</span>
    <input class="workdir-input" id="workdirInput" value="${DEFAULT_DIR}" placeholder="/path/to/project">
    <div class="provider-badge">Provider: <span class="provider-name" id="providerName">Ready</span></div>
  </div>

  <!-- OUTPUT -->
  <div class="output" id="output">
    <div class="welcome" id="welcome">
      <div class="welcome-icon">🤖</div>
      <h2>Coding Agent</h2>
      <p>Describe any coding task. The agent reads files, writes code, and runs commands — streaming every step in real time.</p>
      <div class="welcome-examples">
        <div class="example" onclick="useExample(this)">Build hashnode-publish.js that mirrors devto-publish.js</div>
        <div class="example" onclick="useExample(this)">Add /pause and /resume Telegram commands to bootstrapclaw-core.js</div>
        <div class="example" onclick="useExample(this)">Create model-health-check.js that pings all provider endpoints</div>
        <div class="example" onclick="useExample(this)">Explain what bootstrapclaw-core.js does and list all Telegram commands</div>
      </div>
    </div>
  </div>

  <!-- INPUT -->
  <div class="input-area">
    <div class="input-row">
      <div class="input-wrap">
        <textarea id="taskInput" placeholder="Describe your coding task..." rows="1"></textarea>
      </div>
      <button class="send-btn" id="sendBtn" onclick="runTask()" title="Ctrl+Enter">➤</button>
    </div>
    <div class="input-hint">Ctrl+Enter to run · Agent reads/writes files and runs commands · Streams every step live</div>
  </div>
</div>

<script>
  let isRunning = false;
  let currentLLMEl = null;
  let currentLLMText = '';

  const taskInput = document.getElementById('taskInput');
  taskInput.addEventListener('input', () => {
    taskInput.style.height = 'auto';
    taskInput.style.height = Math.min(taskInput.scrollHeight, 150) + 'px';
  });
  taskInput.addEventListener('keydown', e => {
    if (e.ctrlKey && e.key === 'Enter') { e.preventDefault(); runTask(); }
  });

  function useExample(el) {
    taskInput.value = el.textContent;
    taskInput.style.height = 'auto';
    taskInput.style.height = Math.min(taskInput.scrollHeight, 150) + 'px';
    taskInput.focus();
  }

  function getOutput() { return document.getElementById('output'); }

  function addEl(html, cls = '') {
    const welcome = document.getElementById('welcome');
    if (welcome) welcome.remove();
    const out = getOutput();
    const div = document.createElement('div');
    div.className = 'event ' + cls;
    div.innerHTML = html;
    out.appendChild(div);
    out.scrollTop = out.scrollHeight;
    return div;
  }

  function addTaskBubble(text) {
    const welcome = document.getElementById('welcome');
    if (welcome) welcome.remove();
    const out = getOutput();
    const div = document.createElement('div');
    div.className = 'task-bubble';
    div.textContent = text;
    out.appendChild(div);
    out.scrollTop = out.scrollHeight;
  }

  function handleEvent(data) {
    const out = getOutput();

    switch(data.type) {

      case 'scan':
        addEl('<span>📁 Scanned working directory — <span>' + data.count + ' file(s)</span> found</span>', 'event-scan');
        break;

      case 'iteration':
        currentLLMEl = null; currentLLMText = '';
        addEl('ITERATION ' + data.n + ' / ' + data.max, 'event-iteration');
        break;

      case 'thinking':
        addEl('<div class="dot"></div><div class="dot"></div><div class="dot"></div><span style="margin-left:6px;font-size:11px;">Thinking...</span>', 'event-thinking');
        break;

      case 'provider':
        document.getElementById('providerName').textContent = data.provider;
        // Remove thinking indicator
        const thinking = out.querySelector('.event-thinking');
        if (thinking) thinking.remove();
        // Start LLM stream display
        currentLLMText = '';
        currentLLMEl = addEl('', 'event-llm');
        currentLLMEl.innerHTML = '<span class="cursor"></span>';
        break;

      case 'provider_fail':
        addEl('⚠ ' + data.provider + ' failed — trying next...', 'event-error');
        break;

      case 'llm_chunk':
        if (currentLLMEl) {
          currentLLMText += data.content;
          // Show raw stream but keep it short (thought will be shown separately)
          const preview = currentLLMText.slice(0, 120).replace(/</g,'&lt;').replace(/>/g,'&gt;');
          currentLLMEl.innerHTML = '<span style="color:#44445a">' + preview + (currentLLMText.length > 120 ? '...' : '') + '</span><span class="cursor"></span>';
          out.scrollTop = out.scrollHeight;
        }
        break;

      case 'thought':
        // Replace the raw stream with the formatted thought
        if (currentLLMEl) { currentLLMEl.remove(); currentLLMEl = null; }
        addEl(escHtml(data.text), 'event-thought');
        break;

      case 'parse_error':
        if (currentLLMEl) { currentLLMEl.remove(); currentLLMEl = null; }
        addEl('⚠ JSON parse failed — retrying...', 'event-error');
        break;

      case 'action_start': {
        const icons = { inspect_file: '📂', write_file: '✍️', run_command: '🔧', list_files: '📋', request_info: '❓', complete_task: '✅' };
        const labels = { inspect_file: 'Reading file', write_file: 'Writing file', run_command: 'Running command', list_files: 'Listing files', request_info: 'Question', complete_task: 'Completing' };
        const classes = { inspect_file: 'action-read', write_file: 'action-write', run_command: 'action-run', list_files: 'action-list', request_info: 'action-info' };
        const icon = icons[data.action] || '⚙️';
        const label = labels[data.action] || data.action;
        const cls = classes[data.action] || '';
        addEl(
          '<div class="action-icon">' + icon + '</div>' +
          '<div class="action-body">' +
            '<div class="action-label">' + label + '</div>' +
            '<div class="action-data">' + escHtml(data.data) + '</div>' +
          '</div>',
          'event-action ' + cls
        );
        break;
      }

      case 'action_result': {
        if (!data.result) break;
        const el = addEl('<div class="event-result">' + escHtml(data.result) + '</div>');
        // Add file size info for writes
        if (data.action === 'write_file' && data.size) {
          el.innerHTML += '<div style="color:var(--success);font-size:10px;margin-top:4px;">' + data.size + ' chars written</div>';
        }
        break;
      }

      case 'override':
        addEl('⚠ Hard override: forcing completion (' + data.reason + ')', 'event-override');
        break;

      case 'done': {
        let html = '<div class="done-title">✅ Task Complete</div>';
        html += '<div class="done-summary">' + escHtml(data.summary || '') + '</div>';
        if (data.writtenFiles?.length > 0) {
          html += '<div class="done-files">Files written: ' + data.writtenFiles.map(f => '• ' + f).join(' ') + '</div>';
        }
        if (data.commandsRun?.length > 0) {
          html += '<div class="done-commands">Commands run: ' + data.commandsRun.map(c => '$ ' + c).join(' · ') + '</div>';
        }
        html += '<div style="color:var(--text-dim);font-size:10px;margin-top:6px;">' + data.iterations + ' iterations</div>';
        addEl(html, 'event-done');
        break;
      }

      case 'error':
        addEl('❌ ' + escHtml(data.message), 'event-error');
        break;
    }
  }

  function escHtml(text) {
    return String(text || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/\\n/g,'<br>');
  }

  async function runTask() {
    const task = taskInput.value.trim();
    if (!task || isRunning) return;

    const workdir = document.getElementById('workdirInput').value.trim() || '${DEFAULT_DIR}';

    isRunning = true;
    document.getElementById('sendBtn').disabled = true;
    taskInput.value = '';
    taskInput.style.height = 'auto';
    currentLLMEl = null;
    currentLLMText = '';

    addTaskBubble(task);

    try {
      const response = await fetch('/agent/stream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ task, workdir })
      });

      if (!response.ok) throw new Error('Server error ' + response.status);

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split('\\n');
        buf = lines.pop();
        for (const line of lines) {
          const t = line.trim();
          if (!t.startsWith('data:')) continue;
          try { handleEvent(JSON.parse(t.slice(5).trim())); } catch(e) {}
        }
      }
    } catch(e) {
      addEl('❌ Connection error: ' + e.message, 'event-error');
    } finally {
      isRunning = false;
      document.getElementById('sendBtn').disabled = false;
      taskInput.focus();
    }
  }
</script>
</body>
</html>`;

// ── HTTP SERVER ───────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  // Serve UI
  if (req.method === 'GET' && req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(HTML);
    return;
  }

  // Agent streaming endpoint
  if (req.method === 'POST' && req.url === '/agent/stream') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', async () => {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no'
      });

      try {
        const { task, workdir } = JSON.parse(body);
        const wd = (workdir || DEFAULT_DIR).trim();

        await runAgent(task, wd, event => {
          res.write('data: ' + JSON.stringify(event) + '\n\n');
        });

      } catch(e) {
        res.write('data: ' + JSON.stringify({ type: 'error', message: e.message }) + '\n\n');
      } finally {
        res.end();
      }
    });
    return;
  }

  res.writeHead(404); res.end('Not found');
});

server.listen(PORT, '0.0.0.0', () => {
  console.log('[BootstrapClaw Agent] Running on http://0.0.0.0:' + PORT);
  console.log('[BootstrapClaw Agent] Open in browser: http://YOUR_CONTAINER_IP:' + PORT);
});
