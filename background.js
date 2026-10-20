importScripts('common.js');

// ---------- cache ----------
const cache = new Map();
const CACHE_MAX = 5000;
function cacheSet(k, v) {
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
  cache.set(k, v);
}

// ---------- concurrency limit ----------
let running = 0;
const waiters = [];
async function withSlot(limit, fn) {
  while (running >= Math.max(1, limit)) await new Promise((r) => waiters.push(r));
  running++;
  try {
    return await fn();
  } finally {
    running--;
    const next = waiters.shift();
    if (next) next();
  }
}

// ---------- OpenAI-compatible request ----------
function endpoint(base) {
  base = (base || '').trim().replace(/\/+$/, '');
  return /\/chat\/completions$/.test(base) ? base : base + '/chat/completions';
}

class ApiError extends Error {
  constructor(message, fatal) {
    super(message);
    this.fatal = fatal;
  }
}

async function chat(profile, messages, { json = false } = {}, attempt = 0) {
  if (!profile || !profile.baseUrl) throw new ApiError('未配置模型 API，请打开设置页填写。', true);
  const body = {
    model: profile.model,
    messages,
    temperature: Number(profile.temperature ?? 0.3),
    stream: false,
  };
  if (json && profile.jsonMode !== false) body.response_format = { type: 'json_object' };
  if (profile.extraBody && profile.extraBody.trim()) {
    try {
      Object.assign(body, JSON.parse(profile.extraBody));
    } catch {
      throw new ApiError('配置里的“额外请求参数”不是合法 JSON。', true);
    }
  }
  const headers = { 'Content-Type': 'application/json' };
  if (profile.apiKey) headers.Authorization = 'Bearer ' + profile.apiKey.trim();

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 90000);
  let res, text;
  try {
    res = await fetch(endpoint(profile.baseUrl), {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    text = await res.text();
  } catch (e) {
    if (attempt < 1) return chat(profile, messages, { json }, attempt + 1);
    throw new ApiError('网络请求失败：' + (e.name === 'AbortError' ? '超时' : e.message), false);
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    const retryable = res.status === 429 || res.status >= 500;
    if (retryable && attempt < 2) {
      await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
      return chat(profile, messages, { json }, attempt + 1);
    }
    throw new ApiError(`HTTP ${res.status}：${text.slice(0, 300)}`, !retryable);
  }

  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new ApiError('接口返回的不是 JSON：' + text.slice(0, 200), false);
  }
  const content = data?.choices?.[0]?.message?.content ?? '';
  return String(content).replace(/<think>[\s\S]*?<\/think>/g, '').trim();
}

// ---------- translation ----------
function fill(tpl, toName) {
  return tpl.replaceAll('{{to}}', toName);
}

function parseBatch(content, n) {
  let s = content.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  const start = s.search(/[[{]/);
  if (start > 0) s = s.slice(start);
  let obj;
  try {
    obj = JSON.parse(s);
  } catch {
    return null;
  }
  let arr = Array.isArray(obj) ? obj : obj.translations;
  if (!Array.isArray(arr)) arr = Object.values(obj).find(Array.isArray);
  if (!Array.isArray(arr) || arr.length !== n) return null;
  return arr.map((x) => (typeof x === 'string' ? x : x?.text ?? String(x)));
}

async function translateBatchRaw(profile, texts, toName, s) {
  const system = fill(s.systemPrompt && s.systemPrompt.trim() ? s.systemPrompt : LT.BATCH_SYSTEM_PROMPT, toName);
  const content = await chat(
    profile,
    [
      { role: 'system', content: system },
      { role: 'user', content: JSON.stringify({ items: texts }) },
    ],
    { json: true },
  );
  return parseBatch(content, texts.length);
}

function translateOne(profile, text, toName, s) {
  return withSlot(s.concurrency, () =>
    chat(profile, [
      { role: 'system', content: fill(LT.SINGLE_SYSTEM_PROMPT, toName) },
      { role: 'user', content: text },
    ]),
  );
}

async function translateTexts({ texts, to, single }, s) {
  const profile = LT.activeProfile(s);
  const toName = LT.promptLangName(to || s.targetLang);
  const keyBase = `${profile.baseUrl}|${profile.model}|${toName}|${single ? 1 : 0}|`;
  const out = new Array(texts.length);
  const missIdx = [];
  texts.forEach((t, i) => {
    const c = cache.get(keyBase + t);
    if (c !== undefined) out[i] = c;
    else missIdx.push(i);
  });
  if (!missIdx.length) return out;

  const miss = missIdx.map((i) => texts[i]);
  let res = null;
  if (!single && miss.length > 1) {
    try {
      res = await withSlot(s.concurrency, () => translateBatchRaw(profile, miss, toName, s));
    } catch (e) {
      if (e.fatal) throw e;
    }
  }
  // Batch reply could not be parsed or item count did not match:
  // fall back to one request per item.
  if (!res) res = await Promise.all(miss.map((t) => translateOne(profile, t, toName, s)));

  missIdx.forEach((i, k) => {
    out[i] = res[k];
    cacheSet(keyBase + texts[i], res[k]);
  });
  return out;
}

// ---------- messaging ----------
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === 'translate') {
    (async () => {
      try {
        const s = await LT.getSettings();
        const translations = await translateTexts(msg, s);
        sendResponse({ ok: true, translations });
      } catch (e) {
        sendResponse({ ok: false, error: String(e.message || e) });
      }
    })();
    return true;
  }
  if (msg?.type === 'testProfile') {
    (async () => {
      try {
        const s = await LT.getSettings();
        const t0 = Date.now();
        const [single, batch] = [
          await chat(msg.profile, [
            { role: 'system', content: fill(LT.SINGLE_SYSTEM_PROMPT, 'Simplified Chinese') },
            { role: 'user', content: 'Hello, world! This is a translation test.' },
          ]),
          await translateBatchRaw(msg.profile, ['Good morning.', 'How are you?'], 'Simplified Chinese', s),
        ];
        sendResponse({
          ok: true,
          result: single,
          batchOk: !!batch,
          ms: Date.now() - t0,
        });
      } catch (e) {
        sendResponse({ ok: false, error: String(e.message || e) });
      }
    })();
    return true;
  }
});

chrome.commands.onCommand.addListener(async (cmd, tab) => {
  if (!tab?.id) [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return;
  const type = cmd === 'toggle-page' ? 'toggle' : cmd === 'translate-input' ? 'translateInput' : null;
  if (type) chrome.tabs.sendMessage(tab.id, { type }).catch(() => {});
});
