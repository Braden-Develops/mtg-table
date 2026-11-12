/* Where card lookups run: this computer or the server?
   A lookup (which deck card is this?) can be done by the server or, with the same code, by this
   browser (match-worker.js). Whichever is faster for this player is used. On the join page this
   file downloads the models (once: they are kept in this browser's cache), times a lookup here,
   asks the server how long its own take, and shows the result:
     "Card recognition: this computer 240 ms a card, server 560 ms. Cards are read on this computer."
   Identify, held-up cards and table tagging all go through Identify.ask(), which asks here first. */
window.LocalMatch = (() => {
  const $ = (id) => document.getElementById(id);
  let code = null;
  let worker = null;
  let info = null; // the server's /api/recog/info
  // off | loading | measuring | ready | failed; mode: where lookups go
  const s = { state: 'off', mode: 'server', done: 0, total: 0, cached: false, localMs: null, serverMs: null, refs: null, note: '' };
  let refsHash = null;
  let nextId = 0;
  const pending = new Map();
  let timer = null;

  const mb = (n) => `${(n / 1e6).toFixed(0)} MB`;

  // The status on the join page (and, in short, in the card debug panel).
  function show() {
    const el = $('recog-status');
    if (!el) return;
    const bar = el.querySelector('.recog-bar > span');
    const text = el.querySelector('.recog-text');
    el.hidden = s.state === 'off';
    bar.parentElement.hidden = s.state !== 'loading';
    bar.style.width = `${s.total ? Math.round((s.done / s.total) * 100) : 0}%`;
    if (s.state === 'loading') {
      text.textContent = s.cached
        ? 'Card recognition: starting up (already saved on this computer)…'
        : `Card recognition: downloading ${mb(s.total)} (once; it is kept on this computer)… ${s.total ? Math.round((s.done / s.total) * 100) : 0}%`;
    } else if (s.state === 'measuring') {
      text.textContent = 'Card recognition: checking whether this computer or the server reads cards faster…';
    } else if (s.state === 'ready') {
      text.textContent = `Card recognition: this computer ${s.localMs} ms a card (on its ${s.on || 'processor'}), server ${s.serverMs} ms. `
        + (s.mode === 'local' ? 'Cards are read on this computer.' : 'Cards are read on the server.');
    } else if (s.state === 'failed') {
      text.textContent = `Card recognition runs on the server (${s.note || 'this browser could not load it'}).`;
    }
  }

  const post = (m, transfer) => worker.postMessage(m, transfer || []);
  const once = (type) => new Promise((resolve, reject) => {
    const on = (e) => {
      if (e.data.t === 'error') { worker.removeEventListener('message', on); reject(new Error(e.data.message)); }
      if (e.data.t === type) { worker.removeEventListener('message', on); resolve(e.data); }
    };
    worker.addEventListener('message', on);
  });

  async function getInfo() {
    const t = performance.now();
    const res = await fetch(`/api/recog/info?code=${encodeURIComponent(code)}`);
    if (!res.ok) throw new Error(`info ${res.status}`);
    const data = await res.json();
    data.trip = performance.now() - t;
    return data;
  }

  async function start(inviteCode) {
    if (s.state !== 'off') return;
    code = inviteCode;
    try {
      info = await getInfo();
      if (!info.available) return; // no recognition on this server at all
      s.state = 'loading';
      s.total = info.files.reduce((n, f) => n + f.bytes, 0);
      show();
      worker = new Worker('/static/match-worker.js', { type: 'module' });
      worker.addEventListener('message', (e) => {
        const m = e.data;
        if (m.t === 'progress') { s.done = m.done; s.total = m.total; s.cached = m.cached; show(); }
        if (m.t === 'result') { pending.get(m.id)?.(m.result); pending.delete(m.id); }
        if (m.t === 'refs') { s.refs = { cards: m.cards, references: m.references }; refsHash = m.hash; }
      });
      post({ t: 'init', code, files: info.files });
      s.on = (await once('ready')).on;
      s.state = 'measuring';
      show();
      // With the table's references loaded first, the timing is of a whole real lookup.
      if (info.refs) {
        refsHash = info.refs.hash;
        post({ t: 'refs', code, hash: info.refs.hash });
        await once('refs');
      }
      post({ t: 'bench' });
      s.localMs = (await once('bench')).ms;
      // The server's own figure, plus the trip there and back (a second, quick request: the first
      // one may have had the server measure itself).
      const again = await getInfo();
      info = again;
      s.serverMs = Math.round((again.serverMs || 0) + again.trip);
      s.mode = again.serverMs && s.localMs <= s.serverMs ? 'local' : 'server';
      s.state = 'ready';
      show();
      await refresh();
      timer = setInterval(() => refresh().catch(() => {}), 20000);
    } catch (err) {
      s.state = 'failed';
      s.mode = 'server';
      s.note = String(err.message || err).slice(0, 80);
      show();
    }
  }

  // The reference pack follows the decks at the table: fetch it again when they change.
  async function refresh() {
    if (s.state !== 'ready' || s.mode !== 'local') return;
    info = await getInfo();
    if (info.refs && info.refs.hash !== refsHash) {
      refsHash = info.refs.hash; // (set now, so a slow download isn't started twice)
      post({ t: 'refs', code, hash: info.refs.hash });
    }
  }

  const ready = () => s.state === 'ready' && s.mode === 'local' && !!s.refs;

  // One lookup on this computer. canvas: the picture around the card; hint: { x, y } in 0-1 of it.
  // Resolves with what the server's /api/identify would answer, or null if it can't be done here.
  function identify(canvas, hint) {
    if (!ready()) return Promise.resolve(null);
    const pixels = canvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, canvas.width, canvas.height).data;
    const id = ++nextId;
    return new Promise((resolve) => {
      pending.set(id, resolve);
      setTimeout(() => { if (pending.delete(id)) resolve(null); }, 15000);
      post({ t: 'identify', id, pixels, w: canvas.width, h: canvas.height, hint }, [pixels.buffer]);
    });
  }

  // For testing: send lookups to 'local' or 'server' whatever the measurement said.
  function force(mode) {
    s.mode = mode === 'local' ? 'local' : 'server';
    show();
    return refresh();
  }

  return { start, ready, identify, refresh, force, status: () => ({ ...s }) };
})();
