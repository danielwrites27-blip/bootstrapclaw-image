#!/usr/bin/env node
// lint-prompts.js — BootstrapClaw quality gate
// Usage: node /root/bootstrapclaw/lint-prompts.js
// Exit 0 = pass, Exit 1 = fail

var fs = require('fs');
var path = require('path');

var BASE   = '/root/bootstrapclaw';
var CORE   = BASE + '/bootstrapclaw-core.js';
var DRAFTS = BASE + '/data/drafts';

var failures = [];
var warnings = [];

function fail(msg) { failures.push('❌ ' + msg); }
function warn(msg) { warnings.push('⚠️  ' + msg); }
function pass(msg) { console.log('✅ ' + msg); }

// ── 1. Read core file ────────────────────────────────────────────────────────
var core;
try {
  core = fs.readFileSync(CORE, 'utf8');
} catch(e) {
  fail('Cannot read ' + CORE);
  print(); process.exit(1);
}

// ── 2. Prompt content checks (inline in core.js) ────────────────────────────

// Banned models
if (/mistral/i.test(core))         fail('Banned model reference: mistral (network-blocked)');
else                               pass('No mistral references');

if (/groq.*70b|70b.*groq/i.test(core)) fail('Banned model: groq 70b (retired, tool calling fails)');
else                                    pass('No groq-70b references');

// Researcher prompt must reference tavily and research.json
var researcherBlock = core.match(/runResearcher[\s\S]{0,10000}?runWriter/);
if (researcherBlock) {
  var rb = researcherBlock[0];
  if (!/tavily/i.test(rb))       fail('Researcher prompt missing "tavily" reference');
  else                           pass('Researcher references tavily');
  if (!/research\.json/i.test(rb)) fail('Researcher prompt missing "research.json" reference');
  else                             pass('Researcher references research.json');
} else {
  warn('Could not isolate researcher block for prompt checks');
}

// Writer prompt must reference 800/900, published:true, body_markdown
var writerBlock = core.match(/runWriter[\s\S]{0,10000}?runReporter/);
if (writerBlock) {
  var wb = writerBlock[0];
  if (!/[89]00/.test(wb))           fail('Writer prompt missing word count (800 or 900)');
  else                               pass('Writer prompt has word count requirement');
  if (!/body_markdown/i.test(wb))    fail('Writer prompt missing "body_markdown" field');
  else                               pass('Writer prompt references body_markdown');
} else {
  warn('Could not isolate writer block for prompt checks');
}

// Reporter must reference devto-publish.js
var reporterBlock = core.match(/runReporter[\s\S]{0,10000}?runPipeline/);
if (reporterBlock) {
  if (!/devto-publish\.js/.test(reporterBlock[0])) fail('Reporter missing devto-publish.js reference');
  else                                               pass('Reporter references devto-publish.js');
} else {
  warn('Could not isolate reporter block for prompt checks');
}

// ── 3. Safety checks ────────────────────────────────────────────────────────

// No /tmp/ paths in core
var tmpMatches = core.match(/['"`]\/tmp\//g);
if (tmpMatches && tmpMatches.length > 0) fail('/tmp/ path found in core.js (' + tmpMatches.length + ' occurrence/s)');
else                                     pass('No /tmp/ paths in core.js');

// No sessions_spawn legacy references
if (/sessions_spawn/i.test(core)) fail('Legacy sessions_spawn reference found');
else                              pass('No sessions_spawn references');

// No bare ${ENV_VAR} outside template literals (common copy-paste mistake)
if (/'\$\{[A-Z_]+\}'/.test(core)) fail('Possible unsubstituted ${ENV_VAR} in single-quoted string');
else                               pass('No unsubstituted env vars in single-quoted strings');

// ── 4. article.json pre-publish checks (only if file exists) ────────────────
var articlePath = DRAFTS + '/article.json';
if (fs.existsSync(articlePath)) {
  var article;
  try {
    article = JSON.parse(fs.readFileSync(articlePath, 'utf8'));
    pass('article.json is valid JSON');
  } catch(e) {
    fail('article.json is not valid JSON: ' + e.message);
    article = null;
  }

  if (article) {
    var body = article.body_markdown || '';
    var words = body.split(/\s+/).filter(Boolean).length;

    if (words < 800) fail('article.json word count too low: ' + words + ' (need 800+)');
    else             pass('article.json word count: ' + words);

    if (/(Article title here|continues\.\.\.|truncated|\[INSERT)/i.test(body))
      fail('article.json contains placeholder text');
    else
      pass('No placeholder text in article.json');

    if (/(by leveraging|in conclusion|what matters most|dive into|game-changer)/i.test(body))
      fail('article.json contains banned phrases');
    else
      pass('No banned phrases in article.json');
  }
} else {
  pass('article.json not present — skipping draft checks (pre-run is fine)');
}

// ── 5. Report ────────────────────────────────────────────────────────────────
function print() {
  console.log('\n── Warnings ─────────────────────────────────────');
  if (warnings.length) warnings.forEach(function(w) { console.log(w); });
  else console.log('None');

  console.log('\n── Result ───────────────────────────────────────');
  if (failures.length) {
    failures.forEach(function(f) { console.log(f); });
    console.log('\n🔴 LINT FAILED — ' + failures.length + ' issue/s\n');
    process.exit(1);
  } else {
    console.log('\n🟢 LINT PASSED — all checks clean\n');
    process.exit(0);
  }
}

print();
