/* Picture processor for your own camera: brightness, contrast, saturation and sharpening, done on the
   GPU (WebGL) before the video is sent, so everyone sees the adjusted picture. Works in every browser.
   Plugs into LiveKit's track processor API. Only runs while some setting differs from default. */
window.Picture = (() => {
  const DEFAULTS = { brightness: 100, contrast: 100, saturation: 100, sharpen: 0 };

  const VERTEX = `
    attribute vec2 p;
    varying vec2 v;
    void main() { v = vec2(p.x * 0.5 + 0.5, 0.5 - p.y * 0.5); gl_Position = vec4(p, 0.0, 1.0); }`;
  const FRAGMENT = `
    precision mediump float;
    uniform sampler2D tex;
    uniform vec2 px;
    uniform float bright, contrast, sat, sharp;
    varying vec2 v;
    void main() {
      vec3 c = texture2D(tex, v).rgb;
      if (sharp > 0.0) {
        vec3 n = texture2D(tex, v + vec2(px.x, 0.0)).rgb + texture2D(tex, v - vec2(px.x, 0.0)).rgb
               + texture2D(tex, v + vec2(0.0, px.y)).rgb + texture2D(tex, v - vec2(0.0, px.y)).rgb;
        c += sharp * (4.0 * c - n);
      }
      c *= bright;
      c = (c - 0.5) * contrast + 0.5;
      float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
      c = mix(vec3(l), c, sat);
      gl_FragColor = vec4(clamp(c, 0.0, 1.0), 1.0);
    }`;

  // A worker drives the frame clock: page timers get throttled when the tab is in the background,
  // which would freeze your video for everyone if you switch tabs.
  function makeTicker(fps, onTick) {
    const src = 'let t; onmessage = (e) => { clearInterval(t); if (e.data > 0) t = setInterval(() => postMessage(0), e.data); };';
    const worker = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
    worker.onmessage = onTick;
    worker.postMessage(Math.round(1000 / fps));
    return () => worker.terminate();
  }

  function createProcessor(getParams) {
    let video = null;
    let canvas = null;
    let gl = null;
    let uni = null;
    let stopTicker = null;

    function compile(type, source) {
      const sh = gl.createShader(type);
      gl.shaderSource(sh, source);
      gl.compileShader(sh);
      if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(sh));
      return sh;
    }

    function draw() {
      if (!video || video.readyState < 2) return;
      const w = video.videoWidth;
      const h = video.videoHeight;
      if (!w || !h) return;
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
        gl.viewport(0, 0, w, h);
      }
      const p = getParams();
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, video);
      gl.uniform2f(uni.px, 1 / w, 1 / h);
      gl.uniform1f(uni.bright, p.brightness / 100);
      gl.uniform1f(uni.contrast, p.contrast / 100);
      gl.uniform1f(uni.sat, p.saturation / 100);
      gl.uniform1f(uni.sharp, p.sharpen / 100);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }

    async function setup(track) {
      video = document.createElement('video');
      video.muted = true;
      video.playsInline = true;
      video.srcObject = new MediaStream([track]);
      await video.play().catch(() => {});
      const s = track.getSettings();
      canvas = document.createElement('canvas');
      canvas.width = s.width || 1280;
      canvas.height = s.height || 720;
      gl = canvas.getContext('webgl', { premultipliedAlpha: false, antialias: false });
      if (!gl) throw new Error('WebGL is not available in this browser');
      const prog = gl.createProgram();
      gl.attachShader(prog, compile(gl.VERTEX_SHADER, VERTEX));
      gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, FRAGMENT));
      gl.linkProgram(prog);
      gl.useProgram(prog);
      const buf = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
      const loc = gl.getAttribLocation(prog, 'p');
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
      gl.bindTexture(gl.TEXTURE_2D, gl.createTexture());
      for (const [k, v] of [[gl.TEXTURE_MIN_FILTER, gl.LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR],
        [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]]) gl.texParameteri(gl.TEXTURE_2D, k, v);
      uni = Object.fromEntries(['px', 'bright', 'contrast', 'sat', 'sharp'].map((n) => [n, gl.getUniformLocation(prog, n)]));
      gl.viewport(0, 0, canvas.width, canvas.height);

      const fps = s.frameRate || 30;
      const out = canvas.captureStream(fps).getVideoTracks()[0];
      out.contentHint = 'detail'; // tell the encoder sharp text matters more than smooth motion
      processor.processedTrack = out;
      stopTicker = makeTicker(fps, draw);
    }

    function teardown() {
      stopTicker?.();
      stopTicker = null;
      processor.processedTrack?.stop();
      processor.processedTrack = undefined;
      if (video) video.srcObject = null;
      video = null;
      gl?.getExtension('WEBGL_lose_context')?.loseContext();
      gl = null;
      canvas = null;
    }

    const processor = {
      name: 'mtg-picture',
      processedTrack: undefined,
      async init(opts) { await setup(opts.track); },
      async restart(opts) { teardown(); await setup(opts.track); },
      async destroy() { teardown(); },
    };
    return processor;
  }

  // ---------- state ----------
  let localTrack = null;
  let params = { ...DEFAULTS };
  let active = false;
  let busy = Promise.resolve();

  try { params = { ...DEFAULTS, ...(JSON.parse(localStorage.getItem('picture')) || {}) }; } catch { /* ignore */ }
  const isDefault = () => Object.keys(DEFAULTS).every((k) => Number(params[k]) === DEFAULTS[k]);

  // Turn the processor on or off as needed. Serialized so quick slider moves don't overlap.
  function sync() {
    busy = busy.then(async () => {
      if (!localTrack) return;
      const want = !isDefault();
      try {
        if (want && !active) {
          await localTrack.setProcessor(createProcessor(() => params), true);
          active = true;
        } else if (!want && active) {
          await localTrack.stopProcessor();
          active = false;
        }
      } catch (err) {
        console.warn('Picture adjustments unavailable', err);
        active = false;
      }
    });
    return busy;
  }

  function setTrack(track) {
    localTrack = track;
    active = false;
    return sync();
  }

  function set(key, value) {
    params[key] = Number(value);
    try { localStorage.setItem('picture', JSON.stringify(params)); } catch { /* ignore */ }
    sync(); // values are read every frame, so no restart is needed while it's running
  }

  function reset() {
    params = { ...DEFAULTS };
    try { localStorage.setItem('picture', JSON.stringify(params)); } catch { /* ignore */ }
    return sync();
  }

  return { setTrack, set, reset, get: () => ({ ...params }), DEFAULTS };
})();
