#!/usr/bin/env node
const token = process.env.TELEGRAM_BOT_TOKEN;
const chatId = '2053892551';
if (!token) { console.error('NO_TELEGRAM_TOKEN'); process.exit(1); }
const msg = process.argv[2];
if (!msg) { console.error('Usage: node tg-notify.js "message"'); process.exit(1); }
fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ chat_id: chatId, text: msg, parse_mode: 'HTML' })
})
.then(r => r.json())
.then(data => {
  if (data.ok) { console.log('SENT:', data.result.message_id); }
  else { console.error('ERROR:', JSON.stringify(data)); process.exit(1); }
})
.catch(e => { console.error('FETCH_ERROR:', e.message); process.exit(1); });
