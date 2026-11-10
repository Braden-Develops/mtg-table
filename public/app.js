/* MTG Table client: lobby (camera + quality), then a grid of player videos with live stats. */
(() => {
  const LK = window.LivekitClient;
  const { Room, RoomEvent, Track, VideoPresets, ConnectionState } = LK;

  const QUALITY = {
    '1080-5': { width: 1920, height: 1080, fps: 30, bitrate: 5_000_000 },
    '1080-3': { width: 1920, height: 1080, fps: 30, bitrate: 3_000_000 },
    '720-2': { width: 1280, height: 720, fps: 30, bitrate: 2_500_000 },
  };

  const $ = (id) => document.getElementById(id);
  const code = location.pathname.split('/').pop();
  const store = {
    get(key) { try { return localStorage.getItem(key); } catch { return null; } },
    set(key, value) { try { localStorage.setItem(key, value); } catch { /* ignore */ } },
  };

  let previewVideo = null; // LocalVideoTrack shown in the lobby
  let room = null;
  let statsTimer = null;
  const tiles = new Map(); // participant identity -> tile element
  const prevStats = new Map(); // track sid -> { bytes, frames, ts }

  // ---------------- lobby ----------------
  async function init() {
    try {
      const res = await fetch(`/api/invite/${encodeURIComponent(code)}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Invite not valid.');
      $('greeting').textContent = `Joining as ${data.name} · table "${data.room}"`;
    } catch (err) {
      $('greeting').textContent = '';
      return showLobbyError(err.message);
    }

    const savedQuality = store.get('quality');
    if (savedQuality && QUALITY[savedQuality]) $('quality-select').value = savedQuality;

    $('lobby-body').hidden = false;
    await startPreview(store.get('cameraId'));
    await fillDeviceLists();

    $('camera-select').addEventListener('change', async (e) => {
      store.set('cameraId', e.target.value);
      await startPreview(e.target.value);
    });
    $('quality-select').addEventListener('change', async (e) => {
      store.set('quality', e.target.value);
      await startPreview($('camera-select').value);
    });
    $('join-btn').addEventListener('click', join);
  }

  function showLobbyError(message) {
    const el = $('lobby-error');
    el.textContent = message;
    el.hidden = false;
  }

  async function startPreview(deviceId) {
    const q = QUALITY[$('quality-select').value];
    previewVideo?.stop();
    try {
      previewVideo = await LK.createLocalVideoTrack({
        deviceId: deviceId || undefined,
        resolution: { width: q.width, height: q.height, frameRate: q.fps },
      });
    } catch (err) {
      previewVideo = null;
      showLobbyError(`Could not open the camera: ${err.message}. Check that no other app is using it and that the browser has camera permission.`);
      return;
    }
    previewVideo.attach($('preview'));
    const s = previewVideo.mediaStreamTrack.getSettings();
    $('preview-info').textContent = `Camera gives ${s.width}×${s.height} @ ${Math.round(s.frameRate || 0)} fps`;
    $('lobby-error').hidden = true;
  }

  async function fillDeviceLists() {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const fill = (select, kind, savedId, activeId) => {
      select.innerHTML = '';
      for (const d of devices.filter((x) => x.kind === kind)) {
        const opt = new Option(d.label || `${kind} ${select.length + 1}`, d.deviceId);
        select.add(opt);
      }
      const wanted = activeId || savedId;
      if (wanted && [...select.options].some((o) => o.value === wanted)) select.value = wanted;
    };
    const activeCam = previewVideo?.mediaStreamTrack.getSettings().deviceId;
    fill($('camera-select'), 'videoinput', store.get('cameraId'), activeCam);
  }

  // ---------------- join ----------------
  async function join() {
    const btn = $('join-btn');
    btn.disabled = true;
    btn.textContent = 'Joining…';
    try {
      const res = await fetch('/api/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code }),
      });
      const auth = await res.json();
      if (!res.ok) throw new Error(auth.error || 'Could not get a ticket for the table.');

      const q = QUALITY[$('quality-select').value];
      room = new Room({
        // Always receive the sharpest layer so card text stays readable.
        adaptiveStream: false,
        dynacast: true,
      });
      wireRoomEvents();
      window.Identify.setRoom(room);
      window.Tracker.setRoom(room);
      await room.connect(auth.serverUrl, auth.token);

      if (!previewVideo) await startPreview($('camera-select').value);
      if (previewVideo) {
        // Hint to the encoder: keep fine detail (card text) sharp.
        previewVideo.mediaStreamTrack.contentHint = 'detail';
        await room.localParticipant.publishTrack(previewVideo, {
          source: Track.Source.Camera,
          videoCodec: 'vp8',
          videoEncoding: { maxBitrate: q.bitrate, maxFramerate: q.fps },
          simulcast: true,
          videoSimulcastLayers: [VideoPresets.h216, VideoPresets.h540],
          // When bandwidth is short, drop frame rate instead of resolution (keeps text sharp).
          degradationPreference: 'maintain-resolution',
        });
        window.Adjust.setLocalTrack(previewVideo);
      }

      $('lobby').hidden = true;
      $('room').hidden = false;
      $('room-title').textContent = `${auth.name} · table "${auth.room}"`;
      window.Adjust.init();
      window.Game.start(code, auth.name);
      renderAll();
      statsTimer = setInterval(updateStats, 2000);
    } catch (err) {
      console.error(err);
      showLobbyError(err.message || String(err));
      btn.disabled = false;
      btn.textContent = 'Join table';
      await room?.disconnect();
      room = null;
    }
  }

  function wireRoomEvents() {
    room
      .on(RoomEvent.ParticipantConnected, renderAll)
      .on(RoomEvent.ParticipantDisconnected, (p) => removeTile(p.identity))
      .on(RoomEvent.TrackSubscribed, renderAll)
      .on(RoomEvent.TrackUnsubscribed, renderAll)
      .on(RoomEvent.TrackMuted, renderAll)
      .on(RoomEvent.TrackUnmuted, renderAll)
      .on(RoomEvent.LocalTrackPublished, renderAll)
      .on(RoomEvent.DataReceived, (payload, participant, kind, topic) => {
        window.Identify.onData(payload, participant, topic);
        window.Tracker.onData(payload, participant, topic);
      })
      .on(RoomEvent.ActiveSpeakersChanged, (speakers) => {
        const ids = new Set(speakers.map((s) => s.identity));
        for (const [id, tile] of tiles) tile.classList.toggle('speaking', ids.has(id));
      })
      .on(RoomEvent.Disconnected, () => {
        if (room && room.state === ConnectionState.Disconnected) leave(true);
      });
  }

  // ---------------- tiles ----------------
  function ensureTile(participant) {
    let tile = tiles.get(participant.identity);
    if (tile) return tile;
    tile = document.createElement('div');
    tile.className = 'tile';
    tile.innerHTML = '<video autoplay playsinline></video><div class="no-video" hidden>Camera off</div><div class="overlay-stats"></div><div class="label"></div>';
    tile.querySelector('video').muted = participant.isLocal;
    tile.dataset.identity = participant.identity;
    tile.dataset.local = participant.isLocal ? '1' : '';
    tile.addEventListener('click', () => {
      const wasFocused = tile.classList.contains('focused');
      for (const t of tiles.values()) t.classList.remove('focused');
      if (!wasFocused) tile.classList.add('focused');
    });
    tile.addEventListener('dblclick', () => {
      if (document.fullscreenElement) document.exitFullscreen();
      else tile.requestFullscreen?.();
    });
    tiles.set(participant.identity, tile);
    $('grid').appendChild(tile);
    window.Game.attachTile(tile, participant.name || participant.identity);
    window.Adjust.attachTile(tile, participant.name || participant.identity, participant.isLocal);
    return tile;
  }

  function removeTile(identity) {
    const tile = tiles.get(identity);
    if (tile) window.Game.detachTile(tile);
    tile?.remove();
    tiles.delete(identity);
  }

  function renderParticipant(participant) {
    const tile = ensureTile(participant);
    tile.querySelector('.label').textContent = participant.isLocal ? `${participant.name || 'You'} (you)` : (participant.name || participant.identity);
    const video = tile.querySelector('video');
    const camPub = participant.getTrackPublication(Track.Source.Camera);
    const camTrack = camPub?.track;
    const hasVideo = camTrack && !camPub.isMuted;
    if (hasVideo && video.srcObject?.getVideoTracks()[0] !== camTrack.mediaStreamTrack) camTrack.attach(video);
    tile.querySelector('.no-video').hidden = !!hasVideo;
    video.hidden = !hasVideo;

    if (!participant.isLocal) {
      const micTrack = participant.getTrackPublication(Track.Source.Microphone)?.track;
      if (micTrack && !tile.querySelector('audio')) {
        const audio = micTrack.attach();
        audio.hidden = true;
        tile.appendChild(audio);
      }
    }
  }

  function renderAll() {
    if (!room) return;
    renderParticipant(room.localParticipant);
    for (const p of room.remoteParticipants.values()) renderParticipant(p);
  }

  // ---------------- stats ----------------
  const mbps = (bitsPerSec) => (bitsPerSec / 1e6).toFixed(1);

  function rate(key, bytes, frames, ts) {
    const prev = prevStats.get(key);
    prevStats.set(key, { bytes, frames, ts });
    if (!prev || ts <= prev.ts) return null;
    const secs = (ts - prev.ts) / 1000;
    return { bps: ((bytes - prev.bytes) * 8) / secs, fps: (frames - prev.frames) / secs };
  }

  let reportTick = 0;
  function reportStats(report) {
    // Every ~6 s, share the numbers with the host's server log.
    if (++reportTick % 3 !== 0) return;
    fetch('/api/stats', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, report }),
    }).catch(() => {});
  }

  async function updateStats() {
    if (!room) return;
    const report = { identity: room.localParticipant.identity, ua: navigator.userAgent.slice(0, 120), sending: null, receiving: [] };
    // What you send
    const localPub = room.localParticipant.getTrackPublication(Track.Source.Camera);
    const localTile = tiles.get(room.localParticipant.identity);
    if (localPub?.track && localTile) {
      try {
        const layers = await localPub.track.getSenderStats();
        const top = layers.reduce((a, b) => ((b.frameWidth || 0) > (a?.frameWidth || 0) ? b : a), null);
        const totalBytes = layers.reduce((s, l) => s + (l.bytesSent || 0), 0);
        const r = rate('local', totalBytes, top?.framesSent || 0, Date.now());
        const limit = top?.qualityLimitationReason && top.qualityLimitationReason !== 'none' ? ` · limited by ${top.qualityLimitationReason}` : '';
        localTile.querySelector('.overlay-stats').textContent = top
          ? `Sending ${top.frameWidth}×${top.frameHeight} · ${Math.round(top.framesPerSecond || r?.fps || 0)} fps · ${r ? mbps(r.bps) : '…'} Mbps total${limit}`
          : '';
        if (top) {
          report.sending = {
            width: top.frameWidth,
            height: top.frameHeight,
            fps: Math.round(top.framesPerSecond || r?.fps || 0),
            mbps: r ? +mbps(r.bps) : null,
            limitedBy: top.qualityLimitationReason || 'none',
            layers: layers.map((l) => `${l.rid}:${l.frameWidth || 0}x${l.frameHeight || 0}`).join(' '),
            camera: localPub.track.mediaStreamTrack.getSettings().width + 'x' + localPub.track.mediaStreamTrack.getSettings().height,
          };
        }
      } catch { /* stats are best-effort */ }
    }
    // What you receive from each player
    for (const p of room.remoteParticipants.values()) {
      const pub = p.getTrackPublication(Track.Source.Camera);
      const tile = tiles.get(p.identity);
      if (!pub?.track || !tile) continue;
      try {
        const s = await pub.track.getReceiverStats();
        if (!s) continue;
        const r = rate(pub.trackSid, s.bytesReceived || 0, s.framesDecoded || 0, Date.now());
        tile.querySelector('.overlay-stats').textContent =
          `Receiving ${s.frameWidth || '?'}×${s.frameHeight || '?'} · ${r ? Math.round(r.fps) : '…'} fps · ${r ? mbps(r.bps) : '…'} Mbps · lost ${s.packetsLost || 0} pkts`;
        report.receiving.push({
          from: p.name || p.identity,
          width: s.frameWidth,
          height: s.frameHeight,
          fps: r ? Math.round(r.fps) : null,
          mbps: r ? +mbps(r.bps) : null,
          lost: s.packetsLost || 0,
          decoder: s.decoderImplementation,
        });
      } catch { /* stats are best-effort */ }
    }
    reportStats(report);
  }

  // ---------------- toolbar ----------------
  $('cam-btn').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    const pub = room?.localParticipant.getTrackPublication(Track.Source.Camera);
    if (!pub?.track) return;
    if (pub.isMuted) await pub.track.unmute();
    else await pub.track.mute();
    btn.classList.toggle('off', pub.isMuted);
    btn.title = pub.isMuted ? 'Turn your camera on' : 'Turn your camera off';
    renderAll();
  });

  $('stats-btn').addEventListener('click', (e) => {
    const hidden = document.body.classList.toggle('hide-stats');
    e.target.textContent = hidden ? 'Show stats' : 'Hide stats';
  });

  $('leave-btn').addEventListener('click', () => leave(false));

  async function leave(fromServer) {
    clearInterval(statsTimer);
    const r = room;
    room = null;
    if (!fromServer) await r?.disconnect();
    previewVideo?.stop();
    location.reload();
  }

  window.addEventListener('beforeunload', () => room?.disconnect());

  init();
})();
