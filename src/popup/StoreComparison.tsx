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
}: {
  result: ComparisonResult;
  rebuildState: RebuildSessionState | null;
  cartStale: boolean;
  comparisonUpdatedAt: number | null;
  onRefreshComparison: () => void;
}) {
  const { cartItems, stores, currentStoreId, cheapestStoreId, savingVsCurrent } =
    result;

  const currentStore = stores.find((s) => s.storeId === currentStoreId);
  const cheapestStore = stores.find((s) => s.storeId === cheapestStoreId);

  function openCheapestCart() {
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
        targetStoreId: cheapestStoreId,
        targetStoreName: cheapestStore?.storeName,
      },
      () => {
        /* wait for ack before popup closes */
      }
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

      {/* Summary banner */}
      {savingVsCurrent > 0 && cheapestStore && (
        <div className="bg-green-50 border border-green-200 rounded-lg p-3 space-y-2">
          <p className="text-sm font-semibold text-green-800">
            Du kan spara{" "}
            <span className="text-green-600">{formatPrice(savingVsCurrent)} kr</span>
          </p>
          <p className="text-xs text-green-700">
            Handla hos {cheapestStore.storeName} istället för{" "}
            {currentStore?.storeName ?? "nuvarande butik"}
          </p>
          <button
            onClick={openCheapestCart}
            className="w-full bg-green-600 hover:bg-green-700 text-white text-xs font-semibold py-1.5 px-3 rounded transition-colors"
          >
            Öppna billigaste korgen →
          </button>
        </div>
      )}

      {savingVsCurrent === 0 && (
        <div className="bg-blue-50 border border-blue-100 rounded-lg p-3">
          <p className="text-sm text-blue-800">
            Du handlar redan i den billigaste butiken!
          </p>
        </div>
      )}

      {rebuildState && <RebuildProgressPanel state={rebuildState} />}

      {/* Store list */}
      <div className="space-y-2">
        <h2 className="text-xs font-semibold text-gray-500 uppercase tracking-wider">
          Butiker ({stores.length})
        </h2>
        {stores.map((store) => (
          <StoreRow
            key={store.storeId}
            store={store}
            isCurrent={store.storeId === currentStoreId}
            isCheapest={store.storeId === cheapestStoreId}
            totalItems={cartItems.length}
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
  isCurrent,
  isCheapest,
  totalItems,
}: {
  store: StorePrice;
  isCurrent: boolean;
  isCheapest: boolean;
  totalItems: number;
}) {
  const missingCount = totalItems - store.availableCount;

  return (
    <div
      className={`rounded-lg border px-3 py-2.5 flex items-center justify-between gap-2 ${
        isCheapest
          ? "border-green-300 bg-green-50"
          : isCurrent
          ? "border-blue-200 bg-blue-50"
          : "border-gray-200 bg-white"
      }`}
    >
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
        {missingCount > 0 && (
          <p className="text-[10px] text-amber-600 mt-0.5">
            {missingCount} vara{missingCount !== 1 ? "r" : ""} saknas
          </p>
        )}
      </div>
      <div className="text-right shrink-0">
        <p className="text-sm font-bold text-gray-900">
          {formatPrice(store.totalPrice)} kr
        </p>
        {missingCount > 0 && (
          <p className="text-[10px] text-gray-400">inkl. tillgängliga</p>
        )}
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
              // Find cheapest price across stores for this product
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
