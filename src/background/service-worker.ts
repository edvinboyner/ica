import {
  fetchStoresForZip,
  fetchActiveCart,
  fetchAllProductsForStore,
} from "../api/icaClient";
import {
  buildProductMatches,
  buildStorePrice,
  buildComparisonResult,
} from "../utils/priceComparison";
import type { StoredState, ComparisonResult } from "../api/types";

// ─── State management ────────────────────────────────────────────────────────

/** Ask the active ICA tab's content script for its current storeId */
async function queryStoreIdFromTab(): Promise<string | null> {
  try {
    const tabs = await chrome.tabs.query({
      url: "https://handlaprivatkund.ica.se/*",
      active: true,
    });
    // Fall back to any ICA tab if none is active foreground
    const allTabs =
      tabs.length > 0
        ? tabs
        : await chrome.tabs.query({ url: "https://handlaprivatkund.ica.se/*" });

    for (const tab of allTabs) {
      if (!tab.id) continue;
      try {
        const resp = await chrome.tabs.sendMessage(tab.id, {
          type: "GET_INITIAL_STATE",
        });
        if (resp?.storeId) {
          // Persist for next time
          await saveState({ storeId: resp.storeId, regionId: resp.regionId ?? null });
          return resp.storeId as string;
        }
      } catch {
        // Tab not ready or no content script — try next
      }
    }
  } catch {
    // tabs API not available in some contexts
  }
  return null;
}

async function getStoredState(): Promise<StoredState> {
  return new Promise((resolve) => {
    chrome.storage.local.get(
      ["storeId", "regionId", "zipCode"],
      (result) => {
        const toStr = (v: unknown) =>
          typeof v === "string" && v.length > 0 ? v : null;
        resolve({
          storeId: toStr(result.storeId),
          regionId: toStr(result.regionId),
          zipCode: toStr(result.zipCode),
        });
      }
    );
  });
}

async function saveState(patch: Partial<StoredState>) {
  // Guard: only save string values to prevent [object Object] bugs
  const safe = Object.fromEntries(
    Object.entries(patch).filter(([, v]) => v === null || typeof v === "string")
  );
  return new Promise<void>((resolve) => {
    chrome.storage.local.set(safe, resolve);
  });
}

// ─── Comparison logic ────────────────────────────────────────────────────────

async function runComparison(
  storeId: string,
  zipCode: string
): Promise<ComparisonResult> {
  // Step 1: Fetch cart from current store
  const cartItems = await fetchActiveCart(storeId);
  if (!cartItems.length) {
    throw new Error("EMPTY_CART");
  }

  const productMatches = buildProductMatches(cartItems);

  // Step 2: Fetch all stores with home delivery for zip
  const stores = await fetchStoresForZip(zipCode);
  if (!stores.length) {
    throw new Error("NO_STORES");
  }

  // Step 3: Fetch full product catalogue from each store in parallel
  const storeResults = await Promise.allSettled(
    stores.map(async (store) => {
      const products = await fetchAllProductsForStore(store.accountId);
      return buildStorePrice(store, productMatches, products);
    })
  );

  const storePrices = storeResults
    .filter(
      (r): r is PromiseFulfilledResult<Awaited<ReturnType<typeof buildStorePrice>>> =>
        r.status === "fulfilled"
    )
    .map((r) => r.value);

  if (!storePrices.length) {
    throw new Error("NO_STORE_DATA");
  }

  return buildComparisonResult(productMatches, storePrices, storeId);
}

// ─── Message handler ─────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  (async () => {
    if (message.type === "ICA_INITIAL_STATE") {
      await saveState({
        storeId: message.storeId,
        regionId: message.regionId ?? null,
      });
      sendResponse({ ok: true });
      return;
    }

    if (message.type === "GET_STATE") {
      const state = await getStoredState();
      // If no storeId in storage, try to get it from the open tab right now
      const storeId = state.storeId ?? (await queryStoreIdFromTab());
      sendResponse({
        type: "STATE_UPDATE",
        storeId,
        zipCode: state.zipCode,
      });
      return;
    }

    if (message.type === "SAVE_ZIP") {
      await saveState({ zipCode: message.zipCode });
      sendResponse({ ok: true });
      return;
    }

    if (message.type === "OPEN_CHEAPEST_CART") {
      const { items, targetStoreId } = message;
      const tab = await chrome.tabs.create({
        url: `https://handlaprivatkund.ica.se/stores/${targetStoreId}`,
      });

      const listener = (changedTabId: number, info: { status?: string }) => {
        if (changedTabId !== tab.id || info.status !== "complete") return;
        chrome.tabs.onUpdated.removeListener(listener);
        chrome.scripting.executeScript({
          target: { tabId: tab.id! },
          world: "MAIN",
          files: ["content/rebuildCart.js"],
        }).then(() =>
          chrome.scripting.executeScript({
            target: { tabId: tab.id! },
            world: "MAIN",
            func: (items: unknown, storeId: string) => {
              (window as any).__icaRebuildCart(items, storeId);
            },
            args: [items, targetStoreId],
          })
        ).catch((e) => console.error("inject failed", e));
      };
      chrome.tabs.onUpdated.addListener(listener);

      sendResponse({ ok: true });
      return;
    }

    if (message.type === "GET_COMPARISON") {
      const state = await getStoredState();
      const zipCode: string = message.zipCode ?? state.zipCode;
      // Try storage first, then actively query the open ICA tab
      const storeId: string | null =
        state.storeId ?? (await queryStoreIdFromTab());

      if (!storeId) {
        sendResponse({
          type: "COMPARISON_ERROR",
          error: "NO_STORE — besök handlaprivatkund.ica.se och logga in",
        });
        return;
      }
      if (!zipCode) {
        sendResponse({
          type: "COMPARISON_ERROR",
          error: "NO_ZIP — ange ditt postnummer",
        });
        return;
      }

      try {
        const result = await runComparison(storeId, zipCode);
        sendResponse({ type: "COMPARISON_RESULT", data: result });
      } catch (err) {
        const msg = err instanceof Error ? err.message : "UNKNOWN_ERROR";
        sendResponse({ type: "COMPARISON_ERROR", error: msg });
      }
      return;
    }
  })();

  // Return true to keep the message channel open for async responses
  return true;
});
