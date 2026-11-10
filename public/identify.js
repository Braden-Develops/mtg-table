/* Identify tool: click a card on any player's video to find out what it is.
   The video's owner crops the area from their own camera (full quality, no video compression) and
   asks the server; if they don't answer in time we crop from the video we receive instead.
   Matches come from the decks loaded at the table, the clicked player's deck first. */
window.Identify = (() => {
  const TOPIC = 'identify';
  const OWNER_TIMEOUT_MS = 3000;
  const CROP = 0.55; // crop a square this fraction of the frame's short side around the click

  let code = null;
  let me = null;
  let room = null;
  let current = null; // { tileName, x, y, result, pick, status }
  const waiting = new Map(); // request id -> resolve

  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const enc = new TextEncoder();
  const dec = new TextDecoder();

  function init(opts) {
    ({ code, me } = opts);
    const dlg = $('identify-dialog');
    $('identify-close').addEventListener('click', () => dlg.close());
    dlg.addEventListener('close', () => { current = null; });
    $('identify-body').addEventListener('click', onDialogClick);
  }

  function setRoom(r) {
    room = r;
  }

  // ---------- cropping ----------
  // Cut a square around (x, y) (0-1 over the picture) out of a playing <video>.
  function crop(video, x, y, frac = CROP) {
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    if (!vw || !vh) return null;
    const side = Math.round(Math.min(vw, vh) * Math.min(1, frac));
    const cx = x * vw;
    const cy = y * vh;
    const left = Math.round(Math.max(0, Math.min(vw - side, cx - side / 2)));
    const top = Math.round(Math.max(0, Math.min(vh - side, cy - side / 2)));
    const canvas = document.createElement('canvas');
    canvas.width = side;
    canvas.height = side;
    canvas.getContext('2d').drawImage(video, left, top, side, side, 0, 0, side, side);
    return { canvas, hx: (cx - left) / side, hy: (cy - top) / side, left, top, side, vw, vh };
  }

  async function ask(video, x, y, player, frac) {
    const c = crop(video, x, y, frac);
    if (!c) throw new Error('That video is not playing yet.');
    const blob = await new Promise((resolve) => c.canvas.toBlob(resolve, 'image/jpeg', 0.92));
    const q = new URLSearchParams({ code, player, x: c.hx.toFixed(4), y: c.hy.toFixed(4) });
    const res = await fetch(`/api/identify?${q}`, { method: 'POST', headers: { 'Content-Type': 'image/jpeg' }, body: blob });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Recognition failed.');
    // The card's outline over the whole picture (0-1), so a sticker placed from this can follow
    // the card straight away instead of the tracker searching for it again.
    if (Array.isArray(data.quad) && data.quad.length === 4) {
      data.frameQuad = data.quad.map(([qx, qy]) => [(c.left + qx * c.side) / c.vw, (c.top + qy * c.side) / c.vh]);
      if (video === localVideo()) window.Tracker?.noteIdentified(x, y, data.frameQuad);
    }
    return data;
  }

  const localVideo = () => document.querySelector('.tile[data-local="1"] video');

  // ---------- data messages between players ----------
  function send(msg, identities) {
    room?.localParticipant.publishData(enc.encode(JSON.stringify(msg)), { reliable: true, topic: TOPIC, destinationIdentities: identities });
  }

  async function onData(payload, participant, topic) {
    if (topic !== TOPIC || !participant) return;
    let msg;
    try { msg = JSON.parse(dec.decode(payload)); } catch { return; }
    if (msg.t === 'res') {
      waiting.get(msg.id)?.(msg.result || null);
      return;
    }
    if (msg.t === 'req') {
      // Someone clicked a card on my video: crop it from my camera and look it up for them.
      const video = localVideo();
      let result = null;
      try {
        if (video) result = await ask(video, msg.x, msg.y, me);
      } catch (err) {
        result = { error: err.message };
      }
      send({ t: 'res', id: msg.id, result }, [participant.identity]);
    }
  }

  function fromOwner(identity, x, y) {
    if (!room) return Promise.resolve(null);
    const id = Math.random().toString(36).slice(2, 10);
    return new Promise((resolve) => {
      const done = (r) => {
        waiting.delete(id);
        clearTimeout(timer);
        resolve(r);
      };
      const timer = setTimeout(() => done(null), OWNER_TIMEOUT_MS);
      waiting.set(id, done);
      send({ t: 'req', id, x, y }, [identity]);
    });
  }

  // ---------- click on a video ----------
  async function clickAt(tile, tileName, [x, y]) {
    current = { tileName, x, y, status: 'loading', result: null, pick: 0 };
    render();
    if (!$('identify-dialog').open) $('identify-dialog').showModal();
    const mine = current;
    let result = null;
    let error = null;
    try {
      if (tile.dataset.local === '1') {
        result = await ask(tile.querySelector('video'), x, y, tileName);
      } else {
        result = await fromOwner(tile.dataset.identity, x, y);
        if (!result || result.error) result = await ask(tile.querySelector('video'), x, y, tileName);
      }
    } catch (err) {
      error = err.message;
    }
    if (current !== mine) return; // closed or clicked again meanwhile
    current.status = error ? 'error' : 'done';
    current.error = error;
    current.result = result;
    render();
  }

  // ---------- results dialog ----------
  function render() {
    renderResult();
    const waiting = current?.result?.waiting;
    if (waiting) {
      $('identify-body').insertAdjacentHTML('beforeend',
        `<p class="muted small">Still learning the artwork for ${waiting} card${waiting === 1 ? '' : 's'} in the decks. Try again in a minute if it's wrong.</p>`);
    }
  }

  function renderResult() {
    const body = $('identify-body');
    if (!current) return;
    const r = current.result;
    if (current.status === 'loading') {
      body.innerHTML = '<p class="muted">Looking at the card…</p>';
      return;
    }
    const search = '<button data-id="search">Search by name instead</button>';
    if (current.status === 'error') {
      body.innerHTML = `<p class="error">${esc(current.error)}</p><p>${search}</p>`;
      return;
    }
    if (!r.found) {
      body.innerHTML = r.reason === 'nodecks'
        ? `<p>Nobody at the table has loaded a deck yet. Recognition matches against the decks in the Decks panel.</p><p>${search}</p>`
        : `<p>No card found there. Click near the middle of a card, or zoom the video in first.</p><p>${search}</p>`;
      return;
    }
    const matches = r.matches || [];
    const pick = matches[current.pick];
    if (!pick) {
      body.innerHTML = `<p>A card is there, but nothing in the loaded decks matches it.</p><p>${search}</p>`;
      return;
    }
    const sure = r.confident && current.pick === 0;
    body.innerHTML = `
      <div class="id-result">
        <img class="id-big" src="${esc(pick.card.imageLarge || pick.card.image)}" alt="${esc(pick.card.name)}">
        <div class="id-info">
          <h3>${esc(pick.card.name)}</h3>
          <p class="muted small">${esc(pick.card.typeLine)}</p>
          <p class="small">${current.pick === 0 ? (sure ? '<span class="id-sure">Match</span>' : '<span class="id-unsure">Best guess</span>') : '<span class="id-unsure">Your pick</span>'}
            · from ${esc(pick.owner === me ? 'your' : `${pick.owner}'s`)} deck</p>
          <div class="id-actions">
            <button class="primary" data-id="place">Place as sticker</button>
            <button data-id="open">Open card</button>
            ${search}
          </div>
        </div>
      </div>
      ${matches.length > 1 ? `<p class="muted small">${sure ? 'Not it? Other close matches:' : 'Other possibilities:'}</p>
      <div class="id-alts">${matches.map((m, i) => (i === current.pick ? '' : `<button class="id-alt" data-id="alt" data-i="${i}" title="${esc(m.card.name)}">
        <img src="${esc(m.card.image)}" alt="${esc(m.card.name)}"></button>`)).join('')}</div>` : ''}`;
  }

  function onDialogClick(ev) {
    const btn = ev.target.closest('button[data-id]');
    if (!btn || !current) return;
    const pick = current.result?.matches?.[current.pick];
    switch (btn.dataset.id) {
      case 'alt':
        current.pick = Number(btn.dataset.i);
        render();
        break;
      case 'place':
        if (pick) window.Marks.placeCard(current.tileName, current.x, current.y, pick.card);
        $('identify-dialog').close();
        break;
      case 'open':
        $('identify-dialog').close();
        if (pick) window.Marks.showCard(pick.card);
        break;
      case 'search':
        $('identify-dialog').close();
        window.Marks.openLookup();
        break;
      default:
    }
  }

  // Read a card on my own camera without the dialog (cards held up to the camera). frac: the crop's
  // size as a share of the picture's short side. Resolves with the server's answer.
  const read = (video, x, y, frac) => ask(video, x, y, me, frac);

  return { init, setRoom, onData, clickAt, read };
})();
