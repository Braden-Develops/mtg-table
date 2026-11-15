/* Zoom into a player's video with the mouse wheel (or a trackpad pinch), toward the pointer.
   While zoomed in, drag to move around. Only your own screen changes; nobody else sees it.
   The video and its mark layer (stickers, drawings, zones) get the same transform, so marks stay
   on their cards. Both are clipped back to the tile, which itself must not clip (popovers spill out). */
window.Zoom = (() => {
  const MAX = 6;
  const tiles = new Map(); // tile -> { z, x, y, video, chip }  (x, y: where the picture's top-left sits, px)

  const selecting = () => (document.body.dataset.tool || 'select') === 'select';

  function apply(tile) {
    const s = tiles.get(tile);
    if (!s) return;
    const W = tile.clientWidth;
    const H = tile.clientHeight;
    // Keep the picture covering the tile: no empty space dragged in from the sides.
    s.x = Math.min(0, Math.max(W - W * s.z, s.x));
    s.y = Math.min(0, Math.max(H - H * s.z, s.y));
    const on = s.z > 1.001;
    if (!on) Object.assign(s, { z: 1, x: 0, y: 0 });
    tile.classList.toggle('zoomed', on);
    s.chip.hidden = !on;
    s.chip.textContent = `${s.z.toFixed(1)}× · reset`;

    const layer = tile.querySelector('.mark-layer');
    for (const el of [s.video, layer]) {
      if (!el) continue;
      if (!on) {
        el.style.transform = el.style.transformOrigin = el.style.clipPath = '';
        continue;
      }
      // The element sits at (L, T) in the tile; scale it around the tile's corner, then clip to the tile.
      const L = el.offsetLeft;
      const T = el.offsetTop;
      const left = -s.x / s.z - L;
      const top = -s.y / s.z - T;
      const right = el.offsetWidth - ((W - s.x) / s.z - L);
      const bottom = el.offsetHeight - ((H - s.y) / s.z - T);
      const radius = parseFloat(getComputedStyle(tile).borderTopLeftRadius) || 0;
      el.style.transformOrigin = `${-L}px ${-T}px`;
      el.style.transform = `translate(${s.x}px, ${s.y}px) scale(${s.z})`;
      el.style.clipPath = `inset(${top}px ${right}px ${bottom}px ${left}px round ${radius / s.z}px)`;
    }
  }

  function zoomAt(tile, factor, clientX, clientY) {
    const s = tiles.get(tile);
    const r = tile.getBoundingClientRect();
    const px = clientX - r.left;
    const py = clientY - r.top;
    const z = Math.min(MAX, Math.max(1, s.z * factor));
    // The point under the pointer stays under the pointer.
    s.x = px - ((px - s.x) / s.z) * z;
    s.y = py - ((py - s.y) / s.z) * z;
    s.z = z;
    apply(tile);
    tile.dispatchEvent(new CustomEvent('zoomchange'));
  }

  function reset(tile) {
    const s = tiles.get(tile);
    if (!s) return;
    s.z = 1;
    apply(tile);
    tile.dispatchEvent(new CustomEvent('zoomchange'));
  }

  function attachTile(tile) {
    if (tiles.has(tile)) return;
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'zoom-chip';
    chip.title = 'Back to the whole picture';
    chip.hidden = true;
    tile.appendChild(chip);
    const s = { z: 1, x: 0, y: 0, video: tile.querySelector('video'), chip };
    tiles.set(tile, s);

    chip.addEventListener('click', (e) => { e.stopPropagation(); reset(tile); });
    chip.addEventListener('dblclick', (e) => e.stopPropagation());

    tile.addEventListener('wheel', (e) => {
      // Lists and sliders inside a tile's popovers keep their own scrolling.
      if (e.target.closest('.popover, .adjust-pop, input, select, textarea')) return;
      if (s.z <= 1 && e.deltaY > 0) return; // nothing to zoom out of: let the page have it
      e.preventDefault();
      const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? tile.clientHeight : 1;
      const speed = e.ctrlKey ? 0.01 : 0.0015; // ctrl+wheel is how a trackpad pinch arrives
      zoomAt(tile, Math.exp(-e.deltaY * unit * speed), e.clientX, e.clientY);
    }, { passive: false });

    // Drag to move around while zoomed in (Select tool only; the other tools use the drag themselves).
    let drag = null;
    let dragged = false;
    tile.addEventListener('pointerdown', (e) => {
      dragged = false;
      if (s.z <= 1 || e.button !== 0 || !selecting()) return;
      if (e.target !== s.video && e.target !== tile) return;
      drag = { id: e.pointerId, cx: e.clientX, cy: e.clientY, x: s.x, y: s.y };
    });
    tile.addEventListener('pointermove', (e) => {
      if (!drag || e.pointerId !== drag.id) return;
      const dx = e.clientX - drag.cx;
      const dy = e.clientY - drag.cy;
      if (!dragged && Math.hypot(dx, dy) < 4) return;
      if (!dragged) {
        dragged = true;
        tile.setPointerCapture(drag.id);
        tile.classList.add('panning');
      }
      s.x = drag.x + dx;
      s.y = drag.y + dy;
      apply(tile);
    });
    const end = (e) => {
      if (!drag || e.pointerId !== drag.id) return;
      drag = null;
      tile.classList.remove('panning');
    };
    tile.addEventListener('pointerup', end);
    tile.addEventListener('pointercancel', end);
    // A drag is not a click: don't enlarge or shrink the video (or open a pile) when it ends.
    tile.addEventListener('click', (e) => {
      if (!dragged) return;
      dragged = false;
      e.stopImmediatePropagation();
      e.preventDefault();
    }, true);

    // The tile changes size (enlarged, window resized) or the picture's shape changes: keep it in place.
    let size = [tile.clientWidth, tile.clientHeight];
    new ResizeObserver(() => {
      const [w0, h0] = size;
      size = [tile.clientWidth, tile.clientHeight];
      if (s.z > 1 && w0 && h0) {
        s.x *= size[0] / w0;
        s.y *= size[1] / h0;
      }
      apply(tile);
    }).observe(tile);
    for (const type of ['loadedmetadata', 'resize']) s.video.addEventListener(type, () => requestAnimationFrame(() => apply(tile)));
  }

  function detachTile(tile) {
    tiles.delete(tile);
  }

  return { attachTile, detachTile, reset, level: (tile) => tiles.get(tile)?.z || 1, refresh: apply };
})();
