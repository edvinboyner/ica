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

// ─── Iframe lookup (injected into MAIN world via chrome.scripting) ───────────

/**
 * Self-contained function injected via chrome.scripting.executeScript world:"MAIN".
 * Must not reference any module-level variables — Chrome serialises it via .toString().
 *
 * Uses a worker-pool pattern (MAX_CONCURRENT iframes at a time) to avoid
 * overwhelming the browser when hundreds of lookups are needed across many stores.
 */
async function iframeLookupInMainWorld(
  jobs: Array<{ storeId: string; productName: string; retailerProductId: string; quantity: number }>
): Promise<
  Array<{
    storeId: string;
    retailerProductId: string;
    price: number | null;
    available: boolean;
  }>
> {
  function lookupOne(job: {
    storeId: string;
    productName: string;
    retailerProductId: string;
    quantity: number;
  }) {
    return new Promise<{
      storeId: string;
      retailerProductId: string;
      price: number | null;
      available: boolean;
    }>((resolve) => {
      const iframe = document.createElement("iframe");
      iframe.style.cssText =
        "position:fixed;top:-9999px;left:-9999px;width:1px;height:1px;";
      // Use only the first word of the product name as search query.
      // A shorter/brand-only query returns results faster and is more likely
      // to include the product (ICA's search ranks brand matches highly).
      // Accuracy is unaffected — we still match on exact retailerProductId.
      const searchQuery = job.productName.split(" ")[0] ?? job.productName;
      iframe.src = `https://handlaprivatkund.ica.se/stores/${
        job.storeId
      }/search?q=${encodeURIComponent(searchQuery)}`;
      document.body.appendChild(iframe);

      const check = setInterval(() => {
        try {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const entities: Record<string, any> =
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (iframe.contentWindow as any)?.__INITIAL_STATE__?.data?.products
              ?.productEntities ?? {};
          if (Object.keys(entities).length > 0) {
            clearInterval(check);
            try {
              document.body.removeChild(iframe);
            } catch {
              /* ignore */
            }
            const match = Object.values(entities).find(
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              (p: any) => p.retailerProductId === job.retailerProductId
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
            ) as any;
            const raw: string =
              match?.price?.current?.amount ?? match?.price?.amount ?? "";
            const singleUnitAmount = parseFloat(raw);
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            let price: number | null = isFinite(singleUnitAmount) && singleUnitAmount >= 0 ? singleUnitAmount : null;

            // Check offers for multi-buy / stammis deals: "2 för 135 kr", "6 för 20 kr" etc.
            // The offer is only applied when the user's cart quantity meets the threshold.
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const offers: any[] = match?.offers ?? [];
            for (const offer of offers) {
              const requiredQty: number = offer?.requiredProductQuantity ?? 0;
              if (requiredQty > 0 && job.quantity >= requiredQty) {
                const desc: string = offer?.description ?? "";
                // Match "N för X kr" or "N för X,XX kr" (Swedish decimal comma)
                const m = desc.match(/\d+\s+f\u00f6r\s+([\d,.]+)\s*kr/i);
                if (m) {
                  const totalForGroup = parseFloat(m[1].replace(",", "."));
                  if (isFinite(totalForGroup) && totalForGroup > 0) {
                    const dealPerUnit = totalForGroup / requiredQty;
                    if (price === null || dealPerUnit < price) {
                      price = dealPerUnit;
                    }
                  }
                }
              }
            }

            resolve({
              storeId: job.storeId,
              retailerProductId: job.retailerProductId,
              price,
              // Treat as available whenever the product is found by retailerProductId —
              // consistent with how bulk products are handled (price presence = available).
              // ICA's `available` field is often absent or unreliable in search state.
              available: match != null && price !== null,
            });
          }
        } catch {
          /* iframe not loaded yet — wait for next poll */
        }
      }, 200);

      setTimeout(() => {
        clearInterval(check);
        try {
          document.body.removeChild(iframe);
        } catch {
          /* ignore */
        }
        resolve({
          storeId: job.storeId,
          retailerProductId: job.retailerProductId,
          price: null,
          available: false,
        });
      }, 15000);
    });
  }

  // Interleave jobs by store: [s1i1, s2i1, …, s64i1, s1i2, s2i2, …]
  // Combined with the flat worker pool this ensures:
  //   • At most MAX_CONCURRENT iframes at any given time
  //   • Each store gets at most 1 active iframe at a time (no per-store rate limiting)
  const MAX_CONCURRENT = 50;
  const byStore = new Map<string, typeof jobs>();
  for (const job of jobs) {
    if (!byStore.has(job.storeId)) byStore.set(job.storeId, []);
    byStore.get(job.storeId)!.push(job);
  }
  const storeQueues = [...byStore.values()];
  const maxLen = Math.max(...storeQueues.map((q) => q.length));
  const interleaved: typeof jobs = [];
  for (let i = 0; i < maxLen; i++) {
    for (const q of storeQueues) {
      if (i < q.length) interleaved.push(q[i]);
    }
  }

  // Flat worker pool — JavaScript is single-threaded so nextIndex++ is race-free.
  const results: Array<{
    storeId: string;
    retailerProductId: string;
    price: number | null;
    available: boolean;
  }> = new Array(interleaved.length);
  let nextIndex = 0;

  async function worker() {
    while (true) {
      const i = nextIndex++;
      if (i >= interleaved.length) break;
      results[i] = await lookupOne(interleaved[i]);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(MAX_CONCURRENT, interleaved.length) }, worker)
  );
  return results;
}

async function findIcaTabId(): Promise<number | null> {
  try {
    const tabs = await chrome.tabs.query({
      url: "https://handlaprivatkund.ica.se/*",
    });
    return tabs[0]?.id ?? null;
  } catch {
    return null;
  }
}

/**
 * Self-contained: reads name + retailerProductId for given productIds from the
 * ICA tab's Redux productEntities. ICA's SPA loads ALL basket items' product
 * data into productEntities on init — so this works even for items not in the
 * 309 bulk/campaign products.
 */
function readProductEntitiesInMainWorld(
  productIds: string[]
): Array<{ productId: string; retailerProductId: string | null; name: string | null }> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const entities: Record<string, any> =
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).__INITIAL_STATE__?.data?.products?.productEntities ?? {};
  return productIds.map((id) => ({
    productId: id,
    retailerProductId: entities[id]?.retailerProductId ?? null,
    name: entities[id]?.name ?? null,
  }));
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

  // Get tab ID early — reused for both productEntities enrichment and iframe fallback
  const icaTabId = await findIcaTabId();

  // Enrich items that didn't get retailerProductId from the 309 bulk products.
  // ICA's SPA loads ALL basket items' product data into __INITIAL_STATE__ productEntities
  // on init, so we can always read name + retailerProductId for any cart item from there.
  if (icaTabId !== null) {
    const unenrichedIds = cartItems
      .filter((i) => !i.retailerProductId)
      .map((i) => i.productId);
    if (unenrichedIds.length > 0) {
      try {
        const injected = await chrome.scripting.executeScript({
          target: { tabId: icaTabId },
          world: "MAIN",
          func: readProductEntitiesInMainWorld,
          args: [unenrichedIds],
        });
        type EntityEntry = { productId: string; retailerProductId: string | null; name: string | null };
        for (const e of (injected[0]?.result ?? []) as EntityEntry[]) {
          const item = cartItems.find((i) => i.productId === e.productId);
          if (item && e.retailerProductId) {
            item.retailerProductId = e.retailerProductId;
            if (!item.name && e.name) item.name = e.name;
          }
        }
      } catch {
        // best-effort — items without retailerProductId fall back to "saknas"
      }
    }
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

  // Parallel bulk-fetch for all stores
  let bulkCompleted = 0;
  const bulkSettled = await Promise.allSettled(
    stores.map(async (store) => {
      const products = await fetchAllProductsForStore(store.accountId);
      bulkCompleted += 1;
      await persistComparisonProgress({
        status: "running",
        step: "store_catalogues",
        current: bulkCompleted,
        total: n,
        detail: store.name,
      });
      return { store, products };
    })
  );

  type BulkEntry = { store: (typeof stores)[number]; products: Awaited<ReturnType<typeof fetchAllProductsForStore>> };
  const storeBulkData: BulkEntry[] = bulkSettled
    .filter((r): r is PromiseFulfilledResult<BulkEntry> => r.status === "fulfilled")
    .map((r) => r.value);

  if (!storeBulkData.length) {
    throw new Error("NO_STORE_DATA");
  }

  // Collect iframe jobs:
  //   1. Items NOT found in the store's bulk catalog (availability unknown)
  //   2. Items WITH a member/ICA-card discount in the home store — the bulk catalog
  //      only reflects campaign prices; the SPA search (price.current.amount) also
  //      includes personalized discounts for the logged-in user.
  // Deduplicate per (storeId, retailerProductId) to avoid double lookups.
  type IframeJob = { storeId: string; productName: string; retailerProductId: string; quantity: number };
  const iframeJobs: IframeJob[] = [];
  const addedIframeKeys = new Set<string>();
  for (const { store, products } of storeBulkData) {
    const bulkRids = new Set(
      products.map((p) => p.retailerProductId).filter((id): id is string => !!id)
    );
    for (const item of productMatches) {
      if (!item.retailerProductId) continue;
      const notInBulk = !bulkRids.has(item.retailerProductId);
      const needsMemberPrice = item.hasMemberDiscount === true;
      if (notInBulk || needsMemberPrice) {
        const key = `${store.accountId}:${item.retailerProductId}`;
        if (!addedIframeKeys.has(key)) {
          addedIframeKeys.add(key);
          iframeJobs.push({
            storeId: store.accountId,
            productName: item.name,
            retailerProductId: item.retailerProductId,
            quantity: item.quantity,
          });
        }
      }
    }
  }

  // Iframe lookups: run in batches so the popup can show live progress.
  //
  // Strategy:
  //   1. Pre-interleave ALL jobs globally: [s1i1, s2i1, …, sNi1, s1i2, …]
  //      This guarantees each store gets at most 1 active iframe at a time,
  //      even when batches are processed sequentially.
  //   2. Slice into batches of ≈ one "round" (one job per store).
  //      After each batch we update the progress counter in session storage
  //      so the popup re-renders with the current count.
  type IframeResult = { storeId: string; retailerProductId: string; price: number | null; available: boolean };
  const iframeByStore = new Map<string, Map<string, { price: number | null; available: boolean }>>();

  if (iframeJobs.length > 0 && icaTabId !== null) {
    // Global interleave
    const byStoreMap = new Map<string, typeof iframeJobs>();
    for (const job of iframeJobs) {
      if (!byStoreMap.has(job.storeId)) byStoreMap.set(job.storeId, []);
      byStoreMap.get(job.storeId)!.push(job);
    }
    const queues = [...byStoreMap.values()];
    const maxQ = Math.max(...queues.map((q) => q.length));
    const globalInterleaved: typeof iframeJobs = [];
    for (let round = 0; round < maxQ; round++) {
      for (const q of queues) {
        if (round < q.length) globalInterleaved.push(q[round]);
      }
    }

    // Batch size = one "round" (≈ one job per store) for natural progress steps
    const batchSize = Math.max(storeBulkData.length, 1);
    let iframeDone = 0;

    for (let batchStart = 0; batchStart < globalInterleaved.length; batchStart += batchSize) {
      await persistComparisonProgress({
        status: "running",
        step: "iframe_fallback",
        current: iframeDone,
        total: globalInterleaved.length,
        detail: `Söker priser i butiker…`,
      });

      const batch = globalInterleaved.slice(batchStart, batchStart + batchSize);
      try {
        const injected = await chrome.scripting.executeScript({
          target: { tabId: icaTabId },
          world: "MAIN",
          func: iframeLookupInMainWorld,
          args: [batch],
        });
        for (const r of (injected[0]?.result ?? []) as IframeResult[]) {
          if (!iframeByStore.has(r.storeId)) iframeByStore.set(r.storeId, new Map());
          iframeByStore.get(r.storeId)!.set(r.retailerProductId, { price: r.price, available: r.available });
        }
      } catch {
        // batch failed — continue with next
      }
      iframeDone += batch.length;
    }

    // Final tick so the bar reaches 100 %
    await persistComparisonProgress({
      status: "running",
      step: "iframe_fallback",
      current: iframeDone,
      total: globalInterleaved.length,
      detail: `Söker priser i butiker…`,
    });
  }

  // Build final store prices (bulk + iframe merged via buildStorePrice)
  const storePrices = storeBulkData.map(({ store, products }) =>
    buildStorePrice(store, productMatches, products, iframeByStore.get(store.accountId))
  );

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
      const storeId: string | null =
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
      const result = await chrome.storage.local.get(["ica_rebuild_cart"]);
      const raw = result.ica_rebuild_cart;
      const data =
        typeof raw === "string" && raw.length > 0 ? JSON.parse(raw) : null;
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
