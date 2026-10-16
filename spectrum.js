/**
 * YouTube Studio – Mini Spectrum Analyzer
 * Log-frequency spectrum placed right after the play/pause button.
 *  - Averaging time: 1000 ms (power domain, like Voxengo SPAN "Avg Time")
 *  - Peak hold:      2000 ms, then the peak falls
 */
(() => {
  'use strict';

  if (window.__ytsSpectrum) return; // guard against double injection
  window.__ytsSpectrum = true;

  const CONFIG = Object.freeze({
    width: 200, // CSS px
    height: 30,
    bars: 200,
    minHz: 20,
    maxHz: 20_000,
    minDb: -90,
    maxDb: -10,
    avgTimeMs: 100,
    peakHoldMs: 500,
    peakFallDbPerSec: 24,
    slopeDbPerOct: 4.5, // tilt around 1 kHz (0 = flat, 4.5 = SPAN default)
    fftSize: 8192, // ~5.9 Hz/bin @ 48 kHz → usable low end
    compensateVolume: true, // show source level regardless of the slider
  });

  const CLASS = 'yts-spectrum';

  // ---------- DSP helpers ----------

  const dbToPower = (db) => 10 ** (db / 10); // -Infinity → 0

  /** Log-spaced bands mapped to FFT bins. */
  const buildBands = (sampleRate) => {
    const binHz = sampleRate / CONFIG.fftSize;
    const maxBin = CONFIG.fftSize / 2 - 1;
    const ratio = CONFIG.maxHz / CONFIG.minHz;

    return Array.from({ length: CONFIG.bars }, (_, i) => {
      const f1 = CONFIG.minHz * ratio ** (i / CONFIG.bars);
      const f2 = CONFIG.minHz * ratio ** ((i + 1) / CONFIG.bars);
      const center = Math.sqrt(f1 * f2);
      return {
        lo: Math.ceil(f1 / binHz),
        hi: Math.min(Math.floor(f2 / binHz), maxBin),
        k: Math.min(center / binHz, maxBin - 1),
        tiltDb: CONFIG.slopeDbPerOct * Math.log2(center / 1000),
      };
    });
  };

  /** Mean power of a band; interpolates when the band is narrower than one bin. */
  const bandPower = (spectrum, { lo, hi, k }) => {
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

  // Creating a context without a user gesture leaves it suspended, and a
  // captured <video> would then go silent. Wait for activation instead.
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
        fftSize: CONFIG.fftSize,
        smoothingTimeConstant: 0, // we average ourselves, time-based
      });
      source.connect(audioCtx.destination); // keep the audio audible
      source.connect(analyser);

      const tap = {
        analyser,
        spectrum: new Float32Array(analyser.frequencyBinCount),
        bands: buildBands(audioCtx.sampleRate),
      };
      taps.set(video, tap);
      return tap;
    } catch (error) {
      // e.g. another extension already captured this element
      console.warn('[YouTube Studio] spectrum unavailable:', error);
      taps.set(video, null);
      return null;
    }
  };

  // ---------- Per-view state ----------

  /** wrapper element → render state */
  const views = new Map();

  const createView = () => {
    const wrapper = document.createElement('div');
    wrapper.className = CLASS;
    wrapper.setAttribute('aria-hidden', 'true');

    const canvas = document.createElement('canvas');
    canvas.style.width = `${CONFIG.width}px`;
    canvas.style.height = `${CONFIG.height}px`;
    wrapper.append(canvas);
    return wrapper;
  };

  const createState = (wrapper, video) => {
    const canvas = wrapper.firstElementChild;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(CONFIG.width * dpr);
    canvas.height = Math.round(CONFIG.height * dpr);

    const g = canvas.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);

    const n = CONFIG.bars;
    return {
      video,
      g,
      power: new Float64Array(n),
      db: new Float32Array(n).fill(-Infinity),
      peak: new Float32Array(n).fill(-Infinity),
      peakAt: new Float64Array(n),
      last: performance.now(),
    };
  };

  /** Advances averaging + peak hold. Returns true while anything is visible. */
  const update = (s, tap, now) => {
    const dt = now - s.last;
    s.last = now;
    const alpha = 1 - Math.exp(-dt / CONFIG.avgTimeMs);

    const volume = s.video.volume;
    const offsetDb = CONFIG.compensateVolume && volume > 0 ? -20 * Math.log10(volume) : 0;

    if (tap) tap.analyser.getFloatFrequencyData(tap.spectrum);

    let alive = !s.video.paused;
    for (let i = 0; i < CONFIG.bars; i++) {
      const p = tap ? bandPower(tap.spectrum, tap.bands[i]) : 0;
      s.power[i] += (p - s.power[i]) * alpha;

      const db = 10 * Math.log10(s.power[i]) + (tap?.bands[i].tiltDb ?? 0) + offsetDb;
      s.db[i] = db;

      if (db >= s.peak[i]) {
        s.peak[i] = db;
        s.peakAt[i] = now;
      } else if (now - s.peakAt[i] > CONFIG.peakHoldMs) {
        s.peak[i] = Math.max(db, s.peak[i] - (CONFIG.peakFallDbPerSec * dt) / 1000);
      }
      if (s.peak[i] > CONFIG.minDb) alive = true;
    }
    return alive;
  };

  const draw = ({ g, db, peak }) => {
    const { width: w, height: h, bars, minDb, maxDb } = CONFIG;
    const step = w / bars;
    const barW = Math.max(step - 1, 1);
    const toY = (v) => h - Math.min(Math.max((v - minDb) / (maxDb - minDb), 0), 1) * h;

    g.clearRect(0, 0, w, h);

    g.fillStyle = 'rgba(255, 255, 255, 0.85)';
    for (let i = 0; i < bars; i++) {
      const y = toY(db[i]);
      if (y < h) g.fillRect(i * step, y, barW, h - y);
    }

    g.fillStyle = '#ff0033';
    for (let i = 0; i < bars; i++) {
      if (peak[i] > minDb) g.fillRect(i * step, toY(peak[i]), barW, 1.5);
    }
  };

  // ---------- Render loop (runs only while something is visible) ----------

  let rafId = 0;

  const frame = (now) => {
    rafId = 0;
    let alive = false;
    for (const [wrapper, state] of views) {
      if (!wrapper.isConnected) {
        views.delete(wrapper);
        continue;
      }
      if (update(state, taps.get(state.video) ?? null, now)) alive = true;
      draw(state);
    }
    if (alive) startLoop();
  };

  function startLoop() {
    rafId ||= requestAnimationFrame(frame);
  }

  // ---------- Mounting ----------

  const ensureViews = () => {
    for (const player of document.querySelectorAll('.html5-video-player')) {
      const left = player.querySelector('.ytp-left-controls');
      const video = player.querySelector('video');
      if (!left || !video) continue;

      let wrapper = left.querySelector(`.${CLASS}`);
      if (!wrapper) {
        wrapper = createView();
        const play = left.querySelector('.ytp-play-button');
        if (play) play.after(wrapper);
        else left.prepend(wrapper);
      }

      if (views.get(wrapper)?.video !== video) views.set(wrapper, createState(wrapper, video));
      if (!video.paused) getTap(video);
    }
    if (views.size) startLoop();
  };

  let scheduled = false;
  const schedule = () => {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      ensureViews();
    });
  };

  // 'play' doesn't bubble → capture phase.
  document.addEventListener('play', schedule, true);

  // First gesture: resume/create the AudioContext.
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
})();