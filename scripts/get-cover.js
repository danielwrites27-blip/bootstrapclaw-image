#!/usr/bin/env node
// Fetches images and prints the first Pexels URL only — no JSON parsing needed by agent
const { execSync } = require('child_process');
const keyword = process.argv[2] || 'technology';
const output = execSync(`node /root/.openclaw/fetch-images.js "${keyword}"`).toString();
const images = JSON.parse(output);
const pexels = images.find(i => i.source === 'Pexels');
if (pexels) {
  console.log(pexels.url);
} else {
  console.error('NO_PEXELS_IMAGE');
  process.exit(1);
}
