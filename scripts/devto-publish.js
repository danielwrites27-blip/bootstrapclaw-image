#!/usr/bin/env node
const fs = require('fs');
const apiKey = process.env.DEVTO_API_KEY;
if (!apiKey) { console.error('NO_API_KEY'); process.exit(1); }
const articleFile = process.argv[2];
if (!articleFile) { console.error('Usage: node devto-publish.js <article.json>'); process.exit(1); }
const article = JSON.parse(fs.readFileSync(articleFile, 'utf8'));

// Normalize content field
if (article.content && !article.body_markdown) {
  article.body_markdown = article.content;
  delete article.content;
}

// Minimum word count guard
const wordCount = (article.body_markdown || '').split(/\s+/).filter(Boolean).length;
if (wordCount < 300) {
  console.error(`REJECTED: Body too short (${wordCount} words, minimum 300). Fix the article and retry.`);
  process.exit(1);
}

// Embed cover image as first line of body_markdown (not cover_image field)
if (article.cover_image && article.body_markdown) {
  const imgLine = `![cover](${article.cover_image})\n\n`;
  if (!article.body_markdown.startsWith('![')) {
    article.body_markdown = imgLine + article.body_markdown;
  }
}
delete article.cover_image;
delete article.main_image;

// UPDATE if id exists, CREATE otherwise
const articleId = article.id;
delete article.id;

const url = articleId
  ? `https://dev.to/api/articles/${articleId}`
  : 'https://dev.to/api/articles';
const method = articleId ? 'PUT' : 'POST';

fetch(url, {
  method,
  headers: { 'api-key': apiKey, 'content-type': 'application/json' },
  body: JSON.stringify({ article })
})
.then(r => r.json())
.then(data => {
  if (data.url) {
    console.log('SUCCESS:', data.url);
    console.log('ID:', data.id);
    console.log('SLUG:', data.slug);
  } else {
    console.log('ERROR:', JSON.stringify(data));
  }
})
.catch(e => console.error('FETCH_ERROR:', e.message));
