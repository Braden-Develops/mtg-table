/* Marks layer: drawings (pen, arrow), stickers (P/T, modifiers, counters, text, Scryfall cards)
   placed on players' videos, the sticker editor and the card lookup. Shared through the game state. */
window.Marks = (() => {
  const LIFETIME = 20_000; // must match server DRAWING_LIFETIME_MS
  const FADE = 5_000;
  const COLORS = ['#ffd54a', '#4fc3f7', '#ff8a65', '#81c784', '#ce93d8', '#f06292', '#4db6ac', '#fff176'];
  const COUNTER_LABELS = ['+1/+1', '-1/-1', 'Loyalty', 'Charge', 'Shield', 'Stun', 'Lore', 'Oil', 'Time', 'Quest', 'Defense', 'Finality'];

  let code = null;
  let me = null;
  let act = null;
  let state = null;
  let clockOffset = 0; // serverNow - Date.now()
  let tool = 'select'; // select | sticker | pen | arrow
  let keepDrawings = false;
  let drawColor = null; // chosen in the tools bar; defaults to the player's own color
  let drawSize = 1;
  let pendingItems = null; // items waiting to be placed (from card lookup)
  const ZONES = { play: 'Play area', command: 'Command zone', library: 'Library', graveyard: 'Graveyard', exile: 'Exile' };
  const isPile = (zone) => ZONES[zone] && zone !== 'play'; // the play area has no list of cards
  let zoneKind = 'graveyard'; // which pile the zone tool is marking
  const tiles = new Map(); // tile -> { name, layer, canvas, stickers, video }

  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const newId = () => Math.random().toString(36).slice(2, 10);
  const colorFor = (name) => {
    let h = 0;
    for (const ch of String(name)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    return COLORS[h % COLORS.length];
  };

  // ---------- P/T math ----------
  // Base = last card P/T or "set" P/T in the stack; then add modifiers and +N/+N counters.
  function totalPT(items) {
    let base = null;
    let printed = null; // e.g. Tarmogoyf's "*/1+*", shown when there's no number to add to
    let dp = 0;
    let dt = 0;
    for (const it of items) {
      if (it.type === 'card' && /^-?\d+$/.test(it.power) && /^-?\d+$/.test(it.toughness)) base = [+it.power, +it.toughness];
      else if (it.type === 'card' && it.power !== '' && it.toughness !== '') { base = null; printed = `${it.power}/${it.toughness}`; }
      else if (it.type === 'pt' && it.mode === 'set') base = [it.power, it.toughness];
      else if (it.type === 'pt' && it.mode === 'mod') { dp += it.power; dt += it.toughness; }
      else if (it.type === 'counter') {
        const m = /^([+-]\d+)\/([+-]\d+)$/.exec(it.label.trim());
        if (m) { dp += +m[1] * it.count; dt += +m[2] * it.count; }
      }
    }
    const mods = dp || dt ? `${dp >= 0 ? '+' : ''}${dp}/${dt >= 0 ? '+' : ''}${dt}` : '';
    if (base) return `${base[0] + dp}/${base[1] + dt}`;
    if (printed) return mods ? `${printed} ${mods}` : printed;
    return mods || null;
  }
  const signedPT = (p, t) => `${p >= 0 ? '+' : ''}${p}/${t >= 0 ? '+' : ''}${t}`;

  // ---------- setup ----------
  function init(opts) {
    ({ code, me, act } = opts);
    for (const btn of document.querySelectorAll('[data-tool]')) {
      btn.addEventListener('click', () => setTool(btn.dataset.tool));
    }
    $('keep-btn').addEventListener('click', () => {
      keepDrawings = !keepDrawings;
      $('keep-btn').classList.toggle('on', keepDrawings);
      $('keep-btn').textContent = keepDrawings ? 'Drawings stay' : 'Drawings fade';
    });
    $('clear-mine-btn').addEventListener('click', () => act({ type: 'drawClear', mine: true }));
    $('hide-marks-btn').addEventListener('click', () => {
      const hidden = document.body.classList.toggle('hide-marks');
      $('hide-marks-btn').textContent = hidden ? 'Show marks' : 'Hide marks';
    });
    // Card names on stickers: a per-viewer preference, remembered on this device.
    const setNames = (show) => {
      document.body.classList.toggle('hide-names', !show);
      $('names-btn').textContent = show ? 'Names on' : 'Names off';
      $('names-btn').classList.toggle('on', show);
      try { localStorage.setItem('showNames', show ? '1' : '0'); } catch { /* ignore */ }
    };
    let savedNames = '1';
    try { savedNames = localStorage.getItem('showNames') ?? '1'; } catch { /* ignore */ }
    setNames(savedNames !== '0');
    $('names-btn').addEventListener('click', () => setNames(document.body.classList.contains('hide-names')));
    // Stickers on my camera follow the cards under them (tracked on this computer).
    const showTrack = () => {
      const on = window.Tracker.isEnabled();
      $('track-btn').classList.toggle('on', on);
      $('track-btn').textContent = on ? 'Stickers follow cards' : 'Stickers stay put';
    };
    showTrack();
    $('track-btn').addEventListener('click', () => {
      window.Tracker.setEnabled(!window.Tracker.isEnabled());
      showTrack();
    });
    // Cards I hold up to my camera are read and get a sticker when put down.
    const showReadHeld = () => {
      const on = !!window.AutoRead?.isEnabled();
      $('read-held-btn').classList.toggle('on', on);
      $('read-held-btn').textContent = on ? 'Read cards I hold up' : 'Held-up cards not read';
    };
    showReadHeld();
    $('read-held-btn').addEventListener('click', () => {
      window.AutoRead?.setEnabled(!window.AutoRead.isEnabled());
      showReadHeld();
    });
    // Cards lying on my table are recognised and tagged by themselves.
    const showAutoTag = () => {
      const on = !!window.AutoRead?.isTagging();
      $('auto-tag-btn').classList.toggle('on', on);
      $('auto-tag-btn').textContent = on ? 'Tag cards on my table' : 'Table cards not tagged';
    };
    showAutoTag();
    $('auto-tag-btn').addEventListener('click', () => {
      window.AutoRead?.setTagging(!window.AutoRead.isTagging());
      showAutoTag();
    });
    // Tags of cards that can't be seen: kept (the default) or removed after a few seconds.
    const showRemoveLost = () => {
      const on = !!window.Tracker?.removesLost();
      $('remove-lost-btn').classList.toggle('on', !on);
      $('remove-lost-btn').textContent = on ? 'Tags go when cards leave' : 'Tags stay when cards are picked up';
    };
    showRemoveLost();
    $('remove-lost-btn').addEventListener('click', () => {
      window.Tracker.setRemovesLost(!window.Tracker.removesLost());
      showRemoveLost();
    });
    // Card debug: what recognition sees, drawn over my own camera.
    const showDebug = () => {
      const on = !!window.Tracker?.isDebug();
      $('card-debug-btn').classList.toggle('on', on);
      $('card-debug-btn').textContent = on ? 'Card debug on' : 'Card debug off';
    };
    showDebug();
    $('card-debug-btn').addEventListener('click', () => {
      window.Tracker.setDebug(!window.Tracker.isDebug());
      showDebug();
    });
    // Drawing color and thickness: per-viewer, remembered on this device.
    const load = (key, fallback) => { try { return localStorage.getItem(key) ?? fallback; } catch { return fallback; } };
    const save = (key, value) => { try { localStorage.setItem(key, value); } catch { /* ignore */ } };
    const setColor = (c) => {
      drawColor = /^#[0-9a-f]{6}$/i.test(c) ? c.toLowerCase() : colorFor(me);
      $('draw-color').value = drawColor;
      for (const sw of $('swatches').children) sw.classList.toggle('on', sw.dataset.color === drawColor);
      save('drawColor', drawColor);
    };
    $('swatches').innerHTML = [...COLORS, '#ffffff', '#111111']
      .map((c) => `<button class="swatch" data-color="${c}" style="background:${c}" title="${c}"></button>`).join('');
    $('swatches').addEventListener('click', (ev) => {
      const sw = ev.target.closest('.swatch');
      if (sw) setColor(sw.dataset.color);
    });
    $('draw-color').addEventListener('input', (ev) => setColor(ev.target.value));
    setColor(load('drawColor', colorFor(me)));
    $('draw-size').value = load('drawSize', '1');
    drawSize = Number($('draw-size').value) || 1;
    $('draw-size').addEventListener('change', (ev) => {
      drawSize = Number(ev.target.value) || 1;
      save('drawSize', String(drawSize));
    });

    // Sticker size: a per-viewer preference, remembered on this device.
    const setSize = (pct) => {
      const v = Math.min(200, Math.max(50, Number(pct) || 100));
      document.body.style.setProperty('--sticker-user', String(v / 100));
      $('sticker-size').value = String(v);
      $('sticker-size-out').textContent = `${v}%`;
      try { localStorage.setItem('stickerSize', String(v)); } catch { /* ignore */ }
    };
    let savedSize = '100';
    try { savedSize = localStorage.getItem('stickerSize') ?? '100'; } catch { /* ignore */ }
    setSize(savedSize);
    $('sticker-size').addEventListener('input', (ev) => setSize(ev.target.value));
    $('find-card-btn').addEventListener('click', () => openEditor({ mode: 'lookup' }));
    $('place-cancel').addEventListener('click', () => {
      pendingItems = null;
      setTool('select');
    });
    for (const btn of document.querySelectorAll('[data-zone]')) {
      btn.addEventListener('click', () => {
        zoneKind = btn.dataset.zone;
        for (const b of document.querySelectorAll('[data-zone]')) b.classList.toggle('on', b === btn);
      });
    }
    $('zone-clear')?.addEventListener('click', () => act({ type: 'zoneSet', target: me, zone: zoneKind, box: null }));
    // The pile panel (opened by clicking a zone): hover a card to see it, click to put it on the table.
    $('zone-close').addEventListener('click', closeZonePanel);
    for (const id of ['game-btn', 'deck-btn']) $(id)?.addEventListener('click', () => { $('zone-panel').hidden = true; zonePanel = null; });
    const zb = $('zone-body');
    zb.addEventListener('mousemove', (ev) => {
      const row = ev.target.closest('[data-large]');
      if (row?.dataset.large) showPreview(row.dataset.large, ev);
      else hidePreview();
    });
    zb.addEventListener('mouseleave', hidePreview);
    zb.addEventListener('click', (ev) => {
      const row = ev.target.closest('.zone-row');
      if (!row || !zonePanel) return;
      const i = Number(row.dataset.i);
      const card = state?.piles?.[zonePanel.name]?.[zonePanel.zone]?.[i];
      if (!card) return;
      hidePreview();
      if (ev.target.closest('.pile-x')) act({ type: 'pileRemove', target: zonePanel.name, zone: zonePanel.zone, index: i });
      else showCard({ ...card, type: 'card' });
    });
    wireEditor();
    setInterval(tickFades, 400);
    setInterval(expireLive, 1000);
    window.addEventListener('resize', () => tiles.forEach((_, tile) => layout(tile)));
  }

  function setTool(next) {
    tool = next;
    if (next !== 'sticker') pendingItems = null;
    for (const btn of document.querySelectorAll('[data-tool]')) btn.classList.toggle('on', btn.dataset.tool === tool);
    document.body.dataset.tool = tool;
    const banner = $('place-banner');
    banner.hidden = !(tool === 'sticker');
    $('place-text').textContent = pendingItems
      ? `Click where ${pendingItems[0].name || 'it'} is on any player's video.`
      : 'Click a spot on any player\'s video to put a sticker there.';
  }

  // ---------- tiles ----------
  function attachTile(tile, name) {
    if (tiles.has(tile)) {
      tiles.get(tile).name = name;
      return;
    }
    const layer = document.createElement('div');
    layer.className = 'mark-layer';
    layer.innerHTML = '<canvas class="draw-canvas"></canvas><div class="zone-boxes"></div><div class="sticker-box"></div>';
    tile.appendChild(layer);
    const entry = {
      name,
      layer,
      canvas: layer.querySelector('canvas'),
      stickers: layer.querySelector('.sticker-box'),
      zones: layer.querySelector('.zone-boxes'),
      video: tile.querySelector('video'),
      live: null, // stroke being drawn right now
    };
    tiles.set(tile, entry);
    entry.video.addEventListener('loadedmetadata', () => layout(tile));
    entry.video.addEventListener('resize', () => layout(tile));
    new ResizeObserver(() => layout(tile)).observe(tile);
    wireLayer(tile, entry);
    tile.addEventListener('mousemove', (ev) => hoverZone(entry, ev));
    // In Select, a click on a zone opens its pile (before the tile's own click, which enlarges it).
    tile.addEventListener('click', (ev) => {
      if (tool !== 'select' || ev.target.closest('.sticker, button')) return;
      const zone = zoneUnder(entry, ev);
      if (!zone) return;
      ev.stopPropagation();
      ev.preventDefault();
      openZonePanel(entry.name, zone);
    }, true);
    tile.addEventListener('mouseleave', hideZonePop);
    layout(tile);
  }

  function detachTile(tile) {
    tiles.delete(tile);
  }

  // Fit the mark layer exactly over the visible video picture (object-fit: contain leaves bars).
  function layout(tile) {
    const e = tiles.get(tile);
    if (!e) return;
    const W = tile.clientWidth;
    const H = tile.clientHeight;
    const vw = e.video.videoWidth;
    const vh = e.video.videoHeight;
    let rect = { left: 0, top: 0, width: W, height: H };
    if (vw && vh && !e.video.hidden) {
      const s = Math.min(W / vw, H / vh);
      rect = { left: (W - vw * s) / 2, top: (H - vh * s) / 2, width: vw * s, height: vh * s };
    }
    Object.assign(e.layer.style, {
      left: `${rect.left}px`, top: `${rect.top}px`, width: `${rect.width}px`, height: `${rect.height}px`,
    });
    // Stickers grow and shrink with the video, so they cover the same part of the card at any size.
    e.layer.style.setProperty('--sticker-auto', String(Math.min(1.8, Math.max(0.55, rect.width / 700))));
    const dpr = window.devicePixelRatio || 1;
    e.canvas.width = Math.max(1, Math.round(rect.width * dpr));
    e.canvas.height = Math.max(1, Math.round(rect.height * dpr));
    drawCanvas(tile);
  }

  function pointFromEvent(e, entry) {
    const r = entry.layer.getBoundingClientRect();
    return [
      Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)),
      Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)),
    ];
  }

  function wireLayer(tile, entry) {
    const layer = entry.layer;
    const stop = (ev) => { if (tool !== 'select') ev.stopPropagation(); };
    layer.addEventListener('click', stop);
    layer.addEventListener('dblclick', stop);

    layer.addEventListener('pointerdown', (ev) => {
      if (tool === 'select' || ev.target.closest('.sticker')) return;
      ev.preventDefault();
      ev.stopPropagation();
      const pt = pointFromEvent(ev, entry);
      if (tool === 'sticker') {
        placeSticker(entry.name, pt);
        return;
      }
      if (tool === 'identify') {
        window.Identify.clickAt(tile, entry.name, pt);
        return;
      }
      layer.setPointerCapture(ev.pointerId);
      if (tool === 'zone') {
        // Piles are marked on your own camera (other players mark theirs). On a box: move it, or
        // resize it by an edge or corner. On empty table: draw the picked zone.
        if (entry.name !== me) return;
        const r = entry.layer.getBoundingClientRect();
        const mx = pt[0] * r.width;
        const my = pt[1] * r.height;
        const EDGE = 12;
        let grab = null;
        // Smallest box first, so a pile inside the play area is the one grabbed.
        const area = ([, b]) => (b[2] - b[0]) * (b[3] - b[1]);
        for (const [zone, b] of Object.entries(state?.zones?.[me] || {}).sort((p, q) => area(q) - area(p))) {
          if (!ZONES[zone]) continue;
          const [x0, y0, x1, y1] = [b[0] * r.width, b[1] * r.height, b[2] * r.width, b[3] * r.height];
          if (mx < x0 - EDGE || mx > x1 + EDGE || my < y0 - EDGE || my > y1 + EDGE) continue;
          const ex = Math.abs(mx - x0) < EDGE ? 0 : Math.abs(mx - x1) < EDGE ? 2 : -1;
          const ey = Math.abs(my - y0) < EDGE ? 1 : Math.abs(my - y1) < EDGE ? 3 : -1;
          // (Later boxes are smaller and win; an edge of any box wins over the inside of another.)
          const hit = { zone, mode: ex >= 0 || ey >= 0 ? 'resize' : 'move', ex, ey, start: b.slice() };
          if (!grab || hit.mode === 'resize' || grab.mode !== 'resize') grab = hit;
        }
        if (grab) pickZone(grab.zone);
        entry.zoneDrag = grab ? { ...grab, from: pt, box: grab.start.slice() } : { zone: zoneKind, mode: 'new', from: pt, box: [pt[0], pt[1], pt[0], pt[1]] };
        return;
      }
      if (tool === 'eraser') {
        entry.erasing = true;
        eraseAt(tile, entry, ev);
        return;
      }
      entry.live = { kind: tool, color: drawColor || colorFor(me), size: drawSize, points: [pt] };
    });
    layer.addEventListener('pointermove', (ev) => {
      if (entry.erasing) {
        eraseAt(tile, entry, ev);
        return;
      }
      if (entry.zoneDrag) {
        const d = entry.zoneDrag;
        const p = pointFromEvent(ev, entry);
        if (d.mode === 'new') d.box = [Math.min(d.from[0], p[0]), Math.min(d.from[1], p[1]), Math.max(d.from[0], p[0]), Math.max(d.from[1], p[1])];
        else if (d.mode === 'move') {
          const dx = Math.min(1 - d.start[2], Math.max(-d.start[0], p[0] - d.from[0]));
          const dy = Math.min(1 - d.start[3], Math.max(-d.start[1], p[1] - d.from[1]));
          d.box = [d.start[0] + dx, d.start[1] + dy, d.start[2] + dx, d.start[3] + dy];
        } else {
          const b = d.start.slice();
          if (d.ex >= 0) b[d.ex] = p[0];
          if (d.ey >= 0) b[d.ey] = p[1];
          d.box = [Math.min(b[0], b[2]), Math.min(b[1], b[3]), Math.max(b[0], b[2]), Math.max(b[1], b[3])];
        }
        renderZones(tile);
        return;
      }
      if (!entry.live) return;
      const pt = pointFromEvent(ev, entry);
      const last = entry.live.points[entry.live.points.length - 1];
      if (Math.hypot(pt[0] - last[0], pt[1] - last[1]) < 0.003) return;
      if (entry.live.kind === 'arrow') entry.live.points = [entry.live.points[0], pt];
      else entry.live.points.push(pt);
      drawCanvas(tile);
    });
    const finish = () => {
      if (entry.zoneDrag) {
        const { zone, box, start } = entry.zoneDrag;
        entry.zoneDrag = null;
        // A click without a drag changes nothing.
        const changed = !start || box.some((v, i) => Math.abs(v - start[i]) > 0.002);
        if (changed && box[2] - box[0] > 0.02 && box[3] - box[1] > 0.02) {
          act({ type: 'zoneSet', target: entry.name, zone, box });
          entry.zonePending = { zone, box }; // shown until the server's copy arrives
        }
        renderZones(tile);
        return;
      }
      entry.erasing = false;
      const live = entry.live;
      entry.live = null;
      if (!live || live.points.length < 2) return drawCanvas(tile);
      act({ type: 'draw', target: entry.name, kind: live.kind, color: live.color, size: live.size, points: live.points, keep: keepDrawings });
      // Keep showing it locally until the server echo arrives.
      entry.pending = { ...live, t: Date.now() + clockOffset, keep: keepDrawings };
      drawCanvas(tile);
    };
    layer.addEventListener('pointerup', finish);
    layer.addEventListener('pointercancel', finish);
  }

  function placeSticker(tileName, [x, y]) {
    if (pendingItems) {
      act({ type: 'stickerAdd', id: newId(), target: tileName, x, y, items: pendingItems });
      pendingItems = null;
      setTool('select');
      return;
    }
    openEditor({ mode: 'new', tile: tileName, x, y });
  }

  // ---------- zones ----------
  function renderZones(tile) {
    const e = tiles.get(tile);
    if (!e?.zones) return;
    const boxes = { ...(state?.zones?.[e.name] || {}) };
    if (e.zonePending) boxes[e.zonePending.zone] = e.zonePending.box;
    const drag = e.zoneDrag;
    if (drag) boxes[drag.zone] = drag.box;
    e.zones.innerHTML = Object.entries(boxes).filter(([zone]) => ZONES[zone]).map(([zone, b]) => (
      `<div class="zone-box${drag?.zone === zone ? ' drawing' : ''}" data-zone="${zone}" style="left:${b[0] * 100}%;top:${b[1] * 100}%;width:${(b[2] - b[0]) * 100}%;height:${(b[3] - b[1]) * 100}%"><span>${ZONES[zone]}</span></div>`
    )).join('');
  }

  function pickZone(zone) {
    zoneKind = zone;
    for (const b of document.querySelectorAll('[data-zone]')) b.classList.toggle('on', b.dataset.zone === zone);
  }

  // Which of a player's zones is under this pointer event?
  function zoneUnder(entry, ev) {
    const r = entry.layer.getBoundingClientRect();
    const x = (ev.clientX - r.left) / r.width;
    const y = (ev.clientY - r.top) / r.height;
    return Object.entries(state?.zones?.[entry.name] || {})
      .find(([zone, b]) => isPile(zone) && x >= b[0] && x <= b[2] && y >= b[1] && y <= b[3])?.[0] || null;
  }

  // Clicking a zone opens its pile in the side panel, like a deck: every card that went there this
  // game, newest first. Hover one to see it; click it to put it back on the table as a sticker.
  let zonePanel = null; // { name, zone } while open
  function openZonePanel(name, zone) {
    zonePanel = { name, zone };
    $('game-panel').hidden = true;
    $('deck-panel').hidden = true;
    $('zone-panel').hidden = false;
    document.body.classList.add('panel-open');
    hideZonePop();
    renderZonePanel();
  }
  function closeZonePanel() {
    zonePanel = null;
    $('zone-panel').hidden = true;
    document.body.classList.remove('panel-open');
  }
  function renderZonePanel() {
    if (!zonePanel) return;
    const { name, zone } = zonePanel;
    const pile = state?.piles?.[name]?.[zone] || [];
    $('zone-title').textContent = `${name}'s ${ZONES[zone].toLowerCase()}`;
    const rows = pile.map((c, i) => (
      `<li class="deck-row zone-row" data-i="${i}" data-large="${esc(c.imageLarge || c.image || `https://api.scryfall.com/cards/named?format=image&version=normal&exact=${encodeURIComponent(c.name)}`)}">
        <span class="qty">${pile.length - i}</span>
        <span class="cname">${esc(c.name)}</span>
        <button class="pile-x" title="Take it off this list">✕</button>
      </li>`
    )).reverse();
    $('zone-body').innerHTML = `<p class="muted small">${pile.length ? `${pile.length} card${pile.length === 1 ? '' : 's'}, newest first. Click a card to put it back on the table.` : 'No cards seen going here yet. A stickered card moved into this box is listed here.'}</p>
      <ul class="deck-list">${rows.join('')}</ul>`;
  }

  // Hovering a pile lists the cards that have gone into it this game, newest first.
  function hoverZone(entry, ev) {
    const r = entry.layer.getBoundingClientRect();
    const x = (ev.clientX - r.left) / r.width;
    const y = (ev.clientY - r.top) / r.height;
    const hit = entry.zoneDrag ? null : Object.entries(state?.zones?.[entry.name] || {})
      .find(([zone, b]) => isPile(zone) && x >= b[0] && x <= b[2] && y >= b[1] && y <= b[3]);
    entry.layer.parentElement.style.cursor = hit && tool === 'select' ? 'pointer' : '';
    if (!hit || ev.target.closest('.sticker')) return hideZonePop();
    let pop = $('zone-pop');
    if (!pop) {
      pop = document.createElement('div');
      pop.id = 'zone-pop';
      pop.className = 'zone-pop';
      document.body.appendChild(pop);
    }
    const cards = (state?.piles?.[entry.name]?.[hit[0]] || []).map((c) => c.name).reverse();
    const key = `${entry.name}|${hit[0]}|${cards.length}|${cards[0] || ''}`;
    if (pop.dataset.key !== key) {
      pop.dataset.key = key;
      const shown = cards.slice(0, 30);
      pop.innerHTML = `<b>${esc(entry.name)}'s ${ZONES[hit[0]].toLowerCase()}${cards.length ? ` (${cards.length})` : ''}</b>`
        + (cards.length
          ? `<ol>${shown.map((n) => `<li>${esc(n)}</li>`).join('')}</ol>${cards.length > shown.length ? `<i>and ${cards.length - shown.length} more</i>` : ''}`
          : '<i>No cards seen going here yet.</i>');
    }
    pop.hidden = false;
    const w = pop.offsetWidth;
    const h = pop.offsetHeight;
    pop.style.left = `${Math.max(8, Math.min(window.innerWidth - w - 8, ev.clientX + 16))}px`;
    pop.style.top = `${Math.max(8, Math.min(window.innerHeight - h - 8, ev.clientY + 16))}px`;
  }
  function hideZonePop() {
    const pop = $('zone-pop');
    if (pop) pop.hidden = true;
  }

  // ---------- eraser ----------
  const erased = new Set(); // ids hidden locally until the server confirms they're gone
  const ERASE_RADIUS_PX = 14;

  function distToSegment(px, py, [ax, ay], [bx, by]) {
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    const t = len2 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2)) : 0;
    return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
  }

  // Erase every drawing on this video that passes near the pointer (in screen pixels).
  function eraseAt(tile, entry, ev) {
    const r = entry.layer.getBoundingClientRect();
    const px = ev.clientX - r.left;
    const py = ev.clientY - r.top;
    const hits = [];
    const lw = Math.max(2, r.width * 0.004);
    for (const d of state?.drawings || []) {
      if (d.tile !== entry.name || erased.has(d.id)) continue;
      const radius = ERASE_RADIUS_PX + (lw * (d.size || 1)) / 2; // thick lines are easier to hit
      const pts = d.points.map(([x, y]) => [x * r.width, y * r.height]);
      const near = pts.length === 1
        ? Math.hypot(px - pts[0][0], py - pts[0][1]) < radius
        : pts.slice(1).some((p, i) => distToSegment(px, py, pts[i], p) < radius);
      if (near) hits.push(d.id);
    }
    if (hits.length === 0) return;
    hits.forEach((id) => erased.add(id));
    act({ type: 'drawErase', ids: hits });
    drawCanvas(tile);
  }

  // ---------- drawing ----------
  function drawCanvas(tile) {
    const e = tiles.get(tile);
    if (!e) return;
    const ctx = e.canvas.getContext('2d');
    const w = e.canvas.width;
    const h = e.canvas.height;
    ctx.clearRect(0, 0, w, h);
    const now = Date.now() + clockOffset;
    const list = (state?.drawings || []).filter((d) => d.tile === e.name && !erased.has(d.id));
    if (e.pending && !list.some((d) => d.by === me && Math.abs(d.t - e.pending.t) < 3000 && d.points.length >= 2)) list.push(e.pending);
    else e.pending = null;
    if (e.live) list.push({ ...e.live, keep: true, t: now });
    const lw = Math.max(2, w * 0.004);
    for (const d of list) {
      const age = now - d.t;
      if (!d.keep && age > LIFETIME) continue;
      ctx.globalAlpha = d.keep || age < LIFETIME - FADE ? 1 : Math.max(0, (LIFETIME - age) / FADE);
      ctx.strokeStyle = d.color;
      ctx.fillStyle = d.color;
      const width = lw * (d.size || 1);
      ctx.lineWidth = width;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.shadowColor = 'rgba(0,0,0,.7)';
      ctx.shadowBlur = Math.min(width, lw * 2);
      const pts = d.points.map(([x, y]) => [x * w, y * h]);
      ctx.beginPath();
      ctx.moveTo(pts[0][0], pts[0][1]);
      for (const [x, y] of pts.slice(1)) ctx.lineTo(x, y);
      ctx.stroke();
      if (d.kind === 'arrow' && pts.length >= 2) {
        const [x1, y1] = pts[0];
        const [x2, y2] = pts[pts.length - 1];
        const ang = Math.atan2(y2 - y1, x2 - x1);
        const head = lw * (4 + 2 * (d.size || 1));
        ctx.beginPath();
        ctx.moveTo(x2, y2);
        ctx.lineTo(x2 - head * Math.cos(ang - 0.45), y2 - head * Math.sin(ang - 0.45));
        ctx.lineTo(x2 - head * Math.cos(ang + 0.45), y2 - head * Math.sin(ang + 0.45));
        ctx.closePath();
        ctx.fill();
      }
    }
    ctx.globalAlpha = 1;
  }

  function tickFades() {
    if (!state?.drawings?.some((d) => !d.keep)) return;
    for (const tile of tiles.keys()) drawCanvas(tile);
  }

  // ---------- stickers ----------
  function stickerHtml(s) {
    const total = totalPT(s.items);
    const parts = [];
    if (s.unsure) {
      parts.push('<div class="st-ask">Is it this? <button data-ask="yes" title="Yes: keep this tag">✓</button>'
        + '<button data-ask="other" title="It is a different card: pick which">Other…</button>'
        + '<button data-ask="no" title="Not a card to tag: remove this, and don\'t suggest anything for it again">✕</button></div>');
    }
    if (total) parts.push(`<div class="st-pt">${esc(total)}</div>`);
    for (const it of s.items) {
      if (it.type === 'card') {
        parts.push(`<div class="st-card" data-large="${esc(it.imageLarge)}">${it.image ? `<img src="${esc(it.image)}" alt="">` : ''}<span>${esc(it.name)}</span></div>`);
      } else if (it.type === 'pt') {
        const txt = it.mode === 'mod' ? signedPT(it.power, it.toughness) : `${it.power}/${it.toughness}`;
        if (it.mode === 'mod' || it.label) parts.push(`<div class="st-line">${esc(txt)}${it.label ? ` <span>${esc(it.label)}</span>` : ''}</div>`);
      } else if (it.type === 'counter') {
        parts.push(`<div class="st-line">${esc(it.label)} <b>×${it.count}</b></div>`);
      } else if (it.type === 'text') {
        parts.push(`<div class="st-text">${esc(it.text)}</div>`);
      }
    }
    return parts.join('');
  }

  function renderStickers(tile) {
    const e = tiles.get(tile);
    if (!e) return;
    const mine = Object.values(state?.stickers || {}).filter((s) => s.tile === e.name);
    const existing = new Map([...e.stickers.children].map((el) => [el.dataset.id, el]));
    for (const s of mine) {
      let el = existing.get(s.id);
      existing.delete(s.id);
      if (!el) {
        el = document.createElement('div');
        el.className = 'sticker';
        el.dataset.id = s.id;
        el.innerHTML = '<div class="st-content"></div><span class="st-resize" title="Drag to resize"></span>';
        wireSticker(el);
        e.stickers.appendChild(el);
      }
      positionSticker(el, s);
      el.classList.toggle('unsure', !!s.unsure);
      if (!el.classList.contains('resizing')) el.style.setProperty('--sticker-own', String(s.scale || 1));
      const html = stickerHtml(s);
      if (el._html !== html) {
        el.querySelector('.st-content').innerHTML = html;
        el._html = html;
      }
    }
    for (const el of existing.values()) {
      live.delete(el.dataset.id);
      el.remove();
    }
  }

  // ---------- stickers that follow cards ----------
  // The camera's owner tracks the card under each sticker and sends positions as it moves
  // (window.Tracker); the game state gets the resting position. Live positions win while fresh.
  const LIVE_TTL = 5000;
  const live = new Map(); // sticker id -> { x, y, flags (1 following a card, 2 card lost), at }

  function positionSticker(el, s) {
    const l = live.get(el.dataset.id);
    const fresh = l && Date.now() - l.at < LIVE_TTL;
    if (!el.classList.contains('dragging') && (fresh || s)) {
      el.style.left = `${(fresh ? l.x : s.x) * 100}%`;
      el.style.top = `${(fresh ? l.y : s.y) * 100}%`;
    }
    el.classList.toggle('anchored', !!(fresh && l.flags & 1));
    el.classList.toggle('lost', !!(fresh && l.flags & 2));
  }

  // local: from my own tracker (never goes stale). x === null forgets the live position.
  function setLive(id, x, y, flags = 0, local = false) {
    if (x === null || x === undefined) live.delete(id);
    else live.set(id, { x, y, flags, at: local ? Infinity : Date.now() });
    const el = document.querySelector(`.sticker[data-id="${CSS.escape(id)}"]`);
    if (el) positionSticker(el, state?.stickers?.[id]);
  }

  function expireLive() {
    const now = Date.now();
    for (const [id, l] of live) {
      if (now - l.at < LIVE_TTL) continue;
      live.delete(id);
      const el = document.querySelector(`.sticker[data-id="${CSS.escape(id)}"]`);
      if (el) positionSticker(el, state?.stickers?.[id]);
    }
  }

  function followStatus(s) {
    if (s.fixed) return '';
    const mine = s.tile === me ? window.Tracker.status(s.id) : null;
    const l = live.get(s.id);
    const flags = l && Date.now() - l.at < LIVE_TTL ? l.flags : 0;
    if (mine === 'looking') return 'Looking for the card…';
    if (mine === 'no-card') return 'No card found under it, so it stays put.';
    if (flags & 2 || mine === 'lost') {
      return s.tile === me && !window.Tracker.removesLost?.()
        ? 'Card not in view (picked up?): the tag waits here and goes back on the card when it is seen again.'
        : 'Card not in view: the sticker goes away soon unless it comes back.';
    }
    if (flags & 1) return 'Following the card.';
    if (s.tile === me && !window.Tracker.isEnabled()) return 'Card tracking is off on your computer (menu: Stickers follow cards).';
    return '';
  }

  function wireSticker(el) {
    let start = null;
    el.addEventListener('click', (ev) => ev.stopPropagation());
    el.addEventListener('dblclick', (ev) => ev.stopPropagation());
    el.addEventListener('pointerdown', (ev) => {
      ev.stopPropagation();
      // Which button was pressed is noted here: once the pointer is captured, the release is
      // reported on the sticker itself, not on the button.
      start = { x: ev.clientX, y: ev.clientY, moved: false, ask: ev.target.closest('[data-ask]')?.dataset.ask || null };
      // Corner handle: resize instead of move. Size follows the pointer's distance from the center.
      if (ev.target.closest('.st-resize')) {
        const r = el.getBoundingClientRect();
        const cx = r.left + r.width / 2;
        const cy = r.top + r.height / 2;
        start.resize = {
          cx, cy,
          dist: Math.max(8, Math.hypot(ev.clientX - cx, ev.clientY - cy)),
          scale: Number(el.style.getPropertyValue('--sticker-own')) || 1,
        };
        el.classList.add('resizing');
      }
      el.setPointerCapture(ev.pointerId);
    });
    el.addEventListener('pointermove', (ev) => {
      if (!start) return;
      if (start.resize) {
        const { cx, cy, dist, scale } = start.resize;
        const next = Math.min(3, Math.max(0.4, scale * (Math.hypot(ev.clientX - cx, ev.clientY - cy) / dist)));
        start.resize.current = next;
        el.style.setProperty('--sticker-own', next.toFixed(2));
        return;
      }
      if (!start.moved && Math.hypot(ev.clientX - start.x, ev.clientY - start.y) < 5) return;
      start.moved = true;
      el.classList.add('dragging');
      const r = el.parentElement.getBoundingClientRect();
      el.style.left = `${Math.min(100, Math.max(0, ((ev.clientX - r.left) / r.width) * 100))}%`;
      el.style.top = `${Math.min(100, Math.max(0, ((ev.clientY - r.top) / r.height) * 100))}%`;
    });
    el.addEventListener('pointerup', (ev) => {
      if (!start) return;
      if (start.resize) {
        const scale = start.resize.current;
        start = null;
        el.classList.remove('resizing');
        if (scale) act({ type: 'stickerScale', id: el.dataset.id, scale: Math.round(scale * 100) / 100 });
        return;
      }
      const moved = start.moved;
      const answer = start.ask;
      start = null;
      el.classList.remove('dragging');
      hidePreview();
      if (answer && !moved) {
        // Answering the app's guess.
        const id = el.dataset.id;
        const s = state?.stickers?.[id];
        if (answer === 'yes') {
          act({ type: 'stickerConfirm', id });
          // The player vouches for it: the reader learns what this card looks like here.
          const card = s?.items.find((it) => it.type === 'card');
          if (s?.tile === me && card) window.AutoRead?.learnAt?.(s.x, s.y, card);
        }
        else if (answer === 'other') {
          // The other cards it considered, if this is my camera (my browser did the lookup);
          // otherwise the sticker's own editor, where the card can be changed by hand.
          const seen = s?.tile === me ? window.AutoRead?.alternatives?.(id) : null;
          if (seen && s) window.Identify.choose(s.tile, s.x, s.y, seen, id);
          else openEditor({ mode: 'edit', id });
        } else {
          // Not something to tag: on my own camera the reader remembers what it looks like.
          if (s?.tile === me) window.AutoRead?.rejected?.(id, s.x, s.y);
          act({ type: 'stickerRemove', id });
        }
        return;
      }
      if (moved) {
        const r = el.parentElement.getBoundingClientRect();
        act({ type: 'stickerMove', id: el.dataset.id, x: (ev.clientX - r.left) / r.width, y: (ev.clientY - r.top) / r.height });
      } else {
        openEditor({ mode: 'edit', id: el.dataset.id });
      }
    });
    el.addEventListener('pointercancel', () => {
      start = null;
      el.classList.remove('dragging', 'resizing');
    });
    // Hovering a card thumbnail shows the full Scryfall image.
    el.addEventListener('pointerover', (ev) => {
      const card = ev.target.closest('.st-card');
      if (card?.dataset.large && ev.pointerType === 'mouse') showPreview(card.dataset.large, ev);
    });
    el.addEventListener('pointerout', (ev) => {
      if (ev.target.closest('.st-card')) hidePreview();
    });
  }

  function showPreview(src, ev) {
    const p = $('card-preview');
    p.querySelector('img').src = src;
    p.hidden = false;
    const x = ev.clientX + 20 + 260 > window.innerWidth ? ev.clientX - 280 : ev.clientX + 20;
    const y = Math.max(8, Math.min(window.innerHeight - 370, ev.clientY - 180));
    p.style.left = `${x}px`;
    p.style.top = `${y}px`;
  }
  function hidePreview() {
    $('card-preview').hidden = true;
  }

  // ---------- editor dialog ----------
  // modes: new (tile, x, y), edit (id), lookup (find a card, then place it)
  let editor = null;

  function openEditor(opts) {
    editor = { ...opts, results: [], card: null };
    $('sticker-dialog').showModal();
    renderEditor();
    if (opts.mode === 'lookup') setTimeout(() => $('card-search')?.focus(), 50);
  }

  function closeEditor() {
    editor = null;
    $('sticker-dialog').close();
  }

  function currentSticker() {
    return editor?.mode === 'edit' ? state?.stickers?.[editor.id] : null;
  }

  function renderEditor() {
    if (!editor) return;
    const body = $('sticker-body');
    const s = currentSticker();
    if (editor.mode === 'edit' && !s) {
      // Just created: wait for the server's copy instead of closing.
      if (editor.awaiting && Date.now() - editor.awaiting < 5000) {
        body.innerHTML = '<p class="muted">Saving…</p>';
        return;
      }
      return closeEditor();
    }

    if (editor.mode === 'lookup') {
      $('sticker-title').textContent = 'Find a card on Scryfall';
      body.innerHTML = `${searchHtml()}${editor.card ? `
        <div class="lookup-card">
          <img src="${esc(editor.card.imageLarge)}" alt="${esc(editor.card.name)}">
          <div>
            <p><b>${esc(editor.card.name)}</b><br><span class="muted">${esc(editor.card.typeLine)}</span></p>
            ${editor.card.power !== '' && editor.card.power != null ? `<p>P/T ${esc(editor.card.power)}/${esc(editor.card.toughness)}</p>` : ''}
            <button class="primary" data-ed="place-card">Place as sticker…</button>
            ${commanderButtonsHtml(editor.card)}
          </div>
        </div>` : '<p class="muted">Type a card name, then pick it from the list.</p>'}`;
      $('sticker-delete').hidden = true;
      return;
    }

    const items = s ? s.items : [];
    const tileName = s ? s.tile : editor.tile;
    $('sticker-title').textContent = s ? `Sticker on ${tileName}'s table` : `New sticker on ${tileName}'s table`;
    const total = totalPT(items);
    const pct = Math.round((s?.scale || 1) * 100);
    body.innerHTML = `
      ${total ? `<div class="ed-total">Shows as <b>${esc(total)}</b></div>` : ''}
      ${s ? `<label class="ed-follow"><input type="checkbox" data-ed="follow" ${s.fixed ? '' : 'checked'}> Follow the card under it
        <span class="muted small">${esc(followStatus(s))}</span></label>` : ''}
      ${s ? `<label class="ed-size">Size <input type="range" data-ed="scale" min="40" max="300" step="10" value="${pct}"> <output>${pct}%</output></label>` : ''}
      <ol class="ed-items">${items.map((it, i) => itemEditorHtml(it, i)).join('')}</ol>
      ${items.length ? '' : '<p class="muted">Pick what to put on the table. You can stack more things on it afterwards (equipment, auras, counters).</p>'}
      <div class="ed-add">
        <button data-ed="add" data-kind="pt-set">P/T (e.g. 7/5)</button>
        <button data-ed="add" data-kind="pt-mod">Modifier (+2/+0)</button>
        <button data-ed="add" data-kind="counter">Counter</button>
        <button data-ed="add" data-kind="text">Text</button>
      </div>
      <h4>Add a card from Scryfall</h4>
      ${searchHtml()}
      ${editor.card ? `<div class="lookup-card small"><img src="${esc(editor.card.image)}" alt=""><div><b>${esc(editor.card.name)}</b><br><button class="primary" data-ed="add-card">Add to this sticker</button></div></div>` : ''}
    `;
    $('sticker-delete').hidden = !s;
  }

  // In Commander/Brawl, any card you look up can be made your commander (or partner).
  function commanderButtonsHtml(card) {
    if (!state || state.mode === 'standard') return '';
    const mine = state.players?.[me]?.commanders || [];
    if (mine.some((c) => c.name === card.name)) {
      return '<p><button data-ed="cmdr-remove">Remove as my commander</button></p>';
    }
    return `<p><button data-ed="cmdr-set">Set as my commander</button>
      ${mine.length === 1 ? '<button data-ed="cmdr-partner" title="Partner, Background, Friends forever…">Add as 2nd commander</button>' : ''}</p>`;
  }

  function searchHtml() {
    return `<div class="card-search">
      <input id="card-search" type="search" placeholder="Card name…" autocomplete="off" value="${esc(editor.query || '')}">
      <ul class="search-results">${editor.results.map((n) => `<li><button data-ed="pick" data-name="${esc(n)}">${esc(n)}</button></li>`).join('')}</ul>
    </div>`;
  }

  function stepperHtml(label, value, i, field) {
    return `<span class="ed-step"><span>${label}</span>
      <button data-ed="step" data-i="${i}" data-field="${field}" data-delta="-1">−</button><b>${value}</b><button data-ed="step" data-i="${i}" data-field="${field}" data-delta="1">+</button></span>`;
  }

  function itemEditorHtml(it, i) {
    const remove = `<button class="danger-text" data-ed="remove" data-i="${i}" title="Remove from stack">✕</button>`;
    if (it.type === 'card') {
      return `<li class="ed-item"><div class="ed-card">${it.image ? `<img src="${esc(it.image)}" alt="">` : ''}
        <div><b>${esc(it.name)}</b><br><span class="muted">${esc(it.typeLine)}${it.power !== '' ? ` · ${esc(it.power)}/${esc(it.toughness)}` : ''}</span></div></div>${remove}</li>`;
    }
    if (it.type === 'pt') {
      return `<li class="ed-item"><div class="ed-fields">
        <select data-ed="field" data-i="${i}" data-field="mode">
          <option value="set" ${it.mode === 'set' ? 'selected' : ''}>Set P/T</option>
          <option value="mod" ${it.mode === 'mod' ? 'selected' : ''}>Modifier</option>
        </select>
        ${stepperHtml('Power', it.power, i, 'power')}
        ${stepperHtml('Toughness', it.toughness, i, 'toughness')}
        <input data-ed="field" data-i="${i}" data-field="label" placeholder="Label, e.g. Bonesplitter" value="${esc(it.label)}" maxlength="40">
      </div>${remove}</li>`;
    }
    if (it.type === 'counter') {
      return `<li class="ed-item"><div class="ed-fields">
        <input data-ed="field" data-i="${i}" data-field="label" list="counter-labels" value="${esc(it.label)}" maxlength="24">
        ${stepperHtml('Count', it.count, i, 'count')}
      </div>${remove}</li>`;
    }
    return `<li class="ed-item"><div class="ed-fields">
      <input data-ed="field" data-i="${i}" data-field="text" value="${esc(it.text)}" maxlength="80">
    </div>${remove}</li>`;
  }

  // Add an item: to the open sticker, or create the sticker if it's new.
  function addItem(item) {
    const s = currentSticker();
    if (s) {
      act({ type: 'stickerItemAdd', id: s.id, item });
    } else if (editor.mode === 'new') {
      const id = newId();
      act({ type: 'stickerAdd', id, target: editor.tile, x: editor.x, y: editor.y, items: [item] });
      editor = { mode: 'edit', id, results: [], card: null, awaiting: Date.now() };
      renderEditor();
    }
  }

  function updateItem(i, changes) {
    const s = currentSticker();
    if (!s || !s.items[i]) return;
    const item = { ...s.items[i], ...changes };
    s.items[i] = item; // optimistic, so rapid clicks stack up
    act({ type: 'stickerItemUpdate', id: s.id, index: i, item });
    renderEditor();
  }

  let searchTimer = null;
  async function search(q) {
    editor.query = q;
    clearTimeout(searchTimer);
    searchTimer = setTimeout(async () => {
      if (!editor || q.trim().length < 2) return;
      try {
        const res = await fetch(`/api/scryfall/autocomplete?code=${encodeURIComponent(code)}&q=${encodeURIComponent(q)}`);
        const data = await res.json();
        if (!editor || editor.query !== q) return;
        editor.results = data.names || [];
        renderResultsOnly();
      } catch { /* offline */ }
    }, 200);
  }

  function renderResultsOnly() {
    const ul = document.querySelector('#sticker-body .search-results');
    if (ul) ul.innerHTML = editor.results.map((n) => `<li><button data-ed="pick" data-name="${esc(n)}">${esc(n)}</button></li>`).join('');
  }

  async function pickCard(name) {
    try {
      const res = await fetch(`/api/scryfall/card?code=${encodeURIComponent(code)}&name=${encodeURIComponent(name)}`);
      const card = await res.json();
      if (!res.ok) throw new Error(card.error || 'Not found');
      if (!editor) return;
      editor.card = card;
      editor.results = [];
      editor.query = card.name;
      renderEditor();
    } catch (err) {
      alert(`Couldn't load that card: ${err.message}`);
    }
  }

  function wireEditor() {
    const dlg = $('sticker-dialog');
    $('sticker-done').addEventListener('click', closeEditor);
    $('sticker-delete').addEventListener('click', () => {
      const s = currentSticker();
      if (s) {
        act({ type: 'stickerRemove', id: s.id });
        closeEditor();
      }
    });
    dlg.addEventListener('close', () => { editor = null; });
    dlg.addEventListener('input', (ev) => {
      if (ev.target.id === 'card-search') search(ev.target.value);
      if (ev.target.dataset.ed === 'scale') {
        // Live preview on this screen; saved for everyone when the slider is released.
        ev.target.nextElementSibling.textContent = `${ev.target.value}%`;
        const s = currentSticker();
        const el = s && document.querySelector(`.sticker[data-id="${CSS.escape(s.id)}"]`);
        el?.style.setProperty('--sticker-own', String(Number(ev.target.value) / 100));
      }
    });
    dlg.addEventListener('keydown', (ev) => {
      if (ev.target.id === 'card-search' && ev.key === 'Enter') {
        ev.preventDefault();
        const first = editor?.results?.[0] || ev.target.value;
        if (first) pickCard(first);
      }
    });
    dlg.addEventListener('change', (ev) => {
      const t = ev.target;
      if (t.dataset.ed === 'scale') {
        const s = currentSticker();
        if (s) act({ type: 'stickerScale', id: s.id, scale: Number(t.value) / 100 });
        t.blur();
        return;
      }
      if (t.dataset.ed === 'follow') {
        const s = currentSticker();
        if (s) act({ type: 'stickerFixed', id: s.id, fixed: !t.checked });
        return;
      }
      if (t.dataset.ed !== 'field') return;
      updateItem(Number(t.dataset.i), { [t.dataset.field]: t.value });
    });
    dlg.addEventListener('click', (ev) => {
      const btn = ev.target.closest('button[data-ed]');
      if (!btn || !editor) return;
      const i = Number(btn.dataset.i);
      switch (btn.dataset.ed) {
        case 'add': {
          const kind = btn.dataset.kind;
          if (kind === 'pt-set') addItem({ type: 'pt', mode: 'set', power: 1, toughness: 1, label: '' });
          if (kind === 'pt-mod') addItem({ type: 'pt', mode: 'mod', power: 1, toughness: 1, label: '' });
          if (kind === 'counter') addItem({ type: 'counter', label: '+1/+1', count: 1 });
          if (kind === 'text') {
            const text = prompt('Sticker text:');
            if (text?.trim()) addItem({ type: 'text', text: text.trim() });
          }
          break;
        }
        case 'step': {
          const s = currentSticker();
          const it = s?.items[i];
          if (!it) return;
          const min = btn.dataset.field === 'count' ? 0 : -999;
          updateItem(i, { [btn.dataset.field]: Math.max(min, Number(it[btn.dataset.field]) + Number(btn.dataset.delta)) });
          break;
        }
        case 'remove': {
          const s = currentSticker();
          if (s) act({ type: 'stickerItemRemove', id: s.id, index: i });
          break;
        }
        case 'pick':
          pickCard(btn.dataset.name);
          break;
        case 'add-card':
          if (editor.card) {
            addItem(editor.card);
            editor.card = null;
            editor.query = '';
            renderEditor();
          }
          break;
        case 'place-card':
          pendingItems = [editor.card];
          closeEditor();
          setTool('sticker');
          break;
        case 'cmdr-set':
        case 'cmdr-partner':
        case 'cmdr-remove': {
          const mine = state.players?.[me]?.commanders || [];
          const c = editor.card;
          const pick = { name: c.name, image: c.image, imageLarge: c.imageLarge, scryfallId: c.scryfallId };
          const next = btn.dataset.ed === 'cmdr-set' ? [pick]
            : btn.dataset.ed === 'cmdr-partner' ? [...mine, pick]
              : mine.filter((x) => x.name !== c.name);
          act({ type: 'setCommanders', target: me, commanders: next });
          break;
        }
        default:
      }
    });
  }

  // ---------- state updates ----------
  function update(next) {
    state = next;
    if (typeof next.serverNow === 'number') clockOffset = next.serverNow - Date.now();
    // Forget erased ids the server has dropped.
    if (erased.size) {
      const live = new Set(next.drawings.map((d) => d.id));
      for (const id of erased) if (!live.has(id)) erased.delete(id);
    }
    for (const tile of tiles.keys()) {
      if (!tile.isConnected) {
        tiles.delete(tile);
        continue;
      }
      drawCanvas(tile);
      renderStickers(tile);
      tiles.get(tile).zonePending = null;
      renderZones(tile);
    }
    renderZonePanel();
    window.Tracker?.sync(next);
    // Refresh the editor unless the user is typing in it.
    const active = document.activeElement;
    const typing = active && $('sticker-dialog').contains(active) && active.matches('input, select');
    if (editor && !typing) renderEditor();
  }

  // Counter name suggestions for the editor.
  document.addEventListener('DOMContentLoaded', () => {
    const dl = document.createElement('datalist');
    dl.id = 'counter-labels';
    dl.innerHTML = COUNTER_LABELS.map((l) => `<option value="${esc(l)}">`).join('');
    document.body.appendChild(dl);
  });

  // Which player's video is under this screen point (for drag and drop)?
  function tileAt(cx, cy) {
    const el = document.elementFromPoint(cx, cy);
    const tile = el?.closest?.('.tile');
    return tile && tiles.has(tile) ? tile : null;
  }

  // Drop a card from the deck panel: it becomes a sticker exactly where it was dropped.
  function dropCard(cx, cy, card) {
    const tile = tileAt(cx, cy);
    if (!tile) return false;
    const e = tiles.get(tile);
    let r = e.layer.getBoundingClientRect();
    if (!r.width) r = tile.getBoundingClientRect(); // marks hidden on this screen
    const x = Math.min(1, Math.max(0, (cx - r.left) / r.width));
    const y = Math.min(1, Math.max(0, (cy - r.top) / r.height));
    act({ type: 'stickerAdd', id: newId(), target: e.name, x, y, items: [card] });
    return true;
  }

  // Open the card viewer with a known card (from a deck list or a commander chip).
  function showCard(card) {
    openEditor({ mode: 'lookup' });
    editor.card = card;
    editor.query = card.name;
    renderEditor();
  }

  // Put a card sticker at a spot on a player's video (from the Identify tool).
  // Resolves with nothing; returns the new sticker's id (so the caller can offer Undo).
  function placeCard(tileName, x, y, card) {
    const id = newId();
    act({ type: 'stickerAdd', id, target: tileName, x, y, items: [{ ...card, type: 'card' }] });
    return id;
  }
  const removeSticker = (id) => act({ type: 'stickerRemove', id });

  function openLookup() {
    openEditor({ mode: 'lookup' });
  }

  return { init, attachTile, detachTile, update, showCard, showPreview, hidePreview, tileAt, dropCard, placeCard, removeSticker, openLookup, setLive };
})();
