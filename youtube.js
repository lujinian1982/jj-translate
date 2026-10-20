// YouTube bilingual subtitles. Receives the caption track from yt_main.js,
// translates the whole track, and draws its own overlay synced to the video.
(() => {
  if (window.__ltYtLoaded) return;
  window.__ltYtLoaded = true;

  const CHUNK = 25; // cues per request
  const PARALLEL = 3;

  let track = null; // { key, cues: [{ s, e, text, tr }] }
  let gen = 0;
  let overlay = null;
  let player = null;
  let video = null;
  let lastIdx = -2;

  window.addEventListener('message', (e) => {
    if (e.source !== window || !e.data || e.data.__lt_yt !== 'track') return;
    handleTrack(e.data.url, e.data.text);
  });
  window.postMessage({ __lt_yt: 'ready' }, location.origin);

  document.addEventListener('yt-navigate-start', clear);

  const base = (code) => (code || '').toLowerCase().split(/[-_]/)[0];

  async function handleTrack(url, body) {
    const s = await LT.getSettings();
    if (!s.youtubeEnabled) return;
    let u;
    try {
      u = new URL(url);
    } catch {
      return;
    }
    const q = u.searchParams;
    const lang = q.get('tlang') || q.get('lang') || '';
    const key = [q.get('v'), lang, q.get('kind') || '', q.get('name') || ''].join('|') + '|' + s.targetLang;
    if (track && track.key === key) return;

    let data;
    try {
      data = JSON.parse(body);
    } catch {
      return; // not json3 (e.g. XML format); not supported
    }
    clear();
    if (base(lang) === base(s.targetLang)) return; // captions already in target language

    const cues = buildCues(data, q.get('kind') === 'asr');
    if (!cues.length) return;
    track = { key, cues };
    mount();
    translateTrack(track, s, ++gen);
  }

  // ---------- caption parsing (json3) ----------
  function buildCues(data, asr) {
    const evs = (data.events || []).filter((e) => Array.isArray(e.segs) && e.segs.length);
    if (!asr) {
      return evs
        .map((e) => ({
          s: e.tStartMs,
          e: e.tStartMs + (e.dDurationMs || 2000),
          text: e.segs.map((x) => x.utf8 || '').join('').replace(/\s*\n\s*/g, ' ').trim(),
        }))
        .filter((c) => c.text);
    }

    // Auto-generated captions arrive word by word. Join words into sentences.
    const words = [];
    for (const e of evs) {
      for (const seg of e.segs) {
        const w = seg.utf8 || '';
        if (!w.trim()) continue;
        words.push({ t: e.tStartMs + (seg.tOffsetMs || 0), w });
      }
    }
    const cues = [];
    let cur = [];
    const pushCur = () => {
      if (!cur.length) return;
      const text = cur.map((x) => x.w).join('').replace(/\s+/g, ' ').trim();
      cues.push({ s: cur[0].t, e: cur[cur.length - 1].t + 1500, text });
      cur = [];
    };
    for (const w of words) {
      if (cur.length) {
        const prev = cur[cur.length - 1];
        const len = cur.reduce((n, x) => n + x.w.length, 0);
        if (w.t - prev.t > 1500 || /[.!?。！？]$/.test(prev.w.trim()) || len > 110 || cur.length >= 22) pushCur();
      }
      cur.push(w);
    }
    pushCur();
    for (let i = 0; i < cues.length - 1; i++) cues[i].e = Math.min(cues[i].e, cues[i + 1].s);
    return cues;
  }

  // ---------- translation ----------
  async function translateTrack(t, s, myGen) {
    const chunks = [];
    for (let i = 0; i < t.cues.length; i += CHUNK) chunks.push(t.cues.slice(i, i + CHUNK));
    // Start from the chunk at the current play position.
    const now = (video ? video.currentTime : 0) * 1000;
    const startIdx = Math.max(0, chunks.findIndex((c) => c[c.length - 1].e >= now));
    const order = chunks.slice(startIdx).concat(chunks.slice(0, startIdx));

    let next = 0;
    let failed = 0;
    const worker = async () => {
      while (next < order.length && myGen === gen) {
        const chunk = order[next++];
        let res;
        try {
          res = await chrome.runtime.sendMessage({ type: 'translate', texts: chunk.map((c) => c.text), to: s.targetLang });
        } catch (e) {
          res = { ok: false, error: String(e.message || e) };
        }
        if (myGen !== gen) return;
        if (res && res.ok) {
          chunk.forEach((c, i) => (c.tr = res.translations[i]));
          lastIdx = -2;
          update();
        } else if (++failed === 1) {
          console.warn('[JJ的沉浸翻译] 字幕翻译失败：', res && res.error);
        }
      }
    };
    await Promise.all(Array.from({ length: PARALLEL }, worker));
  }

  // ---------- overlay ----------
  function mount() {
    player = document.querySelector('#movie_player');
    if (!player) return;
    video = player.querySelector('video');
    overlay = player.querySelector('lt-yt-overlay');
    if (!overlay) {
      overlay = document.createElement('lt-yt-overlay');
      player.appendChild(overlay);
    }
    player.classList.add('lt-yt-on');
    if (video && !video.__ltBound) {
      video.__ltBound = true;
      ['timeupdate', 'seeked', 'play'].forEach((ev) => video.addEventListener(ev, update));
    }
    tick();
  }

  // timeupdate fires only ~4 times per second; poll every 100 ms for tighter sync.
  let ticking = false;
  function tick() {
    if (ticking) return;
    ticking = true;
    const loop = () => {
      if (!track) {
        ticking = false;
        return;
      }
      update();
      setTimeout(loop, 100);
    };
    loop();
  }

  function findCue(ms) {
    const cues = track.cues;
    let lo = 0;
    let hi = cues.length - 1;
    let ans = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (cues[mid].s <= ms) {
        ans = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    return ans >= 0 && ms < cues[ans].e ? ans : -1;
  }

  function captionsOn() {
    const btn = document.querySelector('.ytp-subtitles-button');
    return !btn || btn.getAttribute('aria-pressed') === 'true';
  }

  async function update() {
    if (!track || !overlay || !video) return;
    const on = captionsOn();
    player.classList.toggle('lt-yt-on', on);
    if (!on) return;
    const idx = findCue(video.currentTime * 1000);
    if (idx === lastIdx) return;
    lastIdx = idx;
    if (idx < 0) {
      overlay.classList.remove('lt-has-text');
      overlay.replaceChildren();
      return;
    }
    const cue = track.cues[idx];
    const s = await LT.getSettings();
    overlay.style.fontSize = Math.max(14, Math.round(player.clientHeight * 0.042)) + 'px';
    const rows = [];
    if (cue.tr) rows.push(row(cue.tr, 'lt-yt-tr'));
    if (s.youtubeShowOriginal || !cue.tr) rows.push(row(cue.text, 'lt-yt-orig'));
    overlay.replaceChildren(...rows);
    overlay.classList.add('lt-has-text');
  }

  function row(text, cls) {
    const d = document.createElement('div');
    d.className = 'lt-yt-row';
    const span = document.createElement('span');
    span.className = 'lt-yt-line ' + cls;
    span.textContent = text;
    d.appendChild(span);
    return d;
  }

  function clear() {
    gen++;
    track = null;
    lastIdx = -2;
    if (overlay) {
      overlay.replaceChildren();
      overlay.classList.remove('lt-has-text');
    }
    if (player) player.classList.remove('lt-yt-on');
  }
})();
