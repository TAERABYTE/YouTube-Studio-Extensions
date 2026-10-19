/**
 * YouTube Studio – settings schema (single source of truth).
 * Loaded in three places, each with its own global scope:
 *  - the page (MAIN world)          → spectrum.js
 *  - the content-script bridge      → bridge.js (ISOLATED world, has chrome.storage)
 *  - the options page               → settings.js
 */
(() => {
  'use strict';

  if (globalThis.__ytsSettings) return; // guard against double injection

  const STORAGE_KEY = 'ytsSettings';
  const EVENTS = Object.freeze({
    apply: 'yts:settings', // bridge → page, detail = JSON string
    request: 'yts:settings-request', // page → bridge
  });

  const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);

  const formatHz = (hz, digits = 0) =>
    hz >= 1000 ? `${(hz / 1000).toFixed(digits)}kHz` : `${hz.toFixed(digits)}Hz`;

  // ---------- Fields ----------
  // section: 'analyzer' (main) | 'advanced' (collapsed)
  // type:    'range' | 'select' | 'toggle' | 'list'

  const FIELDS = Object.freeze(
    [
      {
        key: 'slopeDbPerOct',
        section: 'analyzer',
        type: 'range',
        label: 'Slope',
        hint: 'Tilt around 1 kHz. 0 shows white noise flat, 3 shows pink noise flat, 4.5 matches Pro-Q and SPAN.',
        min: 0,
        max: 6,
        step: 0.5,
        unit: 'dB/oct',
        presets: [0, 3, 4.5],
        default: 0,
      },
      {
        key: 'avgTimeMs',
        section: 'analyzer',
        type: 'range',
        scale: 'log',
        label: 'Averaging time',
        hint: 'Short follows the music. Long shows the overall tonal balance.',
        min: 10,
        max: 10_000,
        step: 10,
        unit: 'ms',
        default: 50,
      },
      {
        key: 'peakHoldMs',
        section: 'analyzer',
        type: 'range',
        label: 'Peak hold',
        hint: 'How long the peak line stays before it starts to fall.',
        min: 0,
        max: 20_000,
        step: 100,
        unit: 'ms',
        default: 4000,
      },
      {
        key: 'peakFallDbPerSec',
        section: 'analyzer',
        type: 'range',
        label: 'Peak fall rate',
        min: 1,
        max: 120,
        step: 1,
        unit: 'dB/s',
        default: 24,
      },
      {
        key: 'fftSize',
        section: 'analyzer',
        type: 'select',
        label: 'FFT size',
        hint: 'Larger gives a finer low end but reacts slower and uses more CPU.',
        options: [2048, 4096, 8192, 16384, 32768],
        default: 16384,
      },
      {
        key: 'minDb',
        section: 'analyzer',
        type: 'range',
        label: 'Floor',
        hint: 'Bottom of the graph.',
        min: -160,
        max: -20,
        step: 1,
        unit: 'dB',
        default: -100,
      },
      {
        key: 'maxDb',
        section: 'analyzer',
        type: 'range',
        label: 'Ceiling',
        hint: 'Top of the graph.',
        min: -60,
        max: 12,
        step: 1,
        unit: 'dB',
        default: 0,
      },
      {
        key: 'compensateVolume',
        section: 'analyzer',
        type: 'toggle',
        label: 'Show source level',
        hint: 'Ignore the volume slider, so the graph shows the level of the track itself.',
        default: true,
      },
      {
        key: 'minHz',
        section: 'advanced',
        type: 'range',
        scale: 'log',
        label: 'Lowest frequency',
        min: 1,
        max: 1000,
        step: 1,
        unit: 'Hz',
        default: 1,
      },
      {
        key: 'maxHz',
        section: 'advanced',
        type: 'range',
        label: 'Highest frequency',
        hint: 'YouTube audio rarely carries anything above 16–20 kHz.',
        min: 1000,
        max: 24_000,
        step: 100,
        unit: 'Hz',
        default: 24_000,
      },
      {
        key: 'axisPower',
        section: 'advanced',
        type: 'range',
        label: 'Frequency axis curve',
        hint: '1 is a true log scale. Higher values squeeze the lows and give the highs more room.',
        min: 1,
        max: 4,
        step: 0.1,
        unit: '×',
        default: 2,
      },
      {
        key: 'gridHz',
        section: 'advanced',
        type: 'list',
        label: 'Grid lines',
        hint: 'Frequencies in Hz, separated by commas.',
        unit: 'Hz',
        default: [20, 50, 100, 500, 1000, 3000, 5000, 10_000, 20_000],
      },
      {
        key: 'height',
        section: 'advanced',
        type: 'range',
        label: 'Height',
        hint: 'The player control bar is 48 px tall.',
        min: 16,
        max: 48,
        step: 1,
        unit: 'px',
        default: 36,
      },
      {
        key: 'minWidth',
        section: 'advanced',
        type: 'range',
        label: 'Minimum width',
        hint: 'Hide the graph when the free space in the control bar is narrower than this.',
        min: 60,
        max: 600,
        step: 10,
        unit: 'px',
        default: 160,
      },
      {
        key: 'maxWidth',
        section: 'advanced',
        type: 'range',
        label: 'Maximum width',
        min: 100,
        max: 1200,
        step: 10,
        unit: 'px',
        default: 450,
      },
      {
        key: 'sidePadding',
        section: 'advanced',
        type: 'range',
        label: 'Side gap',
        hint: 'Space between the graph and the player buttons.',
        min: 0,
        max: 40,
        step: 1,
        unit: 'px',
        default: 4,
      },
    ].map((field) => Object.freeze(field)),
  );

  const DEFAULTS = Object.freeze(
    Object.fromEntries(
      FIELDS.map(({ key, default: value }) => [key, Array.isArray(value) ? Object.freeze([...value]) : value]),
    ),
  );

  // ---------- Validation ----------

  const MAX_GRID_LINES = 24;

  /** Accepts an array or a "20, 50, 100" string; returns sorted unique positive numbers. */
  const parseList = (value) => {
    const items = Array.isArray(value) ? value : String(value ?? '').split(/[\s,;]+/);
    const numbers = items.map(Number).filter((n) => Number.isFinite(n) && n > 0);
    return [...new Set(numbers)].sort((a, b) => a - b).slice(0, MAX_GRID_LINES);
  };

  const sanitizeField = (field, value) => {
    switch (field.type) {
      case 'range': {
        const n = Number(value);
        return Number.isFinite(n) ? clamp(n, field.min, field.max) : field.default;
      }
      case 'select': {
        const n = Number(value);
        return field.options.includes(n) ? n : field.default;
      }
      case 'toggle':
        return typeof value === 'boolean' ? value : field.default;
      case 'list':
        return value == null ? [...field.default] : parseList(value);
      default:
        return field.default;
    }
  };

  /**
   * Returns a complete, valid, frozen settings object.
   * Never throws; unknown keys are dropped, bad values fall back to defaults.
   */
  const sanitize = (raw) => {
    const source = raw && typeof raw === 'object' ? raw : {};
    const out = {};
    for (const field of FIELDS) out[field.key] = sanitizeField(field, source[field.key]);

    // Cross-field rules
    if (out.maxDb - out.minDb < 10) out.minDb = out.maxDb - 10;
    if (out.maxHz < out.minHz * 2) out.minHz = out.maxHz / 2;
    if (out.minWidth > out.maxWidth) out.minWidth = out.maxWidth;
    out.gridHz = Object.freeze(out.gridHz.filter((hz) => hz >= out.minHz && hz <= out.maxHz));

    return Object.freeze(out);
  };

  // ---------- Frequency axis ----------

  /** Maps frequency ↔ x for a given config: t = log position (0–1), x = width · t^power. */
  const createAxis = ({ minHz, maxHz, axisPower }) => {
    const logRatio = Math.log(maxHz / minHz);
    return Object.freeze({
      hzToX: (hz, width) => width * clamp(Math.log(hz / minHz) / logRatio, 0, 1) ** axisPower,
      xToHz: (x, width) => minHz * Math.exp(logRatio * clamp(x / width, 0, 1) ** (1 / axisPower)),
    });
  };

  // ---------- Colour ramp ----------

  /** 256-step ramp: deep purple → magenta → red → orange. */
  const PALETTE = (() => {
    const stops = [
      [0, [38, 6, 64]],
      [0.35, [110, 24, 150]],
      [0.6, [214, 30, 140]],
      [0.82, [255, 45, 85]],
      [1, [255, 110, 30]],
    ];
    return Object.freeze(
      Array.from({ length: 256 }, (_, i) => {
        const t = i / 255;
        const j = stops.findIndex(([p]) => p >= t);
        const [p1, c1] = stops[Math.max(j - 1, 0)];
        const [p2, c2] = stops[j];
        const u = p2 === p1 ? 0 : (t - p1) / (p2 - p1);
        const [r, g, b] = c1.map((c, k) => Math.round(c + (c2[k] - c) * u));
        return `rgb(${r} ${g} ${b})`;
      }),
    );
  })();

  Object.defineProperty(globalThis, '__ytsSettings', {
    value: Object.freeze({
      STORAGE_KEY,
      EVENTS,
      FIELDS,
      DEFAULTS,
      PALETTE,
      clamp,
      formatHz,
      sanitize,
      createAxis,
    }),
  });
})();
