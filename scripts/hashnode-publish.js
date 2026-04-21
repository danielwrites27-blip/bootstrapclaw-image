#!/usr/bin/env node
// hashnode-publish.js — publishes article to Hashnode via two-step GraphQL
// Usage: node hashnode-publish.js /path/to/article-publish.json

var https = require('https');
var fs = require('fs');

var articlePath = process.argv[2];
if (!articlePath) { console.error('Usage: node hashnode-publish.js <article.json>'); process.exit(1); }

var article = JSON.parse(fs.readFileSync(articlePath, 'utf8'));
var token = process.env.HASHNODE_API_KEY;
var publicationId = process.env.HASHNODE_PUBLICATION_ID;

if (!token || !publicationId) {
  console.error('ERROR: HASHNODE_API_KEY and HASHNODE_PUBLICATION_ID must be set');
  process.exit(1);
}

function gql(query, variables) {
  return new Promise(function(resolve, reject) {
    var body = JSON.stringify({ query: query, variables: variables });
    var req = https.request({
      hostname: 'gql.hashnode.com',
      path: '/',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': token,
        'Content-Length': Buffer.byteLength(body)
      }
    }, function(res) {
      var d = '';
      res.on('data', function(c) { d += c; });
      res.on('end', function() {
        try { resolve(JSON.parse(d)); }
        catch(e) { reject(new Error('Invalid JSON: ' + d.slice(0, 200))); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function publish() {
  // Step 1: Create draft
  var createMutation = `
    mutation CreateDraft($input: CreateDraftInput!) {
      createDraft(input: $input) {
        draft { id }
      }
    }
  `;
  var createVars = {
    input: {
      publicationId: publicationId,
      title: article.title,
      contentMarkdown: article.body_markdown,
      tags: []
    }
  };

  var createRes = await gql(createMutation, createVars);
  if (createRes.errors) throw new Error('createDraft failed: ' + JSON.stringify(createRes.errors));
  
  var draftId = createRes.data.createDraft.draft.id;

  // Step 2: Publish draft
  var publishMutation = `
    mutation PublishDraft($input: PublishDraftInput!) {
      publishDraft(input: $input) {
        post { url }
      }
    }
  `;
  var publishRes = await gql(publishMutation, { input: { draftId: draftId } });
  if (publishRes.errors) throw new Error('publishDraft failed: ' + JSON.stringify(publishRes.errors));

  var url = publishRes.data.publishDraft.post.url;
  console.log('SUCCESS: ' + url);
}

publish().catch(function(e) {
  console.error('ERROR: ' + e.message);
  process.exit(1);
});
