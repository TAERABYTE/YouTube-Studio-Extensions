/**
 * YouTube Normalizer Disabler
 * YouTube lowers HTMLMediaElement.volume below the slider value for loud videos.
 * When enabled, this script forces the element's volume to match the slider and
 * shows a button in the player's right controls with the restored gain in dB.
 */
(() => {
  'use strict';

  if (window.__ytNormalizerDisabler) return; // guard against double injection
  window.__ytNormalizerDisabler = true;

  const STORAGE_KEY = 'ytnd:enabled';
  const BUTTON_CLASS = 'ytnd-button';
  const EPSILON = 0.001;

  const descriptor = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'volume');
  if (!descriptor?.get || !descriptor?.set) return;

  const nativeGet = descriptor.get;
  const nativeSet = descriptor.set;

  /** Volume YouTube wanted to apply (already normalized), per media element. */
  const requestedVolume = new WeakMap();
  /** Last valid boost, kept so the label stays meaningful when the slider is at 0. */
  const lastBoostDb = new WeakMap();

  // ---------- State ----------
  const TARGET_LUFS = -14; // YouTube's loudness target

  /** Estimated integrated loudness (LUFS) of the current video, or null. */
  const getSourceLufs = (player) => {
    const relativeDb = Number(player?.getPlayerResponse?.()?.playerConfig?.audioConfig?.loudnessDb);
    return Number.isFinite(relativeDb) ? TARGET_LUFS + relativeDb : null;
  };

  const loadEnabled = () => {
    try {
      return localStorage.getItem(STORAGE_KEY) !== 'false';
    } catch {
      return true;
    }
  };

  const saveEnabled = (value) => {
    try {
      localStorage.setItem(STORAGE_KEY, String(value));
    } catch {
      /* storage unavailable: state just won't persist */
    }
  };

  let enabled = loadEnabled();

  // ---------- Volume helpers ----------

  const getPlayer = (media) => media.closest?.('.html5-video-player') ?? null;

  /** Slider volume (0–1) of a YouTube player, or null if unavailable. */
  const getSliderVolume = (player) => {
    if (typeof player?.getVolume !== 'function') return null;
    const percent = Number(player.getVolume());
    if (!Number.isFinite(percent)) return null;
    return Math.min(Math.max(percent / 100, 0), 1);
  };

  /** Gain (dB) restored by bypassing normalization, or null if not yet known. */
  const getBoostDb = (media) => {
    const slider = getSliderVolume(getPlayer(media));
    const requested = requestedVolume.get(media);

    if (slider > 0 && requested > 0) {
      const db = Math.max(0, 20 * Math.log10(slider / requested));
      lastBoostDb.set(media, db);
      return db;
    }
    return lastBoostDb.get(media) ?? null;
  };

  // ---------- Volume interception ----------

  Object.defineProperty(HTMLMediaElement.prototype, 'volume', {
    configurable: true,
    enumerable: descriptor.enumerable,
    get() {
      return nativeGet.call(this);
    },
    set(value) {
      const numeric = Number(value);
      if (Number.isFinite(numeric)) requestedVolume.set(this, numeric);

      const slider = enabled ? getSliderVolume(getPlayer(this)) : null;
      nativeSet.call(this, slider ?? value);
    },
  });

  // Safety net for timing edge cases; 'volumechange' doesn't bubble → capture phase.
  document.addEventListener(
    'volumechange',
    (event) => {
      const media = event.target;
      if (!(media instanceof HTMLMediaElement)) return;

      if (enabled) {
        const slider = getSliderVolume(getPlayer(media));
        if (slider !== null && Math.abs(nativeGet.call(media) - slider) > EPSILON) {
          nativeSet.call(media, slider);
        }
      }
      scheduleUiUpdate();
    },
    true,
  );

  document.addEventListener('loadedmetadata', () => scheduleUiUpdate(), true);

  // ---------- Toggle ----------

  const toggle = () => {
    enabled = !enabled;
    saveEnabled(enabled);

    for (const media of document.querySelectorAll('.html5-video-player video')) {
      const target = enabled
        ? getSliderVolume(getPlayer(media))
        : requestedVolume.get(media); // restore YouTube's normalized value
      if (target != null) nativeSet.call(media, target);
    }
    scheduleUiUpdate();
  };

  // ---------- UI ----------

  // Only write when the value differs: our own DOM writes would otherwise
  // re-trigger the MutationObserver in an endless loop.
  const setText = (el, text) => {
    if (el.textContent !== text) el.textContent = text;
  };
  const setAttr = (el, name, value) => {
    if (el.getAttribute(name) !== value) el.setAttribute(name, value);
  };

  // Built with createElement/textContent only: YouTube enforces Trusted Types,
  // so innerHTML would throw.
  const createButton = () => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `ytp-button ${BUTTON_CLASS}`;

    const label = document.createElement('span');
    label.className = 'ytnd-label';
    button.append(label);

    button.addEventListener('click', (event) => {
      event.stopPropagation();
      toggle();
    });
    return button;
  };

  const updateButton = (button, player) => {
    const label = button.firstElementChild;
    const media = player.querySelector('video');
    const db = media ? getBoostDb(media) : null;
    const lufs = getSourceLufs(player);
    const lufsText = lufs === null ? '' : ` ${lufs.toFixed(1)} LUFS`;

    let title;
    if (enabled) {
      setText(label, db === null ? '+–' : `+${db.toFixed(1)}`);
      title = db === null
        ? `Normalization off ${lufsText}`
        : `Normalization off ${lufsText} : +${db.toFixed(1)} dB restored`;
    } else {
      setText(label, `+${db.toFixed(1)}`);
      title = `Normalization Active ${lufsText}`;
    }

    setAttr(button, 'aria-pressed', String(enabled));
    setAttr(button, 'aria-label', title);
    setAttr(button, 'title', title);
  };

  const ensureButtons = () => {
    for (const player of document.querySelectorAll('.html5-video-player')) {
      const controls = player.querySelector('.ytp-right-controls');
      if (!controls) continue;

      // Newer layouts split the right controls into sub-groups.
      const container = controls.querySelector(':scope > .ytp-right-controls-left') ?? controls;

      let button = container.querySelector(`:scope > .${BUTTON_CLASS}`);
      if (!button) {
        button = createButton();
        container.prepend(button); // leftmost position in the right-hand menu
      }
      updateButton(button, player);
    }
  };

  let uiScheduled = false;
  function scheduleUiUpdate() {
    if (uiScheduled) return;
    uiScheduled = true;
    requestAnimationFrame(() => {
      uiScheduled = false;
      ensureButtons();
    });
  }

  // YouTube is an SPA that rebuilds the player (navigation, Shorts, miniplayer),
  // so keep watching; work is throttled to once per frame.
  new MutationObserver(scheduleUiUpdate).observe(document.documentElement, {
    childList: true,
    subtree: true,
  });
})();
