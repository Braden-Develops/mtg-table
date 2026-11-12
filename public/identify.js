/* Identify tool: click a card on any player's video to find out what it is.
   The video's owner crops the area from their own camera (full quality, no video compression) and
   asks the server; if they don't answer in time we crop from the video we receive instead.
   Matches come from the decks loaded at the table, the clicked player's deck first. */
window.Identify = (() => {
  const TOPIC = 'identify';
  const OWNER_TIMEOUT_MS = 3000;
  let lastLookup = null;
  const AUTO_SCORE = 7.5; // a match this strong...
  const AUTO_LEAD = 2.5; // ...and this far ahead of the next card is tagged without asking
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
  // maxPx: shrink the crop to at most this size (smaller uploads; the server straightens the card
  // to 320x448 anyway).
  function crop(video, x, y, frac = CROP, maxPx = Infinity) {
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    if (!vw || !vh) return null;
    const side = Math.round(Math.min(vw, vh) * Math.min(1, frac));
    const cx = x * vw;
    const cy = y * vh;
    const left = Math.round(Math.max(0, Math.min(vw - side, cx - side / 2)));
    const top = Math.round(Math.max(0, Math.min(vh - side, cy - side / 2)));
    const out = Math.min(side, maxPx);
    const canvas = document.createElement('canvas');
    canvas.width = out;
    canvas.height = out;
    canvas.getContext('2d').drawImage(video, left, top, side, side, 0, 0, out, out);
    return { canvas, hx: (cx - left) / side, hy: (cy - top) / side, left, top, side, vw, vh };
  }

  // share: the card's width as a share of the crop's, if known (saves the server guessing its size).
  async function ask(video, x, y, player, frac, maxPx, share) {
    const c = crop(video, x, y, frac, maxPx);
    if (!c) throw new Error('That video is not playing yet.');
    // On this computer, when it reads cards faster than the server (see localmatch.js).
    if (window.LocalMatch?.ready()) {
      const began = performance.now();
      const local = await window.LocalMatch.identify(c.canvas, { x: c.hx, y: c.hy });
      if (local) {
        lastLookup = {
          ms: Math.round(performance.now() - began), server: null, looks: local.runs, found: !!local.found, sure: !!local.confident,
          top: local.matches?.[0] && `${local.matches[0].card.name} ${local.matches[0].score}`, next: local.matches?.[1]?.score, where: 'this computer',
        };
        if (Array.isArray(local.quad) && local.quad.length === 4) {
          local.frameQuad = local.quad.map(([qx, qy]) => [(c.left + qx * c.side) / c.vw, (c.top + qy * c.side) / c.vh]);
          if (video === localVideo()) window.Tracker?.noteIdentified(x, y, local.frameQuad);
        }
        return local;
      }
    }
    const blob = await new Promise((resolve) => c.canvas.toBlob(resolve, 'image/jpeg', 0.92));
    const q = new URLSearchParams({ code, player, x: c.hx.toFixed(4), y: c.hy.toFixed(4) });
    // On my own camera, card tracking knows how big the cards on the table are.
    if (!share && video === localVideo()) {
      const len = window.Tracker?.cardSize?.(); // a card's length, share of the picture's height
      if (len) share = (len * 0.716 * c.vh) / c.side;
    }
    if (share > 0.02 && share < 0.9) q.set('s', share.toFixed(3));
    const sent = performance.now();
    const res = await fetch(`/api/identify?${q}`, { method: 'POST', headers: { 'Content-Type': 'image/jpeg' }, body: blob });
    const data = await res.json();
    // For the card debug overlay.
    lastLookup = {
      ms: Math.round(performance.now() - sent), server: data.ms, looks: data.runs, found: !!data.found, sure: !!data.confident,
      top: data.matches?.[0] && `${data.matches[0].card.name} ${data.matches[0].score}`, next: data.matches?.[1]?.score,
    };
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

  // Tell the server what a lookup turned out to be (name, or null for "none of these"), so
  // recognition can be measured on real cards. Best effort.
  function feedback(id, name, how) {
    if (!id) return;
    fetch('/api/identify/feedback', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code, id, name, how }),
    }).catch(() => {});
  }

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
    // Far ahead of every other card: tag it without asking. (Right matches score 10-13 with the
    // runner-up near 5; wrong ones have so far stayed under 7 and within about 1 of the next.)
    const [top, next] = result?.matches || [];
    if (!error && result?.found && result.confident && top.score >= AUTO_SCORE && top.score - (next?.score ?? 0) >= AUTO_LEAD) {
      const stickerId = window.Marks.placeCard(tileName, x, y, top.card);
      feedback(result.id, top.card.name, 'auto');
      $('identify-dialog').close();
      autoToast(top.card, () => window.Marks.removeSticker(stickerId), () => {
        // Not right: take the tag off and show the usual choices.
        window.Marks.removeSticker(stickerId);
        current = mine;
        render();
        $('identify-dialog').showModal();
      });
      return;
    }
    render();
  }

  // "Tagged X" with a way back, for a card tagged without asking.
  let autoTimer = null;
  function autoToast(card, undo, change) {
    let el = $('identify-toast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'identify-toast';
      el.className = 'track-toast read-toast';
      document.body.appendChild(el);
    }
    el.replaceChildren();
    const span = document.createElement('span');
    span.textContent = `Tagged ${card.name}.`;
    el.appendChild(span);
    for (const [label, fn] of [['Undo', undo], ['Not it', change]]) {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = label;
      b.onclick = () => { el.hidden = true; fn(); };
      el.appendChild(b);
    }
    el.hidden = false;
    clearTimeout(autoTimer);
    autoTimer = setTimeout(() => { el.hidden = true; }, 6000);
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
    const weak = r.weak && current.pick === 0 ? '<p class="muted small">Nothing in the loaded decks stands out, so this card may not be in one of them.</p>' : '';
    body.innerHTML = `${weak}
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
        if (pick) {
          feedback(current.result.id, pick.card.name, 'place');
          // Chosen in place of a suggestion: that tag goes, this one takes its spot.
          if (current.replaceId) window.Marks.removeSticker(current.replaceId);
          window.Marks.placeCard(current.tileName, current.x, current.y, pick.card);
        }
        $('identify-dialog').close();
        break;
      case 'open':
        if (pick) feedback(current.result.id, pick.card.name, 'open');
        $('identify-dialog').close();
        if (pick) window.Marks.showCard(pick.card);
        break;
      case 'search':
        feedback(current.result?.id, null, 'search');
        if (current.replaceId) window.Marks.removeSticker(current.replaceId);
        $('identify-dialog').close();
        window.Marks.openLookup();
        break;
      default:
    }
  }

  // Show a lookup's answer in the dialog so another of its cards can be picked ("Other…" on a
  // suggested tag, or on a held card it wasn't sure of). replaceId: the suggested tag it replaces.
  function choose(tileName, x, y, result, replaceId = null) {
    current = { tileName, x, y, status: 'done', result, pick: 0, replaceId };
    render();
    if (!$('identify-dialog').open) $('identify-dialog').showModal();
  }

  // Read a card on my own camera without the dialog (cards held up to the camera). frac: the crop's
  // size as a share of the picture's short side. Resolves with the server's answer.
  // share: the card's width as a share of that crop's.
  const read = (video, x, y, frac, share) => ask(video, x, y, me, frac, 800, share);

  return { init, setRoom, onData, clickAt, read, feedback, choose, lastLookup: () => lastLookup };
})();
