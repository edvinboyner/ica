import type {
  StoreResponse,
  CartResponse,
  ProductPagesResponse,
  Store,
  CartItem,
  Product,
} from "./types";

const STORE_API_BASE = "https://handla.ica.se/api";
const SHOP_API_BASE = "https://handlaprivatkund.ica.se/stores";

async function apiFetch<T>(url: string): Promise<T> {
  const res = await fetch(url, {
    credentials: "include",
    headers: { Accept: "application/json" },
  });
  if (res.status === 401 || res.status === 403) throw new Error("NOT_LOGGED_IN");
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`);
  return res.json() as Promise<T>;
}

/** Parse delivery fee and free-delivery threshold from a store's marketing text. */
function parseDeliveryInfo(text: string | null | undefined): Pick<Store, "deliveryFee" | "freeDeliveryThreshold"> {
  if (!text) return {};
  const feeMatch = text.match(/plockavgift\s*(\d+)\s*kr/i);
  const thresholdMatch = text.match(/fri\s+frakt\s+vid\s+köp\s+över\s*([\d\s]+)\s*kr/i);
  return {
    deliveryFee: feeMatch ? parseInt(feeMatch[1], 10) : undefined,
    freeDeliveryThreshold: thresholdMatch
      ? parseInt(thresholdMatch[1].replace(/\s/g, ""), 10)
      : undefined,
  };
}

export async function fetchStoresForZip(zipCode: string): Promise<Store[]> {
  const url = `${STORE_API_BASE}/store/v1?zip=${zipCode}&customerType=B2C`;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const data = await apiFetch<{ forHomeDelivery: any[] }>(url);
  return data.forHomeDelivery
    .filter((s) => s.deliveryMethods?.includes("HOME_DELIVERY"))
    .map((s) => ({
      accountId: s.accountId,
      name: s.name,
      city: s.city,
      storeFormat: s.storeFormat,
      deliveryMethods: s.deliveryMethods,
      marketingText: s.marketingText ?? undefined,
      ...parseDeliveryInfo(s.marketingText),
    }));
}

/**
 * Fetch the product catalogue for a store using two parallel requests (tag=web + tag=lihp).
 * The endpoint always returns the same ~300 handpicked products regardless of offset/pagination,
 * so we run both tags in parallel and deduplicate on retailerProductId (~309 unique products).
 */
export async function fetchAllProductsForStore(storeId: string): Promise<Product[]> {
  const base =
    `${SHOP_API_BASE}/${storeId}/api/webproductpagews/v5/product-pages?limit=300&offset=0`;
  const [r1, r2] = await Promise.all([
    apiFetch<ProductPagesResponse>(`${base}&tag=web`).catch(() => null),
    apiFetch<ProductPagesResponse>(`${base}&tag=lihp`).catch(() => null),
  ]);

  const seen = new Set<string>();
  const products: Product[] = [];
  for (const data of [r1, r2]) {
    for (const g of data?.productGroups ?? []) {
      for (const pw of g.products ?? []) {
        if (!pw.product) continue;
        const key = pw.product.retailerProductId ?? pw.product.productId;
        if (!seen.has(key)) {
          seen.add(key);
          products.push(pw.product);
        }
      }
    }
  }
  return products;
}

export async function fetchActiveCart(storeId: string): Promise<CartItem[]> {
  const url = `${SHOP_API_BASE}/${storeId}/api/cart/v1/carts/active`;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const data = await apiFetch<any>(url);

  // Cart API returns only productId + quantity — no names.
  // Some ICA API versions nest product details under item.product; try both.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const items: CartItem[] = (data.items ?? []).map((i: any) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const nested: any = i.product ?? i.catalogItem ?? {};
    return {
      productId: i.productId ?? nested.productId,
      retailerProductId: i.retailerProductId ?? nested.retailerProductId ?? i.ean ?? nested.ean,
      name: i.name ?? nested.name ?? i.productName ?? nested.productName,
      quantity: typeof i.quantity === "object" ? (i.quantity.quantityInBasket ?? 1) : (i.quantity ?? 1),
      price: i.price ?? nested.price,
      finalPrice: i.finalPrice ?? nested.finalPrice,
    };
  });

  // Enrich with name + retailerProductId from the full product catalogue
  try {
    const allProducts = await fetchAllProductsForStore(storeId);
    const productMap = new Map<string, Product>();
    for (const p of allProducts) productMap.set(p.productId, p);
    for (const item of items) {
      const p = productMap.get(item.productId);
      if (p) {
        item.name = p.name;
        item.retailerProductId = p.retailerProductId;
      }
    }
  } catch {
    // best-effort — items will fall back to UUID display
  }

  return items;
}
