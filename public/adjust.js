/* Picture adjustments.
   1. View adjustments: brightness / contrast / saturation for each player's video, on your screen only.
      Works in every browser (CSS filters). Remembered per player on this device.
   2. Camera settings: your own webcam's hardware controls (brightness, contrast, focus, exposure,
      white balance, zoom…) when the browser exposes them (Chrome and Edge do; Firefox and iOS mostly don't).
      These change the video everyone receives. Remembered per camera on this device. */
window.Adjust = (() => {
  const VIEW_DEFAULT = { brightness: 100, contrast: 100, saturate: 100 };
  const VIEW_SLIDERS = [
    ['brightness', 'Brightness', 40, 200],
    ['contrast', 'Contrast', 40, 200],
    ['saturate', 'Saturation', 0, 200],
  ];
  // Camera controls we know how to show, in display order.
  const CAMERA_NUMERIC = [
    ['brightness', 'Brightness'],
    ['contrast', 'Contrast'],
    ['saturation', 'Saturation'],
    ['sharpness', 'Sharpness'],
    ['exposureCompensation', 'Exposure compensation'],
    ['exposureTime', 'Exposure time (manual exposure)'],
    ['colorTemperature', 'Color temperature (manual white balance)'],
    ['focusDistance', 'Focus distance (manual focus)'],
    ['zoom', 'Zoom'],
  ];
  const CAMERA_MODES = [
    ['focusMode', 'Focus'],
    ['exposureMode', 'Exposure'],
    ['whiteBalanceMode', 'White balance'],
  ];
  const MODE_LABEL = { continuous: 'Auto', manual: 'Manual', 'single-shot': 'Auto once', none: 'Off' };

  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const load = (key) => { try { return JSON.parse(localStorage.getItem(key)); } catch { return null; } };
  const save = (key, value) => { try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* ignore */ } };

  let localTrack = null; // LiveKit LocalVideoTrack
  const tiles = new Map(); // tile -> { name, isLocal }
  let openTile = null;

  // ---------- view adjustments ----------
  const viewKey = (name) => `view:${name}`;
  const viewFor = (name) => ({ ...VIEW_DEFAULT, ...(load(viewKey(name)) || {}) });

  function applyView(tile) {
    const t = tiles.get(tile);
    const video = tile.querySelector('video');
    if (!t || !video) return;
    const v = viewFor(t.name);
    const isDefault = VIEW_SLIDERS.every(([k]) => v[k] === VIEW_DEFAULT[k]);
    video.style.filter = isDefault ? '' : `brightness(${v.brightness}%) contrast(${v.contrast}%) saturate(${v.saturate}%)`;
    tile.querySelector('.adjust-btn')?.classList.toggle('has', !isDefault);
  }

  function attachTile(tile, name, isLocal) {
    tiles.set(tile, { name, isLocal });
    if (!tile.querySelector('.adjust-btn')) {
      const btn = document.createElement('button');
      btn.className = 'adjust-btn';
      btn.title = 'Adjust how this video looks on your screen';
      btn.innerHTML = '<svg class="ic"><use href="#i-sun"/></svg>';
      btn.title = isLocal ? 'Adjust your camera picture (everyone sees it)' : 'Adjust how this video looks on your screen';
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        // Your own video: change the feed itself. Others: change only how it looks to you.
        if (tiles.get(tile)?.isLocal) openCameraDialog();
        else togglePopover(tile);
      });
      btn.addEventListener('dblclick', (e) => e.stopPropagation());
      tile.appendChild(btn);
      const pop = document.createElement('div');
      pop.className = 'adjust-pop';
      pop.hidden = true;
      pop.addEventListener('click', (e) => e.stopPropagation());
      pop.addEventListener('dblclick', (e) => e.stopPropagation());
      pop.addEventListener('pointerdown', (e) => e.stopPropagation());
      pop.addEventListener('input', (e) => onViewInput(tile, e));
      tile.appendChild(pop);
    }
    applyView(tile);
  }

  function togglePopover(tile) {
    for (const t of tiles.keys()) if (t !== tile) t.querySelector('.adjust-pop').hidden = true;
    const pop = tile.querySelector('.adjust-pop');
    pop.hidden = !pop.hidden;
    openTile = pop.hidden ? null : tile;
    if (!pop.hidden) renderPopover(tile);
  }

  function renderPopover(tile) {
    const t = tiles.get(tile);
    const v = viewFor(t.name);
    tile.querySelector('.adjust-pop').innerHTML = `
      <b>${t.isLocal ? 'Your camera' : esc(t.name)} · on your screen</b>
      ${VIEW_SLIDERS.map(([k, label, min, max]) => `
        <label>${label}<input type="range" data-view="${k}" min="${min}" max="${max}" step="5" value="${v[k]}"><output>${v[k]}%</output></label>`).join('')}
      <div class="adjust-actions">
        <button data-view-act="reset">Reset</button>
        ${t.isLocal ? '<button data-view-act="camera" class="primary">Camera settings…</button>' : ''}
      </div>
      <p class="muted small">${t.isLocal ? 'These only change your own screen. Use Camera settings to change what everyone sees.' : 'Only changes your screen.'}</p>`;
    tile.querySelector('.adjust-pop').onclick = (e) => {
      e.stopPropagation();
      const act = e.target.closest('[data-view-act]')?.dataset.viewAct;
      if (act === 'reset') {
        save(viewKey(t.name), VIEW_DEFAULT);
        applyView(tile);
        renderPopover(tile);
      } else if (act === 'camera') {
        togglePopover(tile);
        openCameraDialog();
      }
    };
  }

  function onViewInput(tile, e) {
    const key = e.target.dataset.view;
    if (!key) return;
    const t = tiles.get(tile);
    const v = viewFor(t.name);
    v[key] = Number(e.target.value);
    e.target.nextElementSibling.textContent = `${v[key]}%`;
    save(viewKey(t.name), v);
    // The same player may have more than one tile (two devices); update all of them.
    for (const [other, info] of tiles) if (info.name === t.name) applyView(other);
  }

  document.addEventListener('click', () => {
    if (openTile) {
      openTile.querySelector('.adjust-pop').hidden = true;
      openTile = null;
    }
  });

  // ---------- camera hardware settings ----------
  const mediaTrack = () => localTrack?.mediaStreamTrack;
  const cameraKey = () => `camera:${mediaTrack()?.getSettings().deviceId || 'default'}`;

  function cameraSupport() {
    const track = mediaTrack();
    if (!track || typeof track.getCapabilities !== 'function') return { caps: {}, numeric: [], modes: [] };
    const caps = track.getCapabilities() || {};
    const numeric = CAMERA_NUMERIC.filter(([k]) => caps[k] && typeof caps[k].max === 'number' && caps[k].max > caps[k].min);
    const modes = CAMERA_MODES.filter(([k]) => Array.isArray(caps[k]) && caps[k].length > 1);
    return { caps, numeric, modes };
  }

  async function applyCamera(values) {
    const track = mediaTrack();
    if (!track) return;
    const { caps } = cameraSupport();
    const advanced = {};
    for (const [k, v] of Object.entries(values)) if (caps[k] !== undefined) advanced[k] = v;
    // Manual values only take effect in manual mode, so send modes first.
    const modes = Object.fromEntries(Object.entries(advanced).filter(([k]) => k.endsWith('Mode')));
    const rest = Object.fromEntries(Object.entries(advanced).filter(([k]) => !k.endsWith('Mode')));
    try {
      if (Object.keys(modes).length) await track.applyConstraints({ advanced: [modes] });
      if (Object.keys(rest).length) await track.applyConstraints({ advanced: [rest] });
    } catch (err) {
      console.warn('Camera setting not applied', err);
    }
  }

  function setLocalTrack(track) {
    localTrack = track;
    const saved = load(cameraKey());
    if (saved && Object.keys(saved).length) applyCamera(saved);
    window.Picture.setTrack(track); // re-applies saved picture adjustments
  }

  function openCameraDialog() {
    renderCameraDialog();
    $('camera-dialog').showModal();
  }

  const PICTURE_SLIDERS = [
    ['brightness', 'Brightness', 50, 200, '%'],
    ['contrast', 'Contrast', 50, 200, '%'],
    ['saturation', 'Saturation', 0, 200, '%'],
    ['sharpen', 'Sharpen (helps card text)', 0, 100, '%'],
  ];

  function pictureHtml() {
    const p = window.Picture.get();
    const rotated = Number(p.rotate) === 180;
    return `<h4>Picture <span class="muted small">(any browser, everyone sees it)</span></h4>
      <div class="cam-row">Rotate 180°
        <button type="button" class="chip ${rotated ? 'on' : ''}" data-rotate aria-pressed="${rotated}">${rotated ? 'On' : 'Off'}</button>
      </div>
      ${PICTURE_SLIDERS.map(([k, label, min, max, unit]) => `<label class="cam-row">${label}
        <input type="range" data-pic="${k}" min="${min}" max="${max}" step="5" value="${p[k]}">
        <output>${p[k]}${unit}</output>
      </label>`).join('')}`;
  }

  function renderCameraDialog() {
    const body = $('camera-body');
    const track = mediaTrack();
    if (!track) {
      body.innerHTML = '<p class="muted">Turn your camera on first.</p>';
      return;
    }
    const { caps, numeric, modes } = cameraSupport();
    const settings = track.getSettings();
    if (numeric.length === 0 && modes.length === 0) {
      body.innerHTML = `${pictureHtml()}
        <h4>Camera hardware</h4>
        <p class="muted small">This browser doesn't let web pages change your webcam's own settings (focus, exposure…). Chrome and Edge on Windows usually do. Otherwise use your camera's app, e.g. Logitech G HUB or Logi Tune, to lock focus.</p>`;
      return;
    }
    const step = (c) => c.step || (c.max - c.min > 20 ? 1 : 0.1);
    body.innerHTML = `${pictureHtml()}
      <h4>Camera hardware</h4>
      <p class="muted small">Tip for cards: set Focus to Manual and adjust Focus distance until text is sharp, so it stops refocusing when hands move.</p>
      ${modes.map(([k, label]) => `<label class="cam-row">${label}
        <select data-cam="${k}">${caps[k].map((m) => `<option value="${esc(m)}" ${settings[k] === m ? 'selected' : ''}>${esc(MODE_LABEL[m] || m)}</option>`).join('')}</select>
      </label>`).join('')}
      ${numeric.map(([k, label]) => {
        const c = caps[k];
        const val = settings[k] ?? c.min;
        return `<label class="cam-row">${label}
          <input type="range" data-cam="${k}" min="${c.min}" max="${c.max}" step="${step(c)}" value="${val}">
          <output>${Math.round(val * 100) / 100}</output>
        </label>`;
      }).join('')}`;
  }

  function wireCameraDialog() {
    const dlg = $('camera-dialog');
    const collect = () => {
      const values = {};
      for (const el of dlg.querySelectorAll('[data-cam]')) values[el.dataset.cam] = el.tagName === 'SELECT' ? el.value : Number(el.value);
      return values;
    };
    dlg.addEventListener('input', async (e) => {
      if (e.target.dataset.pic) {
        e.target.nextElementSibling.textContent = `${e.target.value}%`;
        window.Picture.set(e.target.dataset.pic, e.target.value);
        return;
      }
      const key = e.target.dataset.cam;
      if (!key) return;
      if (e.target.nextElementSibling?.tagName === 'OUTPUT') e.target.nextElementSibling.textContent = String(Math.round(Number(e.target.value) * 100) / 100);
      const value = e.target.tagName === 'SELECT' ? e.target.value : Number(e.target.value);
      // Moving a manual slider switches its mode to manual, like camera apps do.
      const modeFor = { focusDistance: 'focusMode', exposureTime: 'exposureMode', colorTemperature: 'whiteBalanceMode' }[key];
      const extra = {};
      if (modeFor && cameraSupport().caps[modeFor]?.includes('manual')) {
        extra[modeFor] = 'manual';
        const sel = dlg.querySelector(`[data-cam="${modeFor}"]`);
        if (sel) sel.value = 'manual';
      }
      await applyCamera({ ...extra, [key]: value });
      save(cameraKey(), collect());
    });
    // Upside-down camera: rotate what everyone sees (stickers, drawings and card lookup follow along).
    dlg.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-rotate]');
      if (!btn) return;
      const on = Number(window.Picture.get().rotate) !== 180;
      window.Picture.set('rotate', on ? 180 : 0);
      btn.classList.toggle('on', on);
      btn.setAttribute('aria-pressed', String(on));
      btn.textContent = on ? 'On' : 'Off';
    });
    $('camera-reset').addEventListener('click', async () => {
      await window.Picture.reset();
      save(cameraKey(), {});
      const { caps } = cameraSupport();
      const autos = {};
      for (const [k] of CAMERA_MODES) if (caps[k]?.includes('continuous')) autos[k] = 'continuous';
      await applyCamera(autos);
      renderCameraDialog();
    });
    $('camera-close').addEventListener('click', () => dlg.close());
  }

  function init() {
    wireCameraDialog();
    $('cam-settings-btn').addEventListener('click', openCameraDialog);
  }

  return { init, attachTile, setLocalTrack, openCameraDialog };
})();
