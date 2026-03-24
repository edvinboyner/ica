import type {
  CartItem,
  Product,
  Store,
  ProductMatch,
  StorePrice,
  ComparisonResult,
} from "../api/types";

/**
 * Returns the effective unit price — promoPrice when on sale, otherwise price.
 * ICA returns amounts as strings (e.g. "30.00"), so we parse them.
 */
export function effectivePrice(p: Product): number | null {
  const raw = p.promoPrice?.amount ?? p.price?.amount;
  return parseAmount(raw);
}

export function regularPrice(p: Product): number | null {
  return parseAmount(p.price?.amount);
}

/** Parse a price string or number to float, returns null if not valid */
function parseAmount(v: string | number | undefined | null): number | null {
  if (v == null) return null;
  const n = typeof v === "string" ? parseFloat(v) : v;
  return isFinite(n) && n >= 0 ? n : null;
}

export function buildProductMatches(cartItems: CartItem[]): ProductMatch[] {
  return cartItems.map((item) => {
    const currentPrice =
      parseAmount(item.finalPrice?.amount) ??
      parseAmount(item.price?.amount) ??
      null;

    return {
      productId: item.productId,
      retailerProductId: item.retailerProductId,
      name: item.name ?? item.productId,
      quantity: item.quantity,
      currentPrice,
    };
  });
}

export function buildStorePrice(
  store: Store,
  cartItems: ProductMatch[],
  storeProducts: Product[],
  iframeResults?: Map<string, { price: number | null; available: boolean }>
): StorePrice {
  // Key by retailerProductId (stable cross-store identifier)
  const productMap = new Map<string, Product>();
  for (const p of storeProducts) {
    if (p.retailerProductId) productMap.set(p.retailerProductId, p);
  }

  let total = 0;
  let availableCount = 0;

  const products = cartItems.map((item) => {
    const found = item.retailerProductId
      ? productMap.get(item.retailerProductId)
      : undefined;

    if (found) {
      const price = effectivePrice(found);
      if (price === null) {
        return { productId: item.productId, price: null, ordinaryPrice: null, available: false };
      }
      const reg = regularPrice(found);
      total += price * item.quantity;
      availableCount++;
      return {
        productId: item.productId,
        price,
        // Only set ordinaryPrice when there's an actual discount
        ordinaryPrice: reg !== null && reg > price ? reg : null,
        available: true,
      };
    }

    // Iframe-fallback for products not found in bulk catalog
    const ir = item.retailerProductId
      ? iframeResults?.get(item.retailerProductId)
      : undefined;
    if (ir && ir.available && ir.price !== null) {
      total += ir.price * item.quantity;
      availableCount++;
      return { productId: item.productId, price: ir.price, ordinaryPrice: null, available: true };
    }

    return { productId: item.productId, price: null, ordinaryPrice: null, available: false };
  });

  return {
    storeId: store.accountId,
    storeName: store.name,
    storeFormat: store.storeFormat,
    products,
    totalPrice: total,
    availableCount,
  };
}

export function buildComparisonResult(
  cartItems: ProductMatch[],
  stores: StorePrice[],
  currentStoreId: string
): ComparisonResult {
  // Only consider stores where all cart items are available for "cheapest"
  const fullStores = stores.filter(
    (s) => s.availableCount === cartItems.length
  );

  const ranked = [...fullStores].sort((a, b) => a.totalPrice - b.totalPrice);
  const cheapestStoreId = ranked[0]?.storeId ?? currentStoreId;

  const currentStore = stores.find((s) => s.storeId === currentStoreId);
  const cheapestStore = stores.find((s) => s.storeId === cheapestStoreId);

  const savingVsCurrent =
    currentStore && cheapestStore
      ? currentStore.totalPrice - cheapestStore.totalPrice
      : 0;

  return {
    cartItems,
    stores: [...stores].sort((a, b) => a.totalPrice - b.totalPrice),
    currentStoreId,
    cheapestStoreId,
    savingVsCurrent,
  };
}
