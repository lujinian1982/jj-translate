// Page translation (bilingual / translation-only) and input box translation.
(() => {
  if (window.__ltContentLoaded) return;
  window.__ltContentLoaded = true;

  // Never look inside these, never use their text.
  const SKIP_TREE = new Set([
    'SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'TEXTAREA', 'INPUT', 'SELECT', 'OPTION',
    'BUTTON', 'PRE', 'SVG', 'svg', 'MATH', 'math', 'CANVAS', 'IFRAME', 'OBJECT', 'EMBED',
    'VIDEO', 'AUDIO', 'LT-TRANS', 'LT-TOAST', 'LT-YT-OVERLAY',
  ]);
  // Text inside these stays in the paragraph text but never starts a paragraph.
  const CODE_TAGS = new Set(['CODE', 'KBD', 'SAMP', 'TT', 'VAR']);
  const INLINE_TAGS = new Set([
    'A', 'ABBR', 'B', 'BDI', 'BDO', 'BIG', 'BR', 'CITE', 'CODE', 'DATA', 'DEL', 'DFN', 'EM',
    'FONT', 'I', 'IMG', 'INS', 'KBD', 'LABEL', 'MARK', 'Q', 'RUBY', 'RT', 'RP', 'S', 'SAMP',
    'SMALL', 'SPAN', 'STRIKE', 'STRONG', 'SUB', 'SUP', 'TIME', 'TT', 'U', 'VAR', 'WBR',
    'LT-ORIG', 'LT-TEXT',
  ]);
  const BLOCK_TAGS = new Set([
    'P', 'DIV', 'LI', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'TD', 'TH', 'DT', 'DD', 'BLOCKQUOTE',
    'FIGCAPTION', 'ARTICLE', 'SECTION', 'MAIN', 'HEADER', 'FOOTER', 'NAV', 'ASIDE', 'UL', 'OL',
    'DL', 'TABLE', 'TR', 'TBODY', 'THEAD', 'TFOOT', 'FORM', 'FIELDSET', 'LEGEND', 'DETAILS',
    'SUMMARY', 'CAPTION', 'BODY', 'ADDRESS', 'FIGURE', 'HR',
  ]);

  const inlineCache = new WeakMap();
  const sourceText = new WeakMap(); // block -> text sent for translation
  const pageCache = new Map(); // text -> translation, for this page and target language

  let settings = null;
  let active = false;
  let gen = 0; // bumps on start/stop so late replies are dropped
  let pending = [];
  let flushTimer = 0;
  let io = null;
  let mo = null;
  let mutTimer = 0;
  const mutRoots = new Set();

  // ---------- DOM helpers ----------
  function isInline(el) {
    const tag = el.tagName;
    if (INLINE_TAGS.has(tag)) return true;
    if (BLOCK_TAGS.has(tag)) return false;
    let v = inlineCache.get(el);
    if (v === undefined) {
      const d = getComputedStyle(el).display;
      v = d.startsWith('inline') || d === 'contents' || d === 'ruby';
      inlineCache.set(el, v);
    }
    return v;
  }

  function skipEl(el) {
    if (SKIP_TREE.has(el.tagName)) return true;
    if (el.isContentEditable) return true;
    if (el.getAttribute('translate') === 'no' || el.classList.contains('notranslate')) return true;
    return false;
  }

  function findBlock(textNode) {
    let el = textNode.parentElement;
    let inCode = false;
    while (el && el !== document.body) {
      if (CODE_TAGS.has(el.tagName)) inCode = true;
      if (!isInline(el)) return inCode ? null : el;
      el = el.parentElement;
    }
    return null;
  }

  function extractText(block) {
    const out = [];
    (function walk(node) {
      let prevLink = false;
      for (const c of node.childNodes) {
        if (c.nodeType === 3) {
          out.push(c.nodeValue);
          prevLink = false;
        } else if (c.nodeType === 1) {
          if (c.tagName === 'BR') out.push('\n');
          else if (SKIP_TREE.has(c.tagName)) continue;
          else if (isInline(c)) {
            // Menus often put links side by side with no space between them.
            if (prevLink && c.tagName === 'A') out.push(' ');
            walk(c);
          }
          prevLink = c.tagName === 'A';
        }
      }
    })(block);
    return out
      .join('')
      .replace(/[ \t\r\f\v ]+/g, ' ')
      .replace(/ *\n */g, '\n')
      .replace(/\n{2,}/g, '\n')
      .trim();
  }

  function ratio(text, re) {
    const letters = (text.match(/\p{L}/gu) || []).length;
    if (!letters) return 0;
    return (text.match(re) || []).length / letters;
  }

  function alreadyTarget(text) {
    const to = settings.targetLang;
    if (to.startsWith('zh')) return ratio(text, /\p{Script=Han}/gu) > 0.5 && !/[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(text);
    if (to === 'ja') return /[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(text);
    if (to === 'ko') return ratio(text, /\p{Script=Hangul}/gu) > 0.5;
    if (to === 'en') return ratio(text, /\p{Script=Latin}/gu) > 0.9;
    return false;
  }

  function worthTranslating(text) {
    return text.length >= 2 && /\p{L}/u.test(text) && !alreadyTarget(text);
  }

  function ownTrans(block) {
    for (const c of block.children) if (c.tagName === 'LT-TRANS') return c;
    return null;
  }

  // Insert the translation after the paragraph's inline content,
  // before the first nested block (e.g. a nested list inside <li>).
  function insertionRef(block) {
    for (const c of block.childNodes) {
      if (c.nodeType === 1 && c.tagName !== 'LT-TRANS' && !SKIP_TREE.has(c.tagName) && !isInline(c)) return c;
    }
    return null;
  }

  function makeTrans(block) {
    let t = ownTrans(block);
    if (t) return t;
    t = document.createElement('lt-trans');
    t.setAttribute('translate', 'no');
    block.insertBefore(t, insertionRef(block));
    return t;
  }

  function removeTrans(block) {
    const t = ownTrans(block);
    if (t) t.remove();
  }

  // Translation-only mode: move the original inline nodes into <lt-orig>
  // so CSS can hide them. Done only when that mode is used.
  function wrapOriginal(block) {
    for (const c of block.children) if (c.tagName === 'LT-ORIG') return;
    const t = ownTrans(block);
    if (!t) return;
    const nodes = [];
    for (const c of block.childNodes) {
      if (c === t) break;
      if (c.nodeType === 3 || (c.nodeType === 1 && isInline(c))) nodes.push(c);
    }
    if (!nodes.length) return;
    const o = document.createElement('lt-orig');
    block.insertBefore(o, nodes[0]);
    o.append(...nodes);
  }

  // ---------- scanning ----------
  function scan(root) {
    if (!active || !root) return;
    if (root.nodeType === 3) root = root.parentElement;
    if (!root || !root.isConnected || root.closest('lt-trans')) return;
    for (let a = root; a && a !== document.body; a = a.parentElement) if (skipEl(a)) return;

    const blocks = new Set();
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
      acceptNode(n) {
        if (n.nodeType === 1) return skipEl(n) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_SKIP;
        return /\S/.test(n.nodeValue) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
      },
    });
    let n;
    while ((n = walker.nextNode())) {
      const b = findBlock(n);
      if (b) blocks.add(b);
    }
    for (const b of blocks) consider(b);
  }

  function consider(block) {
    const st = block.dataset.lt;
    if (st === 'queued' || st === 'pending') return;
    const text = extractText(block);
    if (st === 'same' && sourceText.get(block) === text) return;
    if (st === 'done' || st === 'error') {
      // Unchanged and our element still there: nothing to do. If the page
      // re-rendered and dropped our element, pageCache re-renders it fast.
      if (sourceText.get(block) === text && ownTrans(block)) return;
      removeTrans(block);
    }
    if (!worthTranslating(text)) {
      delete block.dataset.lt;
      return;
    }
    sourceText.set(block, text);
    block.dataset.lt = 'queued';
    io.observe(block);
  }

  // ---------- batching ----------
  function enqueue(block) {
    pending.push(block);
    if (!flushTimer) flushTimer = setTimeout(flush, 120);
  }

  function flush() {
    flushTimer = 0;
    const myGen = gen;
    const items = pending.splice(0).filter((b) => b.isConnected && b.dataset.lt === 'queued');
    const groups = [];
    let cur = [];
    let chars = 0;
    for (const b of items) {
      const t = sourceText.get(b);
      if (pageCache.has(t)) {
        render(b, pageCache.get(t));
        continue;
      }
      b.dataset.lt = 'pending';
      showLoading(b);
      if (cur.length && (cur.length >= settings.batchSize || chars + t.length > settings.maxCharsPerBatch)) {
        groups.push(cur);
        cur = [];
        chars = 0;
      }
      cur.push(b);
      chars += t.length;
    }
    if (cur.length) groups.push(cur);
    for (const g of groups) sendGroup(g, myGen);
  }

  async function sendGroup(group, myGen) {
    const uniq = [...new Set(group.map((b) => sourceText.get(b)))];
    const res = await send({ type: 'translate', texts: uniq, to: settings.targetLang });
    if (myGen !== gen) return;
    if (res && res.ok) {
      const map = new Map(uniq.map((t, i) => [t, res.translations[i]]));
      for (const b of group) {
        const src = sourceText.get(b);
        const tr = map.get(src);
        if (tr == null) continue;
        pageCache.set(src, tr);
        render(b, tr);
      }
    } else {
      for (const b of group) renderError(b, res ? res.error : '扩展通信失败');
    }
  }

  async function send(msg) {
    try {
      return await chrome.runtime.sendMessage(msg);
    } catch (e) {
      return { ok: false, error: String(e.message || e) };
    }
  }

  // ---------- rendering ----------
  function render(block, tr) {
    if (!block.isConnected) return;
    const src = sourceText.get(block) || '';
    if (!tr || tr.trim() === src.trim()) {
      block.dataset.lt = 'same';
      removeTrans(block);
      return;
    }
    block.dataset.lt = 'done';
    const t = makeTrans(block);
    const inline = src.length <= 24 && tr.length <= 24 && !src.includes('\n') && !/^H[1-6]$/.test(block.tagName);
    t.className = inline ? 'lt-inline' : 'lt-block';
    t.lang = settings.targetLang;
    const span = document.createElement('lt-text');
    span.textContent = tr;
    t.replaceChildren(...(inline ? [document.createTextNode(' '), span] : [span]));
    if (settings.mode === 'translation') wrapOriginal(block);
  }

  function showLoading(block) {
    const t = makeTrans(block);
    t.className = 'lt-inline lt-loading';
    const dot = document.createElement('lt-dot');
    t.replaceChildren(document.createTextNode(' '), dot);
  }

  function renderError(block, err) {
    if (!block.isConnected) return;
    block.dataset.lt = 'error';
    const t = makeTrans(block);
    t.className = 'lt-inline lt-error';
    t.title = err;
    const span = document.createElement('lt-text');
    span.textContent = ' ⚠ 翻译失败，点击重试';
    t.replaceChildren(span);
    t.onclick = (e) => {
      e.preventDefault();
      e.stopPropagation();
      t.onclick = null;
      block.dataset.lt = 'queued';
      enqueue(block);
    };
    showToast('翻译失败：' + err);
  }

  function applyAppearance() {
    const html = document.documentElement;
    html.dataset.ltTheme = settings.theme;
    const only = active && settings.mode === 'translation';
    html.classList.toggle('lt-only', only);
    if (only) document.querySelectorAll('[data-lt="done"]').forEach(wrapOriginal);
  }

  // ---------- start / stop ----------
  function onMutations(records) {
    for (const r of records) {
      if (r.type === 'characterData') {
        const p = r.target.parentElement;
        if (p && !p.closest('lt-trans')) mutRoots.add(p);
        continue;
      }
      for (const n of r.addedNodes) {
        if (n.nodeType === 1 && (n.tagName === 'LT-TRANS' || n.tagName === 'LT-ORIG' || n.tagName === 'LT-TOAST')) continue;
        const el = n.nodeType === 1 ? n : n.parentElement;
        if (!el || el.closest('lt-trans, lt-orig')) continue;
        mutRoots.add(el);
      }
    }
    if (mutRoots.size && !mutTimer) {
      mutTimer = setTimeout(() => {
        mutTimer = 0;
        const roots = [...mutRoots];
        mutRoots.clear();
        for (const r of roots) scan(r);
      }, 400);
    }
  }

  async function start() {
    settings = await LT.getSettings();
    if (active) return;
    active = true;
    gen++;
    pageCache.clear();
    io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (!e.isIntersecting) continue;
          io.unobserve(e.target);
          enqueue(e.target);
        }
      },
      { rootMargin: '800px 0px' },
    );
    mo = new MutationObserver(onMutations);
    applyAppearance();
    scan(document.body);
    mo.observe(document.body, { childList: true, subtree: true, characterData: true });
  }

  function stop() {
    if (!active) return;
    active = false;
    gen++;
    io && io.disconnect();
    mo && mo.disconnect();
    clearTimeout(flushTimer);
    clearTimeout(mutTimer);
    flushTimer = mutTimer = 0;
    pending = [];
    mutRoots.clear();
    document.querySelectorAll('lt-trans').forEach((t) => t.remove());
    document.querySelectorAll('lt-orig').forEach((o) => o.replaceWith(...o.childNodes));
    document.querySelectorAll('[data-lt]').forEach((b) => delete b.dataset.lt);
    document.documentElement.classList.remove('lt-only');
  }

  // ---------- input box translation ----------
  function deepActive() {
    let a = document.activeElement;
    while (a && a.shadowRoot && a.shadowRoot.activeElement) a = a.shadowRoot.activeElement;
    return a;
  }

  function editHost(el) {
    while (el && el.parentElement && el.parentElement.isContentEditable) el = el.parentElement;
    return el;
  }

  function fieldOf(el) {
    if (!el || el.nodeType !== 1) return null;
    if (el.tagName === 'TEXTAREA') return el;
    if (el.tagName === 'INPUT' && /^(text|search|url|email)$/i.test(el.type || 'text')) return el;
    if (el.isContentEditable) return editHost(el);
    return null;
  }

  function fieldText(el) {
    return el.isContentEditable ? el.innerText : el.value;
  }

  function setFieldText(el, v) {
    if (el.isContentEditable) {
      el.focus();
      const range = document.createRange();
      range.selectNodeContents(el);
      const sel = getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      if (!document.execCommand('insertText', false, v)) el.innerText = v;
    } else {
      const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, v);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }
  }

  let inputBusy = false;
  async function translateInput(target) {
    const el = fieldOf(target);
    if (!el || inputBusy) return;
    if (!settings) settings = await LT.getSettings();
    const text = fieldText(el).replace(/[\s ]+$/, '');
    if (!text.trim()) return;
    inputBusy = true;
    el.setAttribute('data-lt-busy', '');
    const res = await send({ type: 'translate', texts: [text], to: settings.inputTargetLang, single: true });
    el.removeAttribute('data-lt-busy');
    inputBusy = false;
    if (!res || !res.ok) {
      showToast('输入框翻译失败：' + (res ? res.error : '扩展通信失败'));
      return;
    }
    setFieldText(el, res.translations[0]);
  }

  // Trigger: three spaces at the end of the field.
  document.addEventListener(
    'input',
    (e) => {
      if (!settings || !settings.inputTrigger || inputBusy) return;
      const el = fieldOf(e.composedPath()[0]);
      if (!el) return;
      // textContent keeps trailing spaces; innerText collapses them in editors.
      const raw = el.isContentEditable ? el.textContent : el.value;
      const v = raw.replace(/ /g, ' ').replace(/\n+$/, '');
      if (/\S {3}$/.test(v)) translateInput(el);
    },
    true,
  );

  // ---------- toast ----------
  let toastTimer = 0;
  function showToast(msg) {
    let t = document.querySelector('lt-toast');
    if (!t) {
      t = document.createElement('lt-toast');
      document.documentElement.appendChild(t);
    }
    t.textContent = msg;
    t.classList.add('lt-show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('lt-show'), 4000);
  }

  // ---------- messages & settings ----------
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === 'getState') {
      sendResponse({ active });
    } else if (msg.type === 'toggle') {
      (active ? Promise.resolve(stop()) : start()).then(() => sendResponse({ active }));
      return true;
    } else if (msg.type === 'translateInput') {
      translateInput(deepActive());
      sendResponse({ ok: true });
    }
  });

  chrome.storage.onChanged.addListener(async (changes, area) => {
    if (area !== 'local') return;
    const prev = settings;
    settings = await LT.getSettings();
    if (!prev) return;
    const langOrModel =
      changes.targetLang || changes.activeProfileId ||
      (changes.profiles && JSON.stringify(LT.activeProfile(prev)) !== JSON.stringify(LT.activeProfile(settings)));
    if (active && langOrModel) {
      stop();
      start();
      return;
    }
    if (changes.mode && settings.mode === 'bilingual') {
      // Unwrap originals when going back to bilingual.
      document.querySelectorAll('lt-orig').forEach((o) => o.replaceWith(...o.childNodes));
    }
    applyAppearance();
  });

  LT.getSettings().then((s) => {
    settings = s;
  });
})();
