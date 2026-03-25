// Content script: runs on handlaprivatkund.ica.se
// Reads storeId from multiple sources and relays it to the service worker

/** Deep-search an object for a key matching a pattern, returns first string found */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function deepFind(obj: any, keyPattern: RegExp, depth = 0): string | null {
  if (depth > 6 || obj === null || typeof obj !== "object") return null;
  for (const k of Object.keys(obj)) {
    if (keyPattern.test(k) && typeof obj[k] === "string" && obj[k].length > 3) {
      return obj[k] as string;
    }
    const found = deepFind(obj[k], keyPattern, depth + 1);
    if (found) return found;
  }
  return null;
}

/** Extract storeId from current page URL: /stores/{storeId}/... */
function storeIdFromUrl(): string | null {
  const m = window.location.pathname.match(/\/stores\/([^/]+)/);
  return m ? m[1] : null;
}

/** Extract storeId from __INITIAL_STATE__ (tries many known shapes + deep search) */
function storeIdFromInitialState(): string | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const raw = (window as any).__INITIAL_STATE__;
    if (!raw) return null;

    // Known paths
    const candidates = [
      raw?.data?.basket?.storeId,
      raw?.data?.store?.storeId,
      raw?.data?.storeId,
      raw?.store?.currentStore?.storeId,
      raw?.store?.storeId,
      raw?.basket?.storeId,
      raw?.storeId,
    ];
    for (const c of candidates) {
      if (typeof c === "string" && c.length > 3) return c;
    }

    // Fallback: deep search for any key containing "storeId" (case-insensitive)
    return deepFind(raw, /storeId/i);
  } catch {
    return null;
  }
}

/** Extract regionId from __INITIAL_STATE__ */
function regionIdFromInitialState(): string | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const raw = (window as any).__INITIAL_STATE__;
    if (!raw) return null;
    const candidates = [
      raw?.data?.basket?.regionId,
      raw?.data?.regionId,
      raw?.basket?.regionId,
      raw?.regionId,
    ];
    for (const c of candidates) {
      if (typeof c === "string" && c.length > 0) return c;
    }
    return deepFind(raw, /regionId/i);
  } catch {
    return null;
  }
}

function extractState(): { storeId: string | null; regionId: string | null } {
  const storeId = storeIdFromUrl() ?? storeIdFromInitialState();
  const regionId = regionIdFromInitialState();
  return { storeId, regionId };
}

function sendStateToBackground() {
  const { storeId, regionId } = extractState();
  if (storeId) {
    chrome.runtime.sendMessage({
      type: "ICA_INITIAL_STATE",
      storeId,
      regionId,
    });
  }
}

// Send immediately if page is loaded
sendStateToBackground();

// Also send when navigation occurs (SPA)
const observer = new MutationObserver(() => {
  sendStateToBackground();
});
observer.observe(document.body, { childList: true, subtree: false });

// Listen for requests from popup via service worker
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === "GET_INITIAL_STATE") {
    const state = extractState();
    sendResponse(state);
  }
  return true;
});

// MAIN-world rebuild script cannot use chrome.* — forward progress via postMessage.
// Only the three known rebuild message types are allowed through to prevent
// arbitrary page scripts from sending unexpected messages to the service worker.
const ALLOWED_MSG_TYPES = new Set(["REBUILD_STARTED", "REBUILD_PROGRESS", "REBUILD_COMPLETE"]);

window.addEventListener("message", (event: MessageEvent) => {
  if (event.source !== window) return;
  const d = event.data as { __icaExt?: boolean; type?: string } | null;
  if (!d || d.__icaExt !== true || typeof d.type !== "string") return;
  if (!ALLOWED_MSG_TYPES.has(d.type)) return;
  const { __icaExt: _x, ...msg } = d as Record<string, unknown>;
  chrome.runtime.sendMessage(msg);
});
