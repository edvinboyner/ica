import {
  fetchStoresForZip,
  fetchActiveCart,
  fetchAllProductsForStore,
} from "../api/icaClient";
import {
  buildProductMatches,
  buildStorePrice,
  buildComparisonResult,
  effectivePrice,
} from "../utils/priceComparison";
import type {
  StoredState,
  ComparisonResult,
  RebuildSessionState,
  ComparisonSessionCache,
  ComparisonProgressState,
  Product,
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

// ─── Direct search-API lookup (injected into MAIN world via chrome.scripting) ─

/**
 * Self-contained function injected via chrome.scripting.executeScript world:"MAIN".
 * Must not reference any module-level variables — Chrome serialises it via .toString().
 *
 * Replaces the old iframe approach: instead of loading full SPA pages we call
 * ICA's v6 search endpoint directly via fetch(). Running in MAIN world means
 * the request is same-origin with session cookies → no WAF issues, no DOM work.
 *
 * Endpoint: /stores/{id}/api/webproductpagews/v6/product-pages/search
 * Returns `decoratedProducts` with a `promotions` array that includes stammis /
 * multi-buy deals ("2 för 135 kr", "6 för 20 kr" etc.).
 *
 * Uses a flat worker-pool so at most MAX_CONCURRENT requests are in-flight at
 * once — JS is single-threaded so nextIndex++ is race-free.
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
  const MAX_CONCURRENT = 30;

  const results: Array<{
    storeId: string;
    retailerProductId: string;
    price: number | null;
    available: boolean;
  }> = jobs.map((j) => ({
    storeId: j.storeId,
    retailerProductId: j.retailerProductId,
    price: null,
    available: false,
  }));

  let nextIndex = 0;

  async function worker() {
    while (true) {
      const i = nextIndex++;
      if (i >= jobs.length) break;
      const job = jobs[i];
      try {
        // Use first 2 letter-starting words as search term — more specific than
        // a single word but still broad enough for the API to return a match.
        // Single-word searches like "Kaffe" can return 30 unrelated products and
        // miss the specific item (e.g. "Kaffe Ebony Mörkrost 450g Gevalia").
        // We filter out tokens starting with digits (weights: "450g", "33cl", "1-pack").
        const parts = job.productName
          .split(/\s+/)
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          .filter((w: any) => /^[a-zA-ZåäöÅÄÖ]/.test(w));
        const q = encodeURIComponent(parts.slice(0, 2).join(" ") || job.productName);
        const url =
          `/stores/${job.storeId}/api/webproductpagews/v6/product-pages/search` +
          `?q=${q}&maxPageSize=30&maxProductsToDecorate=30&tag=web`;
        const resp = await fetch(url, { credentials: "include" });
        if (!resp.ok) continue;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const data: any = await resp.json();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const products: any[] = (data.productGroups ?? []).flatMap(
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (g: any) => g.decoratedProducts ?? g.products ?? []
        );
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const match: any = products.find(
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (p: any) => p.retailerProductId === job.retailerProductId
        );
        if (!match) continue;

        // Take the lower of price.amount (regular shelf) and price.current.amount
        // (active campaign price), if both are present in the v6 response.
        // price.current.amount captures single-item stammispriser ("20 kr/st") for
        // products not in the bulk catalogue — where Math.min(catalog, fetch)
        // cannot help since catalogPrice would be null.
        const regularRaw: string = match.price?.amount ?? "";
        const currentRaw: string = match.price?.current?.amount ?? "";
        const regularAmount = parseFloat(regularRaw);
        const currentAmount = parseFloat(currentRaw);
        let price: number | null =
          isFinite(regularAmount) && regularAmount >= 0 ? regularAmount : null;
        if (isFinite(currentAmount) && currentAmount >= 0) {
          price = price !== null ? Math.min(price, currentAmount) : currentAmount;
        }

        // Check promotions for deals. Two formats handled:
        //   "N för X kr"  — multi-buy stammis/campaigns ("2 för 135 kr")
        //   "X kr/st"     — single-unit named campaigns ("20 kr/st", "54,90 kr/st")
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        for (const promo of (match.promotions ?? []) as any[]) {
          const desc: string = promo.description ?? "";
          const requiredQty: number = promo.requiredProductQuantity ?? 0;

          // "N för X kr" — only apply when cart quantity meets the group threshold
          if (requiredQty > 0 && job.quantity >= requiredQty) {
            const m = desc.match(/\d+\s+f\u00f6r\s+([\d,.]+)\s*kr/i);
            if (m) {
              const totalForGroup = parseFloat(m[1].replace(",", "."));
              if (isFinite(totalForGroup) && totalForGroup > 0) {
                const dealPerUnit = totalForGroup / requiredQty;
                if (price === null || dealPerUnit < price) price = dealPerUnit;
              }
            }
          }

          // "X kr/st" — single-unit named campaign, always applicable
          const mPerUnit = desc.match(/([\d,.]+)\s*kr\s*\/\s*st/i);
          if (mPerUnit) {
            const unitPrice = parseFloat(mPerUnit[1].replace(",", "."));
            if (isFinite(unitPrice) && unitPrice > 0 && (price === null || unitPrice < price)) {
              price = unitPrice;
            }
          }
        }

        results[i] = {
          storeId: job.storeId,
          retailerProductId: job.retailerProductId,
          price,
          available: match.available === true && price !== null,
        };
      } catch {
        /* leave as { price: null, available: false } */
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(MAX_CONCURRENT, jobs.length) }, worker)
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

// ─── Fast cart rebuild (injected into MAIN world) ─────────────────────────────

/**
 * Self-contained — injected via chrome.scripting.executeScript world:"MAIN".
 * Calls ICA's apply-quantity API directly instead of simulating DOM clicks.
 * All items are sent in a single POST → rebuild completes in ~1 second.
 *
 * Auth: CSRF token + session cookies available in MAIN world (same-origin).
 * After success, navigates the tab to the target store so the user sees
 * their new cart immediately.
 */
async function applyCartInMainWorld(
  items: Array<{ productId: string; quantity: number; name: string }>,
  storeId: string,
  storeName: string
): Promise<void> {
  function showOverlay(msg: string) {
    let el = document.getElementById("ica-rebuild-overlay");
    if (!el) {
      el = document.createElement("div");
      el.id = "ica-rebuild-overlay";
      el.style.cssText = [
        "position:fixed", "top:16px", "right:16px", "z-index:99999",
        "background:#1a5c2e", "color:#fff", "padding:12px 16px",
        "border-radius:8px", "font:14px/1.4 system-ui,sans-serif",
        "box-shadow:0 4px 12px rgba(0,0,0,.25)", "max-width:320px",
        "white-space:pre-line",
      ].join(";");
      document.body.appendChild(el);
    }
    el.textContent = msg;
  }

  function removeOverlay() {
    document.getElementById("ica-rebuild-overlay")?.remove();
  }

  function post(msg: object) {
    window.postMessage({ __icaExt: true, ...msg }, "*");
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const state = (window as any).__INITIAL_STATE__;
  const csrf: string = state?.session?.csrf?.token ?? "";
  const version: string = state?.session?.metadata?.assetVersion ?? "";

  post({ type: "REBUILD_STARTED", total: items.length, storeName });
  showOverlay(`Bygger varukorg hos ${storeName}…`);

  if (!csrf) {
    post({
      type: "REBUILD_COMPLETE",
      added: 0,
      failed: items.length,
      failedItems: items.map((i) => i.name),
    });
    showOverlay("Saknar autentisering — besök handlaprivatkund.ica.se och logga in.");
    setTimeout(removeOverlay, 6000);
    return;
  }

  try {
    const resp = await fetch(
      `/stores/${storeId}/api/cart/v1/carts/active/apply-quantity`,
      {
        method: "POST",
        credentials: "include",
        headers: {
          "Content-Type": "application/json",
          "X-CSRF-TOKEN": csrf,
          "ecom-request-source": "web",
          ...(version ? { "ecom-request-source-version": version } : {}),
        },
        body: JSON.stringify(
          items.map((i) => ({ productId: i.productId, quantity: i.quantity }))
        ),
      }
    );

    if (resp.ok) {
      post({ type: "REBUILD_COMPLETE", added: items.length, failed: 0, failedItems: [] });
      showOverlay(`✓ Varukorg skapad hos ${storeName}!`);
      setTimeout(removeOverlay, 3000);
      // Navigate tab to target store so the user sees their new cart
      setTimeout(() => { window.location.href = `/stores/${storeId}`; }, 800);
    } else {
      throw new Error(`HTTP ${resp.status}`);
    }
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : "okänt fel";
    post({
      type: "REBUILD_COMPLETE",
      added: 0,
      failed: items.length,
      failedItems: items.map((i) => i.name),
    });
    showOverlay(`Fel vid återskapning:\n${errMsg}`);
    setTimeout(removeOverlay, 8000);
  }
}

/**
 * Self-contained: reads name + retailerProductId for given productIds.
 *
 * Checks three Redux state paths in priority order:
 *   1. data.products.productEntities — ICA's SPA loads all cart-item product
 *      data here on init; covers most products.
 *   2. data.basket.items (+ common aliases) — the active cart in Redux state;
 *      contains retailerProductId for items not yet in productEntities
 *      (e.g. newly added items, non-standard catalog products).
 *   3. Fallback: returns null for both fields (will show as unavailable).
 */
function readProductEntitiesInMainWorld(
  productIds: string[]
): Array<{ productId: string; retailerProductId: string | null; name: string | null }> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const state = (window as any).__INITIAL_STATE__;

  // Path 1: productEntities (keyed by productId)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const entities: Record<string, any> = state?.data?.products?.productEntities ?? {};

  // Path 2: basket items — try several known Redux state shapes
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const basketItems: any[] =
    state?.data?.basket?.items ??
    state?.data?.cart?.items ??
    state?.basket?.items ??
    state?.cart?.items ??
    [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const basketMap = new Map<string, any>();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  for (const bi of basketItems as any[]) {
    const pid = bi.productId ?? bi.id;
    if (pid) basketMap.set(pid, bi);
  }

  return productIds.map((id) => {
    const entity = entities[id];
    const bi = basketMap.get(id);
    const retailerProductId =
      entity?.retailerProductId ??
      bi?.retailerProductId ??
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (bi?.product as any)?.retailerProductId ??
      null;
    const name =
      entity?.name ??
      bi?.name ??
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (bi?.product as any)?.name ??
      bi?.title ??
      null;
    return { productId: id, retailerProductId, name };
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
          if (item) {
            // Update retailerProductId and name independently — a product may
            // have a known name but still lack retailerProductId (or vice versa).
            if (e.retailerProductId) item.retailerProductId = e.retailerProductId;
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
  //   2. Items WITH a member/ICA-card discount (finalPrice < price in cart)
  //   3. Items where the bulk catalog price > the cart's actual price — this
  //      catches named campaign deals like "20 kr/st" where ICA's cart API
  //      returns the deal price directly as price.amount (no separate finalPrice),
  //      so hasMemberDiscount is never set, yet the v5 bulk catalog shows the
  //      regular shelf price for non-featured campaign variants (e.g. Yoghurt
  //      Skogsbär when only Jordgubb is the "featured" campaign product).
  // Deduplicate per (storeId, retailerProductId) to avoid double lookups.
  type IframeJob = { storeId: string; productName: string; retailerProductId: string; quantity: number };
  const iframeJobs: IframeJob[] = [];
  const addedIframeKeys = new Set<string>();
  for (const { store, products } of storeBulkData) {
    const bulkRids = new Set(
      products.map((p) => p.retailerProductId).filter((id): id is string => !!id)
    );
    // Build retailerProductId → Product map for catalog-vs-cart price check
    const bulkMap = new Map<string, Product>();
    for (const p of products) {
      if (p.retailerProductId) bulkMap.set(p.retailerProductId, p);
    }
    for (const item of productMatches) {
      if (!item.retailerProductId) continue;
      const notInBulk = !bulkRids.has(item.retailerProductId);
      const needsMemberPrice = item.hasMemberDiscount === true;

      // Trigger search when catalog effective price exceeds the cart price
      // by more than 1 cent — the catalog may be showing regular price while
      // the customer's actual price includes a named campaign discount.
      let catalogMissesDiscount = false;
      if (!notInBulk && item.currentPrice !== null) {
        const bp = bulkMap.get(item.retailerProductId);
        if (bp) {
          const ep = effectivePrice(bp);
          if (ep !== null && ep > item.currentPrice + 0.01) {
            catalogMissesDiscount = true;
          }
        }
      }

      if (notInBulk || needsMemberPrice || catalogMissesDiscount) {
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
    // The search-API lookup handles its own concurrency (30 parallel fetch calls).
    // One executeScript call is enough — no external batching needed.
    await persistComparisonProgress({
      status: "running",
      step: "iframe_fallback",
      current: 0,
      total: iframeJobs.length,
      detail: `Söker kampanjpriser för ${iframeJobs.length} varor/butiker…`,
    });
    try {
      const injected = await chrome.scripting.executeScript({
        target: { tabId: icaTabId },
        world: "MAIN",
        func: iframeLookupInMainWorld,
        args: [iframeJobs],
      });
      for (const r of (injected[0]?.result ?? []) as IframeResult[]) {
        if (!iframeByStore.has(r.storeId)) iframeByStore.set(r.storeId, new Map());
        iframeByStore.get(r.storeId)!.set(r.retailerProductId, { price: r.price, available: r.available });
      }
    } catch {
      /* search step failed — continue with bulk-only results */
    }
    await persistComparisonProgress({
      status: "running",
      step: "iframe_fallback",
      current: iframeJobs.length,
      total: iframeJobs.length,
      detail: `Söker kampanjpriser för ${iframeJobs.length} varor/butiker…`,
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

    if (message.type === "SAVE_ZIP") {
      await saveState({ zipCode: message.zipCode });
      sendResponse({ ok: true });
      return;
    }

    if (message.type === "OPEN_CHEAPEST_CART") {
      const { items, targetStoreId, targetStoreName } = message as {
        items: Array<{ productId: string; quantity: number; name: string }>;
        targetStoreId: string;
        targetStoreName?: string;
      };
      const storeName =
        typeof targetStoreName === "string" && targetStoreName.length > 0
          ? targetStoreName
          : "Butik";

      const existingTabId = await findIcaTabId();
      if (existingTabId !== null) {
        // Reuse the open ICA tab — fastest path, no navigation needed before inject
        chrome.scripting.executeScript({
          target: { tabId: existingTabId },
          world: "MAIN",
          func: applyCartInMainWorld,
          args: [items, targetStoreId, storeName],
        }).catch((e) => console.error("applyCartInMainWorld failed", e));
      } else {
        // No ICA tab open — create one at the target store and inject after load
        const tab = await chrome.tabs.create({
          url: `https://handlaprivatkund.ica.se/stores/${targetStoreId}`,
        });
        const listener = (changedTabId: number, info: { status?: string }) => {
          if (changedTabId !== tab.id || info.status !== "complete") return;
          chrome.tabs.onUpdated.removeListener(listener);
          chrome.scripting.executeScript({
            target: { tabId: tab.id! },
            world: "MAIN",
            func: applyCartInMainWorld,
            args: [items, targetStoreId, storeName],
          }).catch((e) => console.error("applyCartInMainWorld failed", e));
        };
        chrome.tabs.onUpdated.addListener(listener);
      }

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
