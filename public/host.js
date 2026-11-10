/* Host page: log in, make invite links, see who's online, revoke links, close tables. */
(() => {
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  let state = null;
  let timer = null;

  async function api(path, body) {
    const res = await fetch(path, body === undefined
      ? { credentials: 'same-origin' }
      : { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (res.status === 204) return null;
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(data.error || `Request failed (${res.status})`);
      err.status = res.status;
      throw err;
    }
    return data;
  }

  function show(which) {
    $('login').hidden = which !== 'login';
    $('dash').hidden = which !== 'dash';
  }

  async function refresh() {
    try {
      state = await api('/api/host/state');
    } catch (err) {
      if (err.status === 401) {
        clearInterval(timer);
        show('login');
        $('password').focus();
      }
      return;
    }
    show('dash');
    render();
  }

  // ---------- rendering ----------
  const day = (iso) => new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  function expiry(inv) {
    if (inv.status === 'revoked') return 'Revoked';
    if (inv.status === 'expired') return `Expired ${day(inv.expiresAt)}`;
    return inv.expiresAt ? `Works until ${day(inv.expiresAt)}` : 'Works until revoked';
  }

  function render() {
    const showOld = $('show-old').checked;
    const online = state.tables.reduce((n, t) => n + t.online, 0);
    $('summary').textContent = state.videoServer
      ? `${online} player${online === 1 ? '' : 's'} online · up to ${state.maxPlayers} per table`
      : 'The video server is not running, so nobody can be online.';
    $('room-list').innerHTML = state.tables.map((t) => `<option value="${esc(t.room)}">`).join('');

    const tables = state.tables
      .map((t) => ({ ...t, shown: t.invites.filter((i) => showOld || i.status === 'active') }))
      .filter((t) => t.shown.length || t.online);
    if (!tables.length) {
      $('tables').innerHTML = '<p class="muted host-empty">No tables yet. Make an invite above; the table is created with it.</p>';
      return;
    }
    $('tables').innerHTML = tables.map((t) => `
      <section class="host-card" data-room="${esc(t.room)}">
        <div class="host-table-head">
          <div>
            <h2>${esc(t.room)}</h2>
            <p class="muted small">${t.online ? `<span class="dot on"></span>${t.online} online` : 'Nobody online'}</p>
          </div>
          <button class="ghost danger-text" data-act="close" data-room="${esc(t.room)}">Close table</button>
        </div>
        <ul class="host-invites">
          ${t.shown.map((i) => `
            <li class="${i.status}">
              <div class="who">
                <span class="dot ${i.online ? 'on' : ''}" title="${i.online ? 'Online' : 'Offline'}"></span>
                <strong>${esc(i.name)}</strong>
                <span class="muted small">${expiry(i)}</span>
              </div>
              <div class="acts">
                ${i.status === 'active'
                  ? `<button class="chip" data-act="copy" data-url="${esc(i.url)}">Copy link</button>
                     <button class="chip" data-act="revoke" data-code="${esc(i.code)}">Revoke</button>`
                  : `<button class="chip" data-act="remove" data-code="${esc(i.code)}">Remove</button>`}
              </div>
            </li>`).join('')}
        </ul>
      </section>`).join('');
  }

  // ---------- actions ----------
  async function copy(text, btn) {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      prompt('Copy this link:', text);
      return;
    }
    const was = btn.textContent;
    btn.textContent = 'Copied';
    setTimeout(() => { btn.textContent = was; }, 1500);
  }

  // Destructive buttons ask once more on the button itself instead of a popup.
  function armed(btn, label) {
    if (btn.dataset.armed) return true;
    btn.dataset.armed = '1';
    const was = btn.textContent;
    btn.textContent = label;
    btn.classList.add('danger');
    setTimeout(() => {
      delete btn.dataset.armed;
      btn.textContent = was;
      btn.classList.remove('danger');
    }, 3000);
    return false;
  }

  $('tables').addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-act]');
    if (!btn) return;
    const { act } = btn.dataset;
    try {
      if (act === 'copy') return copy(btn.dataset.url, btn);
      if (act === 'revoke') {
        if (!armed(btn, 'Sure? Kicks them')) return;
        await api('/api/host/revoke', { code: btn.dataset.code });
      } else if (act === 'remove') {
        await api('/api/host/remove', { code: btn.dataset.code });
      } else if (act === 'close') {
        if (!armed(btn, 'Sure? Revokes all links')) return;
        await api('/api/host/close', { room: btn.dataset.room });
      }
      refresh();
    } catch (err) {
      alert(err.message);
    }
  });

  $('invite-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    $('invite-error').hidden = true;
    try {
      const { url } = await api('/api/host/invite', {
        name: $('inv-name').value.trim(),
        room: $('inv-room').value.trim(),
        days: Number($('inv-days').value),
      });
      $('new-url').value = url;
      $('new-link').hidden = false;
      $('inv-name').value = '';
      $('inv-name').focus();
      refresh();
    } catch (err) {
      $('invite-error').textContent = err.message;
      $('invite-error').hidden = false;
    }
  });
  $('copy-new').addEventListener('click', (e) => copy($('new-url').value, e.currentTarget));
  $('show-old').addEventListener('change', () => state && render());

  $('login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    $('login-error').hidden = true;
    try {
      await api('/api/host/login', { password: $('password').value });
      $('password').value = '';
      start();
    } catch (err) {
      $('login-error').textContent = err.message;
      $('login-error').hidden = false;
    }
  });
  $('logout').addEventListener('click', async () => {
    await api('/api/host/logout', {}).catch(() => {});
    clearInterval(timer);
    show('login');
  });

  function start() {
    refresh();
    clearInterval(timer);
    timer = setInterval(() => { if (!document.hidden) refresh(); }, 10_000);
  }
  start();
})();
