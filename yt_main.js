// Runs in the page (MAIN world) on YouTube. Captures the caption track the
// player itself downloads (/api/timedtext) and hands it to youtube.js.
(() => {
  if (window.__ltYtHooked) return;
  window.__ltYtHooked = true;

  let last = null; // replayed when youtube.js loads after the track arrived

  function post(url, text) {
    if (!text) return;
    last = { url, text };
    window.postMessage({ __lt_yt: 'track', url, text }, location.origin);
  }

  window.addEventListener('message', (e) => {
    if (e.source === window && e.data && e.data.__lt_yt === 'ready' && last) {
      window.postMessage({ __lt_yt: 'track', url: last.url, text: last.text }, location.origin);
    }
  });

  const isTimedText = (u) => typeof u === 'string' && u.includes('/api/timedtext');

  const origOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this.__ltUrl = String(url);
    return origOpen.call(this, method, url, ...rest);
  };

  const origSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.send = function (...args) {
    if (isTimedText(this.__ltUrl)) {
      this.addEventListener('load', () => {
        try {
          let t;
          if (this.responseType === '' || this.responseType === 'text') t = this.responseText;
          else if (typeof this.response === 'string') t = this.response;
          else if (this.response && this.responseType === 'json') t = JSON.stringify(this.response);
          post(new URL(this.__ltUrl, location.origin).href, t);
        } catch {}
      });
    }
    return origSend.apply(this, args);
  };

  const origFetch = window.fetch;
  window.fetch = function (input, init) {
    const p = origFetch.apply(this, arguments);
    try {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input?.url;
      if (isTimedText(url)) {
        p.then((r) => r.clone().text())
          .then((t) => post(new URL(url, location.origin).href, t))
          .catch(() => {});
      }
    } catch {}
    return p;
  };
})();
