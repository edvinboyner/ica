import type {
  CartItem,
  Product,
  Store,
  ProductMatch,
  StorePrice,
  ComparisonResult,
} from "../api/types";

export function buildProductMatches(cartItems: CartItem[]): ProductMatch[] {
  return cartItems.map((item) => ({
    productId: item.productId,
    name: item.name ?? item.productId,
    quantity: item.quantity,
    currentPrice: item.totalPrices?.finalUnitPrice?.amount ?? null,
  }));
}

export function buildStorePrice(
  store: Store,
  cartItems: ProductMatch[],
  storeProducts: Product[]
): StorePrice {
  // Build a fast lookup map: productId -> product
  const productMap = new Map<string, Product>();
  for (const p of storeProducts) {
    productMap.set(p.productId, p);
  }

  let total = 0;
  let availableCount = 0;

  const products = cartItems.map((item) => {
    const found = productMap.get(item.productId);
    if (!found || found.price == null) {
      return { productId: item.productId, price: null, available: false };
    }
    const lineTotal = found.price.amount * item.quantity;
    total += lineTotal;
    availableCount++;
    return {
      productId: item.productId,
      price: found.price.amount,
      available: true,
    };
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
