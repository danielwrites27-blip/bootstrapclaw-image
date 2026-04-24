// model-health-check.js
// Runs daily at 09:00 UTC + on-demand via /health Telegram command
// Tests each provider, auto-replaces dead models, updates models.json, alerts Telegram

'use strict';

const fs = require('fs');
const path = require('path');

const MODELS_PATH = path.join(__dirname, 'data', 'models.json');
const PING_TIMEOUT_MS = 15000; // default — overridden per provider via cfg.pingTimeoutMs

// ─── Model name filters ────────────────────────────────────────────────────
// Patterns that identify models we should NEVER auto-select
const BAD_MODEL_PATTERNS = [
  /embed/i,
  /embedding/i,
  /whisper/i,
  /tts/i,
  /dall-e/i,
  /vision/i,
  /rerank/i,
  /guard/i,
  /moderat/i,
  /reward/i,
  // Reasoning models return content in reasoning_content field, not content
  /-r1/i,
  /thinking/i,
  /reasoning/i,
  /o1-/i,
  /o3-/i,
  // Tiny models not suitable for article writing
  /nano/i,
  /-1b[^0-9]/i,
  /-3b[^0-9]/i,
];

// Known dead models — never auto-select these even if they pass ping
const KNOWN_DEAD = [
  'moonshotai/kimi-k2-instruct',
  'Qwen3-235B',
  'gpt-oss-120b',           // Cerebras version — times out
  'minimax-m2.7',
  'gpt-oss:120b',
  'nvidia/nemotron-ultra-253b-v1',
  'llama-3.3-70b-instruct', // Cloudflare slug — wrong, use with @cf/ prefix
];

function extractParamBillions(modelId) {
  var m = modelId.toLowerCase().match(/(\d+(?:\.\d+)?)b(?:[^0-9]|$)/);
  if (!m) return null;
  return parseFloat(m[1]);
}

function isBadModel(modelId, minParams) {
  if (KNOWN_DEAD.includes(modelId)) return true;
  if (BAD_MODEL_PATTERNS.some(p => p.test(modelId))) return true;
  if (minParams && minParams > 0) {
    var params = extractParamBillions(modelId);
    if (params !== null && params < minParams) return true;
  }
  return false;
}

// ─── Load / save models.json ───────────────────────────────────────────────
function loadModels() {
  if (!fs.existsSync(MODELS_PATH)) {
    throw new Error(`models.json not found at ${MODELS_PATH}`);
  }
  return JSON.parse(fs.readFileSync(MODELS_PATH, 'utf8'));
}

function saveModels(models) {
  fs.writeFileSync(MODELS_PATH, JSON.stringify(models, null, 2));
}

// ─── HTTP helpers ──────────────────────────────────────────────────────────
function httpPost(url, headers, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const mod = u.protocol === 'https:' ? require('https') : require('http');
    const data = JSON.stringify(body);
    const req = mod.request({
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), ...headers }
    }, res => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => resolve({ status: res.statusCode, body: raw }));
    });
    req.on('error', reject);
    req.setTimeout(timeout, () => { req.destroy(); reject(new Error('timeout')); });
    req.write(data);
    req.end();
  });
}

function httpGet(url, headers) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const mod = u.protocol === 'https:' ? require('https') : require('http');
    const req = mod.request({
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search,
      method: 'GET',
      headers
    }, res => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => resolve({ status: res.statusCode, body: raw }));
    });
    req.on('error', reject);
    req.setTimeout(PING_TIMEOUT_MS, () => { req.destroy(); reject(new Error('timeout')); });
    req.end();
  });
}

// ─── Ping a single model ───────────────────────────────────────────────────
// Returns { ok: true } or { ok: false, reason: '...' }
async function pingModel(providerKey, cfg, modelId) {
  const apiKey = process.env[cfg.apiKeyEnv];
  if (!apiKey) return { ok: false, reason: `env var ${cfg.apiKeyEnv} not set` };
  const timeout = cfg.pingTimeoutMs || PING_TIMEOUT_MS;

  try {
    if (cfg.responseType === 'cloudflare') {
      // Cloudflare: POST to /run/@cf/provider/model
      const slug = modelId.startsWith('@') ? modelId : `@cf/meta/${modelId}`;
      const url = `${cfg.endpoint}/${slug}`;
      const res = await httpPost(url, { Authorization: `Bearer ${apiKey}` }, {
        messages: [{ role: 'user', content: 'Reply with: OK' }],
        max_tokens: 5
      });
      if (res.status !== 200) return { ok: false, reason: `HTTP ${res.status}` };
      const json = JSON.parse(res.body);
      if (!json.success) return { ok: false, reason: `CF error: ${JSON.stringify(json.errors)}` };
      const text = json.result?.response || '';
      if (!text || text.length < 1) return { ok: false, reason: 'empty response' };
      return { ok: true };
    } else {
      // Standard OpenAI-compatible
      const url = `${cfg.endpoint}/chat/completions`;
      const res = await httpPost(url, { Authorization: `Bearer ${apiKey}` }, {
        model: modelId,
        messages: [{ role: 'user', content: 'Reply with: OK' }],
        max_tokens: 5,
        stream: false
      });
      if (res.status !== 200) return { ok: false, reason: `HTTP ${res.status}` };
      const json = JSON.parse(res.body);
      const text = json.choices?.[0]?.message?.content || '';
      if (!text || text.length < 1) return { ok: false, reason: 'empty response' };
      return { ok: true };
    }
  } catch (e) {
    return { ok: false, reason: e.message };
  }
}

// ─── Discover models from provider ────────────────────────────────────────
async function discoverModels(providerKey, cfg) {
  const apiKey = process.env[cfg.apiKeyEnv];
  if (!apiKey) return [];

  try {
    if (cfg.responseType === 'cloudflare') {
      // Cloudflare has its own discovery endpoint
      const res = await httpGet(
        cfg.discoveryEndpoint + '?task=Text+Generation&per_page=50',
        { Authorization: `Bearer ${apiKey}` }
      );
      if (res.status !== 200) return [];
      const json = JSON.parse(res.body);
      const min = cfg.minDiscoveryParams || 0;
      return (json.result || [])
        .map(m => m.name || '')
        .filter(m => m && !isBadModel(m, min));
    } else {
      // Standard /v1/models
      const res = await httpGet(
        `${cfg.endpoint}/models`,
        { Authorization: `Bearer ${apiKey}` }
      );
      if (res.status !== 200) return [];
      const json = JSON.parse(res.body);
      const rawList = json.data || json.models || [];
      const min2 = cfg.minDiscoveryParams || 0;
      return rawList
        .map(m => (typeof m === 'string' ? m : m.id || m.name || ''))
        .filter(m => m && !isBadModel(m, min2));
    }
  } catch (e) {
    return [];
  }
}

// ─── Telegram notify ──────────────────────────────────────────────────────
async function tgSend(message) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = '2053892551';
  if (!token) return;
  try {
    await httpPost(`https://api.telegram.org/bot${token}/sendMessage`, {}, {
      chat_id: chatId,
      text: message,
      parse_mode: 'Markdown'
    });
  } catch (_) {}
}

// ─── Check one provider ────────────────────────────────────────────────────
// Returns { providerKey, status, oldModel, newModel, changed, reason }
async function checkProvider(providerKey, cfg) {
  const oldModel = cfg.current;
  let result = { providerKey, oldModel, newModel: oldModel, changed: false, status: 'ok', reason: '' };

  // Step 1: ping current model
  const pingResult = await pingModel(providerKey, cfg, oldModel);
  if (pingResult.ok) {
    cfg.last_verified = new Date().toISOString();
    cfg.status = 'ok';
    return result;
  }

  // Step 2: current is dead — walk preferred list
  result.reason = `current model failed: ${pingResult.reason}`;
  const candidates = [...cfg.preferred].filter(m => m !== oldModel);

  for (const candidate of candidates) {
    if (isBadModel(candidate)) continue;
    const pr = await pingModel(providerKey, cfg, candidate);
    if (pr.ok) {
      cfg.current = candidate;
      cfg.last_verified = new Date().toISOString();
      cfg.status = 'ok';
      result.newModel = candidate;
      result.changed = true;
      result.status = 'replaced';
      return result;
    }
  }

  // Step 3: preferred list exhausted — auto-discover from provider
  result.reason += ' | preferred list exhausted, discovering models...';
  const discovered = await discoverModels(providerKey, cfg);
  const minParams = cfg.minDiscoveryParams || 0;

  // Step 3a: Tavily research — find which discovered models are well-regarded
  let tavilyRanked = [];
  try {
    const tavilyKey = process.env.TAVILY_API_KEY;
    if (tavilyKey && discovered.length > 0) {
      const providerName = cfg.endpoint.replace(/https?:\/\//, '').split('.')[0];
      const query = providerName + ' best available models 2026 benchmark parameters capabilities';
      const tRes = await httpPost('https://api.tavily.com/search',
        { Authorization: 'Bearer ' + tavilyKey },
        { query, max_results: 5, search_depth: 'basic', include_raw_content: false }
      );
      if (tRes && tRes.results) {
        const combined = tRes.results.map(r => (r.title + ' ' + (r.content || '')).toLowerCase()).join(' ');
        // Score each discovered candidate by how many Tavily snippets mention it
        tavilyRanked = discovered
          .filter(m => !isBadModel(m, minParams) && !cfg.preferred.includes(m))
          .map(m => {
            const shortName = m.toLowerCase().replace(/[^a-z0-9]/g, '');
            const mentions = (combined.match(new RegExp(shortName.slice(0, 8), 'g')) || []).length;
            return { model: m, mentions };
          })
          .sort((a, b) => b.mentions - a.mentions)
          .map(x => x.model);
        result.reason += ' | Tavily ranked ' + tavilyRanked.length + ' candidates';
      }
    }
  } catch(e) {
    result.reason += ' | Tavily search failed: ' + e.message;
  }

  // Try Tavily-ranked candidates first, then remaining discovered models
  const orderedCandidates = [
    ...tavilyRanked,
    ...discovered.filter(m => !tavilyRanked.includes(m) && !isBadModel(m, minParams) && !cfg.preferred.includes(m))
  ];

  for (const candidate of orderedCandidates) {
    const pr = await pingModel(providerKey, cfg, candidate);
    if (pr.ok) {
      cfg.current = candidate;
      cfg.last_verified = new Date().toISOString();
      cfg.status = 'ok';
      cfg.preferred.unshift(candidate);
      result.newModel = candidate;
      result.changed = true;
      result.status = tavilyRanked.includes(candidate) ? 'tavily-discovered' : 'auto-discovered';
      return result;
    }
  }

  // Step 4: nothing works — provider is dead
  cfg.status = 'dead';
  cfg.last_verified = new Date().toISOString();
  result.status = 'dead';
  result.reason += ' | no working model found';
  return result;
}

// ─── Main health check run ────────────────────────────────────────────────
async function runHealthCheck(triggeredBy = 'scheduled') {
  console.log(`[health-check] Starting — triggered by: ${triggeredBy}`);
  let models;
  try {
    models = loadModels();
  } catch (e) {
    console.error('[health-check] Failed to load models.json:', e.message);
    await tgSend(`Health check failed: could not load models.json\n${e.message}`);
    return;
  }

  const results = [];
  const providerKeys = Object.keys(models);

  for (const key of providerKeys) {
    process.stdout.write(`[health-check] Checking ${key}... `);
    const r = await checkProvider(key, models[key]);
    results.push(r);
    console.log(r.status === 'ok' ? 'OK' : r.status.toUpperCase());
  }

  // Save updated models.json
  try {
    saveModels(models);
    console.log('[health-check] models.json updated');
  } catch (e) {
    console.error('[health-check] Failed to save models.json:', e.message);
  }

  // Build Telegram report
  const changed = results.filter(r => r.changed);
  const dead = results.filter(r => r.status === 'dead');
  const ok = results.filter(r => r.status === 'ok');

  let msg = `*Daily Model Health Check* (${triggeredBy})\n`;
  msg += `${new Date().toISOString().replace('T', ' ').slice(0, 16)} UTC\n\n`;

  if (ok.length > 0) {
    msg += `*OK (${ok.length})*\n`;
    ok.forEach(r => { msg += `- ${r.providerKey}: ${r.newModel}\n`; });
    msg += '\n';
  }

  if (changed.length > 0) {
    msg += `*Auto-replaced (${changed.length})*\n`;
    changed.forEach(r => {
      const label = r.status === 'auto-discovered' ? 'discovered' : 'replaced';
      msg += `- ${r.providerKey}: ${r.oldModel} -> ${r.newModel} [${label}]\n`;
    });
    msg += '\n';
  }

  if (dead.length > 0) {
    msg += `*DEAD - no working model (${dead.length})*\n`;
    dead.forEach(r => { msg += `- ${r.providerKey}: ${r.reason}\n`; });
    msg += '\n';
  }

  msg += `${ok.length} healthy / ${changed.length} auto-fixed / ${dead.length} dead`;

  await tgSend(msg);
  console.log('[health-check] Report sent to Telegram');
  return { ok: ok.length, changed: changed.length, dead: dead.length, results };
}

// ─── Exports ───────────────────────────────────────────────────────────────
module.exports = { runHealthCheck, loadModels, MODELS_PATH };

// ─── Direct execution ──────────────────────────────────────────────────────
if (require.main === module) {
  runHealthCheck('manual').then(r => {
    console.log('[health-check] Done:', r);
    process.exit(0);
  }).catch(e => {
    console.error('[health-check] Fatal:', e);
    process.exit(1);
  });
}
