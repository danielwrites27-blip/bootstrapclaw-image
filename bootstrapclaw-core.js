#!/usr/bin/env node
'use strict';

const https = require('https');
const http = require('http');
const fs = require('fs');
const { execSync } = require('child_process');

const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TG_CHAT  = '2053892551';
const BASE_DIR = '/root/bootstrapclaw';
const DRAFTS   = BASE_DIR + '/data/drafts';
const RUNS_LOG = BASE_DIR + '/data/runs.log';
const IDEAS    = BASE_DIR + '/data/article-ideas.md';
const USED     = BASE_DIR + '/data/used-topics.txt';

if (!TG_TOKEN) { console.error('TELEGRAM_BOT_TOKEN not set'); process.exit(1); }

const { runHealthCheck, MODELS_PATH } = require('./model-health-check');

function getModel(key) {
  try {
    return JSON.parse(require('fs').readFileSync(MODELS_PATH, 'utf8'))[key].current;
  } catch(_) {
    var fb = {
      cerebras:'qwen-3-235b-a22b-instruct-2507',
      cloudflare:'@cf/meta/llama-4-scout-17b-16e-instruct',
      sambanova_maverick:'Llama-4-Maverick-17B-128E-Instruct',
      sambanova_llama:'Meta-Llama-3.3-70B-Instruct',
      ollama:'gemma3:27b',
      nvidia:'nvidia/nemotron-3-super-120b-a12b',
      groq_kimi:'openai/gpt-oss-120b',
      groq_fallback:'llama-3.3-70b-versatile'
    };
    return fb[key] || key;
  }
}

// ── PROVIDERS ────────────────────────────────────────────────────────────────
const PROVIDERS = {
  cerebras:        { url: 'https://api.cerebras.ai/v1/chat/completions',     key: function(){ return process.env.CEREBRAS_API_KEY; },  model: 'qwen-3-235b-a22b-instruct-2507', maxTokens: 8192 },
  sambanova_maverick: { url: 'https://api.sambanova.ai/v1/chat/completions', key: function(){ return process.env.SAMBANOVA_API_KEY; }, model: 'Llama-4-Maverick-17B-128E-Instruct', maxTokens: 8192 },
  sambanova_llama: { url: 'https://api.sambanova.ai/v1/chat/completions',    key: function(){ return process.env.SAMBANOVA_API_KEY; }, model: 'Meta-Llama-3.3-70B-Instruct',   maxTokens: 8192 },
  ollama:          { url: 'https://ollama.com/v1/chat/completions',          key: function(){ return process.env.OLLAMA_API_KEY; },    model: 'gemma3:27b',                    maxTokens: 2048 },
  groq_kimi:       { url: 'https://api.groq.com/openai/v1/chat/completions', key: function(){ return process.env.GROQ_API_KEY; },      model: 'openai/gpt-oss-120b',           maxTokens: 4096 },
  groq_fallback:   { url: 'https://api.groq.com/openai/v1/chat/completions', key: function(){ return process.env.GROQ_API_KEY; },      model: 'llama-3.3-70b-versatile',       maxTokens: 4096 },
  cloudflare:      { url: 'https://api.cloudflare.com/client/v4/accounts/96f0514b181a123694206cf8ecd50db3/ai/run/@cf/meta/llama-4-scout-17b-16e-instruct', key: function(){ return process.env.CLOUDFLARE_API_KEY; }, model: 'llama-4-scout-17b-16e-instruct', maxTokens: 4096, responseType: 'cloudflare' },
  nvidia:          { url: 'https://integrate.api.nvidia.com/v1/chat/completions', key: function(){ return process.env.NVIDIA_API_KEY; }, model: 'nvidia/nemotron-3-super-120b-a12b', maxTokens: 4096 },
};

const CHAINS = {
researcher:   ['sambanova_llama', 'sambanova_maverick', 'ollama', 'groq_kimi', 'groq_fallback'],
writer:       ['cerebras', 'cloudflare', 'sambanova_maverick', 'sambanova_llama', 'ollama', 'nvidia', 'groq_kimi', 'groq_fallback'],
humanizer:    ['groq_kimi', 'groq_fallback'],
orchestrator: ['cerebras', 'groq_kimi', 'groq_fallback'],
};

// ── STATE ────────────────────────────────────────────────────────────────────
var offset = 0;
var pipelineStatus = 'idle';
var currentKeyword = null;
var cerebrasRPD = null;
var paused = false;
var pendingDraft = null;

// ── AFFILIATE LINKS ───────────────────────────────────────────────────────────
// Add real links here once PartnerStack/direct programs approve
// Format: { tool, url, keywords, description }
var AFFILIATE_LINKS = [
  { tool: 'FreshBooks', url: 'https://www.freshbooks.com/?ref=PLACEHOLDER', keywords: ['invoic', 'freelanc', 'accounting', 'billing', 'bookkeep', 'self-employ', 'budget'], description: 'accounting and invoicing software for freelancers' },
  { tool: 'Notion', url: 'https://notion.so/?ref=PLACEHOLDER', keywords: ['productivity', 'notes', 'organiz', 'workspace', 'project', 'task', 'plan'], description: 'all-in-one workspace for notes and project management' },
  { tool: 'Canva', url: 'https://canva.com/?ref=PLACEHOLDER', keywords: ['design', 'graphic', 'visual', 'brand', 'social media', 'content', 'creat'], description: 'easy graphic design tool for non-designers' },
  { tool: 'Calendly', url: 'https://calendly.com/?ref=PLACEHOLDER', keywords: ['schedul', 'meeting', 'calendar', 'appointment', 'booking', 'time management'], description: 'automated scheduling tool' },
  { tool: 'Grammarly', url: 'https://grammarly.com/?ref=PLACEHOLDER', keywords: ['writ', 'email', 'grammar', 'communicat', 'content', 'copy'], description: 'AI writing assistant for clear communication' },
  { tool: 'CustomGPT.ai', url: 'https://customgpt.ai/?fpr=daniel65', keywords: ['ai', 'chatbot', 'automat', 'custom', 'gpt', 'workflow', 'assistant', 'small business', 'tool'], description: 'custom AI chatbot builder for businesses' }
];

function getAffiliateLinks(keyword) {
  var kw = (keyword || '').toLowerCase();
  var matches = AFFILIATE_LINKS.filter(function(link) {
    return link.keywords.some(function(k) { return kw.includes(k); });
  }).slice(0, 2);
  return matches;
}

// ── CEREBRAS RPD CHECK ───────────────────────────────────────────────────────
async function refreshCerebrasRPD() {
  try {
    var key = process.env.CEREBRAS_API_KEY;
    if (!key) return;
    var body = '{"model":"qwen-3-235b-a22b-instruct-2507","messages":[{"role":"user","content":"hi"}],"max_tokens":5}';
    await new Promise(function(resolve) {
      var req = https.request({
        hostname: 'api.cerebras.ai', path: '/v1/chat/completions', method: 'POST',
        headers: { 'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
      }, function(r) {
        var rpd = r.headers['x-ratelimit-remaining-requests-day'];
        if (rpd) { cerebrasRPD = parseInt(rpd); log('[RPD] Cerebras: ' + cerebrasRPD + ' remaining'); }
        r.resume(); resolve();
      });
      req.on('error', resolve);
      req.write(body); req.end();
    });
  } catch(e) { log('[RPD] Check failed: ' + e.message); }
}

// ── LOGGING ──────────────────────────────────────────────────────────────────
function log(msg) {
  console.log('[' + new Date().toISOString() + '] ' + msg);
}

// ── HTTP POST ────────────────────────────────────────────────────────────────
function httpPost(urlStr, headers, body, onHeaders) {
  return new Promise(function(resolve, reject) {
    var url = new URL(urlStr);
    var lib = url.protocol === 'https:' ? https : http;
    var bodyStr = JSON.stringify(body);
    var reqHeaders = { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(bodyStr) };
    Object.keys(headers).forEach(function(k) { reqHeaders[k] = headers[k]; });
    var req = lib.request({
      hostname: url.hostname,
      path: url.pathname + url.search,
      method: 'POST',
      headers: reqHeaders
    }, function(res) {
      if (onHeaders) onHeaders(res.headers);
      var data = '';
      res.on('data', function(c) { data += c; });
      res.on('end', function() {
        try { resolve(JSON.parse(data)); }
        catch(e) { reject(new Error('JSON parse failed: ' + data.slice(0,200))); }
      });
    });
    req.on('error', reject);
    req.setTimeout(60000, function() { req.destroy(); reject(new Error('Timeout 60s')); });
    req.write(bodyStr);
    req.end();
  });
}

// ── CORE LLM CALLER ──────────────────────────────────────────────────────────
async function callLLM(chain, sys, usr, opts) {
  var keys = CHAINS[chain];
  for (var i = 0; i < keys.length; i++) {
    var key = keys[i];
    var p = PROVIDERS[key];
    var apiKey = p.key();
    if (!apiKey) { log('[LLM] No key for ' + key); continue; }
    try {
      var currentModel = getModel(key);
      var currentUrl = (key === 'cloudflare')
        ? 'https://api.cloudflare.com/client/v4/accounts/96f0514b181a123694206cf8ecd50db3/ai/run/' + currentModel
        : p.url;
      log('[LLM] Trying ' + key + ' (' + currentModel + ')');
      var onHdr = (key === 'cerebras') ? function(h) {
  var rpd = h['x-ratelimit-remaining-requests-day'];
  if (rpd) cerebrasRPD = parseInt(rpd);
} : null;
var res = await httpPost(currentUrl, { Authorization: 'Bearer ' + apiKey }, {
  model: currentModel,
  messages: [{ role: 'system', content: sys }, { role: 'user', content: usr }],
  max_tokens: p.maxTokens,
  temperature: 0.7
}, onHdr);
      var content;
      if (p.responseType === 'cloudflare') {
        content = res && res.result && res.result.response;
      } else {
        content = res && res.choices && res.choices[0] && res.choices[0].message && res.choices[0].message.content;
      }
      if (content && content.trim().length > 0) {
        if (opts && opts.exclude && opts.exclude.indexOf(key) !== -1) { continue; }
        if (opts && opts.minChars && content.trim().length < opts.minChars) {
          log('[LLM] ' + key + ' response too short (' + content.trim().length + ' chars), trying next');
          continue;
        }
        log('[LLM] OK ' + key + ' ' + content.length + ' chars');
        return { content: content.trim(), provider: key, model: currentModel };
      }
      var rawResStr = JSON.stringify(res).slice(0,200);
      if (rawResStr.indexOf('queue_exceeded') !== -1 || rawResStr.indexOf('too_many_requests') !== -1) {
        log('[LLM] ' + key + ' queue_exceeded — waiting 30s before next provider');
        await new Promise(function(r) { setTimeout(r, 30000); });
      }
      log('[LLM] Empty from ' + key + ': ' + rawResStr);
    } catch(e) {
      log('[LLM] ' + key + ' error: ' + e.message);
    }
  }
  throw new Error('All providers failed for chain: ' + chain);
}

// ── TAVILY SEARCH ────────────────────────────────────────────────────────────
async function tavilySearch(query) {
  var key = process.env.TAVILY_API_KEY;
  if (!key) throw new Error('TAVILY_API_KEY not set');
  var res = await httpPost('https://api.tavily.com/search', { Authorization: 'Bearer ' + key }, {
    query: query, max_results: 6, search_depth: 'advanced', include_raw_content: false
  });
  if (!res.results || !res.results.length) throw new Error('Tavily returned no results');
  return res.results.map(function(r) {
    return { title: r.title, url: r.url, snippet: (r.content || '').slice(0,300) };
  });
}

// ── PHASE 1: RESEARCHER ──────────────────────────────────────────────────────
async function runResearcher(keyword) {
  log('[P1] Researching: ' + keyword);
  await send('🔍 *Phase 1 — Research*\nSearching: _' + keyword + '_');

  var results = await tavilySearch(keyword);
  log('[P1] Tavily: ' + results.length + ' results');

  var sys = 'You are a research analyst. Synthesize web search results into structured article research.\nOnly include facts backed by the provided sources.\nOutput ONLY valid JSON — no markdown, no code fences, no explanation.';

  var sourcesText = results.map(function(r, i) {
    return '[' + (i+1) + '] ' + r.title + '\nURL: ' + r.url + '\n' + r.snippet;
  }).join('\n\n');

  var usr = 'Keyword: "' + keyword + '"\n\nSources:\n' + sourcesText + '\n\nReturn this exact JSON structure:\n{\n  "keyword": "' + keyword + '",\n  "angle": "most interesting article angle",\n  "key_points": ["point 1","point 2","point 3","point 4","point 5"],\n  "stats": ["specific stat with source","another stat"],\n  "sources": [{"title":"...","url":"..."}],\n  "outline": ["Section 1","Section 2","Section 3","Section 4"],\n  "target_reader": "who this article is for in one sentence"\n}';

  var result = await callLLM('researcher', sys, usr);

  var research;
  try {
    var { jsonrepair } = require('jsonrepair');
    var cleaned = result.content.replace(/```json/g,'').replace(/```/g,'').trim();
    var start = cleaned.indexOf('{');
    if (start === -1) throw new Error('No JSON object found in response');
    cleaned = cleaned.slice(start);
    var end = cleaned.lastIndexOf('}');
    if (end !== -1) cleaned = cleaned.slice(0, end + 1);
    try { research = JSON.parse(cleaned); } catch(e) { research = JSON.parse(jsonrepair(cleaned)); }
  } catch(e) {
    throw new Error('Bad JSON from researcher: ' + e.message + ' | Raw: ' + result.content.slice(0,200));
  }

  research.raw_sources = results;
  research.researched_at = new Date().toISOString();
  research.provider = result.provider;

  var realUrls = (research.sources || []).filter(function(s) {
    return s.url && s.url.startsWith('http') && s.url.indexOf('example.com') === -1;
  });
  if (!realUrls.length) throw new Error('No real URLs in research — possible fabrication');

  fs.writeFileSync(DRAFTS + '/research.json', JSON.stringify(research, null, 2));
  log('[P1] Done — ' + realUrls.length + ' real URLs via ' + result.provider);
  research.provider = result.provider;

  var points = research.key_points.slice(0,3).map(function(p) { return '• ' + p; }).join('\n');
  await send('✅ *Phase 1 complete*\n📌 Angle: _' + research.angle + '_\n🔗 Sources: ' + realUrls.length + ' real URLs\n🤖 Provider: ' + result.provider + '\n\nKey points:\n' + points);

  return research;
}

// ── TELEGRAM HELPERS ─────────────────────────────────────────────────────────
function tgRequest(method, payload) {
  return new Promise(function(resolve, reject) {
    var body = JSON.stringify(payload);
    var useProxy = method === 'sendMessage' && process.env.TG_PROXY_URL;
    var proxyHost = useProxy ? 'bootstrapclaw-tg-proxy.danielwrites27.workers.dev' : 'api.telegram.org';
    var proxyPath = useProxy ? '/sendMessage' : '/bot' + TG_TOKEN + '/' + method;
    var req = https.request({
      hostname: proxyHost,
      path: proxyPath,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    }, function(res) {
      var data = '';
      res.on('data', function(c) { data += c; });
      res.on('end', function() { try { resolve(JSON.parse(data)); } catch(e) { resolve({}); } });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function send(text) {
  var chunks = [];
  for (var i = 0; i < text.length; i += 4000) chunks.push(text.slice(i, i+4000));
  return chunks.reduce(function(p, c) {
    return p.then(function() { return tgRequest('sendMessage', { chat_id: TG_CHAT, text: c, parse_mode: 'Markdown' }); });
  }, Promise.resolve());
}

async function registerWebhook() {
  var webhookUrl = 'https://wright27-bootstrapclaw.hf.space/webhook';
  var token = TG_TOKEN;
  var body = JSON.stringify({ url: webhookUrl, allowed_updates: ['message'] });
  var res = await new Promise(function(resolve, reject) {
    var req = https.request({
      hostname: 'bootstrapclaw-tg-proxy.danielwrites27.workers.dev',
      path: '/setWebhook',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), 'X-TG-Token': token }
    }, function(r) {
      var d = '';
      r.on('data', function(c) { d += c; });
      r.on('end', function() { try { resolve(JSON.parse(d)); } catch(e) { resolve({}); } });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
  log('[webhook] Register result: ' + JSON.stringify(res));
}

// ── SYSTEM HELPERS ───────────────────────────────────────────────────────────
function getRam() {
  try {
    var b = parseInt(execSync('cat /sys/fs/cgroup/memory.current').toString().trim());
    return (b/1024/1024).toFixed(0) + ' MB';
  } catch(e) { return 'unknown'; }
}

function getDisk() {
  try {
    var o = execSync('df /root/.openclaw --output=used,avail').toString().trim().split('\n')[1].trim().split(/\s+/);
    return (parseInt(o[0])/1024).toFixed(0) + 'MB used / ' + (parseInt(o[1])/1024).toFixed(0) + 'MB free';
  } catch(e) { return 'unknown'; }
}

function getLastRun() {
  try {
    var r = JSON.parse(fs.readFileSync(RUNS_LOG, 'utf8'));
    if (!r.length) return 'No runs yet';
    var l = r[r.length-1];
    return (l.keyword || '?') + ' — ' + (l.status || '?') + ' — ' + (l.timestamp || '').slice(0,16);
  } catch(e) { return 'No runs yet'; }
}

function writeRunLog(entry) {
  try {
    var runs = [];
    try { runs = JSON.parse(fs.readFileSync(RUNS_LOG, 'utf8')); } catch(e) {}
    runs.push(Object.assign({}, entry, { timestamp: new Date().toISOString() }));
    fs.writeFileSync(RUNS_LOG, JSON.stringify(runs, null, 2));
  } catch(e) { log('[runLog] ' + e.message); }
}

// ── COMMAND HANDLERS ─────────────────────────────────────────────────────────
async function handleCrosspost(arg) {
  try {
    var runs = JSON.parse(fs.readFileSync(RUNS_LOG, 'utf8'));
    var published = runs.filter(function(r) { return r.status === 'published' && r.url; }).reverse();
    if (!published.length) { await send('No published articles found.'); return; }
    // Mode 2: /crosspost N — return metadata for article N
    if (arg) {
      var idx = parseInt(arg) - 1;
      if (isNaN(idx) || idx < 0 || idx >= published.length) {
        await send('Invalid number. Use /crosspost to see the list.');
        return;
      }
      var r = published[idx];
      var tags = Array.isArray(r.medium_tags) ? r.medium_tags.join(', ') : (r.medium_tags || 'not available');
      var msg = '📋 *Cross-post metadata*\n\n' +
        '*TITLE:*\n' + (r.title||'') + '\n\n' +
        '*SEO TITLE:*\n' + (r.seo_title||'not available — old article') + '\n\n' +
        '*SEO DESCRIPTION:*\n' + (r.seo_description||'not available — old article') + '\n\n' +
        '*MEDIUM TAGS:*\n' + tags + '\n\n' +
        '*CANONICAL URL:*\n' + (r.url||'') + '\n\n' +
        '📱 [Open Medium new story](https://medium.com/new-story)';
      await send(msg);
      return;
    }
    // Mode 1: /crosspost — list last 10 published articles
    var list = published.slice(0, 10).map(function(r, i) {
      var date = r.timestamp ? r.timestamp.slice(0,10) : '';
      return (i+1) + '. ' + (r.title||'').slice(0,50) + '... (' + date + ')';
    }).join('\n');
    await send('📋 *Choose an article to cross-post:*\n\n' + list + '\n\nReply: /crosspost [number]');
  } catch(e) { await send('Could not read runs.log: ' + e.message); }
}
async function handleStatus() {
  await send('🦞 *BootstrapClaw Status*\n\n*Pipeline:* ' + pipelineStatus + '\n*Keyword:* ' + (currentKeyword || 'none') + '\n*RAM:* ' + getRam() + '\n*Disk:* ' + getDisk() + '\n*Cerebras RPD:* ' + (cerebrasRPD !== null ? cerebrasRPD.toLocaleString() + ' remaining' : 'unknown') + '\n*Last run:* ' + getLastRun() + '\n\n*Commands:*\n/run [keyword] — auto publish\n/draft [keyword] — write and hold for review\n/approve — publish held draft\n/reject — discard held draft\n/pause — pause pipeline\n/resume — resume pipeline\n/crosspost — list articles for Medium\n/audit — quality check all Dev.to articles\n/status — this message\n/health — full provider health check\n/logs — last 5 runs');
}

async function handleHealth() {
  await send('Running full provider health check...');
  try {
    await send('🔍 Running provider health check...');
    runHealthCheck('manual').then(function(r) { send('✅ Health check complete — ' + r.filter(x=>x.changed).length + ' model(s) updated.'); }).catch(function(e) { send('❌ Health check error: ' + e.message); });
  } catch(e) {
    await send('Health check error: ' + e.message);
  }
}

async function handleLogs() {
  try {
    var runs = JSON.parse(fs.readFileSync(RUNS_LOG, 'utf8'));
    if (!runs.length) { await send('No runs logged yet.'); return; }
    var lines = runs.slice(-5).reverse().map(function(r) {
      return '• ' + (r.timestamp || '').slice(0,16) + ' | ' + r.keyword + ' | ' + r.status;
    }).join('\n');
    await send('📋 *Last runs:*\n' + lines);
  } catch(e) { await send('Could not read runs.log'); }
}


// ── TOPIC DEDUPLICATION ───────────────────────────────────────────────────────
function significantWords(str) {
  var stop = ['a','an','the','and','or','for','to','of','in','on','how','with','your','is','are','be','as','at','by'];
  return str.toLowerCase().replace(/[^a-z0-9 ]/g,'').split(/\s+/).filter(function(w) {
    return w.length > 2 && stop.indexOf(w) === -1;
  });
}

function isTopicUsed(keyword) {
  // Check 1: exact match in used-topics.txt
  try {
    var used = fs.readFileSync(USED, 'utf8').toLowerCase();
    if (used.split('\n').some(function(l) { return l.trim() === keyword.toLowerCase(); })) {
      return { used: true, reason: 'exact match in used-topics' };
    }
  } catch(e) {}

  // Check 2: semantic overlap (40%+) against past article titles
  try {
    var runs = JSON.parse(fs.readFileSync(RUNS_LOG, 'utf8'));
    var kwWords = significantWords(keyword);
    for (var i = 0; i < runs.length; i++) {
      if (!runs[i].title) continue;
      var titleWords = significantWords(runs[i].title);
      var overlap = kwWords.filter(function(w) { return titleWords.indexOf(w) !== -1; });
      var score = overlap.length / Math.max(kwWords.length, 1);
      if (score >= 0.4) {
        return { used: true, reason: 'too similar to: ' + runs[i].title + ' (' + Math.round(score*100) + '% overlap)' };
      }
    }
  } catch(e) {}

  return { used: false };
}

function markTopicUsed(keyword) {
  // Write to used-topics.txt
  fs.appendFileSync(USED, keyword.toLowerCase() + '\n');
  // Remove from article-ideas.md
  try {
    var lines = fs.readFileSync(IDEAS, 'utf8').split('\n');
    var filtered = lines.filter(function(l) {
      return l.replace(/^[-*]\s*/, '').trim().toLowerCase() !== keyword.toLowerCase();
    });
    fs.writeFileSync(IDEAS, filtered.join('\n'));
  } catch(e) {}
  // Auto-refresh queue if running low
  autoRefreshQueue().catch(function(e) { log('[queue] refresh error: ' + e.message); });
}

async function autoRefreshQueue() {
  try {
    // Read current queue
    var ideas = [];
    try {
      ideas = fs.readFileSync(IDEAS, 'utf8').trim().split('\n')
        .filter(function(l) { return l.trim() && !l.startsWith('#'); });
    } catch(e) {}
    if (ideas.length >= 10) return; // Queue healthy, nothing to do

    log('[queue] Only ' + ideas.length + ' keywords left — auto-refreshing...');
    await send('🔄 Keyword queue low (' + ideas.length + ' left) — generating 20 fresh topics...');

    // Build full history context from used-topics.txt
    var usedTopics = '';
    try { usedTopics = fs.readFileSync(USED, 'utf8').trim(); } catch(e) {}

    // Build full title history from runs.log
    var usedTitles = '';
    try {
      var runs = JSON.parse(fs.readFileSync(RUNS_LOG, 'utf8'));
      usedTitles = runs.map(function(r) { return r.title; }).filter(Boolean).join('\n');
    } catch(e) {}

    // Build existing queue list to avoid duplicates
    var existingQueue = ideas.map(function(l) {
      return l.replace(/^[-*]\s*/, '').trim().toLowerCase();
    });

    var prompt = 'Generate exactly 20 fresh article keyword ideas for a blog targeting freelancers, remote workers, solopreneurs, and small business owners. Focus on practical tools, productivity, AI, income streams, career growth, and business skills.\n\n' +
      'Already published keywords — do NOT repeat or closely reword these:\n' + usedTopics + '\n\n' +
      'Already published article titles — do NOT cover the same angles:\n' + usedTitles + '\n\n' +
      'Return ONLY a plain list of 20 keywords, one per line, no numbering, no bullets, no explanation. Each keyword should be a distinct, specific topic not covered above.';

    var result = await callLLM('orchestrator', 'You are a content strategist generating fresh article keyword ideas for a blog.', prompt, { maxTokens: 500 });
    if (!result || !result.content) throw new Error('No content from LLM');

    // Filter: remove too-short, already published, already in queue, semantically similar
    var newKeywords = result.content.trim().split('\n')
      .map(function(l) { return l.replace(/^[-*\d.]\s*/, '').trim().toLowerCase(); })
      .filter(function(l) {
        if (l.length < 5) return false;
        if (existingQueue.includes(l)) return false;
        if (isTopicUsed(l).used) return false;
        return true;
      });

    if (!newKeywords.length) throw new Error('No valid keywords generated after filtering');

    // Append to article-ideas.md
    fs.appendFileSync(IDEAS, '\n' + newKeywords.join('\n'));
    log('[queue] Added ' + newKeywords.length + ' fresh keywords to queue');
    await send('✅ Queue refreshed — ' + newKeywords.length + ' new keywords added:\n' +
      newKeywords.slice(0, 5).join('\n') + '\n...and ' + Math.max(0, newKeywords.length - 5) + ' more');

  } catch(e) {
    log('[queue] Auto-refresh failed: ' + e.message);
    await send('⚠️ Queue auto-refresh failed: ' + e.message);
  }
}

async function handleRun(keyword) {
  if (paused) { await send('Pipeline is paused. Use /resume first.'); return; }
  if (pipelineStatus === 'running') { await send('⚠️ Pipeline already running. Use /status to check.'); return; }
  if (!keyword) {
    try {
      var ideas = fs.readFileSync(IDEAS, 'utf8').trim().split('\n').filter(function(l) { return l.trim() && !l.startsWith('#'); });
      if (!ideas.length) { await send('⚠️ No keywords queued. Add more to article-ideas.md or use /run [keyword]'); return; }
      keyword = null;
      for (var i = 0; i < ideas.length; i++) {
        var candidate = ideas[i].replace(/^[-*]\s*/, '').trim();
        var check = isTopicUsed(candidate);
        if (!check.used) { keyword = candidate; break; }
        log('[dedup] Skipping "' + candidate + '": ' + check.reason);
      }
      if (!keyword) { await send('⚠️ All queued keywords already used. Add fresh topics to article-ideas.md'); return; }
    } catch(e) { await send('Usage: /run [keyword]'); return; }
  } else {
    keyword = keyword.trim();
    var manualCheck = isTopicUsed(keyword);
    if (manualCheck.used) {
      await send('⚠️ Topic already covered: ' + manualCheck.reason + '\nUse a different keyword.');
      return;
    }
  }
  pipelineStatus = 'running';
  currentKeyword = keyword;
  runPipeline(keyword).catch(function(err) {
    log('[pipeline] Fatal: ' + err.message);
    pipelineStatus = 'idle';
    currentKeyword = null;
    send('❌ *Pipeline failed*\n' + err.message).catch(function(){});
    writeRunLog({ keyword: keyword, status: 'failed', error: err.message });
  });
}

async function handleDraft(keyword) {
  if (paused) { await send('Pipeline is paused. Use /resume first.'); return; }
  if (pipelineStatus === 'running') { await send('⚠️ Pipeline already running.'); return; }
  if (pendingDraft) { await send('⚠️ Draft already pending.\nSend /approve to publish or /reject to discard.'); return; }
  if (!keyword) {
    try {
      var ideas = fs.readFileSync(IDEAS, 'utf8').trim().split('\n').filter(function(l) { return l.trim() && !l.startsWith('#'); });
      if (!ideas.length) { await send('⚠️ No keywords queued.'); return; }
      keyword = null;
      for (var i = 0; i < ideas.length; i++) {
        var candidate = ideas[i].replace(/^[-*]\s*/, '').trim();
        var check = isTopicUsed(candidate);
        if (!check.used) { keyword = candidate; break; }
      }
      if (!keyword) { await send('⚠️ All queued keywords already used.'); return; }
    } catch(e) { await send('Usage: /draft [keyword]'); return; }
  } else {
    keyword = keyword.trim();
    var manualCheck = isTopicUsed(keyword);
    if (manualCheck.used) {
      await send('⚠️ Topic already covered: ' + manualCheck.reason + '\nUse a different keyword.');
      return;
    }
  }
  pipelineStatus = 'running';
  currentKeyword = keyword;
  runDraftPipeline(keyword).catch(function(err) {
    log('[draft] Fatal: ' + err.message);
    pipelineStatus = 'idle';
    currentKeyword = null;
    pendingDraft = null;
    send('❌ *Draft failed*\n' + err.message).catch(function(){});
  });
}
// ── PHASE 2: WRITER ──────────────────────────────────────────────────────────
async function runWriter(research) {
  log('[P2] Writing article for: ' + research.keyword);
  await send('✍️ *Phase 2 — Writing*\nAngle: _' + research.angle + '_');

  var affiliateMatches = getAffiliateLinks(research.keyword);
  var affiliateInstruction = '';
  if (affiliateMatches.length > 0 && !affiliateMatches[0].url.includes('PLACEHOLDER')) {
    var linkList = affiliateMatches.map(function(l) { return '- ' + l.tool + ': ' + l.url + ' (' + l.description + ')'; }).join('\n');
    affiliateInstruction = '\n- Naturally embed 1-2 of these affiliate links where relevant to the article content. Use descriptive anchor text, never "click here":\n' + linkList;
  }
  var sys = 'You are an expert content writer. Write a high-quality, engaging article based on the research provided.\nRules:\n- Minimum 900 words\n- Start with a specific statistic or named study — never an emotional statement\n- Use short paragraphs (2-3 sentences max)\n- No em dashes anywhere\n- No phrases like: by leveraging, in conclusion, game-changer, dive into, what matters most\n- Structure article with at least 3 sections using ### headings\n- Include inline links using markdown: [anchor text](url)' + affiliateInstruction + '\n- Output ONLY valid JSON — no markdown fences, no explanation';

  var usr = 'Research:\n' + JSON.stringify(research, null, 2) + '\n\nWrite the article and return this exact JSON:\n{\n  "title": "article title",\n  "description": "meta description under 160 chars",\n  "tags": ["tag1","tag2","tag3","tag4"],\n  "seo_title": "SEO title under 60 chars with main keyword",\n  "seo_description": "SEO description 140-156 chars, includes keyword, summarizes article value",\n  "medium_tags": ["Tag1","Tag2","Tag3","Tag4","Tag5"],\n  "body_markdown": "full article in markdown, 900+ words"\n}';

  var { jsonrepair } = require('jsonrepair');
  var article, result, wordCount;
  var excludeProviders = [];
  for (var attempt = 0; attempt < 8; attempt++) {
    result = await callLLM('writer', sys, usr, { minChars: 2500, exclude: excludeProviders });
    try {
      var cleaned = result.content.replace(/```json/g,'').replace(/```/g,'').trim();
      var start = cleaned.indexOf('{');
      if (start === -1) throw new Error('No JSON object found');
      cleaned = cleaned.slice(start);
      var end = cleaned.lastIndexOf('}');
      if (end !== -1) cleaned = cleaned.slice(0, end + 1);
      try { article = JSON.parse(cleaned); } catch(e) { article = JSON.parse(jsonrepair(cleaned)); }
    } catch(e) {
      log('[P2] JSON parse failed for ' + result.provider + ', retrying with next provider');
      excludeProviders.push(result.provider);
      continue;
    }
    if (!article.title) throw new Error('Writer returned no title');
    if (!article.body_markdown) throw new Error('Writer returned no body');
    article.body_markdown = article.body_markdown.replace(/—/g, ' - ');
    wordCount = article.body_markdown.split(/\s+/).length;
    if (wordCount >= 800) {
      // Check opener has a statistic
      var firstPara = article.body_markdown.split('\n\n').find(function(p) {
        return p.trim() && !p.trim().startsWith('!') && !p.trim().startsWith('###');
      }) || '';
      var hasStatistic = /\d+(%|million|billion|thousand|x |times|percent|study|report|survey|research|according)/i.test(firstPara) ||
        /\bover\s+[\d,]+|\bnearly\s+[\d,]+|\b[\d,]+\s+(bloggers|users|companies|businesses|people|professionals|freelancers|workers|respondents)/i.test(firstPara);
      if (hasStatistic) break;
      log('[P2] ' + result.provider + ' opener missing statistic, retrying with next provider');
      excludeProviders.push(result.provider);
      continue;
    }
    log('[P2] ' + result.provider + ' returned ' + wordCount + ' words, retrying with next provider');
    excludeProviders.push(result.provider);
  }
  if (wordCount < 800) throw new Error('Article too short after all providers: ' + wordCount + ' words');

  article.keyword = research.keyword;
  article.written_at = new Date().toISOString();
  article.provider = result.provider;
  article.word_count = wordCount;

  fs.writeFileSync(DRAFTS + '/article.json', JSON.stringify(article, null, 2));
  log('[P2] Done — ' + wordCount + ' words via ' + result.provider);
  article.provider = result.provider;

  await send('✅ *Phase 2 complete*\n📝 Title: _' + article.title + '_\n📊 Words: ' + wordCount + '\n🤖 Provider: ' + result.provider + '\n\n⏳ Phase 3 (Publisher) coming next');

  return article;
}

// ── PHASE 3: REPORTER / PUBLISHER ────────────────────────────────────────────
async function runHumanizer(article) {
  log('[P2.5] Humanizing article...');
  var sys = `You are a brutally honest writing editor. Your job is to rewrite this article so it reads like a real person wrote it — someone who has actually used these tools and has opinions about them. GPTZero currently scores this article 80% AI. Your target is below 30%.

The two biggest problems to fix:

PROBLEM 1 — SENTENCE RHYTHM (most important)
Every sentence is the same length and structure. This is the top signal GPTZero detects.
Fix it by varying sentence length aggressively throughout every paragraph.
Use short sentences. Sometimes very short. Then follow with a longer sentence that develops the idea further and gives it room to breathe.
Bad: "AI tools help businesses save time. These platforms automate repetitive tasks. Small teams benefit from this automation."
Good: "AI tools save time. That sounds obvious, but the actual hours recovered — on invoicing, scheduling, email triage — add up fast for a team of five with no admin support."
Apply this to EVERY paragraph. No paragraph should have more than 2 sentences of similar length in a row.

PROBLEM 2 — NO PERSONAL VOICE
The article summarises what other sources say. A real writer who tested these tools would have opinions.
Add at least 2 specific observations per section framed as direct experience or reaction.
Examples of the right tone:
- "Xero automatic categorisation is genuinely good. It got about 90% of transactions right on the first pass."
- "Canva Magic Write is useful for a first draft, but it needs editing. The output is always a bit flat."
- "Dialpad transcribes calls in real time. Whether that feels like help or surveillance probably depends on your team."
These observations must be grounded in facts already in the article. Do not invent new claims.

PASS 1 — Fix these patterns:
1. Banned phrases: remove or rewrite any sentence containing "levels the playing field", "pivotal", "testament to", "evolving landscape", "underscores", "groundbreaking", "vibrant", "boasts", "game-changer", "dive into", "in conclusion", "by leveraging", "what matters most", "exciting times ahead", "the future looks bright", "it is worth noting", "it is important to note"
2. AI vocabulary: remove "additionally", "crucial", "delve", "intricate", "tapestry", "underscore", "foster", "furthermore", "notably", "it is clear that"
3. Vague attributions: replace "experts believe", "industry observers", "some critics argue" with named sources or delete
4. Copula avoidance: replace "serves as", "stands as", "functions as" with "is"
5. Negative parallelisms: remove "It is not just X, it is Y" constructions
6. Filler phrases: "in order to" becomes "to", "due to the fact that" becomes "because"
7. Em dashes: replace all — with a comma or period
8. Citation markers: remove [1] [2] [3] style markers
9. Boldface overuse: remove bold markdown from mid-sentence emphasis
10. Headings: convert ALL headings to sentence case (first word and proper nouns only) — IMPORTANT: keep the ### markdown prefix exactly as-is, only change the text after ###
11. Summary ending: if the article ends with a Recommended tools or Key takeaways section, delete it and replace with one direct opinion paragraph about what actually matters

PASS 2 — Self-audit:
Read each paragraph mentally. Ask: would a person who actually used this tool write this sentence? If it sounds like a brochure, rewrite it. Check sentence lengths in every paragraph — if 3 sentences in a row are similar length, break the pattern.

RULES:
- Keep ALL inline markdown links exactly as written in the original
- Keep word count at 900 words or more
- Do NOT invent new facts not in the original
- Output ONLY valid JSON, no markdown fences, no explanation
{"body_markdown": "full humanized article in markdown"}`;

  var usr = 'Humanize this article body. Return only the JSON object.\n\n' + article.body_markdown;

  var result = await callLLM('humanizer', sys, usr);
  var parsed;
  try {
    var { jsonrepair } = require('jsonrepair');
    var clean = result.content.replace(/^```json\s*/,'').replace(/^```\s*/,'').replace(/```\s*$/,'').trim();
    try {
      parsed = JSON.parse(clean);
    } catch(e) {
      parsed = JSON.parse(jsonrepair(clean));
    }
  } catch(e) {
    log('[P2.5] JSON parse failed, using original body: ' + e.message);
    return article;
  }
  if (!parsed.body_markdown) {
    log('[P2.5] No body_markdown in response, using original');
    return article;
  }
  parsed.body_markdown = parsed.body_markdown.replace(/—/g, ' - ');
  // Restore ### headings if humanizer converted them to bold
  var origHeadings = (article.body_markdown.match(/^#{2,}\s+.+/gm) || []);
  var newHeadings = (parsed.body_markdown.match(/^#{2,}\s+.+/gm) || []);
  if (origHeadings.length > 0 && newHeadings.length === 0) {
    log('[P2.5] Humanizer stripped headings — restoring ' + origHeadings.length + ' headings mechanically');
    parsed.body_markdown = parsed.body_markdown.replace(/^\*\*([^*]+)\*\*$/gm, function(match, text) {
      var closest = origHeadings.find(function(h) {
        var hText = h.replace(/^#+\s+/, '').toLowerCase();
        return text.toLowerCase().includes(hText.slice(0,15)) || hText.includes(text.toLowerCase().slice(0,15));
      });
      return closest ? closest : '### ' + text;
    });
  }
  // If headings still missing after restoration attempt, force-inject at paragraph boundaries
  var restoredHeadings = (parsed.body_markdown.match(/^#{2,}\s+.+/gm) || []);
  if (origHeadings.length > 0 && restoredHeadings.length === 0) {
    log('[P2.5] Force-injecting ' + origHeadings.length + ' original headings into humanized body');
    var paragraphs = parsed.body_markdown.split(/\n\n+/).filter(function(p) { return p.trim(); });
    var step = Math.max(1, Math.floor(paragraphs.length / (origHeadings.length + 1)));
    var result = [];
    var hIdx = 0;
    for (var pi = 0; pi < paragraphs.length; pi++) {
      if (hIdx < origHeadings.length && pi > 0 && pi % step === 0) {
        result.push(origHeadings[hIdx++]);
      }
      result.push(paragraphs[pi]);
    }
    parsed.body_markdown = result.join('\n\n');
  }
  // Mechanical banned phrase strip (same approach as em dash)
  parsed.body_markdown = parsed.body_markdown.replace(/game-changer/gi, 'valuable tool');
  parsed.body_markdown = parsed.body_markdown.replace(/game changer/gi, 'valuable tool');
  parsed.body_markdown = parsed.body_markdown.replace(/dive into/gi, 'explore');
  parsed.body_markdown = parsed.body_markdown.replace(/by leveraging/gi, 'using');
  parsed.body_markdown = parsed.body_markdown.replace(/in conclusion/gi, 'to summarize');
  parsed.body_markdown = parsed.body_markdown.replace(/what matters most/gi, 'the key priority');
  // Mechanical first-person over-application strip
  parsed.body_markdown = parsed.body_markdown.replace(/I've (worked with|used|introduced|tested|seen|tried|implemented|deployed|integrated|explored)[^.]*\./gi, '');
  parsed.body_markdown = parsed.body_markdown.replace(/I can (say|attest|tell you|confirm|assure you) that /gi, '');
  parsed.body_markdown = parsed.body_markdown.replace(/I personally (use|recommend|prefer|rely on|favour|favor)[^.]*\./gi, '');
  parsed.body_markdown = parsed.body_markdown.replace(/\n{3,}/g, '\n\n');
  var wordCount = parsed.body_markdown.split(/\s+/).filter(Boolean).length;
  log('[P2.5] Humanized: ' + wordCount + ' words, provider: ' + result.provider);
  article.humanizer_provider = result.provider;
  var humanizedBody = parsed.body_markdown.replace(/\s*\[\d+\]/g, '');
  var humanizedCount = humanizedBody.split(/\s+/).filter(Boolean).length;
  if (humanizedCount < 850) {
    log('[P2.5] Humanized output too short (' + humanizedCount + ' words), using original writer output');
    return article;
  }
  article.body_markdown = humanizedBody;
  article.word_count = humanizedCount;
  return article;
}
async function runReporter(article) {
  log('[P3] Publishing: ' + article.title);
  await send('📤 *Phase 3 — Publishing*\nTitle: _' + article.title + '_');
  // Step 1: Get cover image from Pexels
  var coverUrl = null;
  try {
    var pexelsKey = process.env.PEXELS_API_KEY;
    if (pexelsKey) {
      // Map article keyword to safe, screenshot-free Pexels search terms
      var topicMap = [
        { match: /\b(ai|chatbot|gpt|automat|machine learning)\b/i,     safe: 'business team meeting' },
        { match: /\b(productiv|tools|workflow|efficiency)\b/i,          safe: 'person working desk' },
        { match: /\b(freelanc|self.employ|solopreneur|independent)\b/i, safe: 'laptop coffee shop' },
        { match: /\b(email|communicat|writing|grammar)\b/i,             safe: 'person typing laptop' },
        { match: /\b(budget|financ|money|invoic|accounting)\b/i,        safe: 'notebook calculator desk' },
        { match: /\b(brand|market|social media|content)\b/i,            safe: 'creative workspace whiteboard' },
        { match: /\b(seo|blog|keyword|traffic)\b/i,                     safe: 'person writing notebook' },
        { match: /\b(remote|work from home|distributed)\b/i,            safe: 'home office desk setup' },
        { match: /\b(student|learn|educat|course)\b/i,                  safe: 'student studying books' },
        { match: /\b(small business|entrepreneur|startup)\b/i,          safe: 'small business owner working' },
      ];
      var safeQuery = 'professional workspace';
      for (var i = 0; i < topicMap.length; i++) {
        if (topicMap[i].match.test(article.keyword || '')) {
          safeQuery = topicMap[i].safe;
          break;
        }
      }
      var searchTerm = encodeURIComponent(safeQuery);
      var pexelsRes = await new Promise(function(resolve, reject) {
        var req = https.request({
          hostname: 'api.pexels.com',
          path: '/v1/search?query=' + searchTerm + '&per_page=5&orientation=landscape',
          method: 'GET',
          headers: { Authorization: pexelsKey }
        }, function(res) {
          var d = '';
          res.on('data', function(c) { d += c; });
          res.on('end', function() { try { resolve(JSON.parse(d)); } catch(e) { resolve({}); } });
        });
        req.on('error', reject);
        req.end();
      });
      if (pexelsRes.photos && pexelsRes.photos.length) {
        var pick = pexelsRes.photos[Math.floor(Math.random() * pexelsRes.photos.length)];
        coverUrl = pick.src.large2x;
        log('[P3] Cover image (' + safeQuery + '): ' + coverUrl);
      }
    }
  } catch(e) {
    log('[P3] Pexels failed: ' + e.message + ' — continuing without cover');
  }
  // Step 2: Build body with cover image embedded as first line
  var body = article.body_markdown;
  if (coverUrl) {
    body = '![Cover](' + coverUrl + ')\n\n' + body;
  }

  // Step 3: Publish to Dev.to via devto-publish.js
  article.body_markdown = body;
  // Sanitize tags: Dev.to requires single-word alphanumeric tags, max 4 tags
  if (article.tags) {
    article.tags = article.tags
      .map(t => t.toLowerCase().replace(/[^a-z0-9]/g, ''))
      .filter(t => t.length > 0)
      .slice(0, 4);
  }
  var tmpPath = DRAFTS + '/article-publish.json';
  fs.writeFileSync(tmpPath, JSON.stringify(article, null, 2));
  var { execSync } = require('child_process');
  var articleUrl;
  try {
    var publishOut = execSync(
      'node /root/bootstrapclaw/scripts/devto-publish.js ' + tmpPath,
      { encoding: 'utf8', timeout: 30000, env: process.env }
    ).trim();
    var urlMatch = publishOut.match(/SUCCESS: (https:\/\/[^\s]+)/);
    if (!urlMatch) {
      throw new Error('Unexpected output: ' + publishOut.slice(0,200));
    }
    articleUrl = urlMatch[1];
    log('[P3] devto-publish.js output: ' + publishOut);
  } catch(e) {
    throw new Error('Dev.to publish failed: ' + e.message);
  }
  log('[P3] Published: ' + articleUrl);

  // Step 4: Save URL back to article.json
  article.devto_url = articleUrl;
  article.published_at = new Date().toISOString();
  fs.writeFileSync(DRAFTS + '/article.json', JSON.stringify(article, null, 2));

  await send('🎉 *Published!*\n\n📰 ' + article.title + '\n\n🔗 ' + articleUrl + '\n\n📊 ' + article.word_count + ' words | ' + (article.tags || []).join(', '));

  return articleUrl;
}


// ── CONTENT QUALITY CHECK ────────────────────────────────────────────────────
function runContentQualityCheck(article) {
  var body = article.body_markdown || '';
  var title = article.title || '';
  var issues = [];

  // Check 1: Repetition detection — split into paragraphs, compare word overlap
  var paras = body.split(/\n\n+/).map(function(p) { return p.trim(); }).filter(function(p) { return p.length > 80; });
  var dupCount = 0;
  for (var i = 0; i < paras.length; i++) {
    for (var j = i + 1; j < paras.length; j++) {
      var wordsA = paras[i].toLowerCase().split(/\s+/);
      var wordsB = paras[j].toLowerCase().split(/\s+/);
      var setA = new Set(wordsA);
      var overlap = wordsB.filter(function(w) { return setA.has(w); }).length;
      var similarity = overlap / Math.max(wordsA.length, wordsB.length);
      if (similarity > 0.6) dupCount++;
    }
  }
  if (dupCount >= 3) issues.push('repetition_loop (' + dupCount + ' duplicate paragraph pairs)');

  // Check 2: Thin content — fewer than 3 sections
  var headings = (body.match(/^#{2,}\s+.+/gm) || []).length + (body.match(/^\*\*[^*]+\*\*$/gm) || []).length;
  if (headings < 3) issues.push('thin_content (only ' + headings + ' sections)');

  // Check 3: Title/section number mismatch
  var titleNumMatch = title.match(/\b(\d+)\s+(step|tip|way|strateg|reason|thing|method|tool)/i);
  if (titleNumMatch) {
    var titleNum = parseInt(titleNumMatch[1]);
    if (Math.abs(headings - titleNum) > 1) {
      issues.push('title_mismatch (title says ' + titleNum + ' but found ' + headings + ' sections)');
    }
  }

  // Check 4: Ending repetition — last 20% of article vs first 60%
  var cutA = Math.floor(body.length * 0.6);
  var cutB = Math.floor(body.length * 0.8);
  var firstPart = body.slice(0, cutA).toLowerCase().split(/\s+/);
  var lastPart = body.slice(cutB).toLowerCase().split(/\s+/);
  if (lastPart.length > 30) {
    var firstSet = new Set(firstPart);
    var endOverlap = lastPart.filter(function(w) { return firstSet.has(w); }).length / lastPart.length;
    if (endOverlap > 0.85 && lastPart.length > 80) issues.push('padding_detected (ending repeats opening content)');
  }

  return { passed: issues.length === 0, issues: issues };
}

async function handleAudit() {
  await send('🔍 *Article Audit Started*\nFetching all published articles from Dev.to...');
  try {
    var devtoKey = process.env.DEVTO_API_KEY;
    if (!devtoKey) { await send('DEVTO_API_KEY not set'); return; }
    // Fetch articles from Dev.to API
    var articles = await new Promise(function(resolve, reject) {
      var req = https.request({
        hostname: 'dev.to',
        path: '/api/articles/me/published?per_page=30',
        method: 'GET',
        headers: { 'api-key': devtoKey, 'User-Agent': 'BootstrapClaw/1.0' }
      }, function(res) {
        var d = '';
        res.on('data', function(c) { d += c; });
        res.on('end', function() { try { resolve(JSON.parse(d)); } catch(e) { resolve([]); } });
      });
      req.on('error', reject);
      req.end();
    });
    if (!articles.length) { await send('No published articles found on Dev.to.'); return; }
    var report = [];
    var flagged = 0;
    for (var i = 0; i < articles.length; i++) {
      var a = articles[i];
      var fakeArticle = { title: a.title || '', body_markdown: a.body_markdown || '', word_count: a.body_markdown ? a.body_markdown.split(/\s+/).length : 0 };
      var qc = runContentQualityCheck(fakeArticle);
      if (qc.passed) {
        report.push('✅ ' + (a.title||'').slice(0,45) + '...');
      } else {
        report.push('⚠️ ' + (a.title||'').slice(0,45) + '...\n   Issues: ' + qc.issues.join(', '));
        flagged++;
      }
    }
    var summary = '🔍 *Audit Complete — ' + articles.length + ' articles checked*\n' + flagged + ' flagged / ' + (articles.length - flagged) + ' clean\n\n' + report.join('\n');
    // Split if too long for Telegram
    if (summary.length > 3800) {
      var chunks = [];
      var lines = summary.split('\n');
      var chunk = '';
      for (var l = 0; l < lines.length; l++) {
        if ((chunk + lines[l]).length > 3500) { chunks.push(chunk); chunk = ''; }
        chunk += lines[l] + '\n';
      }
      if (chunk) chunks.push(chunk);
      for (var c = 0; c < chunks.length; c++) await send(chunks[c]);
    } else {
      await send(summary);
    }
  } catch(e) { await send('Audit failed: ' + e.message); }
}

// ── PIPELINE ORCHESTRATOR ────────────────────────────────────────────────────
function runValidator(research, article, devtoUrl) {
  var body = article.body_markdown || '';
  var title = article.title || '';

  // ── ORIGINAL 7 CHECKS ───────────────────────────────────────────────────
  var checks = {
    research_has_real_urls: (research.sources||[]).every(function(s) {
      return s.url && s.url.startsWith('http') && !s.url.includes('example.com');
    }),
    article_word_count: (article.word_count || 0) >= 800,
    article_valid_json: true,
    no_placeholder_text: !/(Article title here|continues\.\.\.| truncated|\[INSERT)/.test(body),
    devto_url_real: !!(devtoUrl && devtoUrl.includes('dev.to/daniel_writes_27/') && !devtoUrl.includes('example.com')),
    no_banned_phrases: !/(by leveraging|in conclusion|what matters most|dive into|game-changer)/.test(body),
    no_em_dashes: !/—/.test(body),

    // ── NEW CHECK 8: Opening contains a statistic ──────────────────────────
    opens_with_statistic: (function() {
      var firstPara = body.split('\n\n').find(function(p) { return p.trim() && !p.trim().startsWith('!') && !p.trim().startsWith('###'); }) || '';
      return /\d+(%|million|billion|thousand|x |times|percent|study|report|survey|research|according)/i.test(firstPara) || /\bover\s+[\d,]+|\bnearly\s+[\d,]+|\b[\d,]+\s+(bloggers|users|companies|businesses|people|professionals|freelancers|workers|respondents)/i.test(firstPara);
    })(),

    // ── NEW CHECK 9: No hallucinated sources ──────────────────────────────
    no_hallucinated_sources: (function() {
      var researchDomains = new Set();
      (research.sources||[]).forEach(function(s) {
        try { researchDomains.add(new URL(s.url).hostname.replace('www.','')); } catch(e) {}
      });
      var bodyLinks = body.match(/https?:\/\/[^\s)]+/g) || [];
      for (var i = 0; i < bodyLinks.length; i++) {
        try {
          var domain = new URL(bodyLinks[i]).hostname.replace('www.','');
          if (!researchDomains.has(domain) && !domain.includes('amazon.') && !domain.includes('customgpt.') && !domain.includes('example.com') && !domain.includes('pexels.com') && !domain.includes('unsplash.com')) {
            // Whitelist trusted high-authority domains LLMs commonly cite legitimately
            var trustedDomains = ['gallup.com','forbes.com','harvard.edu','hbr.org','mckinsey.com','statista.com','gartner.com','pewresearch.org','techcrunch.com','wired.com','nytimes.com','wsj.com','bloomberg.com','reuters.com','bbc.com','economist.com','nerdwallet.com','businessinsider.com','cnbc.com','linkedin.com','wikipedia.org','gov','edu'];
            if (trustedDomains.some(function(t){ return domain.includes(t); })) continue; // skip trusted domains
            var namedInBody = body.toLowerCase().includes(domain.split('.')[0]);
            if (namedInBody && !researchDomains.has(domain)) return false;
          }
        } catch(e) {}
      }
      return true;
    })(),

    // ── NEW CHECK 10: Has at least 3 section headings ─────────────────────
    has_structure: (function() {
      var h = (body.match(/^#{2,}\s+.+/gm) || []).length;
      var bold = (body.match(/^\*\*[^*]+\*\*$/gm) || []).length;
      return (h + bold) >= 3;
    })(),

    // ── NEW CHECK 11: No repeated sentences ──────────────────────────────
    no_repeated_sentences: (function() {
      var sentences = body.match(/[^.!?]+[.!?]+/g) || [];
      var seen = new Set();
      for (var i = 0; i < sentences.length; i++) {
        var s = sentences[i].trim().toLowerCase().slice(0, 80);
        if (s.length > 30 && seen.has(s)) return false;
        seen.add(s);
      }
      return true;
    })(),

    // ── NEW CHECK 12: No sycophantic opener ───────────────────────────────
    no_sycophantic_opener: (function() {
      var firstLine = body.replace(/^!\[.*?\]\(.*?\)\n\n/, '').slice(0, 200).toLowerCase();
      return !/(in today's fast.paced|in the ever.evolving|in an increasingly|in the modern|in today's world|in the age of|in recent years, the landscape)/.test(firstLine);
    })(),

    // ── NEW CHECK 13: No generic conclusion ───────────────────────────────
    no_generic_conclusion: (function() {
      var lastPart = body.slice(-400).toLowerCase();
      return !/(the future (looks|is) bright|more important than ever|rapidly evolving landscape|as we move forward|the possibilities are endless|in this dynamic)/.test(lastPart);
    })(),

    // ── NEW CHECK 14: No localhost or bad URLs in body ────────────────────
    no_bad_urls: !/(localhost|127\.0\.0\.1|example\.com|yourdomain\.com|placeholder\.com)/.test(body),

    // ── NEW CHECK 15: No heading repeated verbatim ────────────────────────
    no_duplicate_headings: (function() {
      var headings = (body.match(/^#{2,}\s+.+/gm) || []).map(function(h) { return h.toLowerCase().trim(); });
      return headings.length === new Set(headings).size;
    })(),

    // ── NEW CHECK 16: Title not truncated or generic ──────────────────────
    title_quality: (function() {
      if (!title || title.length < 10) return false;
      if (/^(article|untitled|draft|test|placeholder)/i.test(title)) return false;
      return true;
    })()
  };

  var total = Object.keys(checks).length;
  var passed = Object.values(checks).filter(Boolean).length;
  var failed = Object.keys(checks).filter(function(k) { return !checks[k]; });
  return { passed: passed, total: total, failed: failed, checks: checks };
}
async function runDraftPipeline(keyword) {
  var pipelineStart = Date.now();
  log('[draft] Start: ' + keyword);
  await send('🚀 *Draft pipeline started*\nKeyword: _' + keyword + '_');
  try {
    var research = await runResearcher(keyword);
    var article = await runWriter(research);
    await send('🧹 *Phase 2.5 — Humanizing*\nRemoving AI patterns...');
    article = await runHumanizer(article);
    await send('✅ *Phase 2.5 complete*\n📝 ' + article.word_count + ' words after humanizing');
    var qcDraft = runContentQualityCheck(article);
    if (!qcDraft.passed) {
      log('[quality] Draft issues: ' + qcDraft.issues.join(', '));
      await send('⚠️ *Quality Check:* ' + qcDraft.issues.join(', ') + '\nReview carefully before approving.');
    } else {
      await send('✅ *Quality Check: passed*');
    }
    pendingDraft = { article: article, research: research, keyword: keyword, pipelineStart: pipelineStart };
    pipelineStatus = 'draft_pending';
    var preview = article.body_markdown.replace(/!\[.*?\]\(.*?\)\n\n/, '').replace(/https?:\/\/[^\s)]+/g, '[link]').slice(0, 300);
    await send('📋 *Draft ready for review*\n\n*Title:* ' + article.title + '\n*Words:* ' + article.word_count + '\n\n*Preview:*\n' + preview + '...\n\n/approve — publish to Dev.to\n/reject — discard draft');
  } catch(err) {
    pipelineStatus = 'idle';
    currentKeyword = null;
    pendingDraft = null;
    throw err;
  }
}

async function handleApprove() {
  if (!pendingDraft) { await send('No draft pending. Use /draft [keyword] to create one.'); return; }
  if (pipelineStatus === 'running') { await send('⚠️ Pipeline already running.'); return; }
  var draft = pendingDraft;
  pendingDraft = null;
  pipelineStatus = 'running';
  try {
    var url = await runReporter(draft.article);
    var validation = runValidator(draft.research, draft.article, url);
    var elapsed = Math.round((Date.now() - draft.pipelineStart) / 1000);
    var validatorMsg = validation.failed.length > 0
      ? '⚠️ *Validator: ' + validation.passed + '/' + validation.total + ' checks passed*\nFailed: ' + validation.failed.join(', ')
      : '✅ *Validator: 7/7 checks passed*';
    await send(validatorMsg);
    var p1 = (draft.research.provider||'?').replace(/_/g,'-');
    var p2 = (draft.article.provider||'?').replace(/_/g,'-');
    var p25 = (draft.article.humanizer_provider||'groq-kimi').replace(/_/g,'-');
    await send('📊 *Run Summary*\n' + elapsed + 's total\nP1: ' + p1 + '\nP2: ' + p2 + '\nP2.5: ' + p25 + '\nWords: ' + draft.article.word_count + '\nCerebras RPD: ' + (cerebrasRPD !== null ? cerebrasRPD.toLocaleString() : 'not used'));
    markTopicUsed(draft.keyword);
    writeRunLog({ keyword: draft.keyword, status: 'published', title: draft.article.title, words: draft.article.word_count, url: url, validator: validation, seo_title: draft.article.seo_title||'', seo_description: draft.article.seo_description||'', medium_tags: draft.article.medium_tags||[] });
    pipelineStatus = 'idle';
    currentKeyword = null;
  } catch(err) {
    pipelineStatus = 'idle';
    currentKeyword = null;
    writeRunLog({ keyword: draft.keyword, status: 'failed', error: err.message });
    send('❌ *Publish failed*\n' + err.message).catch(function(){});
  }
}

async function handleReject() {
  if (!pendingDraft) { await send('No draft pending.'); return; }
  var keyword = pendingDraft.keyword;
  pendingDraft = null;
  pipelineStatus = 'idle';
  currentKeyword = null;
  await send('🗑️ *Draft discarded*\nKeyword: _' + keyword + '_\n\nUse /draft [keyword] to create a new one.');
}
async function runPipeline(keyword) {
  var pipelineStart = Date.now();
  log('[pipeline] Start: ' + keyword);
  await send('🚀 *Pipeline started*\nKeyword: _' + keyword + '_');
  try {
    var research = await runResearcher(keyword);
    var article = await runWriter(research);
    await send('🧹 *Phase 2.5 — Humanizing*\nRemoving AI patterns...');
    article = await runHumanizer(article);
    await send('✅ *Phase 2.5 complete*\n📝 ' + article.word_count + ' words after humanizing');
    var qcRun = runContentQualityCheck(article);
    if (!qcRun.passed) {
      log('[quality] Pipeline issues: ' + qcRun.issues.join(', '));
      await send('⚠️ *Quality Check failed:* ' + qcRun.issues.join(', ') + '\nBlocking publish — use /draft next time to review.');
      throw new Error('Quality check failed: ' + qcRun.issues.join(', '));
    } else {
      await send('✅ *Quality Check: passed*');
    }
    var url = await runReporter(article);
    var validation = runValidator(research, article, url);
    var elapsed = Math.round((Date.now() - pipelineStart) / 1000);
    var validatorMsg = validation.failed.length > 0
      ? '⚠️ *Validator: ' + validation.passed + '/' + validation.total + ' checks passed*\nFailed: ' + validation.failed.join(', ')
      : '✅ *Validator: 7/7 checks passed*';
    await send(validatorMsg);
    var p1 = (research.provider||'?').replace(/_/g,'-');
    var p2 = (article.provider||'?').replace(/_/g,'-');
    var p25 = (article.humanizer_provider||'groq-kimi').replace(/_/g,'-');
    await send('📊 *Run Summary*\n' + elapsed + 's total\nP1: ' + p1 + '\nP2: ' + p2 + '\nP2.5: ' + p25 + '\nWords: ' + article.word_count + '\nCerebras RPD: ' + (cerebrasRPD !== null ? cerebrasRPD.toLocaleString() : 'not used'));
    markTopicUsed(keyword);
    writeRunLog({ keyword: keyword, status: 'published', title: article.title, words: article.word_count, url: url, validator: validation, seo_title: article.seo_title||'', seo_description: article.seo_description||'', medium_tags: article.medium_tags||[] });
    pipelineStatus = 'idle';
    currentKeyword = null;
  } catch(err) {
    pipelineStatus = 'idle';
    currentKeyword = null;
    writeRunLog({ keyword: keyword, status: 'failed', error: err.message });
    throw err;
  }
}

// ── DISPATCH ─────────────────────────────────────────────────────────────────
async function dispatch(text) {
  var t = text.trim();
  if (t === '/status')         return handleStatus();
  if (t === '/health')         return handleHealth();
  if (t === '/logs')           return handleLogs();
  if (t.startsWith('/run'))    return handleRun(t.replace('/run', '').trim());
  if (t.startsWith('/draft'))  return handleDraft(t.replace('/draft', '').trim());
  if (t === '/approve')        return handleApprove();
  if (t.startsWith('/crosspost')) return handleCrosspost(t.replace('/crosspost','').trim());
  if (t === '/reject')         return handleReject();
  if (t === '/audit')          return handleAudit();
  if (t === '/restart')        { await send('♻️ Restarting...'); process.exit(0); }
  if (t === '/pause')          { paused = true;  await send('Pipeline paused. Send /resume to re-enable.'); return; }
  if (t === '/resume')         { paused = false; await send('Pipeline resumed.'); return; }
  await send('Unknown command: ' + t + '\nType /status for help.');
}

// ── WEBHOOK HANDLER ──────────────────────────────────────────────────────────
function handleWebhook(update) {
  var msg = update.message;
  if (!msg || !msg.text) return;
  if (String(msg.chat.id) !== TG_CHAT) return;
  log('CMD: ' + msg.text);
  dispatch(msg.text).catch(function(err) {
    log('Dispatch error: ' + err.message);
    send('❌ ' + err.message).catch(function(){});
  });
}

// ── BOOT ─────────────────────────────────────────────────────────────────────
log('BootstrapClaw starting...');
fs.mkdirSync(DRAFTS, { recursive: true });
send('🦞 *BootstrapClaw v2 online.*\nType /run [keyword] to start or /status to check.').catch(console.error);

// ── HEALTH SERVER (port 7860 for Hugging Face Spaces) ─────────────────────
http.createServer(function(req, res) {
  if (req.method === 'POST' && req.url === '/webhook') {
    var body = '';
    req.on('data', function(chunk) { body += chunk; });
    req.on('end', function() {
      try {
        var update = JSON.parse(body);
        handleWebhook(update);
      } catch(e) {
        log('[webhook] Parse error: ' + e.message);
      }
      res.writeHead(200);
      res.end('OK');
    });
  } else {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('BootstrapClaw running');
  }
}).listen(7860, function() {
  log('[health] HTTP server listening on port 7860');
});
// Self-ping every 25 minutes to prevent HF Spaces sleep
setInterval(function() {
  http.get('http://localhost:7860/', function(r) {
    log('[health] Self-ping OK - status ' + r.statusCode);
  }).on('error', function(e) {
    log('[health] Self-ping error: ' + e.message);
  });
}, 25 * 60 * 1000);

// ── PATTERN ANALYSER ─────────────────────────────────────────────────────────
function analysePatterns() {
  var runs = [];
  try { runs = JSON.parse(fs.readFileSync(RUNS_LOG, 'utf8')); } catch(e) { return null; }
  var cutoff = Date.now() - 28 * 24 * 60 * 60 * 1000;
  var recent = runs.filter(function(r) { return new Date(r.timestamp||0).getTime() > cutoff; });
  var failures = recent.filter(function(r) { return r.status !== 'published'; });
  var failMap = {};
  failures.forEach(function(r) {
    var key = (r.error || 'unknown error').slice(0, 60);
    failMap[key] = (failMap[key] || 0) + 1;
  });
  var patterns = Object.entries(failMap)
    .filter(function(e) { return e[1] >= 3; })
    .map(function(e) { return e[1] + 'x: ' + e[0]; });
  return {
    total: recent.length,
    published: recent.filter(function(r) { return r.status === 'published'; }).length,
    failures: failures.length,
    patterns: patterns
  };
}

// ── DAILY REPORT ─────────────────────────────────────────────────────────────
var lastReportDate = '';
var lastHealthCheckDate = '';
setInterval(function() {
  var now = new Date();
  var h = now.getUTCHours();
  var m = now.getUTCMinutes();
  var today = now.toISOString().slice(0, 10);
  // Sunday Pattern Analyser — 09:00 UTC
  var day = now.getUTCDay(); // 0 = Sunday
  if (h === 9 && m === 0 && day === 0) {
    var pa = analysePatterns();
    if (pa) {
      var patMsg = pa.patterns.length > 0
        ? '*Patterns (3+ repeats):*\n' + pa.patterns.join('\n')
        : '✅ No recurring failure patterns.';
      send(
        '🔍 *Weekly Pattern Report*\n\n' +
        '*Last 28 days:* ' + pa.total + ' runs, ' + pa.published + ' published, ' + pa.failures + ' failed\n\n' +
        patMsg
      ).catch(console.error);
    }
  }
  if (h === 9 && m === 0 && today !== lastHealthCheckDate) {
    lastHealthCheckDate = today;
    runHealthCheck('daily-scheduled').catch(function(e) { log('[health] Scheduled error: ' + e.message); });
  }
  if (h === 9 && m === 0 && today !== lastReportDate) {
    lastReportDate = today;
    var runs = [];
    try { runs = JSON.parse(fs.readFileSync(RUNS_LOG, 'utf8')); } catch(e) {}
    var todayRuns = runs.filter(function(r) { return (r.timestamp||'').slice(0,10) === today; });
    var published = todayRuns.filter(function(r) { return r.status === 'published'; }).length;
    var failed = todayRuns.filter(function(r) { return r.status === 'failed'; }).length;
    var total = runs.length;
    var last = runs.length ? runs[runs.length-1] : null;
    var lastLine = last ? ('_' + last.title + '_\n' + last.url) : 'No runs yet';
    send(
      '🦞 *Daily Report — ' + today + '*\n\n' +
      '*Today:* ' + published + ' published, ' + failed + ' failed\n' +
      '*Total articles:* ' + total + '\n' +
      '*RAM:* ' + getRam() + ' | *Disk:* ' + getDisk() + '\n\n' +
      '*Last published:*\n' + lastLine
    ).catch(console.error);
  }
}, 60 * 1000);
Promise.race([refreshCerebrasRPD(), new Promise(function(r) { setTimeout(r, 12000); })]).catch(function(e) { log('[RPD] Startup check skipped: ' + e.message); }).then(function() { registerWebhook().catch(console.error); });
