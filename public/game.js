/* Game layer: life, poison, commander damage, counters, turn order, monarch/initiative, log.
   State lives on the server; this file renders it onto video tiles and the side panel. */
window.Game = (() => {
  const COUNTERS = [
    ['energy', 'Energy'],
    ['experience', 'Experience'],
    ['rad', 'Rad'],
    ['tickets', 'Tickets'],
  ];
  let code = null;
  let me = null;
  let state = null;
  let source = null;
  const tileNames = new Map(); // tile element -> player name
  let openPopover = null; // { name, kind }

  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function start(inviteCode, myName) {
    code = inviteCode;
    me = myName;
    window.Marks.init({ code, me, act });
    window.Identify.init({ code, me });
    window.Tracker.init({ code, me, act });
    window.Decks.init({ code, me, act });
    connect();
    wirePanel();
  }

  function connect() {
    source?.close();
    source = new EventSource(`/api/game/stream?code=${encodeURIComponent(code)}`);
    source.onmessage = (e) => {
      state = JSON.parse(e.data);
      renderAll();
    };
    // EventSource reconnects by itself after errors.
  }

  async function act(action) {
    try {
      const res = await fetch('/api/game/action', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code, action }),
      });
      if (!res.ok) console.warn('Action failed', action, await res.text());
    } catch (err) {
      console.warn('Action failed', err);
    }
  }

  const MODES = {
    standard: { label: 'Standard', commander: false, cmdDmg: false, life: () => 20 },
    commander: { label: 'Commander', commander: true, cmdDmg: true, life: () => 40 },
    brawl: { label: 'Brawl', commander: true, cmdDmg: false, life: (n) => (n <= 2 ? 25 : 30) },
  };
  const mode = () => MODES[state?.mode] || MODES.commander;

  function isOut(p) {
    return p.life <= 0 || p.poison >= 10 || (mode().cmdDmg && Object.values(p.cmdDmg || {}).some((d) => d >= 21));
  }

  // ---------- tiles ----------
  function attachTile(tile, name) {
    tileNames.set(tile, name);
    window.Marks.attachTile(tile, name);
    if (!tile.querySelector('.game-hud')) {
      const hud = document.createElement('div');
      hud.className = 'game-hud';
      // Clicks on the HUD shouldn't enlarge the video.
      hud.addEventListener('click', (e) => e.stopPropagation());
      hud.addEventListener('dblclick', (e) => e.stopPropagation());
      hud.addEventListener('click', onHudClick);
      tile.appendChild(hud);
      const badges = document.createElement('div');
      badges.className = 'game-badges';
      tile.appendChild(badges);
      // Commander chips: hover for the full card, click to view it large.
      const cmdrs = document.createElement('div');
      cmdrs.className = 'game-cmdrs';
      cmdrs.addEventListener('click', (e) => {
        e.stopPropagation();
        const chip = e.target.closest('[data-cmdr]');
        const c = state?.players?.[tileNames.get(tile)]?.commanders?.[Number(chip?.dataset.cmdr)];
        if (c) window.Marks.showCard(c);
      });
      cmdrs.addEventListener('dblclick', (e) => e.stopPropagation());
      cmdrs.addEventListener('pointerover', (e) => {
        const chip = e.target.closest('[data-large]');
        if (chip && e.pointerType === 'mouse') window.Marks.showPreview(chip.dataset.large, e);
      });
      cmdrs.addEventListener('pointerout', () => window.Marks.hidePreview());
      tile.appendChild(cmdrs);
    }
    renderTile(tile);
  }

  function detachTile(tile) {
    tileNames.delete(tile);
    window.Marks.detachTile(tile);
  }

  function renderTile(tile) {
    const name = tileNames.get(tile);
    const hud = tile.querySelector('.game-hud');
    const badges = tile.querySelector('.game-badges');
    const p = state?.players?.[name];
    if (!hud) return;
    if (!p) {
      hud.innerHTML = '';
      badges.innerHTML = '';
      tile.classList.remove('active-turn', 'player-out');
      return;
    }
    tile.classList.toggle('active-turn', state.active === name);
    tile.classList.toggle('player-out', isOut(p));

    const b = [];
    if (state.active === name) b.push('<span class="badge turn">Their turn</span>');
    if (state.monarch === name) b.push('<span class="badge monarch">Monarch</span>');
    if (state.initiative === name) b.push('<span class="badge initiative">Initiative</span>');
    if (isOut(p)) b.push('<span class="badge out">Out</span>');
    badges.innerHTML = b.join('');

    const cmdrBox = tile.querySelector('.game-cmdrs');
    cmdrBox.innerHTML = mode().commander ? (p.commanders || []).map((c, i) => {
      const tax = (p.casts?.[c.name] || 0) * 2;
      return `<button class="cmdr-chip" data-cmdr="${i}" data-large="${esc(c.imageLarge)}" title="${esc(c.name)}">
        ${c.image ? `<img src="${esc(c.image)}" alt="">` : ''}<span class="cmdr-name">${esc(c.name)}</span>${tax ? `<span class="tax">Tax {${tax}}</span>` : ''}
      </button>`;
    }).join('') : '';

    const cmdTotal = Math.max(0, ...Object.values(p.cmdDmg || {}));
    const counterBits = COUNTERS.filter(([k]) => p.counters?.[k]).map(([k, label]) => `${label} ${p.counters[k]}`);
    hud.innerHTML = `
      <div class="life-row">
        <button data-act="life" data-delta="-5" title="Lose 5 life">−5</button>
        <button data-act="life" data-delta="-1" title="Lose 1 life">−1</button>
        <span class="life" title="Life">${p.life}</span>
        <button data-act="life" data-delta="1" title="Gain 1 life">+1</button>
        <button data-act="life" data-delta="5" title="Gain 5 life">+5</button>
      </div>
      <div class="extra-row">
        <button data-pop="poison" class="${p.poison ? 'has' : ''}" title="Poison counters">Poison ${p.poison}</button>
        ${mode().cmdDmg ? `<button data-pop="cmd" class="${cmdTotal ? 'has' : ''}" title="Commander damage taken">Cmdr ${cmdTotal}</button>` : ''}
        <button data-pop="counters" class="${counterBits.length ? 'has' : ''}" title="Other counters">${counterBits.length ? esc(counterBits.join(' · ')) : 'Counters'}</button>
      </div>
      ${openPopover?.name === name ? popoverHtml(name, p) : ''}
    `;
  }

  function stepper(label, value, attrs) {
    return `<div class="stepper"><span>${label}</span>
      <button ${attrs} data-delta="-1">−</button><b>${value}</b><button ${attrs} data-delta="1">+</button></div>`;
  }

  function popoverHtml(name, p) {
    const kind = openPopover.kind;
    let body = '';
    if (kind === 'poison') {
      body = stepper('Poison', p.poison, `data-act="poison"`);
    } else if (kind === 'cmd') {
      const others = state.order.filter((n) => n !== name);
      body = others.length
        ? others.map((from) => stepper(`From ${esc(from)}`, p.cmdDmg?.[from] || 0, `data-act="cmdDmg" data-from="${esc(from)}"`)).join('')
        : '<p class="muted">No other players yet.</p>';
      body += '<p class="muted small">Commander damage also changes life.</p>';
    } else if (kind === 'counters') {
      body = COUNTERS.map(([k, label]) => stepper(label, p.counters?.[k] || 0, `data-act="counter" data-counter="${k}"`)).join('');
    }
    return `<div class="popover">${body}<button class="close" data-pop="close">Done</button></div>`;
  }

  function onHudClick(e) {
    const btn = e.target.closest('button');
    if (!btn) return;
    const tile = e.currentTarget.closest('.tile');
    const name = tileNames.get(tile);
    if (btn.dataset.pop) {
      const kind = btn.dataset.pop;
      openPopover = kind === 'close' || (openPopover?.name === name && openPopover.kind === kind) ? null : { name, kind };
      renderAll();
      return;
    }
    if (btn.dataset.act) {
      act({
        type: btn.dataset.act,
        target: name,
        delta: Number(btn.dataset.delta),
        from: btn.dataset.from,
        counter: btn.dataset.counter,
      });
    }
  }

  // ---------- side panel ----------
  function wirePanel() {
    document.getElementById('pass-btn').addEventListener('click', () => act({ type: 'passTurn' }));
    document.getElementById('game-btn').addEventListener('click', () => {
      const panel = document.getElementById('game-panel');
      panel.hidden = !panel.hidden;
      if (!panel.hidden) document.getElementById('deck-panel').hidden = true;
      document.body.classList.toggle('panel-open', !panel.hidden);
    });
    document.getElementById('game-mode').addEventListener('change', (e) => {
      // Picking a mode fills in its preset starting life (you can still override it).
      const m = MODES[e.target.value];
      document.getElementById('start-life').value = String(m.life(state?.order.length || 0));
    });
    document.getElementById('panel-close').addEventListener('click', () => {
      document.getElementById('game-panel').hidden = true;
      document.body.classList.remove('panel-open');
    });
    document.getElementById('shuffle-btn').addEventListener('click', () => {
      if (confirm('Randomize turn order and start from round 1?')) act({ type: 'shuffleOrder' });
    });
    document.getElementById('new-game-btn').addEventListener('click', () => {
      const life = document.getElementById('start-life').value;
      const m = document.getElementById('game-mode').value;
      if (confirm(`Start a new ${MODES[m].label} game at ${life} life? Life, counters, stickers and the log reset for everyone. Decks and commanders stay.`)) {
        act({ type: 'newGame', mode: m, startingLife: Number(life) });
      }
    });
    document.getElementById('clear-stickers-btn').addEventListener('click', () => {
      if (confirm('Remove every sticker on every table?')) act({ type: 'stickersClear' });
    });
    document.getElementById('clear-drawings-btn').addEventListener('click', () => act({ type: 'drawClear' }));
    document.getElementById('order-list').addEventListener('click', (e) => {
      const btn = e.target.closest('button');
      if (!btn) return;
      const target = btn.dataset.name;
      if (btn.dataset.act === 'removePlayer' && !confirm(`Remove ${target} from the game?`)) return;
      act({ type: btn.dataset.act, target, delta: Number(btn.dataset.delta || 0), commander: btn.dataset.commander });
    });
  }

  function renderPanel() {
    if (!state) return;
    const passBtn = document.getElementById('pass-btn');
    passBtn.textContent = state.active === me ? 'Pass turn' : `${state.active || '—'}'s turn`;
    passBtn.classList.toggle('primary', state.active === me);

    document.getElementById('round-info').textContent = `${mode().label} · round ${state.turn} · started at ${state.startingLife} life`;
    // Show the current game's settings, unless someone is choosing new ones right now.
    const modeSel = document.getElementById('game-mode');
    const lifeSel = document.getElementById('start-life');
    if (document.activeElement !== modeSel && document.activeElement !== lifeSel && renderPanel.version !== state.version) {
      modeSel.value = state.mode || 'commander';
      if (![...lifeSel.options].some((o) => o.value === String(state.startingLife))) lifeSel.add(new Option(`${state.startingLife} life`, String(state.startingLife)));
      lifeSel.value = String(state.startingLife);
    }
    renderPanel.version = state.version;

    document.getElementById('order-list').innerHTML = state.order.map((name, i) => {
      const p = state.players[name];
      const tags = [
        state.active === name ? '<span class="badge turn">Turn</span>' : '',
        state.monarch === name ? '<span class="badge monarch">Monarch</span>' : '',
        state.initiative === name ? '<span class="badge initiative">Initiative</span>' : '',
        isOut(p) ? '<span class="badge out">Out</span>' : '',
      ].join('');
      const n = esc(name);
      const cmdrs = mode().commander ? (p.commanders || []).map((c) => {
        const casts = p.casts?.[c.name] || 0;
        return `<div class="order-cmdr"><span>${esc(c.name)}</span>
          <span class="muted">cast ${casts}× · tax {${casts * 2}}</span>
          <button data-act="commanderCast" data-name="${n}" data-commander="${esc(c.name)}" data-delta="1" title="Cast from the command zone">Cast</button>
          <button data-act="commanderCast" data-name="${n}" data-commander="${esc(c.name)}" data-delta="-1" title="Undo a cast">−</button>
        </div>`;
      }).join('') : '';
      return `<li>
        <div class="order-head"><b>${i + 1}. ${n}</b> <span class="muted">${p.life} life${p.deck ? ` · ${p.deck.count}-card deck` : ''}</span> ${tags}</div>
        ${cmdrs}
        <div class="order-actions">
          <button data-act="setActive" data-name="${n}" title="Make it ${n}'s turn">Their turn</button>
          <button data-act="monarch" data-name="${n}" title="Give or take the monarch">Monarch</button>
          <button data-act="initiative" data-name="${n}" title="Give or take the initiative">Initiative</button>
          <button data-act="moveSeat" data-delta="-1" data-name="${n}" title="Move earlier in turn order">↑</button>
          <button data-act="moveSeat" data-delta="1" data-name="${n}" title="Move later in turn order">↓</button>
          <button data-act="removePlayer" data-name="${n}" title="Remove from the game" class="danger-text">✕</button>
        </div>
      </li>`;
    }).join('');

    const fmt = (t) => new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    document.getElementById('game-log').innerHTML = [...state.log].reverse()
      .map((e) => `<li><span class="muted">${fmt(e.t)} · ${esc(e.by)}</span><br>${esc(e.text)}</li>`).join('');
  }

  function renderAll() {
    if (state) window.Marks.update(state);
    if (state) window.Decks.update(state);
    for (const tile of tileNames.keys()) {
      if (!tile.isConnected) tileNames.delete(tile);
      else renderTile(tile);
    }
    renderPanel();
  }

  return { start, attachTile, detachTile };
})();
