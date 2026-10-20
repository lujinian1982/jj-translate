const $ = (s) => document.querySelector(s);

function fillSelect(sel, items, value) {
  sel.replaceChildren(
    ...items.map(([v, label]) => {
      const o = document.createElement('option');
      o.value = v;
      o.textContent = label;
      return o;
    }),
  );
  sel.value = value;
}

async function sendToTab(tabId, msg) {
  try {
    return await chrome.tabs.sendMessage(tabId, msg);
  } catch {
    return null;
  }
}

// Tabs opened before the extension was installed have no content script yet.
async function ensureContent(tab) {
  let state = await sendToTab(tab.id, { type: 'getState' });
  if (state) return state;
  try {
    await chrome.scripting.insertCSS({ target: { tabId: tab.id }, files: ['content.css'] });
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['common.js', 'content.js'] });
  } catch {
    return null;
  }
  return sendToTab(tab.id, { type: 'getState' });
}

(async () => {
  const s = await LT.getSettings();
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  fillSelect($('#targetLang'), LT.LANGS.map(([c, l]) => [c, l]), s.targetLang);
  fillSelect($('#theme'), LT.THEMES, s.theme);
  fillSelect($('#profile'), s.profiles.map((p) => [p.id, `${p.name} · ${p.model}`]), s.activeProfileId);

  const showKeyWarn = (settings) => {
    const p = LT.activeProfile(settings);
    $('#keyWarn').hidden = !!(p && p.apiKey) || /localhost|127\.0\.0\.1/.test(p?.baseUrl || '');
  };
  showKeyWarn(s);

  const paintMode = (mode) =>
    document.querySelectorAll('[data-mode]').forEach((b) => b.classList.toggle('sel', b.dataset.mode === mode));
  paintMode(s.mode);

  // Page toggle
  const btn = $('#toggle');
  const paintToggle = (active) => {
    btn.textContent = active ? '显示原文' : '翻译此页';
    btn.classList.toggle('on', active);
  };
  const isPdf = tab && /\.pdf($|[?#])/i.test(tab.url || '');
  $('#pdfHint').hidden = !isPdf;
  if (isPdf) $('#babeldoc').classList.replace('secondary', 'primary');

  const state = tab && /^(https?|file):/.test(tab.url || '') && !isPdf ? await ensureContent(tab) : null;
  if (!state) {
    btn.disabled = true;
    $('#pageHint').hidden = false;
    $('#pageHint').textContent = isPdf ? 'PDF 页面请用下方的 BabelDOC 翻译。' : '这个页面不支持翻译（浏览器内部页面或扩展商店）。';
  } else {
    paintToggle(state.active);
  }
  btn.onclick = async () => {
    const r = await sendToTab(tab.id, { type: 'toggle' });
    if (r) paintToggle(r.active);
  };

  // Settings
  document.querySelectorAll('[data-mode]').forEach((b) => {
    b.onclick = async () => {
      paintMode(b.dataset.mode);
      await chrome.storage.local.set({ mode: b.dataset.mode });
    };
  });
  $('#targetLang').onchange = (e) => chrome.storage.local.set({ targetLang: e.target.value });
  $('#theme').onchange = (e) => chrome.storage.local.set({ theme: e.target.value });
  $('#profile').onchange = async (e) => {
    await chrome.storage.local.set({ activeProfileId: e.target.value });
    showKeyWarn(await LT.getSettings());
  };

  $('#babeldoc').onclick = () => (s.babeldocUrl ? chrome.tabs.create({ url: s.babeldocUrl }) : chrome.runtime.openOptionsPage());
  $('#openOptions').onclick = () => chrome.runtime.openOptionsPage();
})();
