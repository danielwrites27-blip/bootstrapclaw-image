#!/usr/bin/env node
'use strict';

const https = require('https');
const http  = require('http');
const fs    = require('fs');
const path  = require('path');

const PORT = 3000;

// ── GITHUB AUTO-FETCH FILES ───────────────────────────────────────────────────
const GITHUB_RAW = 'https://raw.githubusercontent.com/danielwrites27-blip/bootstrapclaw-image/main/';
const AUTO_FETCH_FILES = [
  'bootstrapclaw-core.js',
  'startup.sh',
  'lint-prompts.js'
];

async function fetchGithubFile(filename) {
  return new Promise((resolve) => {
    const url = GITHUB_RAW + filename;
    https.get(url, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        if (res.statusCode === 200) resolve({ name: filename, content: data });
        else resolve({ name: filename, content: null });
      });
    }).on('error', () => resolve({ name: filename, content: null }));
  });
}

// Fetch all auto-files at startup, cache them, refresh every 5 minutes
let autoFetchedContext = '';
let autoFetchStatus = [];

async function refreshAutoFiles() {
  console.log('[Chat] Fetching latest files from GitHub...');
  const results = await Promise.all(AUTO_FETCH_FILES.map(fetchGithubFile));
  autoFetchStatus = results.map(r => ({ name: r.name, ok: !!r.content }));
  const sections = results.filter(r => r.content).map(r =>
    `=== ${r.name} (live from GitHub) ===\n${r.content}`
  );
  if (sections.length > 0) {
    autoFetchedContext = '\n\n--- LIVE GITHUB FILES (auto-fetched) ---\n' +
      sections.join('\n\n') +
      '\n--- END LIVE GITHUB FILES ---\n';
    console.log('[Chat] Auto-fetched: ' + autoFetchStatus.filter(s=>s.ok).map(s=>s.name).join(', '));
  } else {
    autoFetchedContext = '';
    console.log('[Chat] Warning: Could not fetch any GitHub files');
  }
}

// Initial fetch + refresh every 5 minutes
refreshAutoFiles();
setInterval(refreshAutoFiles, 5 * 60 * 1000);

// ── HARDCODED STANDING RULES ──────────────────────────────────────────────────
const STANDING_RULES = `
=== BOOTSTRAPCLAW STANDING RULES — READ BEFORE EVERY RESPONSE ===

DEPLOYMENT RULES (never suggest otherwise):
- ALL code changes go via GitHub web UI edit → curl pull to container
- NEVER paste complex JS into SSH terminal (heredoc breaks with backticks/special chars)
- NEVER suggest editing files directly in the container without a GitHub commit first
- Pull command: curl -s -o /root/bootstrapclaw/<file> https://raw.githubusercontent.com/danielwrites27-blip/bootstrapclaw-image/main/<file>

PIPELINE SAFETY RULES:
- ALWAYS check Cerebras RPD before suggesting any /run command (14,400 RPD/day, resets 00:00 UTC / 05:30 IST)
- NEVER suggest running pipeline when RPD is unknown or low
- NEVER suggest testing with known bugs unfixed — fix first, test once cleanly
- Backup before major changes: tar -czf /root/.openclaw/backup-pre-sessionXX-$(date +%Y%m%d).tar.gz /root/bootstrapclaw/

PERMANENTLY BLOCKED / DEAD PROVIDERS (never suggest these):
- Mistral — permanently network-blocked on run.claw.cloud (TLS handshake drops silently)
- groq/llama-3.3-70b-versatile — retired, tool calling fails
- gpt-oss:120b on Ollama — times out silently (too large)
- minimax-m2.7 via Ollama — returns empty content (thinking model, content in reasoning field)
- NVIDIA nemotron-ultra-253b — reasoning model, content in reasoning_content not content field

ACTIVE PROVIDER STACK (pipeline only — chat server uses separate keys):
- Phase 1 researcher: sambanova / Meta-Llama-3.3-70B-Instruct (no provider prefix in API call)
- Phase 2 writer: sambanova / Qwen3-235B
- Phase 2.5 humanizer: groq / moonshotai/kimi-k2-instruct
- Phase 3 reporter: groq / moonshotai/kimi-k2-instruct
- Orchestrator: cerebras / qwen-3-235b-a22b-instruct-2507
- Fallback: ollama / gemma3:27b

CONTAINER FACTS:
- RAM: 2GB enforced (not 4GB). Real RAM: grep '^anon ' /sys/fs/cgroup/memory.stat
- free -m shows 126GB host RAM — completely useless, never suggest it
- Disk: df /root/.openclaw (not df /)
- Persistent volume: /root/.openclaw (survives restarts)
- /root/bootstrapclaw/ is wiped on pod restart — startup.sh repopulates it

ARCHITECTURE RULES:
- bootstrapclaw-core.js is the ONLY orchestrator — OpenClaw/AlphaClaw fully deprecated
- Three phases with disk handoff: research.json → article.json → Dev.to
- subagents/runs.json must be wiped on every clean restart (stale entries cause retry loops)
- Never trust bot self-reporting — always verify against filesystem and logs
- sed with complex quoting fails on this container — use python3 heredoc instead

CURRENT STATE (Session 35 complete):
- 14 articles published to Dev.to (daniel_writes_27)
- Validator: 7/7 checks including no em dashes
- Humanizer: Phase 2.5 with 25 anti-AI patterns via groq/kimi
- Topic deduplication: exact match + 40% semantic word overlap
- Chat server: this server, using PUTER_AUTH_TOKEN / CEREBRAS_API_KEY_CHAT / GROQ_API_KEY_CHAT (separate from pipeline)
- startup.sh: auto-pulls bootstrapclaw-core.js and chat-server.js from GitHub on every pod restart

SESSION 36 PRIORITIES (in order):
1. Amazon Associates setup (user-side) + affiliate links in writer prompt
2. Hashnode as second publishing platform (hashnode-publish.js)
3. Remaining Telegram commands: /pause /resume /draft /approve /reject

=== END STANDING RULES ===
`;

// ── PROVIDER CHAIN ────────────────────────────────────────────────────────────
const PROVIDERS = [
  {
    name: 'Puter / MiniMax M2.7',
    url: 'https://api.puter.com/puterai/openai/v1/chat/completions',
    key: () => process.env.PUTER_AUTH_TOKEN,
    model: 'minimax/minimax-m2.7',
    maxTokens: 4096
  },
  {
    name: 'Cerebras / Qwen3-235B',
    url: 'https://api.cerebras.ai/v1/chat/completions',
    key: () => process.env.CEREBRAS_API_KEY_CHAT,
    model: 'qwen-3-235b-a22b-instruct-2507',
    maxTokens: 4096
  },
  {
    name: 'Groq / Kimi K2',
    url: 'https://api.groq.com/openai/v1/chat/completions',
    key: () => process.env.GROQ_API_KEY_CHAT,
    model: 'moonshotai/kimi-k2-instruct',
    maxTokens: 4096
  }
];

// ── LLM CALLER ────────────────────────────────────────────────────────────────
async function callLLM(messages) {
  for (const p of PROVIDERS) {
    const apiKey = p.key();
    if (!apiKey) continue;
    try {
      const body = JSON.stringify({ model: p.model, messages, max_tokens: p.maxTokens, temperature: 0.7 });
      const result = await new Promise((resolve, reject) => {
        const url = new URL(p.url);
        const req = https.request({
          hostname: url.hostname,
          path: url.pathname,
          method: 'POST',
          headers: {
            'Authorization': 'Bearer ' + apiKey,
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(body)
          }
        }, res => {
          let data = '';
          res.on('data', c => data += c);
          res.on('end', () => {
            try { resolve(JSON.parse(data)); }
            catch(e) { reject(new Error('JSON parse failed')); }
          });
        });
        req.on('error', reject);
        req.setTimeout(60000, () => { req.destroy(); reject(new Error('Timeout')); });
        req.write(body);
        req.end();
      });
      const content = result?.choices?.[0]?.message?.content;
      if (content && content.trim()) return { content: content.trim(), provider: p.name };
    } catch(e) {
      console.error('[LLM] ' + p.name + ' failed: ' + e.message);
    }
  }
  throw new Error('All providers failed');
}

// ── HTML UI ───────────────────────────────────────────────────────────────────
const HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>BootstrapClaw Chat</title>
<style>
  @import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@300;400;500&family=Syne:wght@400;600;800&display=swap');

  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

  :root {
    --bg: #0a0a0f;
    --surface: #12121a;
    --surface2: #1a1a26;
    --border: #2a2a3a;
    --accent: #ff6b35;
    --accent2: #7c3aed;
    --text: #e8e8f0;
    --text-dim: #6b6b8a;
    --user-bg: #1e1a2e;
    --ai-bg: #111118;
    --success: #22c55e;
    --warn: #f59e0b;
    --danger: #ef4444;
  }

  html, body { height: 100%; overflow: hidden; background: var(--bg); color: var(--text); font-family: 'Syne', sans-serif; }

  .app { display: grid; grid-template-columns: 280px 1fr; grid-template-rows: 1fr; height: 100vh; }

  /* ── WARNING BANNER ── */
  .warning-banner {
    grid-column: 1 / -1;
    background: linear-gradient(90deg, #2d1200, #1a0a00);
    border-bottom: 1px solid #ff6b3540;
    padding: 7px 20px;
    font-family: 'JetBrains Mono', monospace;
    font-size: 11px;
    color: var(--warn);
    display: flex;
    align-items: center;
    gap: 10px;
    flex-shrink: 0;
  }
  .warning-banner strong { color: #ff6b35; }
  .warning-banner span { color: var(--text-dim); margin-left: auto; font-size: 10px; }

  /* Layout with banner */
  .app {
    display: grid;
    grid-template-columns: 280px 1fr;
    grid-template-rows: auto 1fr;
    height: 100vh;
  }
  .warning-banner { grid-column: 1 / -1; grid-row: 1; }
  .sidebar { grid-row: 2; }
  .chat-area { grid-row: 2; }

  /* Sidebar */
  .sidebar {
    background: var(--surface);
    border-right: 1px solid var(--border);
    display: flex; flex-direction: column;
    overflow: hidden;
  }

  .sidebar-header {
    padding: 20px;
    border-bottom: 1px solid var(--border);
    background: linear-gradient(135deg, #0f0f1a 0%, #1a0f2e 100%);
  }

  .logo { display: flex; align-items: center; gap: 10px; font-size: 18px; font-weight: 800; letter-spacing: -0.5px; }
  .logo-icon { font-size: 24px; }
  .logo-sub { font-size: 10px; font-weight: 400; color: var(--text-dim); letter-spacing: 2px; text-transform: uppercase; margin-top: 2px; font-family: 'JetBrains Mono', monospace; }

  .sidebar-section { padding: 16px 20px 8px; font-size: 10px; font-weight: 600; letter-spacing: 2px; text-transform: uppercase; color: var(--text-dim); font-family: 'JetBrains Mono', monospace; }

  /* Auto-fetch status */
  .autofetch-status {
    padding: 0 12px 10px;
    font-family: 'JetBrains Mono', monospace;
    font-size: 10px;
  }
  .autofetch-item {
    display: flex; align-items: center; gap: 6px;
    padding: 4px 8px; border-radius: 4px;
    margin-bottom: 3px; color: var(--text-dim);
  }
  .autofetch-item.ok { color: var(--success); }
  .autofetch-item.fail { color: var(--danger); }
  .autofetch-refresh {
    margin-top: 6px; padding: 5px 8px;
    background: var(--surface2); border: 1px solid var(--border);
    border-radius: 4px; color: var(--text-dim);
    font-family: 'JetBrains Mono', monospace; font-size: 10px;
    cursor: pointer; width: 100%; text-align: center;
  }
  .autofetch-refresh:hover { color: var(--accent); border-color: var(--accent); }

  /* System prompt */
  .system-area { padding: 0 12px 12px; flex-shrink: 0; }
  .system-input {
    width: 100%; background: var(--surface2); border: 1px solid var(--border); border-radius: 8px;
    color: var(--text); font-family: 'JetBrains Mono', monospace; font-size: 11px;
    padding: 10px; resize: vertical; min-height: 60px; max-height: 120px; line-height: 1.5;
    outline: none; transition: border-color 0.2s;
  }
  .system-input:focus { border-color: var(--accent2); }

  /* File upload */
  .upload-area { padding: 0 12px 12px; }
  .upload-btn {
    width: 100%; padding: 10px; background: var(--surface2); border: 1px dashed var(--border);
    border-radius: 8px; color: var(--text-dim); font-family: 'JetBrains Mono', monospace;
    font-size: 11px; cursor: pointer; text-align: center; transition: all 0.2s;
  }
  .upload-btn:hover { border-color: var(--accent); color: var(--accent); background: rgba(255,107,53,0.05); }
  #fileInput { display: none; }

  .files-list { padding: 0 12px; flex: 1; overflow-y: auto; }
  .file-item {
    display: flex; align-items: center; justify-content: space-between;
    padding: 8px 10px; background: var(--surface2); border-radius: 6px;
    margin-bottom: 6px; font-family: 'JetBrains Mono', monospace; font-size: 10px;
    border: 1px solid var(--border);
  }
  .file-name { color: var(--success); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; }
  .file-remove { color: var(--text-dim); cursor: pointer; padding: 0 4px; flex-shrink: 0; }
  .file-remove:hover { color: #ef4444; }

  .provider-display {
    padding: 12px 20px; border-top: 1px solid var(--border);
    font-family: 'JetBrains Mono', monospace; font-size: 10px; color: var(--text-dim); flex-shrink: 0;
  }
  .provider-name { color: var(--accent); font-weight: 500; }

  .controls { padding: 12px; border-top: 1px solid var(--border); flex-shrink: 0; }
  .btn {
    width: 100%; padding: 9px; border: none; border-radius: 7px; font-family: 'Syne', sans-serif;
    font-size: 12px; font-weight: 600; cursor: pointer; transition: all 0.15s; letter-spacing: 0.5px;
  }
  .btn-clear { background: var(--surface2); color: var(--text-dim); border: 1px solid var(--border); }
  .btn-clear:hover { color: var(--text); border-color: var(--text-dim); }

  /* Chat area */
  .chat-area { display: flex; flex-direction: column; overflow: hidden; }

  .messages {
    flex: 1; overflow-y: auto; padding: 24px;
    display: flex; flex-direction: column; gap: 16px; scroll-behavior: smooth;
  }
  .messages::-webkit-scrollbar { width: 4px; }
  .messages::-webkit-scrollbar-track { background: transparent; }
  .messages::-webkit-scrollbar-thumb { background: var(--border); border-radius: 2px; }

  .msg { display: flex; gap: 12px; max-width: 900px; animation: fadeIn 0.2s ease; }
  @keyframes fadeIn { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: translateY(0); } }
  .msg.user { align-self: flex-end; flex-direction: row-reverse; }
  .msg.assistant { align-self: flex-start; }

  .avatar {
    width: 32px; height: 32px; border-radius: 8px; display: flex; align-items: center;
    justify-content: center; font-size: 14px; flex-shrink: 0; margin-top: 2px;
  }
  .msg.user .avatar { background: linear-gradient(135deg, var(--accent2), #9333ea); }
  .msg.assistant .avatar { background: linear-gradient(135deg, #1e3a5f, #0f4c75); }

  .bubble {
    padding: 12px 16px; border-radius: 12px; font-size: 14px; line-height: 1.7;
    max-width: calc(100% - 44px); word-wrap: break-word; font-family: 'JetBrains Mono', monospace;
  }
  .msg.user .bubble { background: var(--user-bg); border: 1px solid #2d2040; border-top-right-radius: 3px; }
  .msg.assistant .bubble { background: var(--ai-bg); border: 1px solid var(--border); border-top-left-radius: 3px; }

  .bubble pre {
    background: #0d0d14; border: 1px solid var(--border); border-radius: 6px;
    padding: 12px; margin: 10px 0; overflow-x: auto; font-size: 12px; line-height: 1.5;
  }
  .bubble code { font-family: 'JetBrains Mono', monospace; font-size: 12px; }
  .bubble p { margin-bottom: 8px; }
  .bubble p:last-child { margin-bottom: 0; }

  .thinking { display: flex; gap: 4px; padding: 14px 16px; align-items: center; }
  .dot { width: 6px; height: 6px; border-radius: 50%; background: var(--accent); animation: pulse 1.2s infinite; }
  .dot:nth-child(2) { animation-delay: 0.2s; background: var(--accent2); }
  .dot:nth-child(3) { animation-delay: 0.4s; }
  @keyframes pulse { 0%,100% { opacity: 0.3; transform: scale(0.8); } 50% { opacity: 1; transform: scale(1.1); } }

  .welcome {
    display: flex; flex-direction: column; align-items: center; justify-content: center;
    height: 100%; gap: 16px; color: var(--text-dim); text-align: center; padding: 40px;
  }
  .welcome-icon { font-size: 48px; }
  .welcome h2 { font-size: 22px; font-weight: 800; color: var(--text); }
  .welcome p { font-size: 13px; line-height: 1.6; max-width: 400px; font-family: 'JetBrains Mono', monospace; }
  .welcome .context-note {
    font-size: 11px; color: var(--success); background: rgba(34,197,94,0.08);
    border: 1px solid rgba(34,197,94,0.2); border-radius: 6px; padding: 8px 14px;
    font-family: 'JetBrains Mono', monospace;
  }

  .input-area {
    padding: 16px 24px 20px; border-top: 1px solid var(--border);
    background: var(--surface); flex-shrink: 0;
  }
  .input-row { display: flex; gap: 10px; align-items: flex-end; }
  .input-wrap { flex: 1; position: relative; }

  textarea#userInput {
    width: 100%; background: var(--surface2); border: 1px solid var(--border);
    border-radius: 10px; color: var(--text); font-family: 'JetBrains Mono', monospace;
    font-size: 13px; padding: 12px 16px; resize: none; min-height: 50px; max-height: 200px;
    line-height: 1.5; outline: none; transition: border-color 0.2s; overflow-y: auto;
  }
  textarea#userInput:focus { border-color: var(--accent); }
  textarea#userInput::placeholder { color: var(--text-dim); }

  .send-btn {
    width: 48px; height: 48px; background: var(--accent); border: none; border-radius: 10px;
    color: white; font-size: 18px; cursor: pointer; flex-shrink: 0; transition: all 0.15s;
    display: flex; align-items: center; justify-content: center;
  }
  .send-btn:hover { background: #ff8555; transform: scale(1.05); }
  .send-btn:active { transform: scale(0.97); }
  .send-btn:disabled { background: var(--border); cursor: not-allowed; transform: none; }

  .input-hint { font-family: 'JetBrains Mono', monospace; font-size: 10px; color: var(--text-dim); margin-top: 8px; }

  .token-bar {
    display: flex; justify-content: space-between; align-items: center;
    padding: 6px 24px; background: var(--surface); border-top: 1px solid var(--border);
    font-family: 'JetBrains Mono', monospace; font-size: 10px; color: var(--text-dim); flex-shrink: 0;
  }
  .token-count { color: var(--warn); }

  body::before {
    content: ''; position: fixed; inset: 0; pointer-events: none; z-index: 100;
    background-image: url("data:image/svg+xml,%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='noise'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23noise)' opacity='0.04'/%3E%3C/svg%3E");
    opacity: 0.35;
  }
</style>
</head>
<body>
<div class="app">

  <!-- WARNING BANNER -->
  <div class="warning-banner">
    ⚠️ <strong>Planning assistant — not an authority.</strong>
    Always deploy via GitHub + curl. Never paste complex JS into SSH. Verify Cerebras RPD before /run.
    <span>Standing rules + live GitHub files auto-loaded</span>
  </div>

  <!-- SIDEBAR -->
  <aside class="sidebar">
    <div class="sidebar-header">
      <div class="logo">
        <span class="logo-icon">🦞</span>
        <div>
          <div>BootstrapClaw</div>
          <div class="logo-sub">AI Chat · Session Assistant</div>
        </div>
      </div>
    </div>

    <div class="sidebar-section">Live GitHub Files</div>
    <div class="autofetch-status" id="autofetchStatus">
      <div class="autofetch-item">⏳ Loading from GitHub...</div>
    </div>

    <div class="sidebar-section">System Prompt</div>
    <div class="system-area">
      <textarea class="system-input" id="systemPrompt" placeholder="Additional context...">You are an expert software engineer helping build and maintain BootstrapClaw. You have the standing rules, live GitHub files, and any uploaded session docs in your context. Always follow the standing rules exactly — especially deployment via GitHub+curl, Cerebras RPD checks, and never suggesting blocked providers. Be precise, direct, and technical.</textarea>
    </div>

    <div class="sidebar-section">Extra Session Files</div>
    <div class="upload-area">
      <label class="upload-btn" for="fileInput">⬆ Upload .md / .txt / .js files</label>
      <input type="file" id="fileInput" multiple accept=".md,.txt,.js,.json,.sh">
    </div>
    <div class="files-list" id="filesList"></div>

    <div style="flex:1"></div>

    <div class="provider-display">
      Provider: <span class="provider-name" id="providerName">Ready</span>
    </div>

    <div class="controls">
      <button class="btn btn-clear" onclick="clearChat()">Clear conversation</button>
    </div>
  </aside>

  <!-- CHAT -->
  <main class="chat-area">
    <div class="messages" id="messages">
      <div class="welcome" id="welcome">
        <div class="welcome-icon">🦞</div>
        <h2>BootstrapClaw Chat</h2>
        <p>Standing rules + live GitHub files are always in context. Upload session .md docs for full project state.</p>
        <div class="context-note" id="contextNote">⏳ Fetching live files from GitHub...</div>
      </div>
    </div>

    <div class="token-bar">
      <span>Messages in context: <span id="msgCount">0</span></span>
      <span>Est. tokens: <span class="token-count" id="tokenCount">0</span></span>
    </div>

    <div class="input-area">
      <div class="input-row">
        <div class="input-wrap">
          <textarea id="userInput" placeholder="Ask anything about BootstrapClaw..." rows="1"></textarea>
        </div>
        <button class="send-btn" id="sendBtn" onclick="sendMessage()" title="Send (Ctrl+Enter)">➤</button>
      </div>
      <div class="input-hint">Ctrl+Enter to send · Standing rules always active · Live GitHub files auto-loaded</div>
    </div>
  </main>
</div>

<script>
  const history = [];
  const loadedFiles = {};
  let githubFilesContext = '';
  let githubFileNames = [];

  // ── AUTO-FETCH GITHUB FILES ON LOAD ────────────────────────────────────────
  const GITHUB_FILES = ['bootstrapclaw-core.js', 'startup.sh', 'lint-prompts.js'];
  const GITHUB_RAW = 'https://raw.githubusercontent.com/danielwrites27-blip/bootstrapclaw-image/main/';

  async function fetchGithubFiles() {
    const statusEl = document.getElementById('autofetchStatus');
    const contextNote = document.getElementById('contextNote');
    statusEl.innerHTML = '<div class="autofetch-item">⏳ Fetching from GitHub...</div>';

    const results = [];
    for (const fname of GITHUB_FILES) {
      try {
        const res = await fetch(GITHUB_RAW + fname);
        if (res.ok) {
          const text = await res.text();
          results.push({ name: fname, content: text, ok: true });
        } else {
          results.push({ name: fname, content: null, ok: false });
        }
      } catch(e) {
        results.push({ name: fname, content: null, ok: false });
      }
    }

    // Build context block
    const loaded = results.filter(r => r.ok);
    if (loaded.length > 0) {
      githubFilesContext = '\\n\\n--- LIVE GITHUB FILES (fetched at session start) ---\\n' +
        loaded.map(r => '=== ' + r.name + ' ===\\n' + r.content).join('\\n\\n') +
        '\\n--- END LIVE GITHUB FILES ---\\n';
      githubFileNames = loaded.map(r => r.name);
    }

    // Render status in sidebar
    statusEl.innerHTML = results.map(r =>
      '<div class="autofetch-item ' + (r.ok ? 'ok' : 'fail') + '">' +
      (r.ok ? '✓' : '✗') + ' ' + r.name + '</div>'
    ).join('') +
    '<button class="autofetch-refresh" onclick="fetchGithubFiles()">↻ Refresh from GitHub</button>';

    // Update welcome note
    if (contextNote) {
      if (loaded.length === GITHUB_FILES.length) {
        contextNote.textContent = '✓ Live files loaded: ' + githubFileNames.join(', ');
        contextNote.style.color = '#22c55e';
      } else if (loaded.length > 0) {
        contextNote.textContent = '⚠ Partial load: ' + githubFileNames.join(', ');
        contextNote.style.color = '#f59e0b';
      } else {
        contextNote.textContent = '✗ Could not fetch GitHub files — upload manually';
        contextNote.style.color = '#ef4444';
      }
    }

    updateStats();
  }

  // Fetch on load
  fetchGithubFiles();

  // ── FILE UPLOAD ────────────────────────────────────────────────────────────
  const input = document.getElementById('userInput');
  input.addEventListener('input', () => {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 200) + 'px';
  });
  input.addEventListener('keydown', e => {
    if (e.ctrlKey && e.key === 'Enter') { e.preventDefault(); sendMessage(); }
  });

  document.getElementById('fileInput').addEventListener('change', async e => {
    for (const file of e.target.files) {
      const text = await file.text();
      loadedFiles[file.name] = text;
      renderFilesList();
    }
    e.target.value = '';
  });

  function renderFilesList() {
    const el = document.getElementById('filesList');
    el.innerHTML = '';
    for (const name of Object.keys(loadedFiles)) {
      const div = document.createElement('div');
      div.className = 'file-item';
      div.innerHTML = \`<span class="file-name">📄 \${name}</span><span class="file-remove" onclick="removeFile('\${name}')">✕</span>\`;
      el.appendChild(div);
    }
  }

  function removeFile(name) { delete loadedFiles[name]; renderFilesList(); }

  // ── BUILD FULL SYSTEM PROMPT ───────────────────────────────────────────────
  // Order: standing rules → live GitHub files → user system prompt → uploaded docs
  function buildSystemPrompt() {
    const STANDING_RULES = \`=== BOOTSTRAPCLAW STANDING RULES — ALWAYS FOLLOW THESE ===

DEPLOYMENT (never suggest otherwise):
- ALL code changes: GitHub web UI edit → curl pull to container
- NEVER paste complex JS into SSH terminal (heredoc breaks with backticks)
- NEVER edit files directly in container without GitHub commit first
- curl pull: curl -s -o /root/bootstrapclaw/<file> https://raw.githubusercontent.com/danielwrites27-blip/bootstrapclaw-image/main/<file>

PIPELINE SAFETY:
- ALWAYS check Cerebras RPD before any /run (14,400/day, resets 00:00 UTC / 05:30 IST)
- NEVER run pipeline when RPD is unknown or low
- NEVER test with known bugs unfixed — fix first, test once cleanly
- Backup: tar -czf /root/.openclaw/backup-pre-sessionXX-\$(date +%Y%m%d).tar.gz /root/bootstrapclaw/

PERMANENTLY BLOCKED PROVIDERS (never suggest):
- Mistral — network-blocked on run.claw.cloud
- groq/llama-3.3-70b-versatile — retired
- gpt-oss:120b on Ollama — times out silently
- minimax-m2.7 via Ollama — returns empty (thinking model)
- NVIDIA nemotron-ultra-253b — content in reasoning_content field, not content

ACTIVE PIPELINE PROVIDERS:
- Phase 1: sambanova / Meta-Llama-3.3-70B-Instruct (no provider prefix in API call)
- Phase 2: sambanova / Qwen3-235B
- Phase 2.5 + Phase 3: groq / moonshotai/kimi-k2-instruct
- Orchestrator: cerebras / qwen-3-235b-a22b-instruct-2507
- Fallback: ollama / gemma3:27b
- CHAT SERVER uses separate keys: PUTER_AUTH_TOKEN, CEREBRAS_API_KEY_CHAT, GROQ_API_KEY_CHAT

CONTAINER FACTS:
- RAM: 2GB enforced. Real RAM: grep '^anon ' /sys/fs/cgroup/memory.stat (free -m shows host RAM, useless)
- Disk: df /root/.openclaw
- Persistent: /root/.openclaw (survives restarts). /root/bootstrapclaw/ is wiped on restart.
- sed with complex quoting fails — use python3 heredoc instead

ARCHITECTURE:
- bootstrapclaw-core.js is the ONLY orchestrator (OpenClaw fully deprecated)
- Phases: research.json → article.json → Dev.to
- Never trust bot self-reporting — verify against filesystem and logs

CURRENT STATE (Session 35):
- 14 articles published, validator 7/7, humanizer Phase 2.5, topic dedup live
- startup.sh auto-pulls bootstrapclaw-core.js and chat-server.js from GitHub on every restart

SESSION 36 PRIORITIES: Amazon Associates + Hashnode publishing + affiliate links in writer prompt

=== END STANDING RULES ===\`;

    let sys = STANDING_RULES;

    // Inject live GitHub files
    if (githubFilesContext) {
      sys += githubFilesContext;
    }

    // User's custom system prompt
    const userPrompt = document.getElementById('systemPrompt').value.trim();
    if (userPrompt) sys += '\\n\\n--- ADDITIONAL CONTEXT ---\\n' + userPrompt;

    // Manually uploaded session docs
    const files = Object.entries(loadedFiles);
    if (files.length > 0) {
      sys += '\\n\\n--- UPLOADED SESSION FILES ---\\n';
      for (const [name, content] of files) {
        sys += '\\n=== ' + name + ' ===\\n' + content + '\\n';
      }
      sys += '\\n--- END OF SESSION FILES ---\\n';
    }

    return sys;
  }

  function estimateTokens(text) { return Math.round(text.length / 4); }

  function updateStats() {
    document.getElementById('msgCount').textContent = history.length;
    const allText = history.map(m => m.content).join(' ') + buildSystemPrompt();
    document.getElementById('tokenCount').textContent = estimateTokens(allText).toLocaleString();
  }

  function addMessage(role, content, isThinking = false) {
    const welcome = document.getElementById('welcome');
    if (welcome) welcome.remove();

    const messages = document.getElementById('messages');
    const div = document.createElement('div');
    div.className = 'msg ' + role;
    div.id = isThinking ? 'thinking' : '';

    const avatar = role === 'user' ? '👤' : '🦞';
    const bubbleContent = isThinking
      ? '<div class="thinking"><div class="dot"></div><div class="dot"></div><div class="dot"></div></div>'
      : formatContent(content);

    div.innerHTML = \`<div class="avatar">\${avatar}</div><div class="bubble">\${bubbleContent}</div>\`;
    messages.appendChild(div);
    messages.scrollTop = messages.scrollHeight;
    return div;
  }

  function formatContent(text) {
    return text
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/\`\`\`(\\w*)?\\n([\\s\\S]*?)\`\`\`/g, '<pre><code>$2</code></pre>')
      .replace(/\`([^\`]+)\`/g, '<code>$1</code>')
      .replace(/\\*\\*([^*]+)\\*\\*/g, '<strong>$1</strong>')
      .replace(/\\n/g, '<br>');
  }

  async function sendMessage() {
    const input = document.getElementById('userInput');
    const text = input.value.trim();
    if (!text) return;

    const sendBtn = document.getElementById('sendBtn');
    sendBtn.disabled = true;
    input.value = '';
    input.style.height = 'auto';

    history.push({ role: 'user', content: text });
    addMessage('user', text);
    updateStats();

    const thinkingDiv = addMessage('assistant', '', true);

    try {
      const messages = [
        { role: 'system', content: buildSystemPrompt() },
        ...history
      ];

      const res = await fetch('/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages })
      });

      if (!res.ok) throw new Error('Server error: ' + res.status);
      const data = await res.json();

      thinkingDiv.remove();
      history.push({ role: 'assistant', content: data.content });
      addMessage('assistant', data.content);
      document.getElementById('providerName').textContent = data.provider;
      updateStats();
    } catch(e) {
      thinkingDiv.remove();
      addMessage('assistant', '❌ Error: ' + e.message);
    } finally {
      sendBtn.disabled = false;
      input.focus();
    }
  }

  function clearChat() {
    if (!confirm('Clear conversation history?')) return;
    history.length = 0;
    const messages = document.getElementById('messages');
    messages.innerHTML = \`<div class="welcome" id="welcome">
      <div class="welcome-icon">🦞</div>
      <h2>BootstrapClaw Chat</h2>
      <p>Standing rules + live GitHub files are always in context. Upload session .md docs for full project state.</p>
      <div class="context-note" style="color:#22c55e;background:rgba(34,197,94,0.08);border:1px solid rgba(34,197,94,0.2);border-radius:6px;padding:8px 14px;font-family:JetBrains Mono,monospace;font-size:11px;">
        ✓ Files in context: \${githubFileNames.length > 0 ? githubFileNames.join(', ') : 'none — refresh from sidebar'}
      </div>
    </div>\`;
    document.getElementById('providerName').textContent = 'Ready';
    updateStats();
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

  if (req.method === 'GET' && req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(HTML);
    return;
  }

  if (req.method === 'POST' && req.url === '/chat') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', async () => {
      try {
        const { messages } = JSON.parse(body);

        // Inject server-side auto-fetched context into system message
        if (autoFetchedContext && messages[0]?.role === 'system') {
          messages[0].content += autoFetchedContext;
        }

        const result = await callLLM(messages);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      } catch(e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  res.writeHead(404); res.end('Not found');
});

server.listen(PORT, '0.0.0.0', () => {
  console.log('[BootstrapClaw Chat] Running on http://0.0.0.0:' + PORT);
  console.log('[BootstrapClaw Chat] Open in browser: http://YOUR_CONTAINER_IP:' + PORT);
});
