import React from "react";
import type {
  ComparisonResult,
  StorePrice,
  RebuildItem,
  RebuildSessionState,
} from "../api/types";

function RebuildProgressPanel({ state }: { state: RebuildSessionState }) {
  if (state.status === "running") {
    const pct =
      state.total > 0 ? Math.min(100, Math.round((state.current / state.total) * 100)) : 0;
    return (
      <div className="rounded-lg border border-gray-200 bg-gray-50 p-3 space-y-2">
        <p className="text-xs text-gray-700">
          Lägger till varor i{" "}
          <span className="font-semibold text-gray-900">{state.storeName}</span>
          …
        </p>
        <div className="h-2.5 bg-gray-200 rounded-full overflow-hidden">
          <div
            className="h-full bg-[#1a5c2e] transition-[width] duration-300 ease-out"
            style={{ width: `${pct}%` }}
          />
        </div>
        <div className="flex justify-between text-[11px] text-gray-500 tabular-nums">
          <span>
            {state.current}/{state.total} varor
          </span>
          <span>{pct}%</span>
        </div>
        {state.itemName ? (
          <p className="text-xs text-gray-800 truncate" title={state.itemName}>
            {state.itemName}
            {state.itemStatus === "not_found" && (
              <span className="text-amber-700 ml-1">— hittades inte</span>
            )}
          </p>
        ) : null}
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-green-200 bg-green-50/80 p-3 text-xs text-green-950 space-y-1">
      <p className="font-semibold">Återskapning klar</p>
      <p>
        {state.added} varor tillagda i {state.storeName}
        {state.failed > 0 ? ` · ${state.failed} kunde inte läggas till` : ""}
      </p>
      {state.failedItems.length > 0 ? (
        <p className="text-amber-900 leading-snug">
          Saknas: {state.failedItems.slice(0, 6).join(", ")}
          {state.failedItems.length > 6 ? " …" : ""}
        </p>
      ) : null}
    </div>
  );
}

const FORMAT_LABEL: Record<string, string> = {
  kvantum: "Kvantum",
  maxi: "Maxi",
  nara: "Nära",
  supermarket: "Supermarket",
};

function formatPrice(amount: number): string {
  return amount.toLocaleString("sv-SE", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function StoreFormatBadge({ format }: { format: string }) {
  const colors: Record<string, string> = {
    kvantum: "bg-blue-100 text-blue-700",
    maxi: "bg-purple-100 text-purple-700",
    nara: "bg-green-100 text-green-700",
    supermarket: "bg-orange-100 text-orange-700",
  };
  const cls = colors[format.toLowerCase()] ?? "bg-gray-100 text-gray-600";
  return (
    <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded ${cls}`}>
      {FORMAT_LABEL[format.toLowerCase()] ?? format}
    </span>
  );
}

export default function StoreComparison({
  result,
  rebuildState,
  cartStale,
  comparisonUpdatedAt,
  onRefreshComparison,
  liveStoreId,
  includeDelivery,
}: {
  result: ComparisonResult;
  rebuildState: RebuildSessionState | null;
  cartStale: boolean;
  comparisonUpdatedAt: number | null;
  onRefreshComparison: () => void;
  liveStoreId: string | null;
  includeDelivery: boolean;
}) {
  const { cartItems, stores, currentStoreId, cheapestStoreId, savingVsCurrent, actualCartTotal } =
    result;

  const resolvableCount = cartItems.filter((i) => !!i.retailerProductId).length;
  const threshold = resolvableCount > 0 ? resolvableCount : cartItems.length;

  /** Effective total for a store — adds delivery cost when toggle is on */
  function effectiveTotal(store: StorePrice): number {
    return includeDelivery && store.deliveryCost !== undefined
      ? store.totalPrice + store.deliveryCost
      : store.totalPrice;
  }

  /** Re-sort stores: full stores first by effectiveTotal, incomplete stores last */
  const sortedStores = includeDelivery
    ? [...stores].sort((a, b) => {
        const aFull = a.availableCount >= threshold;
        const bFull = b.availableCount >= threshold;
        if (aFull !== bFull) return aFull ? -1 : 1;
        return effectiveTotal(a) - effectiveTotal(b);
      })
    : stores;

  // Use the user's live store (if it's in the results) as the "current" store
  // so the savings banner always reflects where they are right now.
  const liveStore = liveStoreId ? sortedStores.find((s) => s.storeId === liveStoreId) : undefined;
  const displayCurrentStore = liveStore ?? sortedStores.find((s) => s.storeId === currentStoreId);

  // When delivery is included, recompute cheapest from sorted stores.
  // Otherwise use cheapestStoreId from the comparison result.
  const cheapestStore = includeDelivery
    ? sortedStores.find((s) => s.availableCount >= threshold)
    : sortedStores.find((s) => s.storeId === cheapestStoreId);
  const cheapestPrice = cheapestStore ? effectiveTotal(cheapestStore) : undefined;

  // Savings relative to where the user is now (0 if they're already at cheapest).
  const displaySaving =
    displayCurrentStore && cheapestStore && cheapestStore.storeId !== displayCurrentStore.storeId
      ? Math.max(0, effectiveTotal(displayCurrentStore) - effectiveTotal(cheapestStore))
      : 0;

  // True when the user's store is tied in price with the cheapest store but
  // isn't the one designated as cheapest (alphabetical tiebreak).
  const isTiedWithCheapest =
    displayCurrentStore !== undefined &&
    cheapestPrice !== undefined &&
    effectiveTotal(displayCurrentStore) === cheapestPrice &&
    displayCurrentStore.storeId !== cheapestStore?.storeId;

  // hasHiddenDeals is still based on the original home store (actualCartTotal
  // comes from the home-store cart API and is fixed at comparison time).
  const currentStore = stores.find((s) => s.storeId === currentStoreId);
  const hasHiddenDeals =
    currentStore !== undefined &&
    actualCartTotal < currentStore.totalPrice - 0.01;

  function openCart(store: StorePrice) {
    const items: RebuildItem[] = cartItems.map((i) => ({
      productId: i.productId,
      retailerProductId: i.retailerProductId,
      quantity: i.quantity,
      name: i.name,
    }));
    chrome.runtime.sendMessage(
      {
        type: "OPEN_CHEAPEST_CART",
        items,
        targetStoreId: store.storeId,
        targetStoreName: store.storeName,
      },
      () => {}
    );
  }

  const updatedLabel =
    comparisonUpdatedAt !== null
      ? new Date(comparisonUpdatedAt).toLocaleTimeString("sv-SE", {
          hour: "2-digit",
          minute: "2-digit",
        })
      : null;

  return (
    <div className="space-y-4">
      {cartStale && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 space-y-2">
          <p className="text-xs text-amber-900">
            Korgen har ändrats sedan senaste jämförelsen.
          </p>
          <button
            type="button"
            onClick={onRefreshComparison}
            className="text-xs font-semibold text-amber-900 underline hover:text-amber-950"
          >
            Kör om jämförelse
          </button>
        </div>
      )}

      {updatedLabel && (
        <div className="flex items-center justify-between text-xs text-gray-500">
          <span>Uppdaterad {updatedLabel}</span>
          <button
            type="button"
            onClick={onRefreshComparison}
            className="font-medium text-[#e3000b] hover:underline"
          >
            Uppdatera
          </button>
        </div>
      )}

      {/* Summary banner — always based on the user's current live store */}
      {displaySaving > 0 && cheapestStore ? (
        <div className="bg-green-50 border border-green-200 rounded-xl p-4 space-y-3">
          <div className="flex items-baseline gap-1.5">
            <span className="text-2xl font-bold text-green-700">
              {formatPrice(displaySaving)} kr
            </span>
            <span className="text-sm text-green-600">att spara</span>
          </div>
          <p className="text-xs text-green-700">
            Handla hos{" "}
            <span className="font-semibold">{cheapestStore.storeName}</span>{" "}
            istället för {displayCurrentStore?.storeName ?? "nuvarande butik"}
          </p>
          <button
            onClick={() => openCart(cheapestStore)}
            className="w-full bg-[#1a5c2e] hover:bg-[#154d26] text-white text-sm font-semibold py-2 px-3 rounded-lg transition-colors"
          >
            Öppna billigaste varukorg →
          </button>
        </div>
      ) : (
        <div className="bg-blue-50 border border-blue-100 rounded-xl p-3 space-y-1">
          <p className="text-sm font-medium text-blue-800">
            {isTiedWithCheapest
              ? "Du handlar i en av de billigaste butikerna!"
              : "Du handlar redan i den billigaste butiken!"}
          </p>
          <p className="text-[11px] text-blue-600">
            Du kan ändå öppna korgen i en annan butik via listan nedan.
          </p>
        </div>
      )}

      {rebuildState && <RebuildProgressPanel state={rebuildState} />}

      {/* Hidden-deals info */}
      {hasHiddenDeals && (
        <div className="rounded-lg border border-blue-100 bg-blue-50 px-3 py-2 text-[11px] text-blue-800 leading-snug space-y-0.5">
          <p>
            <span className="font-semibold">Din korg kostar faktiskt {formatPrice(actualCartTotal)} kr</span>
            {" "}(inkl. stammispris &amp; flerkampanjer).
          </p>
          <p className="text-blue-600">
            Jämförelsepriser baseras på katalog — faktisk besparing kan vara större.
          </p>
        </div>
      )}

      {/* Store list */}
      <div className="space-y-1.5">
        <h2 className="text-xs font-semibold text-gray-500 uppercase tracking-wider">
          Butiker ({sortedStores.length})
        </h2>
        {sortedStores.map((store, idx) => (
          <StoreRow
            key={store.storeId}
            store={store}
            rank={idx + 1}
            isCurrent={store.storeId === currentStoreId}
            isCheapest={cheapestPrice !== undefined && effectiveTotal(store) === cheapestPrice && store.availableCount >= threshold}
            totalItems={cartItems.length}
            cartItems={cartItems}
            onOpenCart={openCart}
            includeDelivery={includeDelivery}
            effectiveTotal={effectiveTotal(store)}
          />
        ))}
      </div>

      {/* Product breakdown */}
      <ProductTable cartItems={cartItems} stores={stores} />
    </div>
  );
}

function StoreRow({
  store,
  rank,
  isCurrent,
  isCheapest,
  totalItems,
  cartItems,
  onOpenCart,
  includeDelivery,
  effectiveTotal,
}: {
  store: StorePrice;
  rank: number;
  isCurrent: boolean;
  isCheapest: boolean;
  totalItems: number;
  cartItems: ComparisonResult["cartItems"];
  onOpenCart: (store: StorePrice) => void;
  includeDelivery: boolean;
  effectiveTotal: number;
}) {
  // Find which specific products are unavailable in this store
  const missingItems = cartItems.filter((item) => {
    const p = store.products.find((sp) => sp.productId === item.productId);
    return !p?.available;
  });

  // Items without retailerProductId can't be cross-store matched — group them
  // into a single summary line instead of repeating "Okänd vara" for every store.
  const knownMissing = missingItems.filter((item) => !!item.retailerProductId);
  const unknownMissing = missingItems.filter((item) => !item.retailerProductId);

  // "saknas" only counts items we could look up but didn't find — not unresolvable items
  // (those are already shown as "kan inte jämföras" and shouldn't double-count as missing).
  const missingCount = knownMissing.length;
  const unknownPrice = unknownMissing.reduce(
    (sum, item) => sum + (item.currentPrice ?? 0) * item.quantity,
    0
  );

  return (
    <div
      className={`rounded-lg border px-3 py-2 ${
        isCheapest
          ? "border-green-300 bg-green-50"
          : isCurrent
          ? "border-blue-200 bg-blue-50"
          : "border-gray-100 bg-white"
      }`}
    >
      <div className="flex items-center justify-between gap-2">
        {/* Left: rank + store info */}
        <div className="min-w-0 flex items-start gap-2">
          <span className="text-[11px] text-gray-400 font-mono tabular-nums mt-0.5 shrink-0">
            #{rank}
          </span>
          <div className="min-w-0">
            <div className="flex items-center gap-1.5 flex-wrap">
              <span className="text-sm font-medium text-gray-900 truncate">
                {store.storeName}
              </span>
              <StoreFormatBadge format={store.storeFormat} />
              {isCurrent && (
                <span className="text-[10px] bg-blue-200 text-blue-800 px-1.5 py-0.5 rounded font-medium">
                  Din butik
                </span>
              )}
              {isCheapest && (
                <span className="text-[10px] bg-green-200 text-green-800 px-1.5 py-0.5 rounded font-medium">
                  Billigast
                </span>
              )}
            </div>
            {missingItems.length > 0 && (
              <div className="mt-0.5 space-y-0.5">
                {knownMissing.map((item) => (
                  <p key={item.productId} className="text-[10px] text-amber-600 leading-tight">
                    Saknas: {item.name}
                    {item.currentPrice !== null
                      ? ` (${formatPrice(item.currentPrice)} kr)`
                      : ""}
                  </p>
                ))}
                {unknownMissing.length > 0 && (
                  <p className="text-[10px] text-gray-400 leading-tight">
                    {unknownMissing.length} vara{unknownMissing.length > 1 ? "r" : ""} kan inte jämföras
                    {unknownPrice > 0 ? ` (${formatPrice(unknownPrice)} kr i din butik)` : ""}
                  </p>
                )}
              </div>
            )}
          </div>
        </div>

        {/* Right: price + open button */}
        <div className="text-right shrink-0 flex flex-col items-end gap-1">
          <p className="text-sm font-bold text-gray-900">
            {formatPrice(includeDelivery ? effectiveTotal : store.totalPrice)} kr
          </p>
          {includeDelivery && store.deliveryCost !== undefined && store.deliveryCost > 0 && (
            <p className="text-[10px] text-gray-400">
              inkl. {formatPrice(store.deliveryCost)} kr frakt
            </p>
          )}
          {includeDelivery && store.deliveryCost === 0 && (
            <p className="text-[10px] text-green-600">Fri frakt</p>
          )}
          {missingCount > 0 && (
            <p className="text-[10px] text-amber-600">
              {missingCount} vara{missingCount !== 1 ? "r" : ""} saknas
            </p>
          )}
          <button
            onClick={() => onOpenCart(store)}
            className="text-[11px] text-gray-400 hover:text-[#1a5c2e] font-medium transition-colors leading-none"
            title={`Öppna varukorg hos ${store.storeName}`}
          >
            Öppna →
          </button>
        </div>
      </div>
    </div>
  );
}

function ProductTable({
  cartItems,
  stores,
}: {
  cartItems: ComparisonResult["cartItems"];
  stores: StorePrice[];
}) {
  const [expanded, setExpanded] = React.useState(false);

  if (!expanded) {
    return (
      <button
        onClick={() => setExpanded(true)}
        className="w-full text-xs text-gray-500 underline hover:text-gray-700 py-1"
      >
        Visa detaljerad produktjämförelse ({cartItems.length} varor)
      </button>
    );
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <h2 className="text-xs font-semibold text-gray-500 uppercase tracking-wider">
          Produkter
        </h2>
        <button
          onClick={() => setExpanded(false)}
          className="text-xs text-gray-400 hover:text-gray-600"
        >
          Dölj
        </button>
      </div>
      <div className="overflow-x-auto rounded-lg border border-gray-200">
        <table className="text-xs w-full">
          <thead>
            <tr className="bg-gray-50 border-b border-gray-200">
              <th className="text-left py-2 px-3 font-medium text-gray-600 min-w-[120px]">
                Produkt
              </th>
              {stores.map((s) => (
                <th
                  key={s.storeId}
                  className="text-right py-2 px-2 font-medium text-gray-600 min-w-[70px]"
                >
                  {s.storeName.split(" ")[0]}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {cartItems.map((item) => {
              const prices = stores
                .map((s) => {
                  const p = s.products.find((p) => p.productId === item.productId);
                  return p?.price ?? null;
                })
                .filter((p): p is number => p !== null);
              const minPrice = prices.length ? Math.min(...prices) : null;

              return (
                <tr
                  key={item.productId}
                  className="border-b border-gray-100 last:border-0 hover:bg-gray-50"
                >
                  <td className="py-2 px-3 text-gray-800">
                    <div>{item.name}</div>
                    {item.quantity > 1 && (
                      <div className="text-gray-400">×{item.quantity}</div>
                    )}
                  </td>
                  {stores.map((s) => {
                    const p = s.products.find(
                      (p) => p.productId === item.productId
                    );
                    const price = p?.price ?? null;
                    const isCheapest = price !== null && price === minPrice;
                    const onSale = p?.available && p.ordinaryPrice !== null;
                    return (
                      <td
                        key={s.storeId}
                        className={`py-2 px-2 text-right ${
                          !p?.available
                            ? "text-gray-300"
                            : isCheapest
                            ? "text-green-700 font-semibold"
                            : "text-gray-700"
                        }`}
                      >
                        {p?.available && price !== null ? (
                          <>
                            {formatPrice(price)}
                            {onSale && (
                              <div className="text-[10px] text-gray-400 line-through font-normal">
                                {formatPrice(p.ordinaryPrice!)}
                              </div>
                            )}
                          </>
                        ) : "–"}
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
          <tfoot>
            <tr className="bg-gray-50 border-t border-gray-200 font-semibold">
              <td className="py-2 px-3 text-gray-700">Totalt</td>
              {stores.map((s) => (
                <td key={s.storeId} className="py-2 px-2 text-right text-gray-900">
                  {formatPrice(s.totalPrice)}
                </td>
              ))}
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
  );
}
