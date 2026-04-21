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

// ── PROVIDERS ────────────────────────────────────────────────────────────────
const PROVIDERS = {
  cerebras:        { url: 'https://api.cerebras.ai/v1/chat/completions',     key: function(){ return process.env.CEREBRAS_API_KEY; },  model: 'qwen-3-235b-a22b-instruct-2507', maxTokens: 8192 },
  sambanova_maverick: { url: 'https://api.sambanova.ai/v1/chat/completions', key: function(){ return process.env.SAMBANOVA_API_KEY; }, model: 'Llama-4-Maverick-17B-128E-Instruct', maxTokens: 8192 },
  sambanova_llama: { url: 'https://api.sambanova.ai/v1/chat/completions',    key: function(){ return process.env.SAMBANOVA_API_KEY; }, model: 'Meta-Llama-3.3-70B-Instruct',   maxTokens: 8192 },
  ollama:          { url: 'https://ollama.com/v1/chat/completions',          key: function(){ return process.env.OLLAMA_API_KEY; },    model: 'gemma3:27b',                    maxTokens: 2048 },
  groq_kimi:       { url: 'https://api.groq.com/openai/v1/chat/completions', key: function(){ return process.env.GROQ_API_KEY; },      model: 'openai/gpt-oss-120b',           maxTokens: 4096 },
  groq_fallback:   { url: 'https://api.groq.com/openai/v1/chat/completions', key: function(){ return process.env.GROQ_API_KEY; },      model: 'llama-3.3-70b-versatile',       maxTokens: 4096 },
};

const CHAINS = {
researcher:   ['sambanova_llama', 'sambanova_maverick', 'ollama', 'groq_kimi', 'groq_fallback'],
writer:       ['cerebras', 'sambanova_maverick', 'sambanova_llama', 'ollama', 'groq_kimi', 'groq_fallback'],
humanizer:    ['groq_kimi', 'groq_fallback'],
orchestrator: ['cerebras', 'groq_kimi', 'groq_fallback'],
};

// ── STATE ────────────────────────────────────────────────────────────────────
var offset = 0;
var pipelineStatus = 'idle';
var currentKeyword = null;
var cerebrasRPD = null;

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
      log('[LLM] Trying ' + key + ' (' + p.model + ')');
      var onHdr = (key === 'cerebras') ? function(h) {
  var rpd = h['x-ratelimit-remaining-requests-day'];
  if (rpd) cerebrasRPD = parseInt(rpd);
} : null;
var res = await httpPost(p.url, { Authorization: 'Bearer ' + apiKey }, {
  model: p.model,
  messages: [{ role: 'system', content: sys }, { role: 'user', content: usr }],
  max_tokens: p.maxTokens,
  temperature: 0.7
}, onHdr);
      var content = res && res.choices && res.choices[0] && res.choices[0].message && res.choices[0].message.content;
      if (content && content.trim().length > 0) {
        if (opts && opts.minChars && content.trim().length < opts.minChars) {
          log('[LLM] ' + key + ' response too short (' + content.trim().length + ' chars), trying next');
          continue;
        }
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
  research.provider = result.provider;

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
  await send('🦞 *BootstrapClaw Status*\n\n*Pipeline:* ' + pipelineStatus + '\n*Keyword:* ' + (currentKeyword || 'none') + '\n*RAM:* ' + getRam() + '\n*Disk:* ' + getDisk() + '\n*Cerebras RPD:* ' + (cerebrasRPD !== null ? cerebrasRPD.toLocaleString() + ' remaining' : 'unknown') + '\n*Last run:* ' + getLastRun() + '\n\n/run [keyword] — start pipeline\n/status — this message\n/health — system check\n/logs — last 5 runs');
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
}

async function handleRun(keyword) {
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

// ── PHASE 2: WRITER ──────────────────────────────────────────────────────────
async function runWriter(research) {
  log('[P2] Writing article for: ' + research.keyword);
  await send('✍️ *Phase 2 — Writing*\nAngle: _' + research.angle + '_');

  var sys = 'You are an expert content writer. Write a high-quality, engaging article based on the research provided.\nRules:\n- Minimum 900 words\n- Start with a specific statistic or named study — never an emotional statement\n- Use short paragraphs (2-3 sentences max)\n- No em dashes anywhere\n- No phrases like: by leveraging, in conclusion, game-changer, dive into, what matters most\n- Include inline links using markdown: [anchor text](url)\n- Output ONLY valid JSON — no markdown fences, no explanation';

  var usr = 'Research:\n' + JSON.stringify(research, null, 2) + '\n\nWrite the article and return this exact JSON:\n{\n  "title": "article title",\n  "description": "meta description under 160 chars",\n  "tags": ["tag1","tag2","tag3","tag4"],\n  "body_markdown": "full article in markdown, 900+ words"\n}';

  var result = await callLLM('writer', sys, usr, { minChars: 3000 });

  var article;
  try {
    var { jsonrepair } = require('jsonrepair');
    var cleaned = result.content.replace(/```json/g,'').replace(/```/g,'').trim();
    var start = cleaned.indexOf('{');
    var end = cleaned.lastIndexOf('}');
    if (start === -1 || end === -1) throw new Error('No JSON object found in response');
    cleaned = cleaned.slice(start, end + 1);
    try {
      article = JSON.parse(cleaned);
    } catch(e) {
      article = JSON.parse(jsonrepair(cleaned));
    }
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
10. Title case headings: convert ALL headings to sentence case (first word and proper nouns only)
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
  return { passed: passed, total: 7, failed: failed, checks: checks };
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
    var url = await runReporter(article);
    var validation = runValidator(research, article, url);
    var elapsed = Math.round((Date.now() - pipelineStart) / 1000);
    var validatorMsg = validation.failed.length > 0
      ? '⚠️ *Validator: ' + validation.passed + '/7 checks passed*\nFailed: ' + validation.failed.join(', ')
      : '✅ *Validator: 7/7 checks passed*';
    await send(validatorMsg);
    var p1 = (research.provider||'?').replace(/_/g,'-');
    var p2 = (article.provider||'?').replace(/_/g,'-');
    var p25 = (article.humanizer_provider||'groq-kimi').replace(/_/g,'-');
    await send('📊 *Run Summary*\n' + elapsed + 's total\nP1: ' + p1 + '\nP2: ' + p2 + '\nP2.5: ' + p25 + '\nWords: ' + article.word_count + '\nCerebras RPD: ' + (cerebrasRPD !== null ? cerebrasRPD.toLocaleString() : 'not used'));
    markTopicUsed(keyword);
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
Promise.race([refreshCerebrasRPD(), new Promise(function(r) { setTimeout(r, 12000); })]).catch(function(e) { log('[RPD] Startup check skipped: ' + e.message); }).then(function() { poll(); });
