/* Small UI helpers: dropdown menus, and keeping the Game/Decks buttons lit while their panel is open. */
(() => {
  // ---------- dropdown menus: <div class="menu"><button data-menu-btn>…</button><div class="menu-pop">…</div></div>
  const closeAll = (except) => {
    for (const m of document.querySelectorAll('.menu.open')) if (m !== except) m.classList.remove('open');
  };
  document.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-menu-btn]');
    if (btn) {
      const menu = btn.closest('.menu');
      closeAll(menu);
      menu.classList.toggle('open');
      return;
    }
    // Clicks inside a menu keep it open (sliders, toggles), except actions that leave the page.
    if (!e.target.closest('.menu-pop')) closeAll();
  });
  // ---------- back to gallery: everyone's video the same size again
  const unfocus = () => {
    for (const t of document.querySelectorAll('#grid > .tile.focused')) t.classList.remove('focused');
  };

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    // Escape closes an open menu first; with nothing else open it leaves the enlarged view.
    if (document.querySelector('.menu.open')) return closeAll();
    if (document.querySelector('dialog[open]') || e.target.closest?.('input, textarea, select')) return;
    unfocus();
  });

  // ---------- panel buttons reflect whether their panel is open
  const link = (btnId, panelId) => {
    const btn = document.getElementById(btnId);
    const panel = document.getElementById(panelId);
    if (!btn || !panel) return;
    const sync = () => btn.classList.toggle('on', !panel.hidden);
    new MutationObserver(sync).observe(panel, { attributes: true, attributeFilter: ['hidden'] });
    sync();
  };
  // ---------- video grid: every tile fits on screen at once, as large as possible (16:9)
  const GAP = 16;
  const RATIO = 16 / 9;
  const fit = (w, h) => (w / h > RATIO ? [h * RATIO, h] : [w, w / RATIO]);

  function place(tile, x, y, w, h) {
    const [tw, th] = fit(w, h);
    Object.assign(tile.style, {
      left: `${Math.round(x + (w - tw) / 2)}px`,
      top: `${Math.round(y + (h - th) / 2)}px`,
      width: `${Math.round(tw)}px`,
      height: `${Math.round(th)}px`,
    });
  }

  function layoutGrid() {
    const grid = document.getElementById('grid');
    if (!grid || !grid.offsetParent) return;
    const pad = window.innerWidth <= 560 ? 8 : 16;
    const W = grid.clientWidth - pad * 2;
    const H = grid.clientHeight - pad * 2;
    const tiles = [...grid.querySelectorAll(':scope > .tile')];
    const n = tiles.length;
    if (!n || W <= 0 || H <= 0) return;

    const focused = tiles.find((t) => t.classList.contains('focused'));
    if (focused && n > 1) {
      // One big video, the rest in a strip beside it (below it on tall screens).
      const others = tiles.filter((t) => t !== focused);
      const side = W / H > 1.2;
      const strip = side ? Math.min(W * 0.24, 360) : Math.min(H * 0.24, 220);
      if (side) {
        place(focused, pad, pad, W - strip - GAP, H);
        const each = (H - GAP * (others.length - 1)) / others.length;
        others.forEach((t, i) => place(t, pad + W - strip, pad + i * (each + GAP), strip, each));
      } else {
        place(focused, pad, pad, W, H - strip - GAP);
        const each = (W - GAP * (others.length - 1)) / others.length;
        others.forEach((t, i) => place(t, pad + i * (each + GAP), pad + H - strip, each, strip));
      }
      return;
    }

    // Pick the column count that gives the biggest tiles.
    let best = null;
    for (let cols = 1; cols <= n; cols++) {
      const rows = Math.ceil(n / cols);
      const [tw] = fit((W - GAP * (cols - 1)) / cols, (H - GAP * (rows - 1)) / rows);
      if (!best || tw > best.tw) best = { cols, rows, tw };
    }
    const { cols, rows } = best;
    const cellW = (W - GAP * (cols - 1)) / cols;
    const cellH = (H - GAP * (rows - 1)) / rows;
    const [tw, th] = fit(cellW, cellH);
    const top = pad + (H - (rows * th + GAP * (rows - 1))) / 2;
    tiles.forEach((t, i) => {
      const r = Math.floor(i / cols);
      const inRow = Math.min(cols, n - r * cols);
      const left = pad + (W - (inRow * tw + GAP * (inRow - 1))) / 2;
      place(t, left + (i % cols) * (tw + GAP), top + r * (th + GAP), tw, th);
    });
  }

  let queued = false;
  const relayout = () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => { queued = false; layoutGrid(); });
  };

  document.addEventListener('DOMContentLoaded', () => {
    link('game-btn', 'game-panel');
    link('deck-btn', 'deck-panel');
    const grid = document.getElementById('grid');
    // A click on empty space around the videos (not on a video) returns to gallery view.
    grid.addEventListener('click', (e) => {
      if (e.target === grid) unfocus();
    });
    new ResizeObserver(relayout).observe(grid);
    // While a video is enlarged, the big one follows the turn: when the turn passes, the new
    // active player's video takes the big spot. Enlarging someone else mid-turn sticks until then.
    let lastActive = null;
    const followTurn = () => {
      const active = grid.querySelector(':scope > .tile.active-turn');
      if (active === lastActive) return;
      lastActive = active;
      const focused = grid.querySelector(':scope > .tile.focused');
      if (active && focused && focused !== active) {
        focused.classList.remove('focused');
        active.classList.add('focused');
      }
    };
    new MutationObserver(() => { followTurn(); relayout(); })
      .observe(grid, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });
    window.addEventListener('resize', relayout);
  });
})();
