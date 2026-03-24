// Store API types
export interface StoreResponse {
  forHomeDelivery: Store[];
}

export interface Store {
  accountId: string;
  name: string;
  city: string;
  storeFormat: "kvantum" | "maxi" | "nara" | "supermarket" | string;
  deliveryMethods: string[];
}

// Cart API types
export interface CartResponse {
  items: CartItem[];
}

export interface CartItem {
  productId: string;
  retailerProductId?: string;
  quantity: number;
  name?: string;
  price?: { currency: string; amount: string };
  finalPrice?: { currency: string; amount: string };
}

// Product pages API types
export interface ProductPagesResponse {
  productGroups: ProductGroup[];
}

export interface ProductGroup {
  products: ProductWrapper[];
}

export interface ProductWrapper {
  product: Product;
}

export interface ProductPrice {
  amount: string;
  currency: string;
}

export interface Product {
  productId: string;
  retailerProductId?: string;
  name: string;
  /** Regular shelf price */
  price?: ProductPrice;
  /** Campaign/promo price — present when product is on sale */
  promoPrice?: ProductPrice;
  imageUrl?: string;
}

// Internal comparison types
export interface ProductMatch {
  productId: string;
  retailerProductId?: string;
  name: string;
  quantity: number;
  /** Effective unit price in current store (after discounts) */
  currentPrice: number | null;
  imageUrl?: string;
}

export interface StorePrice {
  storeId: string;
  storeName: string;
  storeFormat: string;
  products: {
    productId: string;
    price: number | null;
    /** Original price before discount, if any */
    ordinaryPrice: number | null;
    available: boolean;
  }[];
  totalPrice: number;
  availableCount: number;
}

export interface ComparisonResult {
  cartItems: ProductMatch[];
  stores: StorePrice[];
  currentStoreId: string;
  cheapestStoreId: string;
  savingVsCurrent: number;
}

// Content script message types
export interface InitialStateMessage {
  type: "ICA_INITIAL_STATE";
  storeId: string;
  regionId?: string;
  zipCode?: string;
}

export interface RebuildItem {
  productId: string;
  retailerProductId?: string;
  quantity: number;
  name: string;
}

export type MessageToBackground =
  | InitialStateMessage
  | { type: "GET_COMPARISON"; zipCode: string }
  | { type: "GET_STATE" }
  | {
      type: "OPEN_CHEAPEST_CART";
      items: RebuildItem[];
      targetStoreId: string;
      targetStoreName?: string;
    };

export type MessageFromBackground =
  | { type: "COMPARISON_RESULT"; data: ComparisonResult }
  | { type: "COMPARISON_ERROR"; error: string }
  | { type: "STATE_UPDATE"; storeId: string | null; zipCode: string | null };

export interface StoredState {
  storeId: string | null;
  regionId: string | null;
  zipCode: string | null;
}

/** Persisted in chrome.storage.session while rebuild runs or after completion */
export type RebuildSessionState =
  | {
      status: "running";
      total: number;
      storeName: string;
      current: number;
      itemName: string;
      itemStatus?: "added" | "not_found";
    }
  | {
      status: "complete";
      total: number;
      storeName: string;
      added: number;
      failed: number;
      failedItems: string[];
    };

export interface ComparisonSessionCache {
  timestamp: number;
  sourceStoreId: string;
  cartFingerprint: string;
  results: ComparisonResult;
}

/** Shown in popup while GET_COMPARISON runs */
export interface ComparisonProgressState {
  status: "running";
  /** cart | stores_list | store_catalogues | iframe_fallback */
  step: "cart" | "stores_list" | "store_catalogues" | "iframe_fallback";
  current: number;
  total: number;
  detail?: string;
}
