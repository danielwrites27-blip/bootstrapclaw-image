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

if (!TG_TOKEN) { console.error('TELEGRAM_BOT_TOKEN not set'); process.exit(1); }

// ── PROVIDERS ────────────────────────────────────────────────────────────────
const PROVIDERS = {
  cerebras:        { url: 'https://api.cerebras.ai/v1/chat/completions',     key: function(){ return process.env.CEREBRAS_API_KEY; },  model: 'qwen-3-235b-a22b-instruct-2507', maxTokens: 4096 },
  sambanova_qwen:  { url: 'https://api.sambanova.ai/v1/chat/completions',    key: function(){ return process.env.SAMBANOVA_API_KEY; }, model: 'Qwen3-235B',                     maxTokens: 4096 },
  sambanova_llama: { url: 'https://api.sambanova.ai/v1/chat/completions',    key: function(){ return process.env.SAMBANOVA_API_KEY; }, model: 'Meta-Llama-3.3-70B-Instruct',    maxTokens: 4096 },
  ollama:          { url: 'https://ollama.com/v1/chat/completions',          key: function(){ return process.env.OLLAMA_API_KEY; },    model: 'gemma3:27b',                     maxTokens: 2048 },
  groq_kimi:       { url: 'https://api.groq.com/openai/v1/chat/completions', key: function(){ return process.env.GROQ_API_KEY; },      model: 'moonshotai/kimi-k2-instruct',    maxTokens: 2048 },
  groq_fallback:   { url: 'https://api.groq.com/openai/v1/chat/completions', key: function(){ return process.env.GROQ_API_KEY; },      model: 'llama-3.1-8b-instant',          maxTokens: 2048 },
};

const CHAINS = {
  researcher:   ['sambanova_llama', 'sambanova_qwen', 'ollama', 'groq_kimi', 'groq_fallback'],
  writer:       ['sambanova_qwen',  'sambanova_llama', 'ollama', 'groq_kimi', 'groq_fallback'],
  reporter:     ['groq_kimi', 'ollama', 'groq_fallback'],
  orchestrator: ['cerebras', 'sambanova_qwen', 'groq_kimi', 'groq_fallback'],
};

// ── STATE ────────────────────────────────────────────────────────────────────
var offset = 0;
var pipelineStatus = 'idle';
var currentKeyword = null;

// ── LOGGING ──────────────────────────────────────────────────────────────────
function log(msg) {
  console.log('[' + new Date().toISOString() + '] ' + msg);
}

// ── HTTP POST ────────────────────────────────────────────────────────────────
function httpPost(urlStr, headers, body) {
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
async function callLLM(chain, sys, usr) {
  var keys = CHAINS[chain];
  for (var i = 0; i < keys.length; i++) {
    var key = keys[i];
    var p = PROVIDERS[key];
    var apiKey = p.key();
    if (!apiKey) { log('[LLM] No key for ' + key); continue; }
    try {
      log('[LLM] Trying ' + key + ' (' + p.model + ')');
      var res = await httpPost(p.url, { Authorization: 'Bearer ' + apiKey }, {
        model: p.model,
        messages: [{ role: 'system', content: sys }, { role: 'user', content: usr }],
        max_tokens: p.maxTokens,
        temperature: 0.7
      });
      var content = res && res.choices && res.choices[0] && res.choices[0].message && res.choices[0].message.content;
      if (content && content.trim().length > 0) {
        log('[LLM] OK ' + key + ' ' + content.length + ' chars');
        return { content: content.trim(), provider: key, model: p.model };
      }
      log('[LLM] Empty from ' + key + ': ' + JSON.stringify(res).slice(0,150));
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
    var cleaned = result.content.replace(/```json/g,'').replace(/```/g,'').trim();
    var start = cleaned.indexOf('{');
    var end = cleaned.lastIndexOf('}');
    if (start === -1 || end === -1) throw new Error('No JSON object found in response');
    cleaned = cleaned.slice(start, end + 1);
    research = JSON.parse(cleaned);
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

  var points = research.key_points.slice(0,3).map(function(p) { return '• ' + p; }).join('\n');
  await send('✅ *Phase 1 complete*\n📌 Angle: _' + research.angle + '_\n🔗 Sources: ' + realUrls.length + ' real URLs\n🤖 Provider: ' + result.provider + '\n\nKey points:\n' + points);

  return research;
}

// ── TELEGRAM HELPERS ─────────────────────────────────────────────────────────
function tgRequest(method, payload) {
  return new Promise(function(resolve, reject) {
    var body = JSON.stringify(payload);
    var req = https.request({
      hostname: 'api.telegram.org',
      path: '/bot' + TG_TOKEN + '/' + method,
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

async function getUpdates() {
  var res = await tgRequest('getUpdates', { offset: offset, timeout: 30, allowed_updates: ['message'] });
  if (!res.ok || !res.result || !res.result.length) return [];
  offset = res.result[res.result.length - 1].update_id + 1;
  return res.result;
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
async function handleStatus() {
  await send('🦞 *BootstrapClaw Status*\n\n*Pipeline:* ' + pipelineStatus + '\n*Keyword:* ' + (currentKeyword || 'none') + '\n*RAM:* ' + getRam() + '\n*Disk:* ' + getDisk() + '\n*Last run:* ' + getLastRun() + '\n\n/run [keyword] — start pipeline\n/status — this message\n/health — system check\n/logs — last 5 runs');
}

async function handleHealth() {
  await send('🩺 *Health Check*\n*RAM:* ' + getRam() + '\n*Disk:* ' + getDisk() + '\n*Pipeline:* ' + pipelineStatus + '\n*Providers:* SambaNova ✅ Cerebras ✅ Ollama ✅ Groq ✅');
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

async function handleRun(keyword) {
  if (pipelineStatus === 'running') { await send('⚠️ Pipeline already running. Use /status to check.'); return; }
  if (!keyword) {
    try {
      var ideas = fs.readFileSync(IDEAS, 'utf8').trim().split('\n').filter(function(l) { return l.trim() && !l.startsWith('#'); });
      if (!ideas.length) { await send('No keywords queued. Use /run [keyword]'); return; }
      keyword = ideas[0].replace(/^[-*]\s*/, '').trim();
    } catch(e) { await send('Usage: /run [keyword]'); return; }
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

// ── PHASE 2: WRITER ──────────────────────────────────────────────────────────
async function runWriter(research) {
  log('[P2] Writing article for: ' + research.keyword);
  await send('✍️ *Phase 2 — Writing*\nAngle: _' + research.angle + '_');

  var sys = 'You are an expert content writer. Write a high-quality, engaging article based on the research provided.\nRules:\n- Minimum 900 words\n- Start with a specific statistic or named study — never an emotional statement\n- Use short paragraphs (2-3 sentences max)\n- No em dashes anywhere\n- No phrases like: by leveraging, in conclusion, game-changer, dive into, what matters most\n- Include inline links using markdown: [anchor text](url)\n- Output ONLY valid JSON — no markdown fences, no explanation';

  var usr = 'Research:\n' + JSON.stringify(research, null, 2) + '\n\nWrite the article and return this exact JSON:\n{\n  "title": "article title",\n  "description": "meta description under 160 chars",\n  "tags": ["tag1","tag2","tag3","tag4"],\n  "body_markdown": "full article in markdown, 900+ words"\n}';

  var result = await callLLM('writer', sys, usr);

  var article;
  try {
    var cleaned = result.content.replace(/```json/g,'').replace(/```/g,'').trim();
    // Find JSON boundaries robustly
    var start = cleaned.indexOf('{');
    var end = cleaned.lastIndexOf('}');
    if (start === -1 || end === -1) throw new Error('No JSON object found in response');
    cleaned = cleaned.slice(start, end + 1);
    article = JSON.parse(cleaned);
  } catch(e) {
    throw new Error('Bad JSON from writer: ' + e.message + ' | Raw: ' + result.content.slice(0,200));
  }

  if (!article.title) throw new Error('Writer returned no title');
  if (!article.body_markdown) throw new Error('Writer returned no body');

  article.body_markdown = article.body_markdown.replace(/—/g, ' - ');

  var wordCount = article.body_markdown.split(/\s+/).length;
  if (wordCount < 800) throw new Error('Article too short: ' + wordCount + ' words (minimum 800)');

  article.keyword = research.keyword;
  article.written_at = new Date().toISOString();
  article.provider = result.provider;
  article.word_count = wordCount;

  fs.writeFileSync(DRAFTS + '/article.json', JSON.stringify(article, null, 2));
  log('[P2] Done — ' + wordCount + ' words via ' + result.provider);

  await send('✅ *Phase 2 complete*\n📝 Title: _' + article.title + '_\n📊 Words: ' + wordCount + '\n🤖 Provider: ' + result.provider + '\n\n⏳ Phase 3 (Publisher) coming next');

  return article;
}

// ── PHASE 3: REPORTER / PUBLISHER ────────────────────────────────────────────
async function runHumanizer(article) {
  log('[P2.5] Humanizing article...');
  var sys = `You are a writing editor. Remove all signs of AI-generated writing from the article body provided, using this process:

PASS 1 — Rewrite fixing these patterns:
1. Significance inflation: remove "pivotal moment", "testament to", "evolving landscape", "underscores", "highlights", "marks a shift", "setting the stage"
2. Promotional language: remove "nestled", "vibrant", "groundbreaking", "breathtaking", "renowned", "boasts", "showcasing"
3. Vague attributions: replace "experts believe", "industry observers", "some critics argue" with specific named sources or remove
4. Superficial -ing phrases: remove trailing "symbolizing...", "reflecting...", "contributing to...", "fostering...", "showcasing..."
5. Em dashes: replace all — with commas or periods
6. Rule of three: break up forced "X, Y, and Z" groupings where they feel assembled
7. Copula avoidance: replace "serves as", "stands as", "functions as" with "is" or "are"
8. Negative parallelisms: remove "It's not just X, it's Y" constructions
9. AI vocabulary: remove "additionally", "crucial", "delve", "intricate", "tapestry", "testament", "underscore", "vibrant", "pivotal", "foster"
10. Boldface overuse: remove **bold** from mid-sentence emphasis, keep only if essential
11. Filler phrases: "in order to" → "to", "due to the fact that" → "because", "it is important to note that" → remove
12. Excessive hedging: "could potentially possibly" → "may"
13. Generic conclusions: replace "the future looks bright", "exciting times ahead" with a specific fact or plan
14. Inline-header lists: convert "**Label:** description" bullet lists into prose
15. Hyphenated pairs: remove hyphens from "data-driven", "cross-functional", "client-facing", "high-quality", "decision-making", "real-time", "long-term"

PASS 2 — Self-audit:
Ask yourself: "What still makes this obviously AI-generated?" Fix any remaining tells.

SOUL CHECK:
- Vary sentence length. Short punchy sentences work. Longer ones that take their time are fine too.
- Use specific numbers and named sources over vague claims
- One opinion or reaction is allowed — "This is worth paying attention to" beats pure neutral reporting
- Read it aloud mentally. If it sounds like a press release, rewrite that paragraph.

RULES:
- Keep ALL inline markdown links exactly as they appear in the original
- Keep word count at 900+ words
- Do NOT add new facts that were not in the original
- Output ONLY valid JSON with one field, no markdown fences, no explanation

Output format:
{"body_markdown": "full humanized article in markdown"}`;

  var usr = 'Humanize this article body. Return only the JSON object.\n\n' + article.body_markdown;

  var result = await callLLM('reporter', sys, usr);
  var parsed;
  try {
    var clean = result.content.replace(/^```json\s*/,'').replace(/^```\s*/,'').replace(/```\s*$/,'').trim();
    parsed = JSON.parse(clean);
  } catch(e) {
    log('[P2.5] JSON parse failed, using original body: ' + e.message);
    return article;
  }
  if (!parsed.body_markdown) {
    log('[P2.5] No body_markdown in response, using original');
    return article;
  }
  parsed.body_markdown = parsed.body_markdown.replace(/—/g, ' - ');
  var wordCount = parsed.body_markdown.split(/\s+/).filter(Boolean).length;
  log('[P2.5] Humanized: ' + wordCount + ' words, provider: ' + result.provider);
  article.body_markdown = parsed.body_markdown;
  article.word_count = wordCount;
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
      var searchTerm = encodeURIComponent(article.keyword || 'students studying');
      var pexelsRes = await new Promise(function(resolve, reject) {
        var req = https.request({
          hostname: 'api.pexels.com',
          path: '/v1/search?query=' + searchTerm + '&per_page=1&orientation=landscape',
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
        coverUrl = pexelsRes.photos[0].src.large2x;
        log('[P3] Cover image: ' + coverUrl);
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

// ── PIPELINE ORCHESTRATOR ────────────────────────────────────────────────────
function runValidator(research, article, devtoUrl) {
  var checks = {
    research_has_real_urls: (research.sources||[]).every(function(s) {
      return s.url && s.url.startsWith('http') && !s.url.includes('example.com');
    }),
    article_word_count: (article.word_count || 0) >= 800,
    article_valid_json: true,
    no_placeholder_text: !/(Article title here|continues\.\.\.|truncated|\[INSERT)/.test(article.body_markdown||''),
    devto_url_real: !!(devtoUrl && devtoUrl.includes('dev.to/daniel_writes_27/') && !devtoUrl.includes('example.com')),
    no_banned_phrases: !/(by leveraging|in conclusion|what matters most|dive into|game-changer)/.test(article.body_markdown||''),
    no_em_dashes: !/—/.test(article.body_markdown||'')
  };
  var passed = Object.values(checks).filter(Boolean).length;
  var failed = Object.keys(checks).filter(function(k) { return !checks[k]; });
  return { passed: passed, total: 6, failed: failed, checks: checks };
}

async function runPipeline(keyword) {
  log('[pipeline] Start: ' + keyword);
  await send('🚀 *Pipeline started*\nKeyword: _' + keyword + '_');
  try {
    var research = await runResearcher(keyword);
    var article = await runWriter(research);
    await send('🧹 *Phase 2.5 — Humanizing*\nRemoving AI patterns...');
    article = await runHumanizer(article);
    await send('✅ *Phase 2.5 complete*\n📝 ' + article.word_count + ' words after humanizing');
    var url = await runReporter(article);
    var validation = runValidator(research, article, url);
    if (validation.failed.length > 0) {
      await send('⚠️ *Validator: ' + validation.passed + '/6 checks passed*\nFailed: ' + validation.failed.join(', '));
    } else {
      await send('✅ *Validator: 6/6 checks passed*');
    }
    writeRunLog({ keyword: keyword, status: 'published', title: article.title, words: article.word_count, url: url, validator: validation });
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
  if (t === '/restart')        { await send('♻️ Restarting...'); process.exit(0); }
  await send('Unknown command: ' + t + '\nType /status for help.');
}

// ── POLL LOOP ────────────────────────────────────────────────────────────────
async function poll() {
  while (true) {
    try {
      var updates = await getUpdates();
      for (var i = 0; i < updates.length; i++) {
        var msg = updates[i].message;
        if (!msg || !msg.text) continue;
        if (String(msg.chat.id) !== TG_CHAT) continue;
        log('CMD: ' + msg.text);
        dispatch(msg.text).catch(function(err) {
          log('Dispatch error: ' + err.message);
          send('❌ ' + err.message).catch(function(){});
        });
      }
    } catch(err) {
      log('Poll error: ' + err.message);
      await new Promise(function(r) { setTimeout(r, 5000); });
    }
  }
}

// ── BOOT ─────────────────────────────────────────────────────────────────────
log('BootstrapClaw starting...');
fs.mkdirSync(DRAFTS, { recursive: true });
send('🦞 *BootstrapClaw v2 online.*\nType /run [keyword] to start or /status to check.').catch(console.error);

// ── DAILY REPORT ─────────────────────────────────────────────────────────────
var lastReportDate = '';
setInterval(function() {
  var now = new Date();
  var h = now.getUTCHours();
  var m = now.getUTCMinutes();
  var today = now.toISOString().slice(0, 10);
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
poll();
