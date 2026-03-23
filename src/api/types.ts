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
  quantity: number;
  totalPrices?: {
    finalUnitPrice?: {
      amount: number;
      currency: string;
    };
  };
  name?: string;
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

export interface Product {
  productId: string;
  retailerProductId?: string;
  name: string;
  price?: {
    amount: number;
    currency: string;
  };
  imageUrl?: string;
}

// Internal comparison types
export interface ProductMatch {
  productId: string;
  name: string;
  quantity: number;
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

export type MessageToBackground =
  | InitialStateMessage
  | { type: "GET_COMPARISON"; zipCode: string }
  | { type: "GET_STATE" };

export type MessageFromBackground =
  | { type: "COMPARISON_RESULT"; data: ComparisonResult }
  | { type: "COMPARISON_ERROR"; error: string }
  | { type: "STATE_UPDATE"; storeId: string | null; zipCode: string | null };

export interface StoredState {
  storeId: string | null;
  regionId: string | null;
  zipCode: string | null;
}
