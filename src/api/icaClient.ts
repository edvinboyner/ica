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
    headers: {
      Accept: "application/json",
    },
  });

  if (res.status === 401 || res.status === 403) {
    throw new Error("NOT_LOGGED_IN");
  }

  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${url}`);
  }

  return res.json() as Promise<T>;
}

export async function fetchStoresForZip(zipCode: string): Promise<Store[]> {
  const url = `${STORE_API_BASE}/store/v1?zip=${zipCode}&customerType=B2C`;
  const data = await apiFetch<StoreResponse>(url);
  return data.forHomeDelivery.filter((s) =>
    s.deliveryMethods.includes("HOME_DELIVERY")
  );
}

export async function fetchActiveCart(storeId: string): Promise<CartItem[]> {
  const url = `${SHOP_API_BASE}/${storeId}/api/cart/v1/carts/active`;
  const data = await apiFetch<CartResponse>(url);
  return data.items ?? [];
}

export async function fetchAllProductsForStore(
  storeId: string
): Promise<Product[]> {
  const products: Product[] = [];
  const limit = 50;
  let offset = 0;
  let hasMore = true;

  while (hasMore) {
    const url =
      `${SHOP_API_BASE}/${storeId}/api/webproductpagews/v5/product-pages` +
      `?limit=${limit}&offset=${offset}&tag=web&tag=lihp`;

    let data: ProductPagesResponse;
    try {
      data = await apiFetch<ProductPagesResponse>(url);
    } catch {
      break;
    }

    const batch: Product[] = [];
    for (const group of data.productGroups ?? []) {
      for (const pw of group.products ?? []) {
        if (pw.product) batch.push(pw.product);
      }
    }

    products.push(...batch);

    if (batch.length < limit) {
      hasMore = false;
    } else {
      offset += limit;
    }
  }

  return products;
}
