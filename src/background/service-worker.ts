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
import type {
  StoredState,
  ComparisonResult,
  RebuildSessionState,
  ComparisonSessionCache,
  ComparisonProgressState,
} from "../api/types";
import {
  fingerprintFromProductMatches,
  fingerprintFromCartItems,
} from "../utils/cartFingerprint";

// Clear any corrupted storeId that was saved as non-string
chrome.storage.local.get(["storeId"], (result) => {
  if (result.storeId !== undefined && typeof result.storeId !== "string") {
    chrome.storage.local.remove("storeId");
  }
});

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
  await persistComparisonProgress({
    status: "running",
    step: "cart",
    current: 0,
    total: 1,
    detail: "Hämtar varukorg…",
  });

  const cartItems = await fetchActiveCart(storeId);
  if (!cartItems.length) {
    throw new Error("EMPTY_CART");
  }

  await persistComparisonProgress({
    status: "running",
    step: "cart",
    current: 1,
    total: 1,
    detail: `${cartItems.length} varor i korgen`,
  });

  const productMatches = buildProductMatches(cartItems);

  await persistComparisonProgress({
    status: "running",
    step: "stores_list",
    current: 0,
    total: 1,
    detail: "Hämtar butiker för ditt postnummer…",
  });

  const stores = await fetchStoresForZip(zipCode);
  if (!stores.length) {
    throw new Error("NO_STORES");
  }

  await persistComparisonProgress({
    status: "running",
    step: "stores_list",
    current: 1,
    total: 1,
    detail: `${stores.length} butiker med hemleverans`,
  });

  const n = stores.length;
  await persistComparisonProgress({
    status: "running",
    step: "store_catalogues",
    current: 0,
    total: n,
    detail: "Hämtar sortiment från varje butik…",
  });

  let completed = 0;
  const storeResults = await Promise.allSettled(
    stores.map(async (store) => {
      const products = await fetchAllProductsForStore(store.accountId);
      const row = buildStorePrice(store, productMatches, products);
      completed += 1;
      await persistComparisonProgress({
        status: "running",
        step: "store_catalogues",
        current: completed,
        total: n,
        detail: store.name,
      });
      return row;
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

async function persistRebuildState(state: RebuildSessionState | null) {
  if (state === null) {
    await chrome.storage.session.remove("rebuildState");
    return;
  }
  await chrome.storage.session.set({ rebuildState: state });
}

async function saveComparisonCache(data: ComparisonSessionCache) {
  await chrome.storage.session.set({ comparisonCache: data });
}

async function persistComparisonProgress(state: ComparisonProgressState | null) {
  if (state === null) {
    await chrome.storage.session.remove("comparisonProgress");
    return;
  }
  await chrome.storage.session.set({ comparisonProgress: state });
}

// ─── Message handler ─────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  (async () => {
    if (message.type === "REBUILD_STARTED") {
      const { total, storeName } = message as {
        total: number;
        storeName: string;
      };
      await persistRebuildState({
        status: "running",
        total,
        storeName,
        current: 0,
        itemName: "",
      });
      sendResponse({ ok: true });
      return;
    }

    if (message.type === "REBUILD_PROGRESS") {
      const { current, total, itemName, status } = message as {
        current: number;
        total: number;
        itemName: string;
        status: "added" | "not_found";
      };
      const raw = await chrome.storage.session.get("rebuildState");
      const prev = raw.rebuildState as RebuildSessionState | undefined;
      const storeName =
        prev?.status === "running"
          ? prev.storeName
          : prev?.status === "complete"
          ? prev.storeName
          : "Butik";
      await persistRebuildState({
        status: "running",
        total,
        storeName,
        current,
        itemName,
        itemStatus: status,
      });
      sendResponse({ ok: true });
      return;
    }

    if (message.type === "REBUILD_COMPLETE") {
      const { added, failed, failedItems } = message as {
        added: number;
        failed: number;
        failedItems: string[];
      };
      const prev = (await chrome.storage.session.get("rebuildState"))
        .rebuildState as RebuildSessionState | undefined;
      const total =
        prev?.status === "running"
          ? prev.total
          : prev?.status === "complete"
          ? prev.total
          : added + failed;
      const storeName =
        prev?.status === "running"
          ? prev.storeName
          : prev?.status === "complete"
          ? prev.storeName
          : "Butik";
      await persistRebuildState({
        status: "complete",
        total,
        storeName,
        added,
        failed,
        failedItems,
      });
      sendResponse({ ok: true });
      return;
    }

    if (message.type === "CHECK_CART_FINGERPRINT") {
      const raw = await chrome.storage.session.get("comparisonCache");
      const cache = raw.comparisonCache as ComparisonSessionCache | undefined;
      if (!cache) {
        sendResponse({ stale: false, hasCache: false });
        return;
      }
      const state = await getStoredState();
      let storeId: string | null =
        state.storeId ?? (await queryStoreIdFromTab());
      if (!storeId) {
        sendResponse({ stale: false, hasCache: true, uncertain: true });
        return;
      }
      const cartItems = await fetchActiveCart(storeId);
      const fp = fingerprintFromCartItems(cartItems);
      sendResponse({
        stale: fp !== cache.cartFingerprint,
        hasCache: true,
        uncertain: false,
      });
      return;
    }

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

    if (message.type === "GET_REBUILD_CART") {
      const result = await new Promise<{ ica_rebuild_cart?: string }>((resolve) =>
        chrome.storage.local.get("ica_rebuild_cart", resolve)
      );
      const data = result.ica_rebuild_cart
        ? JSON.parse(result.ica_rebuild_cart)
        : null;
      // Clear after reading so it's only used once
      chrome.storage.local.remove(["ica_rebuild_cart"]);
      sendResponse(data);
      return;
    }

    if (message.type === "SAVE_ZIP") {
      await saveState({ zipCode: message.zipCode });
      sendResponse({ ok: true });
      return;
    }

    if (message.type === "OPEN_CHEAPEST_CART") {
      const { items, targetStoreId, targetStoreName } = message as {
        items: unknown;
        targetStoreId: string;
        targetStoreName?: string;
      };
      await new Promise<void>((resolve) =>
        chrome.storage.local.set(
          { ica_rebuild_cart: JSON.stringify({ items, targetStoreId }) },
          resolve
        )
      );
      const tab = await chrome.tabs.create({
        url: `https://handlaprivatkund.ica.se/stores/${targetStoreId}`,
      });

      const rebuildItems = items;
      const rebuildStoreId = targetStoreId;

      const listener = (changedTabId: number, info: { status?: string }) => {
        if (changedTabId !== tab.id || info.status !== "complete") return;
        chrome.tabs.onUpdated.removeListener(listener);
        chrome.storage.local.remove(["ica_rebuild_cart"]);

        // First inject the rebuildCart module, then call rebuildCart()
        const storeLabel =
          typeof targetStoreName === "string" && targetStoreName.length > 0
            ? targetStoreName
            : "Butik";
        chrome.scripting.executeScript({
          target: { tabId: tab.id! },
          world: "MAIN",
          files: ["content/rebuildCart.js"],
        }).then(() =>
          chrome.scripting.executeScript({
            target: { tabId: tab.id! },
            world: "MAIN",
            func: (items: unknown, storeId: string, name: string) => {
              (window as any).__icaRebuildCart(items, storeId, name);
            },
            args: [rebuildItems, rebuildStoreId, storeLabel],
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
        await saveComparisonCache({
          timestamp: Date.now(),
          sourceStoreId: storeId,
          cartFingerprint: fingerprintFromProductMatches(result.cartItems),
          results: result,
        });
        sendResponse({ type: "COMPARISON_RESULT", data: result });
      } catch (err) {
        const msg = err instanceof Error ? err.message : "UNKNOWN_ERROR";
        sendResponse({ type: "COMPARISON_ERROR", error: msg });
      } finally {
        await persistComparisonProgress(null);
      }
      return;
    }
  })();

  // Return true to keep the message channel open for async responses
  return true;
});
