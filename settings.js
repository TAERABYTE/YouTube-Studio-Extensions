/**
 * YouTube Studio – options page.
 * Controls are generated from settings-schema.js, so a new field there
 * shows up here automatically.
 */
(() => {
  'use strict';

  const { STORAGE_KEY, FIELDS, DEFAULTS, PALETTE, clamp, formatHz, sanitize, createAxis } =
    globalThis.__ytsSettings;

  const SAVE_DELAY_MS = 250;
  const SLIDER_STEPS = 1000; // resolution of log-scaled sliders

  let state = DEFAULTS;
  /** key → (value, activeElement) => void, refreshes that field's inputs. */
  const writers = new Map();

  const $ = (id) => document.getElementById(id);

  const el = (tag, className, props = {}) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    return Object.assign(node, props);
  };

  const decimalsOf = (step) => String(step).split('.')[1]?.length ?? 0;
  const formatValue = (field, value) => Number(value).toFixed(decimalsOf(field.step));

  // ---------- Slider scale (linear or log) ----------

  const toSlider = (field, value) =>
    field.scale === 'log'
      ? Math.round((SLIDER_STEPS * Math.log(value / field.min)) / Math.log(field.max / field.min))
      : value;

  const fromSlider = (field, position) => {
    if (field.scale !== 'log') return Number(position);
    const raw = field.min * (field.max / field.min) ** (Number(position) / SLIDER_STEPS);
    return clamp(Math.round(raw / field.step) * field.step, field.min, field.max);
  };

  // ---------- State ----------

  const setValue = (key, value) => {
    state = sanitize({ ...state, [key]: value });
    // Refresh every field except the one being edited (cross-field rules may move others).
    for (const [k, write] of writers) write(state[k], document.activeElement);
    drawPreview();
    scheduleSave();
  };

  // ---------- Status + saving ----------

  let statusTimer = 0;
  const showStatus = (text, isError = false) => {
    const status = $('status');
    status.textContent = text;
    status.classList.toggle('is-error', isError);
    status.classList.add('is-visible');
    clearTimeout(statusTimer);
    if (!isError) statusTimer = setTimeout(() => status.classList.remove('is-visible'), 1500);
  };

  let saveTimer = 0;
  const scheduleSave = () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(async () => {
      try {
        await chrome.storage.local.set({ [STORAGE_KEY]: state });
        showStatus('Saved');
      } catch (error) {
        showStatus(`Couldn’t save: ${error.message}`, true);
      }
    }, SAVE_DELAY_MS);
  };

  const reset = async () => {
    clearTimeout(saveTimer);
    state = DEFAULTS;
    for (const [k, write] of writers) write(state[k], null);
    drawPreview();
    try {
      await chrome.storage.local.remove(STORAGE_KEY);
      showStatus('Defaults restored');
    } catch (error) {
      showStatus(`Couldn’t reset: ${error.message}`, true);
    }
  };

  // ---------- Controls ----------

  const buildRange = (field, id, control) => {
    const slider = el('input', 'slider', {
      type: 'range',
      min: field.scale === 'log' ? 0 : field.min,
      max: field.scale === 'log' ? SLIDER_STEPS : field.max,
      step: field.scale === 'log' ? 1 : field.step,
    });
    slider.setAttribute('aria-label', field.label);

    const number = el('input', 'input', {
      id,
      type: 'number',
      min: field.min,
      max: field.max,
      step: field.step,
    });
    const unit = el('span', 'unit', { textContent: field.unit });
    control.append(slider, number, unit);

    slider.addEventListener('input', () => setValue(field.key, fromSlider(field, slider.value)));
    number.addEventListener('input', () => {
      if (number.value !== '' && Number.isFinite(number.valueAsNumber)) setValue(field.key, number.valueAsNumber);
    });
    // On commit, show the value that was actually kept (clamped/adjusted).
    number.addEventListener('change', () => writers.get(field.key)(state[field.key], null));

    const chips = (field.presets ?? []).map((preset) => {
      const chip = el('button', 'chip', { type: 'button', textContent: String(preset) });
      chip.addEventListener('click', () => setValue(field.key, preset));
      return chip;
    });
    if (chips.length) {
      const presets = el('div', 'presets');
      presets.setAttribute('aria-label', `${field.label} presets`);
      presets.append(...chips);
      control.append(presets);
    }

    return (value, active) => {
      if (active !== slider) slider.value = toSlider(field, value);
      if (active !== number) number.value = formatValue(field, value);
      chips.forEach((chip, i) => chip.setAttribute('aria-pressed', String(field.presets[i] === value)));
    };
  };

  const buildSelect = (field, id, control) => {
    const select = el('select', 'input', { id });
    for (const option of field.options) {
      const hzPerBin = (48_000 / option).toFixed(1);
      select.append(el('option', '', { value: option, textContent: `${option}  (${hzPerBin} Hz per bin)` }));
    }
    control.append(select);
    select.addEventListener('change', () => setValue(field.key, Number(select.value)));
    return (value) => {
      select.value = String(value);
    };
  };

  const buildToggle = (field, id, control) => {
    const box = el('input', 'toggle', { id, type: 'checkbox' });
    control.append(box);
    box.addEventListener('change', () => setValue(field.key, box.checked));
    return (value) => {
      box.checked = value;
    };
  };

  const buildList = (field, id, control) => {
    const text = el('input', 'input input-wide', { id, type: 'text', inputMode: 'decimal', spellcheck: false });
    control.append(text, el('span', 'unit', { textContent: field.unit }));
    text.addEventListener('change', () => {
      setValue(field.key, text.value);
      writers.get(field.key)(state[field.key], null); // show the cleaned-up list
    });
    return (value, active) => {
      if (active !== text) text.value = value.join(', ');
    };
  };

  const BUILDERS = { range: buildRange, select: buildSelect, toggle: buildToggle, list: buildList };

  const buildField = (field) => {
    const id = `field-${field.key}`;
    const row = el('div', 'field');
    const text = el('div', 'field-text');
    text.append(el('label', '', { htmlFor: id, textContent: field.label }));
    if (field.hint) text.append(el('p', 'hint', { id: `${id}-hint`, textContent: field.hint }));

    const control = el('div', 'field-control');
    const write = BUILDERS[field.type](field, id, control);
    if (field.hint) control.querySelector(`#${id}`)?.setAttribute('aria-describedby', `${id}-hint`);

    row.append(text, control);
    writers.set(field.key, write);
    return row;
  };

  // ---------- Preview ----------

  /** Rough per-bin spectrum of a mastered mix (flat-display reference), in dBFS. */
  const simulatedMix = (hz) => {
    let db = -38 - 4.5 * Math.log2(hz / 1000);
    if (hz < 35) db -= 12 * Math.log2(35 / hz); // sub roll-off
    if (hz > 16_000) db -= 40 * Math.log2(hz / 16_000); // codec low-pass
    db += 4 * Math.exp(-((Math.log2(hz / 60) / 0.6) ** 2)); // kick
    db += 2 * Math.exp(-((Math.log2(hz / 3000) / 0.8) ** 2)); // presence
    return db;
  };

  const drawPreview = () => {
    const canvas = $('preview');
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (!w || !h) return;

    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    const g = canvas.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);

    const cfg = state;
    const axis = createAxis(cfg);
    const range = cfg.maxDb - cfg.minDb;
    const levels = Array.from({ length: Math.floor(w) }, (_, x) => {
      const hz = axis.xToHz(x + 0.5, w);
      return simulatedMix(hz) + cfg.slopeDbPerOct * Math.log2(hz / 1000);
    });

    g.clearRect(0, 0, w, h);

    // Filled spectrum
    levels.forEach((db, x) => {
      const t = (db - cfg.minDb) / range;
      if (!(t > 0)) return;
      const y = h * (1 - Math.min(t, 1));
      g.fillStyle = PALETTE[Math.min(255, Math.round(t * 255))];
      g.fillRect(x, y, 1, h - y);
    });

    // Darken towards the bottom
    const shade = g.createLinearGradient(0, 0, 0, h);
    shade.addColorStop(0, 'rgba(0, 0, 0, 0)');
    shade.addColorStop(1, 'rgba(0, 0, 0, 0.45)');
    g.globalCompositeOperation = 'source-atop';
    g.fillStyle = shade;
    g.fillRect(0, 0, w, h);
    g.globalCompositeOperation = 'source-over';

    // Grid
    g.font = '10px "Segoe UI", system-ui, sans-serif';
    g.textBaseline = 'top';
    for (const hz of cfg.gridHz) {
      const x = Math.round(axis.hzToX(hz, w));
      g.fillStyle = 'rgba(255, 255, 255, 0.14)';
      g.fillRect(x, 0, 1, h);
      const label = formatHz(hz, 0);
      const labelW = g.measureText(label).width;
      g.fillStyle = 'rgba(255, 255, 255, 0.5)';
      g.fillText(label, x + 3 + labelW > w ? x - 3 - labelW : x + 3, 4); // flip at the right edge
    }

    // Outline
    g.beginPath();
    levels.forEach((db, x) => {
      const y = h * (1 - clamp((db - cfg.minDb) / range, 0, 1));
      if (x === 0) g.moveTo(x + 0.5, y);
      else g.lineTo(x + 0.5, y);
    });
    g.strokeStyle = 'rgba(255, 255, 255, 0.9)';
    g.lineWidth = 1;
    g.stroke();
  };

  // ---------- Init ----------

  const init = async () => {
    for (const field of FIELDS) $(`section-${field.section}`).append(buildField(field));

    try {
      const stored = await chrome.storage.local.get(STORAGE_KEY);
      state = sanitize(stored[STORAGE_KEY]);
    } catch (error) {
      showStatus(`Couldn’t load settings: ${error.message}`, true);
    }

    for (const [k, write] of writers) write(state[k], null);
    $('reset').addEventListener('click', reset);
    new ResizeObserver(drawPreview).observe($('preview'));
    drawPreview();
  };

  init();
})();
