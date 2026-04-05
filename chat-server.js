#!/usr/bin/env node
'use strict';

const https = require('https');
const http  = require('http');
const fs    = require('fs');
const path  = require('path');

const PORT = 3000;
const HISTORY_FILE = '/root/.openclaw/bootstrapclaw-data/chat-history.json';

// ── GITHUB AUTO-FETCH ─────────────────────────────────────────────────────────
const GITHUB_RAW = 'https://raw.githubusercontent.com/danielwrites27-blip/bootstrapclaw-image/main/';
const AUTO_FETCH_FILES = ['bootstrapclaw-core.js', 'startup.sh', 'lint-prompts.js'];

async function fetchGithubFile(filename) {
  return new Promise((resolve) => {
    https.get(GITHUB_RAW + filename, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve({ name: filename, content: res.statusCode === 200 ? data : null }));
    }).on('error', () => resolve({ name: filename, content: null }));
  });
}

let autoFetchedContext = '';
let autoFetchStatus = [];

async function refreshAutoFiles() {
  console.log('[Chat] Fetching latest files from GitHub...');
  const results = await Promise.all(AUTO_FETCH_FILES.map(fetchGithubFile));
  autoFetchStatus = results.map(r => ({ name: r.name, ok: !!r.content }));
  const sections = results.filter(r => r.content).map(r => `=== ${r.name} ===\n${r.content}`);
  autoFetchedContext = sections.length > 0
    ? '\n\n--- LIVE GITHUB FILES ---\n' + sections.join('\n\n') + '\n--- END LIVE GITHUB FILES ---\n'
    : '';
  console.log('[Chat] Auto-fetched: ' + autoFetchStatus.filter(s => s.ok).map(s => s.name).join(', '));
}

refreshAutoFiles();
setInterval(refreshAutoFiles, 5 * 60 * 1000);

// ── HISTORY PERSISTENCE (server-side) ─────────────────────────────────────────
function loadHistory() {
  try {
    if (fs.existsSync(HISTORY_FILE)) {
      const data = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
      if (Date.now() - (data.ts || 0) > 24 * 60 * 60 * 1000) return [];
      return data.history || [];
    }
  } catch(e) {}
  return [];
}

function saveHistory(history) {
  try {
    fs.writeFileSync(HISTORY_FILE, JSON.stringify({ ts: Date.now(), history }), 'utf8');
  } catch(e) { console.error('[Chat] History save failed:', e.message); }
}

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

// ── STREAMING LLM ─────────────────────────────────────────────────────────────
async function streamLLM(messages, res) {
  for (const p of PROVIDERS) {
    const apiKey = p.key();
    if (!apiKey) continue;
    try {
      const body = JSON.stringify({
        model: p.model, messages,
        max_tokens: p.maxTokens, temperature: 0.7, stream: true
      });

      await new Promise((resolve, reject) => {
        const url = new URL(p.url);
        const req = https.request({
          hostname: url.hostname, path: url.pathname, method: 'POST',
          headers: {
            'Authorization': 'Bearer ' + apiKey,
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(body)
          }
        }, (provRes) => {
          if (provRes.statusCode !== 200) { provRes.resume(); reject(new Error('HTTP ' + provRes.statusCode)); return; }

          // Send provider name to client first
          res.write(`data: ${JSON.stringify({ type: 'provider', provider: p.name })}\n\n`);

          let buffer = '';
          provRes.on('data', chunk => {
            buffer += chunk.toString();
            const lines = buffer.split('\n');
            buffer = lines.pop();
            for (const line of lines) {
              const trimmed = line.trim();
              if (!trimmed.startsWith('data:')) continue;
              const raw = trimmed.slice(5).trim();
              if (raw === '[DONE]') { res.write(`data: ${JSON.stringify({ type: 'done' })}\n\n`); resolve(); return; }
              try {
                const parsed = JSON.parse(raw);
                const content = parsed?.choices?.[0]?.delta?.content;
                if (content) res.write(`data: ${JSON.stringify({ type: 'chunk', content })}\n\n`);
              } catch(e) {}
            }
          });
          provRes.on('end', () => { res.write(`data: ${JSON.stringify({ type: 'done' })}\n\n`); resolve(); });
          provRes.on('error', reject);
        });
        req.on('error', reject);
        req.setTimeout(60000, () => { req.destroy(); reject(new Error('Timeout')); });
        req.write(body);
        req.end();
      });

      return; // success — stop trying providers

    } catch(e) {
      console.error('[LLM Stream] ' + p.name + ' failed: ' + e.message);
    }
  }
  throw new Error('All providers failed');
}

// ── STANDING RULES ────────────────────────────────────────────────────────────
const STANDING_RULES = `=== BOOTSTRAPCLAW STANDING RULES — ALWAYS FOLLOW THESE ===

DEPLOYMENT (never suggest otherwise):
- ALL code changes: GitHub web UI edit → curl pull to container
- NEVER paste complex JS into SSH terminal (heredoc breaks with backticks)
- NEVER edit files directly in container without GitHub commit first
- curl pull: curl -s -o /root/bootstrapclaw/<file> https://raw.githubusercontent.com/danielwrites27-blip/bootstrapclaw-image/main/<file>

PIPELINE SAFETY:
- ALWAYS check Cerebras RPD before any /run (14,400/day, resets 00:00 UTC / 05:30 IST)
- NEVER run pipeline when RPD is unknown or low
- NEVER test with known bugs unfixed — fix first, test once cleanly
- Backup: tar -czf /root/.openclaw/backup-pre-sessionXX-$(date +%Y%m%d).tar.gz /root/bootstrapclaw/

PERMANENTLY BLOCKED PROVIDERS (never suggest):
- Mistral — network-blocked on run.claw.cloud
- groq/llama-3.3-70b-versatile — retired
- gpt-oss:120b on Ollama — times out silently
- minimax-m2.7 via Ollama — returns empty (thinking model)
- NVIDIA nemotron-ultra-253b — content in reasoning_content not content

ACTIVE PIPELINE PROVIDERS:
- Phase 1: sambanova / Meta-Llama-3.3-70B-Instruct (no provider prefix in API call)
- Phase 2: sambanova / Qwen3-235B
- Phase 2.5 + Phase 3: groq / moonshotai/kimi-k2-instruct
- Orchestrator: cerebras / qwen-3-235b-a22b-instruct-2507
- Fallback: ollama / gemma3:27b
- CHAT SERVER uses separate keys: PUTER_AUTH_TOKEN, CEREBRAS_API_KEY_CHAT, GROQ_API_KEY_CHAT

CONTAINER FACTS:
- RAM: 2GB enforced. Real RAM: grep '^anon ' /sys/fs/cgroup/memory.stat (free -m useless)
- Disk: df /root/.openclaw. Persistent: /root/.openclaw. /root/bootstrapclaw/ wiped on restart.
- sed with complex quoting fails — use python3 heredoc instead

ARCHITECTURE:
- bootstrapclaw-core.js is the ONLY orchestrator (OpenClaw fully deprecated)
- Three phases: research.json → article.json → Dev.to
- Never trust bot self-reporting — verify against filesystem and logs

CURRENT STATE (Session 35 complete):
- 14 articles published, validator 7/7, humanizer Phase 2.5, topic dedup live
- startup.sh auto-pulls bootstrapclaw-core.js and chat-server.js on every restart

SESSION 36 PRIORITIES: Amazon Associates + Hashnode publishing + affiliate links in writer prompt

=== END STANDING RULES ===`;

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
    --bg: #0a0a0f; --surface: #12121a; --surface2: #1a1a26; --border: #2a2a3a;
    --accent: #ff6b35; --accent2: #7c3aed; --text: #e8e8f0; --text-dim: #6b6b8a;
    --user-bg: #1e1a2e; --ai-bg: #111118; --success: #22c55e; --warn: #f59e0b; --danger: #ef4444;
  }
  html, body { height: 100%; overflow: hidden; background: var(--bg); color: var(--text); font-family: 'Syne', sans-serif; }
  .app { display: grid; grid-template-columns: 280px 1fr; grid-template-rows: auto 1fr; height: 100vh; }

  /* Warning banner */
  .warning-banner {
    grid-column: 1 / -1; grid-row: 1;
    background: linear-gradient(90deg, #2d1200, #1a0a00);
    border-bottom: 1px solid #ff6b3540; padding: 7px 20px;
    font-family: 'JetBrains Mono', monospace; font-size: 11px; color: var(--warn);
    display: flex; align-items: center; gap: 10px;
  }
  .warning-banner strong { color: #ff6b35; }
  .banner-right { color: var(--text-dim); margin-left: auto; font-size: 10px; display: flex; gap: 14px; align-items: center; }
  .history-status { color: var(--success); }

  /* Sidebar */
  .sidebar { grid-row: 2; background: var(--surface); border-right: 1px solid var(--border); display: flex; flex-direction: column; overflow: hidden; }
  .sidebar-header { padding: 20px; border-bottom: 1px solid var(--border); background: linear-gradient(135deg, #0f0f1a 0%, #1a0f2e 100%); }
  .logo { display: flex; align-items: center; gap: 10px; font-size: 18px; font-weight: 800; letter-spacing: -0.5px; }
  .logo-icon { font-size: 24px; }
  .logo-sub { font-size: 10px; font-weight: 400; color: var(--text-dim); letter-spacing: 2px; text-transform: uppercase; margin-top: 2px; font-family: 'JetBrains Mono', monospace; }
  .sidebar-section { padding: 16px 20px 8px; font-size: 10px; font-weight: 600; letter-spacing: 2px; text-transform: uppercase; color: var(--text-dim); font-family: 'JetBrains Mono', monospace; }

  .autofetch-status { padding: 0 12px 10px; font-family: 'JetBrains Mono', monospace; font-size: 10px; }
  .autofetch-item { display: flex; align-items: center; gap: 6px; padding: 4px 8px; border-radius: 4px; margin-bottom: 3px; color: var(--text-dim); }
  .autofetch-item.ok { color: var(--success); }
  .autofetch-item.fail { color: var(--danger); }
  .autofetch-refresh { margin-top: 6px; padding: 5px 8px; background: var(--surface2); border: 1px solid var(--border); border-radius: 4px; color: var(--text-dim); font-family: 'JetBrains Mono', monospace; font-size: 10px; cursor: pointer; width: 100%; text-align: center; }
  .autofetch-refresh:hover { color: var(--accent); border-color: var(--accent); }

  .system-area { padding: 0 12px 12px; flex-shrink: 0; }
  .system-input { width: 100%; background: var(--surface2); border: 1px solid var(--border); border-radius: 8px; color: var(--text); font-family: 'JetBrains Mono', monospace; font-size: 11px; padding: 10px; resize: vertical; min-height: 60px; max-height: 120px; line-height: 1.5; outline: none; transition: border-color 0.2s; }
  .system-input:focus { border-color: var(--accent2); }

  .upload-area { padding: 0 12px 12px; }
  .upload-btn { width: 100%; padding: 10px; background: var(--surface2); border: 1px dashed var(--border); border-radius: 8px; color: var(--text-dim); font-family: 'JetBrains Mono', monospace; font-size: 11px; cursor: pointer; text-align: center; transition: all 0.2s; }
  .upload-btn:hover { border-color: var(--accent); color: var(--accent); background: rgba(255,107,53,0.05); }
  #fileInput { display: none; }

  .files-list { padding: 0 12px; flex: 1; overflow-y: auto; }
  .file-item { display: flex; align-items: center; justify-content: space-between; padding: 8px 10px; background: var(--surface2); border-radius: 6px; margin-bottom: 6px; font-family: 'JetBrains Mono', monospace; font-size: 10px; border: 1px solid var(--border); }
  .file-name { color: var(--success); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; }
  .file-remove { color: var(--text-dim); cursor: pointer; padding: 0 4px; flex-shrink: 0; }
  .file-remove:hover { color: var(--danger); }

  .provider-display { padding: 12px 20px; border-top: 1px solid var(--border); font-family: 'JetBrains Mono', monospace; font-size: 10px; color: var(--text-dim); flex-shrink: 0; }
  .provider-name { color: var(--accent); font-weight: 500; }

  .controls { padding: 12px; border-top: 1px solid var(--border); flex-shrink: 0; display: flex; gap: 8px; }
  .btn { flex: 1; padding: 9px; border: none; border-radius: 7px; font-family: 'Syne', sans-serif; font-size: 11px; font-weight: 600; cursor: pointer; transition: all 0.15s; }
  .btn-save { background: var(--surface2); color: var(--text-dim); border: 1px solid var(--border); }
  .btn-save:hover { color: var(--success); border-color: var(--success); }
  .btn-clear { background: var(--surface2); color: var(--text-dim); border: 1px solid var(--border); }
  .btn-clear:hover { color: var(--danger); border-color: var(--danger); }

  /* Chat area */
  .chat-area { grid-row: 2; display: flex; flex-direction: column; overflow: hidden; }
  .messages { flex: 1; overflow-y: auto; padding: 24px; display: flex; flex-direction: column; gap: 16px; scroll-behavior: smooth; }
  .messages::-webkit-scrollbar { width: 4px; }
  .messages::-webkit-scrollbar-thumb { background: var(--border); border-radius: 2px; }

  .msg { display: flex; gap: 12px; max-width: 900px; animation: fadeIn 0.2s ease; }
  @keyframes fadeIn { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: translateY(0); } }
  .msg.user { align-self: flex-end; flex-direction: row-reverse; }
  .msg.assistant { align-self: flex-start; }

  .avatar { width: 32px; height: 32px; border-radius: 8px; display: flex; align-items: center; justify-content: center; font-size: 14px; flex-shrink: 0; margin-top: 2px; }
  .msg.user .avatar { background: linear-gradient(135deg, var(--accent2), #9333ea); }
  .msg.assistant .avatar { background: linear-gradient(135deg, #1e3a5f, #0f4c75); }

  .bubble { padding: 12px 16px; border-radius: 12px; font-size: 14px; line-height: 1.7; max-width: calc(100% - 44px); word-wrap: break-word; font-family: 'JetBrains Mono', monospace; }
  .msg.user .bubble { background: var(--user-bg); border: 1px solid #2d2040; border-top-right-radius: 3px; }
  .msg.assistant .bubble { background: var(--ai-bg); border: 1px solid var(--border); border-top-left-radius: 3px; }
  .bubble pre { background: #0d0d14; border: 1px solid var(--border); border-radius: 6px; padding: 12px; margin: 10px 0; overflow-x: auto; font-size: 12px; line-height: 1.5; }
  .bubble code { font-family: 'JetBrains Mono', monospace; font-size: 12px; }
  .bubble p { margin-bottom: 8px; }
  .bubble p:last-child { margin-bottom: 0; }

  /* Streaming cursor */
  .cursor { display: inline-block; width: 2px; height: 14px; background: var(--accent); margin-left: 2px; animation: blink 0.8s infinite; vertical-align: middle; }
  @keyframes blink { 0%,100% { opacity: 1; } 50% { opacity: 0; } }

  .thinking { display: flex; gap: 4px; padding: 14px 16px; align-items: center; }
  .dot { width: 6px; height: 6px; border-radius: 50%; background: var(--accent); animation: pulse 1.2s infinite; }
  .dot:nth-child(2) { animation-delay: 0.2s; background: var(--accent2); }
  .dot:nth-child(3) { animation-delay: 0.4s; }
  @keyframes pulse { 0%,100% { opacity: 0.3; transform: scale(0.8); } 50% { opacity: 1; transform: scale(1.1); } }

  .welcome { display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100%; gap: 16px; color: var(--text-dim); text-align: center; padding: 40px; }
  .welcome-icon { font-size: 48px; }
  .welcome h2 { font-size: 22px; font-weight: 800; color: var(--text); }
  .welcome p { font-size: 13px; line-height: 1.6; max-width: 400px; font-family: 'JetBrains Mono', monospace; }
  .context-note { font-size: 11px; color: var(--success); background: rgba(34,197,94,0.08); border: 1px solid rgba(34,197,94,0.2); border-radius: 6px; padding: 8px 14px; font-family: 'JetBrains Mono', monospace; }

  .token-bar { display: flex; justify-content: space-between; padding: 6px 24px; background: var(--surface); border-top: 1px solid var(--border); font-family: 'JetBrains Mono', monospace; font-size: 10px; color: var(--text-dim); flex-shrink: 0; }
  .token-count { color: var(--warn); }

  .input-area { padding: 16px 24px 20px; border-top: 1px solid var(--border); background: var(--surface); flex-shrink: 0; }
  .input-row { display: flex; gap: 10px; align-items: flex-end; }
  .input-wrap { flex: 1; }
  textarea#userInput { width: 100%; background: var(--surface2); border: 1px solid var(--border); border-radius: 10px; color: var(--text); font-family: 'JetBrains Mono', monospace; font-size: 13px; padding: 12px 16px; resize: none; min-height: 50px; max-height: 200px; line-height: 1.5; outline: none; transition: border-color 0.2s; overflow-y: auto; }
  textarea#userInput:focus { border-color: var(--accent); }
  textarea#userInput::placeholder { color: var(--text-dim); }
  .send-btn { width: 48px; height: 48px; background: var(--accent); border: none; border-radius: 10px; color: white; font-size: 18px; cursor: pointer; flex-shrink: 0; transition: all 0.15s; display: flex; align-items: center; justify-content: center; }
  .send-btn:hover { background: #ff8555; transform: scale(1.05); }
  .send-btn:disabled { background: var(--border); cursor: not-allowed; transform: none; }
  .input-hint { font-family: 'JetBrains Mono', monospace; font-size: 10px; color: var(--text-dim); margin-top: 8px; }

  body::before { content: ''; position: fixed; inset: 0; pointer-events: none; z-index: 100; background-image: url("data:image/svg+xml,%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='noise'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23noise)' opacity='0.04'/%3E%3C/svg%3E"); opacity: 0.35; }
</style>
</head>
<body>
<div class="app">

  <!-- WARNING BANNER -->
  <div class="warning-banner">
    ⚠️ <strong>Planning assistant.</strong> Deploy via GitHub + curl only. Check Cerebras RPD before /run.
    <div class="banner-right">
      <span class="history-status" id="historyStatus">⏳ Loading history...</span>
      <span>Standing rules + live GitHub files active</span>
    </div>
  </div>

  <!-- SIDEBAR -->
  <aside class="sidebar">
    <div class="sidebar-header">
      <div class="logo">
        <span class="logo-icon">🦞</span>
        <div><div>BootstrapClaw</div><div class="logo-sub">Session Assistant</div></div>
      </div>
    </div>

    <div class="sidebar-section">Live GitHub Files</div>
    <div class="autofetch-status" id="autofetchStatus">
      <div class="autofetch-item">⏳ Loading from GitHub...</div>
    </div>

    <div class="sidebar-section">System Prompt</div>
    <div class="system-area">
      <textarea class="system-input" id="systemPrompt">You are an expert software engineer helping build and maintain BootstrapClaw. Always follow the standing rules — deploy via GitHub+curl, check Cerebras RPD, never suggest blocked providers. Be precise, direct, and technical.</textarea>
    </div>

    <div class="sidebar-section">Extra Session Files</div>
    <div class="upload-area">
      <label class="upload-btn" for="fileInput">⬆ Upload .md / .txt / .js files</label>
      <input type="file" id="fileInput" multiple accept=".md,.txt,.js,.json,.sh">
    </div>
    <div class="files-list" id="filesList"></div>

    <div style="flex:1"></div>
    <div class="provider-display">Provider: <span class="provider-name" id="providerName">Ready</span></div>
    <div class="controls">
      <button class="btn btn-save" onclick="saveToServer()">💾 Save</button>
      <button class="btn btn-clear" onclick="clearChat()">🗑 Clear</button>
    </div>
  </aside>

  <!-- CHAT -->
  <main class="chat-area">
    <div class="messages" id="messages">
      <div class="welcome" id="welcome">
        <div class="welcome-icon">🦞</div>
        <h2>BootstrapClaw Chat</h2>
        <p>Standing rules + live GitHub files always in context. History auto-saved — survives refresh and lost connections.</p>
        <div class="context-note" id="contextNote">⏳ Loading...</div>
      </div>
    </div>
    <div class="token-bar">
      <span>Messages: <span id="msgCount">0</span></span>
      <span>Est. tokens: <span class="token-count" id="tokenCount">0</span></span>
    </div>
    <div class="input-area">
      <div class="input-row">
        <div class="input-wrap">
          <textarea id="userInput" placeholder="Ask anything about BootstrapClaw..." rows="1"></textarea>
        </div>
        <button class="send-btn" id="sendBtn" onclick="sendMessage()" title="Ctrl+Enter">➤</button>
      </div>
      <div class="input-hint">Ctrl+Enter to send · Streams as it types · History survives refresh</div>
    </div>
  </main>
</div>

<script>
  const history = [];
  const loadedFiles = {};
  let githubFilesContext = '';
  let githubFileNames = [];
  let isStreaming = false;

  // ── GITHUB AUTO-FETCH ──────────────────────────────────────────────────────
  const GITHUB_FILES = ['bootstrapclaw-core.js', 'startup.sh', 'lint-prompts.js'];
  const GITHUB_RAW = 'https://raw.githubusercontent.com/danielwrites27-blip/bootstrapclaw-image/main/';

  async function fetchGithubFiles() {
    const statusEl = document.getElementById('autofetchStatus');
    statusEl.innerHTML = '<div class="autofetch-item">⏳ Fetching from GitHub...</div>';
    const results = [];
    for (const fname of GITHUB_FILES) {
      try {
        const r = await fetch(GITHUB_RAW + fname);
        results.push({ name: fname, content: r.ok ? await r.text() : null, ok: r.ok });
      } catch(e) { results.push({ name: fname, content: null, ok: false }); }
    }
    const loaded = results.filter(r => r.ok);
    githubFilesContext = loaded.length > 0
      ? '\\n\\n--- LIVE GITHUB FILES ---\\n' + loaded.map(r => '=== ' + r.name + ' ===\\n' + r.content).join('\\n\\n') + '\\n--- END LIVE GITHUB FILES ---\\n'
      : '';
    githubFileNames = loaded.map(r => r.name);
    statusEl.innerHTML = results.map(r =>
      '<div class="autofetch-item ' + (r.ok ? 'ok' : 'fail') + '">' + (r.ok ? '✓' : '✗') + ' ' + r.name + '</div>'
    ).join('') + '<button class="autofetch-refresh" onclick="fetchGithubFiles()">↻ Refresh</button>';
    const note = document.getElementById('contextNote');
    if (note) {
      note.textContent = loaded.length === GITHUB_FILES.length ? '✓ Live files: ' + githubFileNames.join(', ') : loaded.length > 0 ? '⚠ Partial: ' + githubFileNames.join(', ') : '✗ Could not fetch GitHub files';
      note.style.color = loaded.length === GITHUB_FILES.length ? '#22c55e' : loaded.length > 0 ? '#f59e0b' : '#ef4444';
    }
    updateStats();
  }
  fetchGithubFiles();

  // ── HISTORY PERSISTENCE ────────────────────────────────────────────────────
  function saveToLocalStorage() {
    try { localStorage.setItem('bc_history', JSON.stringify({ ts: Date.now(), history })); } catch(e) {}
  }

  async function saveToServer() {
    const statusEl = document.getElementById('historyStatus');
    try {
      await fetch('/api/history', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ history })
      });
      statusEl.textContent = '✓ Saved ' + new Date().toLocaleTimeString();
      statusEl.style.color = '#22c55e';
    } catch(e) { statusEl.textContent = '✗ Save failed'; statusEl.style.color = '#ef4444'; }
  }

  function persistHistory() {
    saveToLocalStorage();
    saveToServer();
  }

  async function loadHistoryOnStart() {
    const statusEl = document.getElementById('historyStatus');
    // Try localStorage first (instant, no network)
    try {
      const saved = localStorage.getItem('bc_history');
      if (saved) {
        const data = JSON.parse(saved);
        if (Date.now() - (data.ts || 0) < 24 * 60 * 60 * 1000 && data.history?.length > 0) {
          data.history.forEach(m => { history.push(m); renderMessage(m.role, m.content); });
          updateStats();
          statusEl.textContent = '✓ Restored ' + history.length + ' messages';
          statusEl.style.color = '#22c55e';
          return;
        }
      }
    } catch(e) {}
    // Fall back to server (persistent volume — survives cache clear)
    try {
      const res = await fetch('/api/history');
      if (res.ok) {
        const data = await res.json();
        if (data.history?.length > 0) {
          data.history.forEach(m => { history.push(m); renderMessage(m.role, m.content); });
          updateStats();
          saveToLocalStorage();
          statusEl.textContent = '✓ Restored ' + history.length + ' msgs (server)';
          statusEl.style.color = '#22c55e';
          return;
        }
      }
    } catch(e) {}
    statusEl.textContent = '○ No saved history';
    statusEl.style.color = '#6b6b8a';
  }
  loadHistoryOnStart();

  // ── BUILD SYSTEM PROMPT ────────────────────────────────────────────────────
  const STANDING_RULES_CLIENT = \`=== BOOTSTRAPCLAW STANDING RULES ===
DEPLOYMENT: GitHub edit → curl pull. NEVER heredoc. NEVER direct container edit.
SAFETY: Check Cerebras RPD before /run. Fix bugs before testing. Backup before changes.
BLOCKED: Mistral (network blocked), groq-70b (retired), gpt-oss:120b (timeout), minimax-m2.7 via Ollama (empty response), NVIDIA nemotron (wrong field).
ACTIVE PIPELINE: Phase1=sambanova/Meta-Llama-3.3-70B-Instruct, Phase2=sambanova/Qwen3-235B, Phase2.5+3=groq/kimi-k2, Orchestrator=cerebras/qwen-3-235b, Fallback=ollama/gemma3:27b.
CONTAINER: 2GB RAM. Use cgroup not free -m. Persistent: /root/.openclaw. sed fails — use python3.
STATE: Session 35 done. 14 articles. Validator 7/7. Humanizer live. Dedup live. Chat server on separate keys.
SESSION 36: Amazon Associates + Hashnode + affiliate links in writer prompt.
=== END RULES ===\`;

  function buildSystemPrompt() {
    let sys = STANDING_RULES_CLIENT;
    if (githubFilesContext) sys += githubFilesContext;
    const extra = document.getElementById('systemPrompt').value.trim();
    if (extra) sys += '\\n\\n--- ADDITIONAL ---\\n' + extra;
    const files = Object.entries(loadedFiles);
    if (files.length > 0) {
      sys += '\\n\\n--- UPLOADED FILES ---\\n';
      files.forEach(([n, c]) => { sys += '=== ' + n + ' ===\\n' + c + '\\n'; });
    }
    return sys;
  }

  // ── FILE UPLOAD ────────────────────────────────────────────────────────────
  const userInputEl = document.getElementById('userInput');
  userInputEl.addEventListener('input', () => {
    userInputEl.style.height = 'auto';
    userInputEl.style.height = Math.min(userInputEl.scrollHeight, 200) + 'px';
  });
  userInputEl.addEventListener('keydown', e => {
    if (e.ctrlKey && e.key === 'Enter') { e.preventDefault(); sendMessage(); }
  });

  document.getElementById('fileInput').addEventListener('change', async e => {
    for (const file of e.target.files) { loadedFiles[file.name] = await file.text(); renderFilesList(); }
    e.target.value = '';
  });

  function renderFilesList() {
    document.getElementById('filesList').innerHTML = Object.keys(loadedFiles).map(name =>
      '<div class="file-item"><span class="file-name">📄 ' + name + '</span><span class="file-remove" onclick="removeFile(\\'' + name + '\\')">✕</span></div>'
    ).join('');
  }
  function removeFile(name) { delete loadedFiles[name]; renderFilesList(); }

  // ── RENDER ─────────────────────────────────────────────────────────────────
  function renderMessage(role, content) {
    const welcome = document.getElementById('welcome');
    if (welcome) welcome.remove();
    const messages = document.getElementById('messages');
    const div = document.createElement('div');
    div.className = 'msg ' + role;
    div.innerHTML = '<div class="avatar">' + (role === 'user' ? '👤' : '🦞') + '</div><div class="bubble">' + formatContent(content) + '</div>';
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

  function estimateTokens(t) { return Math.round(t.length / 4); }
  function updateStats() {
    document.getElementById('msgCount').textContent = history.length;
    document.getElementById('tokenCount').textContent = estimateTokens(history.map(m => m.content).join(' ') + buildSystemPrompt()).toLocaleString();
  }

  // ── SEND + STREAMING ───────────────────────────────────────────────────────
  async function sendMessage() {
    const text = userInputEl.value.trim();
    if (!text || isStreaming) return;

    isStreaming = true;
    document.getElementById('sendBtn').disabled = true;
    userInputEl.value = '';
    userInputEl.style.height = 'auto';

    history.push({ role: 'user', content: text });
    renderMessage('user', text);
    updateStats();

    // Show thinking dots
    const welcome = document.getElementById('welcome');
    if (welcome) welcome.remove();
    const messages = document.getElementById('messages');
    const streamDiv = document.createElement('div');
    streamDiv.className = 'msg assistant';
    streamDiv.id = 'stream-msg';
    streamDiv.innerHTML = '<div class="avatar">🦞</div><div class="bubble" id="stream-bubble"><div class="thinking"><div class="dot"></div><div class="dot"></div><div class="dot"></div></div></div>';
    messages.appendChild(streamDiv);
    messages.scrollTop = messages.scrollHeight;

    let fullContent = '';
    let streamBubble = document.getElementById('stream-bubble');
    let started = false;

    try {
      const response = await fetch('/chat/stream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: [{ role: 'system', content: buildSystemPrompt() }, ...history] })
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
          try {
            const d = JSON.parse(t.slice(5).trim());
            if (d.type === 'provider') {
              document.getElementById('providerName').textContent = d.provider;
              if (!started) { streamBubble.innerHTML = '<span class="cursor"></span>'; started = true; }
            }
            if (d.type === 'chunk' && started) {
              fullContent += d.content;
              streamBubble.innerHTML = formatContent(fullContent) + '<span class="cursor"></span>';
              messages.scrollTop = messages.scrollHeight;
            }
            if (d.type === 'done' && started) {
              streamBubble.innerHTML = formatContent(fullContent);
            }
          } catch(e) {}
        }
      }

      // Clean up thinking if provider never responded
      const remaining = document.getElementById('stream-msg');
      if (remaining) remaining.removeAttribute('id');

      if (fullContent) {
        history.push({ role: 'assistant', content: fullContent });
        persistHistory();
        updateStats();
      }

    } catch(e) {
      const remaining = document.getElementById('stream-msg');
      if (remaining) remaining.remove();
      renderMessage('assistant', '❌ Error: ' + e.message);
    } finally {
      isStreaming = false;
      document.getElementById('sendBtn').disabled = false;
      userInputEl.focus();
    }
  }

  // ── CLEAR ──────────────────────────────────────────────────────────────────
  function clearChat() {
    if (!confirm('Clear conversation history?')) return;
    history.length = 0;
    try { localStorage.removeItem('bc_history'); } catch(e) {}
    fetch('/api/history', { method: 'DELETE' }).catch(() => {});
    document.getElementById('messages').innerHTML = \`<div class="welcome" id="welcome">
      <div class="welcome-icon">🦞</div><h2>BootstrapClaw Chat</h2>
      <p>History cleared. Standing rules + live GitHub files still active.</p>
      <div class="context-note">✓ \${githubFileNames.length > 0 ? githubFileNames.join(', ') : 'No files loaded'}</div>
    </div>\`;
    document.getElementById('providerName').textContent = 'Ready';
    document.getElementById('historyStatus').textContent = '○ Cleared';
    document.getElementById('historyStatus').style.color = '#6b6b8a';
    updateStats();
  }
</script>
</body>
</html>`;

// ── HTTP SERVER ───────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  // Serve UI
  if (req.method === 'GET' && req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(HTML);
    return;
  }

  // Load history
  if (req.method === 'GET' && req.url === '/api/history') {
    const history = loadHistory();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ history }));
    return;
  }

  // Save history
  if (req.method === 'POST' && req.url === '/api/history') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const { history } = JSON.parse(body);
        saveHistory(history);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch(e) { res.writeHead(400); res.end(JSON.stringify({ error: e.message })); }
    });
    return;
  }

  // Delete history
  if (req.method === 'DELETE' && req.url === '/api/history') {
    try { fs.unlinkSync(HISTORY_FILE); } catch(e) {}
    res.writeHead(200); res.end(JSON.stringify({ ok: true }));
    return;
  }

  // Streaming chat
  if (req.method === 'POST' && req.url === '/chat/stream') {
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
        const { messages } = JSON.parse(body);
        // Server-side: inject standing rules + GitHub files on top of whatever client sent
        if (messages[0]?.role === 'system') {
          messages[0].content = STANDING_RULES + (autoFetchedContext || '') + '\n\n' + messages[0].content;
        }
        await streamLLM(messages, res);
      } catch(e) {
        res.write(`data: ${JSON.stringify({ type: 'error', error: e.message })}\n\n`);
      } finally {
        res.end();
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
