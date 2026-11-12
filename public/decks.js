/* Deck sidebar: load your own deck list, browse anyone's deck, pick commanders from your deck,
   preview cards and turn them into stickers. */
window.Decks = (() => {
  const GROUP_ORDER = ['commander', 'companion', 'Creature', 'Planeswalker', 'Battle', 'Instant', 'Sorcery', 'Artifact', 'Enchantment', 'Land', 'Other', 'side'];
  const GROUP_LABEL = { commander: 'Commander', companion: 'Companion', side: 'Sideboard' };

  let code = null;
  let me = null;
  let act = null;
  let state = null;
  let viewing = null; // player whose deck is shown
  const cache = new Map(); // player -> { updated, deck }
  let loadingFor = null;

  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // "{2}{G}{G/U}" -> Scryfall's mana symbol images
  function manaHtml(cost) {
    return String(cost || '').replace(/\{([^}]+)\}/g, (_, sym) => {
      const file = sym.replace(/\//g, '').toUpperCase();
      return `<img class="mana" src="https://svgs.scryfall.io/card-symbols/${encodeURIComponent(file)}.svg" alt="{${esc(sym)}}">`;
    });
  }

  function init(opts) {
    ({ code, me, act } = opts);
    $('deck-btn').addEventListener('click', () => {
      const panel = $('deck-panel');
      panel.hidden = !panel.hidden;
      if (!panel.hidden) {
        $('game-panel').hidden = true;
        if (!viewing) viewing = me;
        render();
      }
      document.body.classList.toggle('panel-open', !panel.hidden);
    });
    $('deck-close').addEventListener('click', () => {
      $('deck-panel').hidden = true;
      document.body.classList.remove('panel-open');
    });
    $('deck-tabs').addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-player]');
      if (!btn) return;
      if (viewing !== btn.dataset.player) $('deck-search').value = '';
      viewing = btn.dataset.player;
      render();
    });
    $('deck-body').addEventListener('click', onBodyClick);
    $('deck-search').addEventListener('input', () => render());
    wireDrag();
    $('deck-body').addEventListener('pointerover', (e) => {
      const row = e.target.closest('[data-large]');
      if (row && e.pointerType === 'mouse') window.Marks.showPreview(row.dataset.large, e);
    });
    $('deck-body').addEventListener('pointerout', (e) => {
      if (e.target.closest('[data-large]')) window.Marks.hidePreview();
    });
    $('deck-cancel').addEventListener('click', () => $('deck-dialog').close());
    $('deck-load').addEventListener('click', submitDeck);
  }

  async function submitDeck() {
    const text = $('deck-text').value;
    if (!text.trim()) return;
    const btn = $('deck-load');
    btn.disabled = true;
    $('deck-status').textContent = 'Looking up cards on Scryfall…';
    try {
      const res = await fetch('/api/deck', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code, text }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not load the deck');
      cache.delete(me);
      window.LocalMatch?.deckChanged?.();
      $('deck-status').textContent = '';
      $('deck-dialog').close();
      viewing = me;
      if (data.notFound?.length) alert(`Loaded ${data.summary.count} cards. Couldn't find: ${data.notFound.join(', ')}`);
      render();
    } catch (err) {
      $('deck-status').textContent = err.message;
    } finally {
      btn.disabled = false;
    }
  }

  async function fetchDeck(player) {
    const summary = state?.players?.[player]?.deck;
    if (!summary) return null;
    const hit = cache.get(player);
    if (hit && hit.updated === summary.updated) return hit.deck;
    if (loadingFor === player) return undefined;
    loadingFor = player;
    try {
      const res = await fetch(`/api/deck?code=${encodeURIComponent(code)}&player=${encodeURIComponent(player)}`);
      const deck = res.ok ? await res.json() : null;
      cache.set(player, { updated: summary.updated, deck });
      return deck;
    } finally {
      loadingFor = null;
    }
  }

  function tabsHtml() {
    return (state?.order || []).map((name) => {
      const d = state.players[name]?.deck;
      return `<button data-player="${esc(name)}" class="${name === viewing ? 'on' : ''}">${esc(name)}${name === me ? ' (you)' : ''}<span class="muted"> ${d ? d.count : '—'}</span></button>`;
    }).join('');
  }

  async function render() {
    if ($('deck-panel').hidden || !state) return;
    if (!viewing || !state.players[viewing]) viewing = me;
    $('deck-tabs').innerHTML = tabsHtml();
    const body = $('deck-body');
    const mineView = viewing === me;
    const summary = state.players[viewing]?.deck;
    const ownerButtons = mineView ? `<div class="deck-actions">
        <button data-deck="paste" class="primary">${summary ? 'Replace deck list' : 'Paste deck list'}</button>
        ${summary ? '<button data-deck="remove" class="danger-text">Remove deck</button>' : ''}
      </div>` : '';
    if (!summary) {
      body.innerHTML = `${ownerButtons}<p class="muted">${mineView ? 'You haven\'t loaded a deck yet.' : `${esc(viewing)} hasn't loaded a deck.`}</p>`;
      return;
    }
    const deck = await fetchDeck(viewing);
    if (deck === undefined) return; // a fetch is already running; it will re-render
    if (!deck) {
      body.innerHTML = `${ownerButtons}<p class="muted">Couldn't load this deck.</p>`;
      return;
    }
    if (viewing !== deck.owner || $('deck-panel').hidden) return render();

    const commanders = state.players[viewing]?.commanders || [];
    const isCmdr = (c) => commanders.some((x) => x.name === c.name);
    const canPick = mineView && state.mode !== 'standard';
    const eligible = (c) => (state.mode === 'brawl' ? c.canBrawl : c.canCommand);

    // Search: every word must appear in the card's name or type line.
    const words = $('deck-search').value.toLowerCase().split(/\s+/).filter(Boolean);
    const matches = (c) => words.every((w) => `${c.name} ${c.typeLine}`.toLowerCase().includes(w));
    const groups = new Map();
    for (const c of deck.cards) {
      if (!matches(c)) continue;
      const g = GROUP_ORDER.includes(c.group) ? c.group : 'Other';
      if (!groups.has(g)) groups.set(g, []);
      groups.get(g).push(c);
    }
    const sections = GROUP_ORDER.filter((g) => groups.has(g)).map((g) => {
      const cards = groups.get(g);
      const n = cards.reduce((s, c) => s + c.qty, 0);
      return `<h3>${esc(GROUP_LABEL[g] || g)} <span class="muted">${n}</span></h3>
        <ul class="deck-list">${cards.map((c) => {
          const idx = deck.cards.indexOf(c);
          const star = canPick && (eligible(c) || isCmdr(c))
            ? `<button class="cmdr-pick ${isCmdr(c) ? 'on' : ''}" data-deck="cmdr" data-i="${idx}" title="${isCmdr(c) ? 'Remove as commander' : 'Make this your commander'}">★</button>`
            : '';
          return `<li class="deck-row" data-i="${idx}" data-large="${esc(c.imageLarge)}">
            <span class="drag-handle" title="Drag onto a video to place it as a sticker">⠿</span>
            <span class="qty">${c.qty}</span>
            <span class="cname">${esc(c.name)}${isCmdr(c) ? ' <span class="badge monarch">Commander</span>' : ''}</span>
            <span class="cost">${manaHtml(c.manaCost)}</span>${star}
          </li>`;
        }).join('')}</ul>`;
    }).join('');

    const updated = new Date(deck.updated).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
    body.innerHTML = `${ownerButtons}
      <p class="muted small">${summary.count} cards · loaded ${esc(updated)}. Drag a card (or its ⠿ handle on touch screens) onto any video to place it as a sticker. Click a card to view it.${canPick ? ' Click ★ to choose your commander.' : ''}</p>
      ${sections || '<p class="muted">No cards match your search.</p>'}
      ${deck.notFound?.length ? `<p class="muted small">Not found on Scryfall: ${esc(deck.notFound.join(', '))}</p>` : ''}`;
    body._deck = deck;
  }

  // ---------- drag a card onto a video ----------
  // Mouse: drag the whole row. Touch: drag the ⠿ handle (so the list can still scroll).
  let drag = null;
  let suppressClick = false;

  function wireDrag() {
    $('deck-body').addEventListener('pointerdown', (e) => {
      const row = e.target.closest('.deck-row');
      const deck = $('deck-body')._deck;
      if (!row || !deck || e.button > 0 || e.target.closest('button')) return;
      const onHandle = !!e.target.closest('.drag-handle');
      if (e.pointerType !== 'mouse' && !onHandle) return;
      if (onHandle) e.preventDefault();
      drag = { row, card: deck.cards[Number(row.dataset.i)], x: e.clientX, y: e.clientY, started: false, ghost: null, over: null };
      row.setPointerCapture(e.pointerId);
    });
    document.addEventListener('pointermove', (e) => {
      if (!drag) return;
      if (!drag.started) {
        if (Math.hypot(e.clientX - drag.x, e.clientY - drag.y) < 6) return;
        drag.started = true;
        window.Marks.hidePreview();
        const ghost = document.createElement('div');
        ghost.className = 'drag-ghost';
        ghost.innerHTML = drag.card.image ? `<img src="${esc(drag.card.image)}" alt="">` : `<span>${esc(drag.card.name)}</span>`;
        document.body.appendChild(ghost);
        drag.ghost = ghost;
        document.body.classList.add('dragging-card');
      }
      drag.ghost.style.left = `${e.clientX}px`;
      drag.ghost.style.top = `${e.clientY}px`;
      const tile = window.Marks.tileAt(e.clientX, e.clientY);
      if (tile !== drag.over) {
        drag.over?.classList.remove('drop-target');
        tile?.classList.add('drop-target');
        drag.over = tile;
      }
    });
    const end = (e, cancelled) => {
      if (!drag) return;
      const d = drag;
      drag = null;
      d.over?.classList.remove('drop-target');
      d.ghost?.remove();
      document.body.classList.remove('dragging-card');
      if (!d.started) return;
      suppressClick = true;
      setTimeout(() => { suppressClick = false; }, 0);
      if (!cancelled) window.Marks.dropCard(e.clientX, e.clientY, d.card);
    };
    document.addEventListener('pointerup', (e) => end(e, false));
    document.addEventListener('pointercancel', (e) => end(e, true));
  }

  function onBodyClick(e) {
    if (suppressClick) {
      suppressClick = false;
      return;
    }
    const btn = e.target.closest('button[data-deck]');
    const deck = $('deck-body')._deck;
    if (btn?.dataset.deck === 'paste') {
      $('deck-status').textContent = '';
      $('deck-dialog').showModal();
      return;
    }
    if (btn?.dataset.deck === 'remove') {
      if (confirm('Remove your deck list?')) {
        fetch('/api/deck/remove', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ code }),
        }).then(() => cache.delete(me));
      }
      return;
    }
    if (btn?.dataset.deck === 'cmdr' && deck) {
      e.stopPropagation();
      const c = deck.cards[Number(btn.dataset.i)];
      const mine = state.players[me]?.commanders || [];
      const pick = { name: c.name, image: c.image, imageLarge: c.imageLarge, scryfallId: c.scryfallId };
      let next;
      if (mine.some((x) => x.name === c.name)) next = mine.filter((x) => x.name !== c.name);
      else if (mine.length === 1 && confirm(`Keep ${mine[0].name} too, as a second commander (Partner, Background…)?\nOK = both, Cancel = replace.`)) next = [...mine, pick];
      else next = [pick];
      act({ type: 'setCommanders', target: me, commanders: next });
      return;
    }
    const row = e.target.closest('.deck-row');
    if (row && deck) {
      window.Marks.hidePreview();
      window.Marks.showCard(deck.cards[Number(row.dataset.i)]);
    }
  }

  let lastKey = '';
  function update(next) {
    state = next;
    // Re-render when decks, commanders, players or the mode change (not on every life click).
    const key = JSON.stringify([state.mode, state.order, Object.entries(state.players).map(([n, p]) => [n, p.deck?.updated, (p.commanders || []).map((c) => c.name)])]);
    if (key !== lastKey) {
      lastKey = key;
      render();
    }
  }

  return { init, update };
})();
