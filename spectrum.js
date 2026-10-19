/**
 * YouTube Studio – Spectrum Analyzer
 * Log-frequency spectrum centred in the player's bottom control bar.
 * Visible only while normalization is bypassed (+dB mode in inject.js).
 *  - Averaging:  time-based, power domain (like Voxengo SPAN "Avg Time")
 *  - Peak hold:  then the peak line falls
 *  - Hover:      level | frequency | note ± cents
 * All tunable values come from the options page (settings-schema.js + bridge.js).
 */
(() => {
  'use strict';

  if (window.__ytsSpectrum) return; // guard against double injection
  window.__ytsSpectrum = true;

  const settings = window.__ytsSettings;
  if (!settings) {
    console.warn('[YouTube Studio] settings-schema.js must load before spectrum.js');
    return;
  }
  const { DEFAULTS, EVENTS, PALETTE, clamp, formatHz, sanitize, createAxis } = settings;

  const CLASS = 'yts-spectrum';
  const FALLBACK_RATE = 48_000;
  const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

  /** Live settings. Replaced as a whole (never mutated) when the options page saves. */
  let config = DEFAULTS;
  let axis = createAxis(config);
  let dbRange = config.maxDb - config.minDb;

  /** Set by inject.js; anything but "off" counts as bypass enabled. */
  const isEnabled = () => document.documentElement.dataset.ytnd !== 'off';

  // ---------- Helpers ----------

  const dbToPower = (db) => 10 ** (db / 10); // -Infinity → 0

  const noteOf = (hz) => {
    const midi = 69 + 12 * Math.log2(hz / 440);
    const n = Math.round(midi);
    const cents = Math.round((midi - n) * 100);
    const name = `${NOTE_NAMES[((n % 12) + 12) % 12]}${Math.floor(n / 12) - 1}`;
    return `${name} ${cents < 0 ? '−' : '+'} ${Math.abs(cents)} Cents`;
  };

  /** One band per pixel column (spaced by the frequency axis), mapped to FFT bins. */
  const buildColumns = (width, sampleRate) => {
    const binHz = sampleRate / config.fftSize;
    const maxBin = config.fftSize / 2 - 1;

    return Array.from({ length: width }, (_, x) => {
      const f1 = axis.xToHz(x, width);
      const f2 = axis.xToHz(x + 1, width);
      const hz = Math.sqrt(f1 * f2);
      return {
        hz,
        lo: Math.ceil(f1 / binHz),
        hi: Math.min(Math.floor(f2 / binHz), maxBin),
        k: Math.min(hz / binHz, maxBin - 1),
        tiltDb: config.slopeDbPerOct * Math.log2(hz / 1000),
      };
    });
  };

  /** Mean power of a column; interpolates when it is narrower than one bin. */
  const columnPower = (spectrum, { lo, hi, k }) => {
    if (hi >= lo) {
      let sum = 0;
      for (let b = lo; b <= hi; b++) sum += dbToPower(spectrum[b]);
      return sum / (hi - lo + 1);
    }
    const b0 = Math.floor(k);
    const t = k - b0;
    return dbToPower(spectrum[b0]) * (1 - t) + dbToPower(spectrum[b0 + 1]) * t;
  };

  // ---------- Audio graph ----------

  let audioCtx = null;
  /** video → tap, or null if capture failed (don't retry). */
  const taps = new WeakMap();

  // A context created without a user gesture starts suspended, and a captured
  // <video> would then go silent. Wait for activation instead.
  const hasActivation = () => navigator.userActivation?.hasBeenActive ?? true;

  const resumeContext = () => {
    if (audioCtx?.state === 'suspended') audioCtx.resume().catch(() => {});
  };

  const getTap = (video) => {
    if (taps.has(video)) return taps.get(video);
    if (!hasActivation()) return null;

    audioCtx ??= new AudioContext({ latencyHint: 'playback' });
    resumeContext();

    try {
      const source = audioCtx.createMediaElementSource(video);
      const analyser = new AnalyserNode(audioCtx, {
        fftSize: config.fftSize,
        smoothingTimeConstant: 0, // averaged ourselves, time-based
      });
      source.connect(audioCtx.destination); // keep the audio audible
      source.connect(analyser);

      const tap = { analyser, spectrum: new Float32Array(analyser.frequencyBinCount) };
      taps.set(video, tap);
      return tap;
    } catch (error) {
      // e.g. another extension already captured this element
      console.warn('[YouTube Studio] spectrum unavailable:', error);
      taps.set(video, null);
      return null;
    }
  };

  /** Applies a changed FFT size to an existing analyser. */
  const syncTap = (tap) => {
    if (tap.analyser.fftSize === config.fftSize) return;
    tap.analyser.fftSize = config.fftSize;
    tap.spectrum = new Float32Array(tap.analyser.frequencyBinCount);
  };

  // ---------- Views ----------

  /** controls element → view */
  const views = new Map();
  const resizeObserver = new ResizeObserver(() => schedule());

  const createView = (controls, video) => {
    const wrapper = document.createElement('div');
    wrapper.className = CLASS;
    wrapper.hidden = true;
    const canvas = document.createElement('canvas');
    wrapper.append(canvas);
    controls.append(wrapper);

    const view = {
      controls,
      wrapper,
      canvas,
      g: canvas.getContext('2d'),
      video,
      width: 0,
      dpr: 0,
      hoverX: null,
    };

    wrapper.addEventListener('pointermove', (event) => {
      view.hoverX = event.offsetX;
      startLoop();
    });
    wrapper.addEventListener('pointerleave', () => {
      view.hoverX = null;
      startLoop();
    });

    resizeObserver.observe(controls);
    return view;
  };

  /** Resets columns and averaging buffers. */
  const rebuild = (view) => {
    const n = view.width;
    view.sampleRate = audioCtx?.sampleRate ?? FALLBACK_RATE;
    view.fftSize = config.fftSize;
    view.columns = buildColumns(n, view.sampleRate);
    view.power = new Float64Array(n);
    view.db = new Float32Array(n).fill(-Infinity);
    view.peak = new Float32Array(n).fill(-Infinity);
    view.peakAt = new Float64Array(n);
    view.last = performance.now();
  };

  const resize = (view, width) => {
    const dpr = window.devicePixelRatio || 1;
    const height = config.height;
    view.width = width;
    view.dpr = dpr;
    view.wrapper.style.width = `${width}px`;
    view.wrapper.style.height = `${height}px`;
    view.canvas.width = Math.round(width * dpr);
    view.canvas.height = Math.round(height * dpr);
    view.g.setTransform(dpr, 0, 0, dpr, 0, 0);

    const shade = view.g.createLinearGradient(0, 0, 0, height);
    shade.addColorStop(0, 'rgba(0, 0, 0, 0)');
    shade.addColorStop(1, 'rgba(0, 0, 0, 0.45)');
    view.shade = shade;

    rebuild(view);
  };

  /** Outer edge of the visible children of a control group. */
  const edgeOf = (group, side) => {
    let edge = side === 'right' ? -Infinity : Infinity;
    for (const child of group?.children ?? []) {
      if (child.classList.contains(CLASS)) continue;
      const rect = child.getBoundingClientRect();
      if (!rect.width) continue;
      edge = side === 'right' ? Math.max(edge, rect.right) : Math.min(edge, rect.left);
    }
    return edge;
  };

  /** Centres the view in the bar without overlapping the left/right controls. */
  const layout = (view) => {
    const bar = view.controls.getBoundingClientRect();
    if (!bar.width) return;

    const leftEdge = Math.max(edgeOf(view.controls.querySelector('.ytp-left-controls'), 'right') - bar.left, 0);
    const rightEdge = Math.min(edgeOf(view.controls.querySelector('.ytp-right-controls'), 'left') - bar.left, bar.width);
    const pad = config.sidePadding;
    const width = Math.floor(Math.min(config.maxWidth, rightEdge - leftEdge - pad * 2));

    if (width < config.minWidth) {
      view.wrapper.hidden = true;
      return;
    }

    const x = clamp((bar.width - width) / 2, leftEdge + pad, rightEdge - pad - width);
    view.wrapper.hidden = false;
    view.wrapper.style.left = `${Math.round(x)}px`;
    if (width !== view.width || (window.devicePixelRatio || 1) !== view.dpr) resize(view, width);
  };

  // ---------- Analysis ----------

  /** Advances averaging + peak hold. Returns true while anything is visible. */
  const update = (view, tap, now) => {
    if (tap) syncTap(tap);
    if (tap && (view.sampleRate !== audioCtx.sampleRate || view.fftSize !== config.fftSize)) rebuild(view);

    // rAF's timestamp is the frame start and can be earlier than the
    // performance.now() stored by rebuild() → negative dt → NaN. Clamp it.
    const dt = clamp(now - view.last, 0, 1000);
    view.last = now;
    const alpha = 1 - Math.exp(-dt / config.avgTimeMs);

    const volume = view.video.volume;
    const offsetDb = config.compensateVolume && volume > 0 ? -20 * Math.log10(volume) : 0;

    if (tap) tap.analyser.getFloatFrequencyData(tap.spectrum);

    const { columns, power, db, peak, peakAt } = view;
    let alive = !view.video.paused;

    for (let x = 0; x < view.width; x++) {
      const column = columns[x];
      const p = tap ? columnPower(tap.spectrum, column) : 0;
      power[x] += (p - power[x]) * alpha;
      if (!(power[x] >= 0)) power[x] = 0; // never let NaN/negative values persist

      const level = 10 * Math.log10(power[x]) + column.tiltDb + offsetDb;
      db[x] = level;

      if (level >= peak[x]) {
        peak[x] = level;
        peakAt[x] = now;
      } else if (now - peakAt[x] > config.peakHoldMs) {
        peak[x] = Math.max(level, peak[x] - (config.peakFallDbPerSec * dt) / 1000);
      }
      if (peak[x] > config.minDb) alive = true;
    }
    return alive;
  };

  // ---------- Drawing ----------

  const toY = (db) => config.height * (1 - clamp((db - config.minDb) / dbRange, 0, 1));

  const strokeCurve = (g, values, style) => {
    g.beginPath();
    let penDown = false;
    for (let x = 0; x < values.length; x++) {
      const v = values[x];
      if (!(v > config.minDb)) {
        penDown = false;
        continue;
      }
      if (penDown) g.lineTo(x + 0.5, toY(v));
      else g.moveTo(x + 0.5, toY(v));
      penDown = true;
    }
    g.strokeStyle = style;
    g.lineWidth = 1;
    g.stroke();
  };

  const drawTooltip = (view) => {
    const { g, width: w, db, columns } = view;
    const h = config.height;
    const x = Math.floor(view.hoverX);
    if (x < 0 || x >= w) return;

    const { hz } = columns[x];
    const level = Number.isFinite(db[x]) ? `${db[x].toFixed(2)}dB` : '−∞dB';
    const text = `${level} | ${formatHz(hz, 2)} | ${noteOf(hz)}`;

    g.fillStyle = 'rgba(255, 255, 255, 0.6)';
    g.fillRect(x, 0, 1, h);

    g.font = '10px Roboto, Arial, sans-serif';
    g.textBaseline = 'middle';
    const boxW = g.measureText(text).width + 8;
    const preferred = x + 6 + boxW > w ? x - 6 - boxW : x + 6;
    const bx = Math.max(2, Math.min(preferred, w - boxW - 2));

    g.fillStyle = 'rgba(20, 20, 24, 0.85)';
    g.fillRect(bx, 2, boxW, 14);
    g.fillStyle = '#fff';
    g.fillText(text, bx + 4, 9);
  };

  const draw = (view) => {
    const { g, width: w, db, peak } = view;
    const h = config.height;

    g.globalCompositeOperation = 'source-over';
    g.clearRect(0, 0, w, h);

    // Filled spectrum, coloured per column by level
    for (let x = 0; x < w; x++) {
      const t = (db[x] - config.minDb) / dbRange;
      if (!(t > 0)) continue;
      const y = h * (1 - Math.min(t, 1));
      g.fillStyle = PALETTE[Math.min(255, Math.round(t * 255))];
      g.fillRect(x, y, 1, h - y);
    }

    // Darken towards the bottom, then put the background behind everything
    g.globalCompositeOperation = 'source-atop';
    g.fillStyle = view.shade;
    g.fillRect(0, 0, w, h);
    g.globalCompositeOperation = 'destination-over';
    g.fillStyle = 'rgba(0, 0, 0, 0.45)';
    g.fillRect(0, 0, w, h);
    g.globalCompositeOperation = 'source-over';

    // Frequency grid
    g.font = '9px Roboto, Arial, sans-serif';
    g.textBaseline = 'top';
    for (const hz of config.gridHz) {
      const x = Math.round(axis.hzToX(hz, w));
      g.fillStyle = 'rgba(255, 255, 255, 0.14)';
      g.fillRect(x, 0, 1, h);
      const label = formatHz(hz, 0);
      const labelW = g.measureText(label).width;
      g.fillStyle = 'rgba(255, 255, 255, 0.45)';
      g.fillText(label, x + 3 + labelW > w ? x - 3 - labelW : x + 3, 2); // flip at the right edge
    }

    strokeCurve(g, peak, 'rgba(214, 190, 255, 0.55)'); // peak hold
    strokeCurve(g, db, 'rgba(255, 255, 255, 0.9)'); // averaged outline

    if (view.hoverX !== null) drawTooltip(view);
  };

  // ---------- Render loop (runs only while something is visible) ----------

  let rafId = 0;

  const frame = (now) => {
    rafId = 0;
    if (!isEnabled()) return;

    let alive = false;
    for (const [controls, view] of views) {
      if (!view.wrapper.isConnected) {
        views.delete(controls);
        resizeObserver.unobserve(controls);
        continue;
      }
      if (view.wrapper.hidden || !view.width) continue;

      const active = update(view, taps.get(view.video) ?? null, now);
      if (active || view.hoverX !== null) alive = true;
      draw(view);
    }
    if (alive) startLoop();
  };

  function startLoop() {
    rafId ||= requestAnimationFrame(frame);
  }

  // ---------- Mounting ----------

  const ensureViews = () => {
    const enabled = isEnabled();

    for (const player of document.querySelectorAll('.html5-video-player')) {
      const controls = player.querySelector('.ytp-chrome-controls');
      const video = player.querySelector('video');
      if (!controls || !video) continue;

      let view = views.get(controls);
      if (!view?.wrapper.isConnected) {
        view = createView(controls, video);
        views.set(controls, view);
      }
      if (view.video !== video) {
        view.video = video;
        if (view.width) rebuild(view);
      }

      if (!enabled) continue; // CSS hides it; skip layout and audio capture
      layout(view);
      if (!video.paused) getTap(video);
    }

    if (enabled && views.size) startLoop();
  };

  let scheduled = false;
  function schedule() {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      ensureViews();
    });
  }

  // ---------- Settings ----------

  const applySettings = (raw) => {
    config = sanitize(raw);
    axis = createAxis(config);
    dbRange = config.maxDb - config.minDb;
    for (const view of views.values()) view.dpr = 0; // forces resize() + rebuild() on next layout
    schedule();
  };

  window.addEventListener(EVENTS.apply, (event) => {
    if (typeof event.detail !== 'string') return;
    try {
      applySettings(JSON.parse(event.detail));
    } catch {
      /* malformed payload: keep current settings */
    }
  });

  // ---------- Events ----------

  // Normalization toggled in inject.js → start fresh.
  window.addEventListener('ytnd:change', () => {
    for (const view of views.values()) if (view.width) rebuild(view);
    schedule();
  });

  // 'play' doesn't bubble → capture phase.
  document.addEventListener('play', schedule, true);

  // New clip/song: YouTube reuses the same <video>, so watch for a new source instead.
  document.addEventListener(
    'loadstart',
    (event) => {
      for (const view of views.values()) {
        if (view.video === event.target && view.width) rebuild(view);
      }
      startLoop(); // draw one frame so the old graph is cleared even while paused
    },
    true,
  );

  // First gesture: create/resume the AudioContext.
  for (const type of ['pointerdown', 'keydown']) {
    window.addEventListener(
      type,
      () => {
        resumeContext();
        schedule();
      },
      { capture: true, passive: true },
    );
  }

  // SPA: the player gets rebuilt on navigation, Shorts, miniplayer.
  new MutationObserver(schedule).observe(document.documentElement, {
    childList: true,
    subtree: true,
  });

  // Ask bridge.js for the saved settings (it may have sent them before we listened).
  window.dispatchEvent(new CustomEvent(EVENTS.request));
})();
