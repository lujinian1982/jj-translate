// Run: node test/background.test.js
// Loads common.js + background.js with fake chrome/fetch and checks the API layer.
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const root = path.join(__dirname, '..');
let onMessage;
let store = {};
const calls = [];
let reply; // (body) => { status, json }

const ctx = {
  console, setTimeout, clearTimeout, AbortController, URL,
  chrome: {
    storage: { local: { get: async () => ({ ...store }) } },
    runtime: { onMessage: { addListener: (f) => (onMessage = f) } },
    commands: { onCommand: { addListener() {} } },
    tabs: {},
  },
  fetch: async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url, body, headers: init.headers });
    const r = reply(body);
    const text = typeof r.json === 'string' ? r.json : JSON.stringify(r.json);
    return { ok: r.status === 200, status: r.status, text: async () => text };
  },
};
ctx.importScripts = (f) => vm.runInContext(fs.readFileSync(path.join(root, f), 'utf8'), ctx, { filename: f });
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(root, 'background.js'), 'utf8'), ctx, { filename: 'background.js' });

const send = (msg) => new Promise((res) => onMessage(msg, {}, (r) => res(JSON.parse(JSON.stringify(r)))));
const chatReply = (content) => ({ status: 200, json: { choices: [{ message: { content } }] } });
const itemsOf = (body) => JSON.parse(body.messages[1].content).items;

(async () => {
  store = { profiles: [{ id: 'd', name: 'DS', baseUrl: 'https://api.deepseek.com/', apiKey: 'k1', model: 'deepseek-chat', jsonMode: true }], activeProfileId: 'd' };

  // 1. batch OK
  reply = (b) => chatReply(JSON.stringify({ translations: itemsOf(b).map((t) => 'ZH:' + t) }));
  let r = await send({ type: 'translate', texts: ['a1', 'b1'], to: 'zh-CN' });
  assert.deepStrictEqual(r, { ok: true, translations: ['ZH:a1', 'ZH:b1'] });
  assert.strictEqual(calls[0].url, 'https://api.deepseek.com/chat/completions');
  assert.strictEqual(calls[0].headers.Authorization, 'Bearer k1');
  assert.deepStrictEqual({ ...calls[0].body.response_format }, { type: 'json_object' });
  assert.match(calls[0].body.messages[0].content, /Simplified Chinese/);
  console.log('ok 1 batch json');

  // 2. cache hit: no new request
  const n = calls.length;
  r = await send({ type: 'translate', texts: ['a1', 'b1'], to: 'zh-CN' });
  assert.strictEqual(calls.length, n);
  console.log('ok 2 cache');

  // 3. fenced json + <think>
  reply = (b) => chatReply('<think>hmm</think>```json\n' + JSON.stringify({ translations: itemsOf(b).map((t) => 'F:' + t) }) + '\n```');
  r = await send({ type: 'translate', texts: ['c1', 'd1'], to: 'zh-CN' });
  assert.deepStrictEqual(r.translations, ['F:c1', 'F:d1']);
  console.log('ok 3 fenced');

  // 4. count mismatch -> per-item fallback
  reply = (b) => (b.response_format ? chatReply(JSON.stringify({ translations: ['only one'] })) : chatReply('S:' + b.messages[1].content));
  r = await send({ type: 'translate', texts: ['e1', 'f1', 'g1'], to: 'zh-CN' });
  assert.deepStrictEqual(r.translations, ['S:e1', 'S:f1', 'S:g1']);
  console.log('ok 4 fallback');

  // 5. 401 is fatal: one request, error returned, no fallback storm
  const before = calls.length;
  reply = () => ({ status: 401, json: { error: { message: 'Authentication Fails' } } });
  r = await send({ type: 'translate', texts: ['h1', 'i1'], to: 'zh-CN' });
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /HTTP 401/);
  assert.strictEqual(calls.length - before, 1);
  console.log('ok 5 fatal 401');

  // 6. zhipu endpoint, extraBody merge, single (input box) mode
  store.profiles.push({ id: 'z', name: 'GLM', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', apiKey: 'zk', model: 'glm-4.5-air', jsonMode: true, extraBody: '{"thinking":{"type":"disabled"}}' });
  store.activeProfileId = 'z';
  reply = (b) => chatReply('Hello world');
  r = await send({ type: 'translate', texts: ['你好世界'], to: 'en', single: true });
  const last = calls[calls.length - 1];
  assert.strictEqual(last.url, 'https://open.bigmodel.cn/api/paas/v4/chat/completions');
  assert.deepStrictEqual(JSON.parse(JSON.stringify(last.body.thinking)), { type: 'disabled' });
  assert.strictEqual(last.body.response_format, undefined);
  assert.match(last.body.messages[0].content, /English/);
  assert.deepStrictEqual(r.translations, ['Hello world']);
  console.log('ok 6 zhipu single');

  // 7. 429 retried, then succeeds
  let hits = 0;
  reply = (b) => (++hits === 1 ? { status: 429, json: 'rate limited' } : chatReply(JSON.stringify({ translations: itemsOf(b) })));
  r = await send({ type: 'translate', texts: ['j1', 'k1'], to: 'ja' });
  assert.ok(r.ok && hits === 2);
  console.log('ok 7 retry 429');

  console.log('ALL PASSED');
})().catch((e) => {
  console.error('FAILED', e);
  process.exit(1);
});
