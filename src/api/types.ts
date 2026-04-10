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
  /** Raw marketing text from ICA, e.g. "Plockavgift 59kr. Fri frakt vid köp över 1200kr." */
  marketingText?: string;
  /** Delivery/picking fee in SEK when below free-delivery threshold */
  deliveryFee?: number;
  /** Cart total (SEK) required for free delivery */
  freeDeliveryThreshold?: number;
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
  /** Regular/shelf price amount */
  amount: string;
  currency: string;
  /** Current effective price after campaigns/discounts — prefer this over amount */
  current?: { amount: string; currency?: string };
}

export interface Product {
  productId: string;
  retailerProductId?: string;
  name: string;
  /** Price object — use price.current.amount (campaign price) over price.amount (shelf price) */
  price?: ProductPrice;
  /** Legacy promo price field — superseded by price.current */
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
  /**
   * True when the cart's finalPrice < price for this item — indicates an
   * ICA-card / loyalty discount that the bulk catalog doesn't reflect.
   * Used to trigger iframe lookups for this item in all stores.
   */
  hasMemberDiscount?: boolean;
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
  /** Delivery cost for this store given the current cart total (0 = free, undefined = unknown) */
  deliveryCost?: number;
  /** Cart total required for free delivery at this store */
  freeDeliveryThreshold?: number;
}

export interface ComparisonResult {
  cartItems: ProductMatch[];
  stores: StorePrice[];
  currentStoreId: string;
  cheapestStoreId: string;
  savingVsCurrent: number;
  /**
   * Actual home-store cart total from cart API finalPrices — includes
   * stammis / multi-buy deals (2 för X kr) that aren't visible in the
   * product catalogue. Used for display only; comparison totals are always
   * catalogue-based so all stores are on equal footing.
   */
  actualCartTotal: number;
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
  | { type: "GET_COMPARISON"; zipCode: string; storeId?: string }
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
