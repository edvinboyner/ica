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

export async function fetchStoresForZip(zipCode: string): Promise<Store[]> {
  const url = `${STORE_API_BASE}/store/v1?zip=${zipCode}&customerType=B2C`;
  const data = await apiFetch<StoreResponse>(url);
  return data.forHomeDelivery.filter((s) => s.deliveryMethods.includes("HOME_DELIVERY"));
}

/**
 * Paginate through the full product catalogue for a store.
 * Stops when a page returns fewer items than the limit.
 */
export async function fetchAllProductsForStore(storeId: string): Promise<Product[]> {
  const products: Product[] = [];
  const limit = 50;
  let offset = 0;

  while (true) {
    const url =
      `${SHOP_API_BASE}/${storeId}/api/webproductpagews/v5/product-pages` +
      `?limit=${limit}&offset=${offset}&tag=web&tag=lihp`;
    let data: ProductPagesResponse;
    try {
      data = await apiFetch<ProductPagesResponse>(url);
    } catch {
      break;
    }
    let count = 0;
    for (const g of data.productGroups ?? []) {
      for (const pw of g.products ?? []) {
        if (pw.product) { products.push(pw.product); count++; }
      }
    }
    if (count < limit) break;
    offset += limit;
  }

  return products;
}

export async function fetchActiveCart(storeId: string): Promise<CartItem[]> {
  const url = `${SHOP_API_BASE}/${storeId}/api/cart/v1/carts/active`;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const data = await apiFetch<any>(url);

  // Cart API returns only productId + quantity — no names
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const items: CartItem[] = (data.items ?? []).map((i: any) => ({
    productId: i.productId,
    retailerProductId: i.retailerProductId,
    name: i.name,
    quantity: typeof i.quantity === "object" ? (i.quantity.quantityInBasket ?? 1) : (i.quantity ?? 1),
    price: i.price,
    finalPrice: i.finalPrice,
  }));

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
