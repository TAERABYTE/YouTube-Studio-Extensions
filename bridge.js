/**
 * YouTube Studio – settings bridge (ISOLATED world).
 * spectrum.js runs in the page (MAIN world) and can't use chrome.storage,
 * so this script reads the settings and forwards them as a DOM event.
 *
 * Standalone on purpose: Chrome injects a given file only once per frame, so
 * settings-schema.js (already loaded in the MAIN world) is NOT available here.
 * Values are forwarded raw; spectrum.js validates them with sanitize().
 */
(() => {
  'use strict';

  if (globalThis.__ytsBridge) return; // guard against double injection
  globalThis.__ytsBridge = true;

  // Must match STORAGE_KEY / EVENTS in settings-schema.js.
  const STORAGE_KEY = 'ytsSettings';
  const EVENT_APPLY = 'yts:settings';
  const EVENT_REQUEST = 'yts:settings-request';

  // Objects in CustomEvent.detail don't cross worlds reliably → send a JSON string.
  const send = (raw) => {
    window.dispatchEvent(new CustomEvent(EVENT_APPLY, { detail: JSON.stringify(raw ?? {}) }));
  };

  const load = async () => {
    try {
      const stored = await chrome.storage.local.get(STORAGE_KEY);
      send(stored[STORAGE_KEY]);
    } catch (error) {
      // e.g. "Extension context invalidated" after the extension was reloaded
      console.warn('[YouTube Studio] settings unavailable:', error);
    }
  };

  // spectrum.js asks on start-up, in case it loaded after our first send.
  window.addEventListener(EVENT_REQUEST, load);

  // Options page saved → apply live to every open YouTube tab.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && STORAGE_KEY in changes) send(changes[STORAGE_KEY].newValue);
  });

  load();
})();
