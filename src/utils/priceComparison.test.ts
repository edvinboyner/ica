import { describe, it, expect } from "vitest";
import {
  effectivePrice,
  regularPrice,
  buildProductMatches,
  buildStorePrice,
  buildComparisonResult,
} from "./priceComparison";
import type { Product, CartItem, Store, ProductMatch, StorePrice } from "../api/types";

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeProduct(overrides: Partial<Product> = {}): Product {
  return {
    productId: "prod-1",
    retailerProductId: "ret-1",
    name: "Testvara",
    ...overrides,
  };
}

function makeStore(overrides: Partial<Store> = {}): Store {
  return {
    accountId: "store-1",
    name: "Testbutik",
    city: "Stockholm",
    storeFormat: "supermarket",
    deliveryMethods: ["HOME_DELIVERY"],
    ...overrides,
  };
}

function makeCartItem(overrides: Partial<CartItem> = {}): CartItem {
  return {
    productId: "prod-1",
    retailerProductId: "ret-1",
    quantity: 1,
    name: "Testvara",
    ...overrides,
  };
}

function makeProductMatch(overrides: Partial<ProductMatch> = {}): ProductMatch {
  return {
    productId: "prod-1",
    retailerProductId: "ret-1",
    name: "Testvara",
    quantity: 1,
    currentPrice: 29.90,
    ...overrides,
  };
}

// ─── effectivePrice ──────────────────────────────────────────────────────────

describe("effectivePrice", () => {
  it("returns price.current.amount when present (highest priority)", () => {
    const p = makeProduct({
      price: { amount: "30.00", currency: "SEK", current: { amount: "24.90", currency: "SEK" } },
      promoPrice: { amount: "27.00", currency: "SEK" },
    });
    expect(effectivePrice(p)).toBe(24.90);
  });

  it("falls back to promoPrice.amount when no price.current", () => {
    const p = makeProduct({
      price: { amount: "30.00", currency: "SEK" },
      promoPrice: { amount: "27.00", currency: "SEK" },
    });
    expect(effectivePrice(p)).toBe(27.00);
  });

  it("falls back to price.amount when no promoPrice or current", () => {
    const p = makeProduct({ price: { amount: "30.00", currency: "SEK" } });
    expect(effectivePrice(p)).toBe(30.00);
  });

  it("returns null when no price at all", () => {
    const p = makeProduct({ price: undefined, promoPrice: undefined });
    expect(effectivePrice(p)).toBeNull();
  });

  it("handles string amounts correctly (ICA returns strings)", () => {
    const p = makeProduct({ price: { amount: "54.90", currency: "SEK" } });
    expect(effectivePrice(p)).toBe(54.90);
  });

  it("returns null for negative price", () => {
    const p = makeProduct({ price: { amount: "-5.00", currency: "SEK" } });
    expect(effectivePrice(p)).toBeNull();
  });

  it("returns null for non-numeric string", () => {
    const p = makeProduct({ price: { amount: "gratis", currency: "SEK" } });
    expect(effectivePrice(p)).toBeNull();
  });

  it("returns 0 for zero price (free item)", () => {
    const p = makeProduct({ price: { amount: "0.00", currency: "SEK" } });
    expect(effectivePrice(p)).toBe(0);
  });

  it("price.current.amount beats lower promoPrice", () => {
    // price.current.amount (24.90) is lower than price.amount (30.00) but
    // promoPrice (20.00) is even lower — price.current should still win
    const p = makeProduct({
      price: { amount: "30.00", currency: "SEK", current: { amount: "24.90", currency: "SEK" } },
      promoPrice: { amount: "20.00", currency: "SEK" },
    });
    // effectivePrice always picks price.current first — NOT necessarily the cheapest
    expect(effectivePrice(p)).toBe(24.90);
  });
});

// ─── regularPrice ────────────────────────────────────────────────────────────

describe("regularPrice", () => {
  it("always returns price.amount regardless of promoPrice", () => {
    const p = makeProduct({
      price: { amount: "30.00", currency: "SEK" },
      promoPrice: { amount: "20.00", currency: "SEK" },
    });
    expect(regularPrice(p)).toBe(30.00);
  });

  it("returns price.amount even when price.current exists", () => {
    const p = makeProduct({
      price: { amount: "30.00", currency: "SEK", current: { amount: "24.00", currency: "SEK" } },
    });
    expect(regularPrice(p)).toBe(30.00);
  });

  it("returns null when price is absent", () => {
    const p = makeProduct({ price: undefined });
    expect(regularPrice(p)).toBeNull();
  });
});

// ─── buildProductMatches ─────────────────────────────────────────────────────

describe("buildProductMatches", () => {
  it("uses finalPrice when available", () => {
    const item = makeCartItem({
      price: { currency: "SEK", amount: "30.00" },
      finalPrice: { currency: "SEK", amount: "24.00" },
    });
    const [match] = buildProductMatches([item]);
    expect(match.currentPrice).toBe(24.00);
  });

  it("falls back to price.amount when no finalPrice", () => {
    const item = makeCartItem({
      price: { currency: "SEK", amount: "30.00" },
      finalPrice: undefined,
    });
    const [match] = buildProductMatches([item]);
    expect(match.currentPrice).toBe(30.00);
  });

  it("returns null currentPrice when neither price nor finalPrice set", () => {
    const item = makeCartItem({ price: undefined, finalPrice: undefined });
    const [match] = buildProductMatches([item]);
    expect(match.currentPrice).toBeNull();
  });

  it("sets hasMemberDiscount=true when finalPrice < price", () => {
    const item = makeCartItem({
      price: { currency: "SEK", amount: "30.00" },
      finalPrice: { currency: "SEK", amount: "24.00" },
    });
    const [match] = buildProductMatches([item]);
    expect(match.hasMemberDiscount).toBe(true);
  });

  it("sets hasMemberDiscount=true when quantity > 1 (possible multi-buy deal)", () => {
    const item = makeCartItem({
      quantity: 2,
      price: { currency: "SEK", amount: "30.00" },
      finalPrice: { currency: "SEK", amount: "30.00" }, // same price, no discount
    });
    const [match] = buildProductMatches([item]);
    expect(match.hasMemberDiscount).toBe(true);
  });

  it("leaves hasMemberDiscount undefined when qty=1 and no discount", () => {
    const item = makeCartItem({
      quantity: 1,
      price: { currency: "SEK", amount: "30.00" },
      finalPrice: { currency: "SEK", amount: "30.00" },
    });
    const [match] = buildProductMatches([item]);
    expect(match.hasMemberDiscount).toBeUndefined();
  });

  it("falls back to 'Okänd vara' for UUID-like productId when name missing", () => {
    const item = makeCartItem({
      productId: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
      name: undefined,
    });
    const [match] = buildProductMatches([item]);
    expect(match.name).toBe("Okänd vara");
  });

  it("uses productId as name when it doesn't look like a UUID", () => {
    const item = makeCartItem({ productId: "ABC123", name: undefined });
    const [match] = buildProductMatches([item]);
    expect(match.name).toBe("ABC123");
  });

  it("preserves retailerProductId", () => {
    const item = makeCartItem({ retailerProductId: "ret-42" });
    const [match] = buildProductMatches([item]);
    expect(match.retailerProductId).toBe("ret-42");
  });
});

// ─── buildStorePrice ─────────────────────────────────────────────────────────

describe("buildStorePrice", () => {
  const store = makeStore();

  it("finds item via retailerProductId and uses effectivePrice", () => {
    const item = makeProductMatch({ retailerProductId: "ret-1", quantity: 2 });
    const product = makeProduct({
      retailerProductId: "ret-1",
      price: { amount: "30.00", currency: "SEK" },
    });
    const result = buildStorePrice(store, [item], [product]);
    expect(result.products[0].available).toBe(true);
    expect(result.products[0].price).toBe(30.00);
    expect(result.totalPrice).toBe(60.00);
    expect(result.availableCount).toBe(1);
  });

  it("marks item unavailable when not found in catalog", () => {
    const item = makeProductMatch({ retailerProductId: "ret-99" });
    const product = makeProduct({ retailerProductId: "ret-1" });
    const result = buildStorePrice(store, [item], [product]);
    expect(result.products[0].available).toBe(false);
    expect(result.products[0].price).toBeNull();
    expect(result.totalPrice).toBe(0);
    expect(result.availableCount).toBe(0);
  });

  it("sets ordinaryPrice only when regularPrice > effectivePrice", () => {
    const item = makeProductMatch({ retailerProductId: "ret-1" });
    const product = makeProduct({
      retailerProductId: "ret-1",
      price: { amount: "30.00", currency: "SEK" },
      promoPrice: { amount: "24.90", currency: "SEK" },
    });
    const result = buildStorePrice(store, [item], [product]);
    expect(result.products[0].price).toBe(24.90);
    expect(result.products[0].ordinaryPrice).toBe(30.00);
  });

  it("does NOT set ordinaryPrice when effectivePrice equals regularPrice", () => {
    const item = makeProductMatch({ retailerProductId: "ret-1" });
    const product = makeProduct({
      retailerProductId: "ret-1",
      price: { amount: "30.00", currency: "SEK" },
    });
    const result = buildStorePrice(store, [item], [product]);
    expect(result.products[0].ordinaryPrice).toBeNull();
  });

  it("does NOT match on productId alone — requires retailerProductId", () => {
    // The product has the same productId but no retailerProductId
    // The cart item has retailerProductId set
    const item = makeProductMatch({ productId: "prod-1", retailerProductId: "ret-1" });
    const product = makeProduct({ productId: "prod-1", retailerProductId: undefined });
    const result = buildStorePrice(store, [item], [product]);
    // Should be unavailable because productMap keys on retailerProductId
    expect(result.products[0].available).toBe(false);
  });

  it("item without retailerProductId is unavailable (no catalog match possible)", () => {
    const item = makeProductMatch({ retailerProductId: undefined });
    const product = makeProduct({ retailerProductId: "ret-1" });
    const result = buildStorePrice(store, [item], [product]);
    expect(result.products[0].available).toBe(false);
  });

  describe("with iframeResults", () => {
    it("uses iframe price when catalog price not present", () => {
      const item = makeProductMatch({ retailerProductId: "ret-1", quantity: 3 });
      // Product exists in catalog but no retailerProductId → won't match
      const iframeResults = new Map([
        ["ret-1", { price: 22.50, available: true }],
      ]);
      const result = buildStorePrice(store, [item], [], iframeResults);
      expect(result.products[0].available).toBe(true);
      expect(result.products[0].price).toBe(22.50);
      expect(result.totalPrice).toBe(67.50);
    });

    it("takes min(catalog, iframe) — catalog wins for single-item campaigns", () => {
      const item = makeProductMatch({ retailerProductId: "ret-1", quantity: 1 });
      const product = makeProduct({
        retailerProductId: "ret-1",
        price: { amount: "50.00", currency: "SEK", current: { amount: "39.90", currency: "SEK" } },
      });
      const iframeResults = new Map([
        ["ret-1", { price: 50.00, available: true }], // iframe returns shelf price
      ]);
      const result = buildStorePrice(store, [item], [product], iframeResults);
      // catalog price (39.90) < iframe price (50.00) → catalog wins
      expect(result.products[0].price).toBe(39.90);
    });

    it("takes min(catalog, iframe) — iframe wins for stammis/multi-buy deals", () => {
      const item = makeProductMatch({ retailerProductId: "ret-1", quantity: 2 });
      const product = makeProduct({
        retailerProductId: "ret-1",
        price: { amount: "30.00", currency: "SEK" }, // shelf price only in catalog
      });
      const iframeResults = new Map([
        ["ret-1", { price: 22.50, available: true }], // deal price from search API
      ]);
      const result = buildStorePrice(store, [item], [product], iframeResults);
      // iframe price (22.50) < catalog price (30.00) → iframe wins
      expect(result.products[0].price).toBe(22.50);
      expect(result.totalPrice).toBe(45.00); // 22.50 × 2
    });

    it("ignores unavailable iframe result", () => {
      const item = makeProductMatch({ retailerProductId: "ret-1" });
      const iframeResults = new Map([
        ["ret-1", { price: 22.50, available: false }],
      ]);
      const result = buildStorePrice(store, [item], [], iframeResults);
      expect(result.products[0].available).toBe(false);
    });

    it("ignores iframe result with null price", () => {
      const item = makeProductMatch({ retailerProductId: "ret-1" });
      const iframeResults = new Map([
        ["ret-1", { price: null, available: true }],
      ]);
      const result = buildStorePrice(store, [item], [], iframeResults);
      expect(result.products[0].available).toBe(false);
    });

    describe("household campaign cap (maxDealUnits)", () => {
      it("blends deal+shelf price when qty exceeds maxDealUnits", () => {
        // "2 för 23 kr — Max 1 erbj/hushåll" means max 2 units at deal price
        // qty=4: first 2 at 11.50, next 2 at shelf price 15.00
        const item = makeProductMatch({ retailerProductId: "ret-1", quantity: 4 });
        const product = makeProduct({
          retailerProductId: "ret-1",
          price: { amount: "15.00", currency: "SEK" }, // shelf price in catalog
        });
        const iframeResults = new Map([
          ["ret-1", { price: 11.50, available: true, maxDealUnits: 2 }],
        ]);
        const result = buildStorePrice(store, [item], [product], iframeResults);
        // 2 × 11.50 + 2 × 15.00 = 23.00 + 30.00 = 53.00
        expect(result.products[0].price).toBe(11.50); // displayed price is the deal price
        expect(result.totalPrice).toBe(53.00);
      });

      it("uses deal price for all units when qty equals maxDealUnits exactly", () => {
        const item = makeProductMatch({ retailerProductId: "ret-1", quantity: 2 });
        const product = makeProduct({
          retailerProductId: "ret-1",
          price: { amount: "15.00", currency: "SEK" },
        });
        const iframeResults = new Map([
          ["ret-1", { price: 11.50, available: true, maxDealUnits: 2 }],
        ]);
        const result = buildStorePrice(store, [item], [product], iframeResults);
        // qty (2) === maxDealUnits (2) → full deal applies
        expect(result.totalPrice).toBe(23.00); // 11.50 × 2
      });

      it("uses deal price for all units when qty < maxDealUnits", () => {
        const item = makeProductMatch({ retailerProductId: "ret-1", quantity: 1 });
        const product = makeProduct({
          retailerProductId: "ret-1",
          price: { amount: "15.00", currency: "SEK" },
        });
        const iframeResults = new Map([
          ["ret-1", { price: 11.50, available: true, maxDealUnits: 2 }],
        ]);
        const result = buildStorePrice(store, [item], [product], iframeResults);
        expect(result.totalPrice).toBe(11.50);
      });

      it("falls back to deal price as shelf price when regularPrice is null", () => {
        // If catalog has no price.amount, use deal price for all units (can't blend)
        const item = makeProductMatch({ retailerProductId: "ret-1", quantity: 4 });
        const product = makeProduct({
          retailerProductId: "ret-1",
          price: undefined, // no shelf price in catalog
        });
        const iframeResults = new Map([
          ["ret-1", { price: 11.50, available: true, maxDealUnits: 2 }],
        ]);
        const result = buildStorePrice(store, [item], [product], iframeResults);
        // shelfP falls back to price (11.50)
        // 2 × 11.50 + 2 × 11.50 = 46.00
        expect(result.totalPrice).toBe(46.00);
      });

      it("coffee case: 4×kaffe, deal price 67.50 (2 för 135 kr), max 1 erbj → maxDealUnits=2", () => {
        // Real-world: Gevalia kaffe, shelf ~85kr, deal "2 för 135 kr — Max 1 erbj/hushåll"
        const item = makeProductMatch({ retailerProductId: "ret-kaffe", quantity: 4 });
        const product = makeProduct({
          retailerProductId: "ret-kaffe",
          price: { amount: "85.00", currency: "SEK" },
        });
        const iframeResults = new Map([
          ["ret-kaffe", { price: 67.50, available: true, maxDealUnits: 2 }],
        ]);
        const result = buildStorePrice(store, [item], [product], iframeResults);
        // 2 × 67.50 + 2 × 85.00 = 135.00 + 170.00 = 305.00
        expect(result.totalPrice).toBeCloseTo(305.00, 2);
      });

      it("pastej case: 4×pastej, deal 11.50 (2 för 23 kr), max 1 erbj → no over-discount", () => {
        const item = makeProductMatch({ retailerProductId: "ret-pastej", quantity: 4 });
        const product = makeProduct({
          retailerProductId: "ret-pastej",
          price: { amount: "15.00", currency: "SEK" },
        });
        const iframeResults = new Map([
          ["ret-pastej", { price: 11.50, available: true, maxDealUnits: 2 }],
        ]);
        const result = buildStorePrice(store, [item], [product], iframeResults);
        // 2 × 11.50 + 2 × 15.00 = 23.00 + 30.00 = 53.00
        expect(result.totalPrice).toBeCloseTo(53.00, 2);
      });
    });
  });

  it("handles multiple items with mixed availability", () => {
    const items = [
      makeProductMatch({ productId: "p1", retailerProductId: "r1", quantity: 2 }),
      makeProductMatch({ productId: "p2", retailerProductId: "r2", quantity: 1 }),
      makeProductMatch({ productId: "p3", retailerProductId: "r3", quantity: 3 }),
    ];
    const products = [
      makeProduct({ productId: "p1", retailerProductId: "r1", price: { amount: "10.00", currency: "SEK" } }),
      // r2 missing
      makeProduct({ productId: "p3", retailerProductId: "r3", price: { amount: "5.00", currency: "SEK" } }),
    ];
    const result = buildStorePrice(store, items, products);
    expect(result.availableCount).toBe(2);
    expect(result.totalPrice).toBe(10.00 * 2 + 5.00 * 3); // 20 + 15 = 35
    expect(result.products[1].available).toBe(false); // r2 missing
  });
});

// ─── buildComparisonResult ───────────────────────────────────────────────────

describe("buildComparisonResult", () => {
  const items = [
    makeProductMatch({ productId: "p1", retailerProductId: "r1", quantity: 1, currentPrice: 30 }),
    makeProductMatch({ productId: "p2", retailerProductId: "r2", quantity: 2, currentPrice: 15 }),
  ];

  function makeStorePrice(
    storeId: string,
    total: number,
    available: number,
    storeName = storeId
  ): StorePrice {
    return {
      storeId,
      storeName,
      storeFormat: "supermarket",
      products: [],
      totalPrice: total,
      availableCount: available,
    };
  }

  it("selects cheapest full store as cheapestStoreId", () => {
    const stores = [
      makeStorePrice("s1", 100, 2),
      makeStorePrice("s2", 80, 2),  // cheapest with all items
      makeStorePrice("s3", 70, 1),  // cheaper total but missing an item
    ];
    const result = buildComparisonResult(items, stores, "s1");
    expect(result.cheapestStoreId).toBe("s2");
  });

  it("calculates savingVsCurrent correctly", () => {
    const stores = [
      makeStorePrice("current", 100, 2),
      makeStorePrice("cheaper", 75, 2),
    ];
    const result = buildComparisonResult(items, stores, "current");
    expect(result.savingVsCurrent).toBe(25);
  });

  it("savingVsCurrent is 0 when current store is cheapest", () => {
    const stores = [
      makeStorePrice("current", 75, 2),
      makeStorePrice("other", 100, 2),
    ];
    const result = buildComparisonResult(items, stores, "current");
    expect(result.savingVsCurrent).toBe(0);
  });

  it("places full stores before incomplete stores in sorted output", () => {
    const stores = [
      makeStorePrice("incomplete", 50, 1), // cheap but missing item
      makeStorePrice("full-expensive", 120, 2),
      makeStorePrice("full-cheap", 90, 2),
    ];
    const result = buildComparisonResult(items, stores, "full-expensive");
    const ids = result.stores.map((s) => s.storeId);
    // Full stores first (sorted by price), then incomplete
    expect(ids[0]).toBe("full-cheap");
    expect(ids[1]).toBe("full-expensive");
    expect(ids[2]).toBe("incomplete");
  });

  it("uses resolvableCount threshold — items without retailerProductId don't block full stores", () => {
    const itemsWithUnresolvable = [
      makeProductMatch({ productId: "p1", retailerProductId: "r1" }),
      makeProductMatch({ productId: "p2", retailerProductId: undefined }), // unresolvable
    ];
    // Store has 1 available (only the resolvable item)
    const stores = [makeStorePrice("s1", 100, 1)];
    const result = buildComparisonResult(itemsWithUnresolvable, stores, "s1");
    // resolvableCount = 1, threshold = 1, s1 has availableCount=1 → full store
    expect(result.cheapestStoreId).toBe("s1");
  });

  it("falls back to currentStoreId as cheapestStoreId when no full stores exist", () => {
    const stores = [
      makeStorePrice("s1", 100, 1), // incomplete
      makeStorePrice("s2", 80, 1),  // incomplete
    ];
    const result = buildComparisonResult(items, stores, "s1");
    expect(result.cheapestStoreId).toBe("s1"); // falls back to currentStoreId
  });

  it("calculates actualCartTotal from currentPrice × quantity", () => {
    // items: p1 qty=1 price=30, p2 qty=2 price=15 → total = 30 + 30 = 60
    const result = buildComparisonResult(items, [], "s1");
    expect(result.actualCartTotal).toBe(60);
  });

  it("actualCartTotal treats null currentPrice as 0", () => {
    const itemsWithNull = [
      makeProductMatch({ productId: "p1", currentPrice: null, quantity: 2 }),
      makeProductMatch({ productId: "p2", currentPrice: 10, quantity: 1 }),
    ];
    const result = buildComparisonResult(itemsWithNull, [], "s1");
    expect(result.actualCartTotal).toBe(10);
  });

  it("tied stores — both stores with same price are sorted before more expensive stores", () => {
    const stores = [
      makeStorePrice("s1", 100, 2),
      makeStorePrice("s2", 100, 2), // tied
      makeStorePrice("s3", 120, 2),
    ];
    const result = buildComparisonResult(items, stores, "s1");
    // Both s1 and s2 could be cheapest — cheapestStoreId should be one of them
    expect(["s1", "s2"]).toContain(result.cheapestStoreId);
    // savingVsCurrent should be 0 since current store (s1) ties with cheapest
    expect(result.savingVsCurrent).toBe(0);
  });

  it("savingVsCurrent can be negative if current store is MORE expensive than cheapest", () => {
    // This shouldn't happen in practice (cheapest should always be <= current)
    // but let's verify the math
    const stores = [
      makeStorePrice("current", 100, 2),
      makeStorePrice("cheaper", 80, 2),
    ];
    const result = buildComparisonResult(items, stores, "current");
    expect(result.savingVsCurrent).toBe(20);
    expect(result.savingVsCurrent).toBeGreaterThanOrEqual(0);
  });
});

// ─── Specification-based tests (what SHOULD happen per spec) ────────────────
//
// These tests are written from the specification, not from the implementation.
// Failing tests here indicate a gap between spec and code.

describe("spec: household cap applies even when item is only found via iframe (not in bulk catalog)", () => {
  const store = makeStore();

  it("SHOULD blend deal+shelf price, but no shelf price available → uses deal price for all units (known limitation)", () => {
    // Spec: "only the first maxDealUnits units get the deal price; the rest pay shelf price"
    // If the item is ONLY in iframeResults (not in bulk catalog), there's no shelf price.
    // The spec can't be fully satisfied — but the code should at minimum not silently
    // apply the deal to ALL units as if maxDealUnits doesn't exist.
    // Current behavior: total = ir.price * item.quantity (ignores maxDealUnits entirely)
    const item = makeProductMatch({ retailerProductId: "ret-1", quantity: 4 });
    const iframeResults = new Map([
      ["ret-1", { price: 11.50, available: true, maxDealUnits: 2 }],
    ]);
    // No storeProducts → item is only in iframe
    const result = buildStorePrice(store, [item], [], iframeResults);
    // Spec says max 2 units at deal price. Without shelf price, best effort would be
    // 2 × 11.50 + 2 × 11.50 = 46.00 (same deal for all) OR show as partially unavailable.
    // The problem: code says total = 11.50 × 4 = 46.00 — same answer coincidentally,
    // but only because we have no shelf price. With shelf price the answer should differ.
    // This test documents the known limitation.
    expect(result.totalPrice).toBe(46.00);
  });

  it("SHOULD blend when item IS in catalog and iframe brings the deal price + cap", () => {
    // This is the CORRECT scenario: item in catalog (has shelf price) + iframe finds cap
    // Spec: 2×deal + 2×shelf
    const item = makeProductMatch({ retailerProductId: "ret-1", quantity: 4 });
    const product = makeProduct({
      retailerProductId: "ret-1",
      price: { amount: "15.00", currency: "SEK" }, // shelf price from catalog
    });
    const iframeResults = new Map([
      ["ret-1", { price: 11.50, available: true, maxDealUnits: 2 }],
    ]);
    const result = buildStorePrice(store, [item], [product], iframeResults);
    // 2 × 11.50 + 2 × 15.00 = 23 + 30 = 53
    expect(result.totalPrice).toBe(53.00);
  });
});

describe("spec: effectivePrice should return the price the customer actually pays", () => {
  it("when BOTH price.current AND promoPrice exist, returns price.current (spec says it has priority)", () => {
    // Spec: "price.current.amount (post-campaign) > promoPrice.amount > price.amount"
    const p = makeProduct({
      price: { amount: "30.00", currency: "SEK", current: { amount: "24.90", currency: "SEK" } },
      promoPrice: { amount: "20.00", currency: "SEK" },
    });
    // By spec priority: price.current.amount wins.
    // NOTE: If promoPrice (20.00) is in fact the actual customer price, this would be a bug.
    // But spec says price.current takes priority — promoPrice is a legacy field.
    expect(effectivePrice(p)).toBe(24.90);
  });
});

describe("spec: min(catalog, iframe) — customer always gets the lower price", () => {
  const store = makeStore();

  it("stammis deal via iframe should beat regular catalog shelf price", () => {
    // Spec: iframe captures stammis/multi-buy deals; catalog has shelf price
    // Customer should pay stammis price
    const item = makeProductMatch({ retailerProductId: "ret-1", quantity: 1 });
    const product = makeProduct({
      retailerProductId: "ret-1",
      price: { amount: "85.00", currency: "SEK" }, // shelf price only in catalog
    });
    const iframeResults = new Map([
      ["ret-1", { price: 67.50, available: true }], // stammis deal
    ]);
    const result = buildStorePrice(store, [item], [product], iframeResults);
    expect(result.products[0].price).toBe(67.50); // iframe wins
  });

  it("catalog campaign should beat iframe shelf price for single-item campaigns", () => {
    // Spec: catalog captures single-item campaigns reliably; iframe returns shelf price for these
    const item = makeProductMatch({ retailerProductId: "ret-1", quantity: 1 });
    const product = makeProduct({
      retailerProductId: "ret-1",
      price: { amount: "50.00", currency: "SEK", current: { amount: "39.90", currency: "SEK" } },
    });
    const iframeResults = new Map([
      ["ret-1", { price: 50.00, available: true }], // iframe returns shelf (no campaign there)
    ]);
    const result = buildStorePrice(store, [item], [product], iframeResults);
    expect(result.products[0].price).toBe(39.90); // catalog wins
  });

  it("ordinaryPrice shows the regular shelf price when stammis deal is applied via iframe", () => {
    // Spec: ordinaryPrice should show what the customer saves
    // When iframe brings 67.50 and catalog shelf is 85.00, ordinaryPrice should be 85.00
    const item = makeProductMatch({ retailerProductId: "ret-1", quantity: 1 });
    const product = makeProduct({
      retailerProductId: "ret-1",
      price: { amount: "85.00", currency: "SEK" },
    });
    const iframeResults = new Map([
      ["ret-1", { price: 67.50, available: true }],
    ]);
    const result = buildStorePrice(store, [item], [product], iframeResults);
    expect(result.products[0].ordinaryPrice).toBe(85.00); // shows discount
  });
});

describe("spec: buildProductMatches hasMemberDiscount reflects need for accurate pricing", () => {
  it("qty=1, finalPrice equals price → no iframe needed (no flag)", () => {
    // Spec: single item, no discount → catalog price is reliable, no flag needed
    const item = makeCartItem({
      quantity: 1,
      price: { currency: "SEK", amount: "30.00" },
      finalPrice: { currency: "SEK", amount: "30.00" },
    });
    const [match] = buildProductMatches([item]);
    expect(match.hasMemberDiscount).toBeUndefined();
  });

  it("qty=2, no discount → flagged because multi-buy deal might apply", () => {
    // Spec: qty > 1 always flagged — can't know without iframe if there's a "2 för X" deal
    const item = makeCartItem({
      quantity: 2,
      price: { currency: "SEK", amount: "30.00" },
      finalPrice: { currency: "SEK", amount: "30.00" },
    });
    const [match] = buildProductMatches([item]);
    expect(match.hasMemberDiscount).toBe(true);
  });

  it("stammis discount (finalPrice < price) → flagged even at qty=1", () => {
    // Spec: ICA-card discount → catalog won't know → flag it
    const item = makeCartItem({
      quantity: 1,
      price: { currency: "SEK", amount: "30.00" },
      finalPrice: { currency: "SEK", amount: "24.00" },
    });
    const [match] = buildProductMatches([item]);
    expect(match.hasMemberDiscount).toBe(true);
  });
});

describe("spec: actualCartTotal reflects true customer cost (not catalog prices)", () => {
  it("actualCartTotal uses finalPrice (stammis-adjusted) not catalog prices", () => {
    // Spec: actualCartTotal is "actual home-store cost from cart finalPrices"
    // If customer pays 24.00 (stammis) for an item cataloged at 30.00, total should use 24.00
    const items: ProductMatch[] = [
      makeProductMatch({ productId: "p1", currentPrice: 24.00, quantity: 1 }), // paid 24 (stammis)
      makeProductMatch({ productId: "p2", currentPrice: 30.00, quantity: 2 }), // paid 30 × 2
    ];
    const result = buildComparisonResult(items, [], "s1");
    // 24.00 × 1 + 30.00 × 2 = 84.00
    expect(result.actualCartTotal).toBe(84.00);
  });

  it("actualCartTotal should differ from catalog-based total when deals apply", () => {
    // This is the core use case: actualCartTotal shows what YOU paid, comparison shows catalog prices
    const cartItems: CartItem[] = [
      {
        productId: "p1",
        retailerProductId: "r1",
        name: "Kaffe",
        quantity: 2,
        price: { currency: "SEK", amount: "85.00" },       // catalog shelf
        finalPrice: { currency: "SEK", amount: "67.50" },  // 2-for-135 deal → 67.50/st
      },
    ];
    const matches = buildProductMatches(cartItems);
    // actualCartTotal in comparison uses currentPrice from matches (= 67.50)
    // 67.50 × 2 = 135.00
    const result = buildComparisonResult(matches, [], "s1");
    expect(result.actualCartTotal).toBe(135.00);
    // And currentPrice should be 67.50 (finalPrice), not 85.00 (shelf)
    expect(matches[0].currentPrice).toBe(67.50);
  });
});

describe("spec: household cap should only apply when the iframe deal actually won", () => {
  const store = makeStore();

  it("catalog wins via min() → household cap from iframe should NOT apply to catalog price", () => {
    // Scenario: two separate deals at the same store:
    //   - Single-item campaign: price.current.amount = 25.00  (catalog)
    //   - Multi-buy deal: 2 för 60 kr = 30.00/st, Max 1 erbj/hushåll  (iframe)
    //
    // Catalog price (25.00) < iframe price (30.00) → customer pays catalog price.
    // The household-capped deal is irrelevant here — customer won't USE a worse deal.
    // So total should be 25.00 × 4 = 100.00.
    //
    // BUG: current code applies maxDealUnits even when catalog won,
    // giving 2×25 + 2×35 = 120 instead of 100.
    const item = makeProductMatch({ retailerProductId: "ret-1", quantity: 4 });
    const product = makeProduct({
      retailerProductId: "ret-1",
      price: { amount: "35.00", currency: "SEK", current: { amount: "25.00", currency: "SEK" } },
    });
    const iframeResults = new Map([
      ["ret-1", { price: 30.00, available: true, maxDealUnits: 2 }], // worse deal
    ]);
    const result = buildStorePrice(store, [item], [product], iframeResults);
    // catalog wins: 25.00 × 4 = 100.00
    expect(result.products[0].price).toBe(25.00);
    expect(result.totalPrice).toBe(100.00);
  });
});

describe("spec: incomplete stores must never be cheapestStoreId", () => {
  it("a store missing one item should never win even if its partial total is lowest", () => {
    // Spec: only full stores (all items available) qualify for cheapestStoreId
    const items = [
      makeProductMatch({ productId: "p1", retailerProductId: "r1" }),
      makeProductMatch({ productId: "p2", retailerProductId: "r2" }),
    ];
    const stores: StorePrice[] = [
      { storeId: "full",       storeName: "Full",       storeFormat: "supermarket", products: [], totalPrice: 100, availableCount: 2 },
      { storeId: "incomplete", storeName: "Incomplete", storeFormat: "supermarket", products: [], totalPrice: 10,  availableCount: 1 }, // artificially cheap
    ];
    const result = buildComparisonResult(items, stores, "full");
    expect(result.cheapestStoreId).toBe("full"); // incomplete should NOT win
    expect(result.cheapestStoreId).not.toBe("incomplete");
  });
});

// ─── Integration: full pipeline ──────────────────────────────────────────────

describe("full pipeline integration", () => {
  it("processes cart → matches → store prices → comparison correctly", () => {
    const cartItems: CartItem[] = [
      {
        productId: "p1",
        retailerProductId: "r1",
        name: "Mjölk",
        quantity: 2,
        price: { currency: "SEK", amount: "15.90" },
        finalPrice: { currency: "SEK", amount: "15.90" },
      },
      {
        productId: "p2",
        retailerProductId: "r2",
        name: "Bröd",
        quantity: 1,
        price: { currency: "SEK", amount: "29.90" },
        finalPrice: { currency: "SEK", amount: "29.90" },
      },
    ];

    const currentStoreProducts: Product[] = [
      makeProduct({ productId: "p1", retailerProductId: "r1", price: { amount: "15.90", currency: "SEK" } }),
      makeProduct({ productId: "p2", retailerProductId: "r2", price: { amount: "29.90", currency: "SEK" } }),
    ];

    const cheaperStoreProducts: Product[] = [
      makeProduct({ productId: "p1-s2", retailerProductId: "r1", price: { amount: "13.50", currency: "SEK" } }),
      makeProduct({ productId: "p2-s2", retailerProductId: "r2", price: { amount: "27.00", currency: "SEK" } }),
    ];

    const currentStore = makeStore({ accountId: "current", name: "Dyrare Butik" });
    const cheaperStore = makeStore({ accountId: "cheaper", name: "Billigare Butik" });

    const productMatches = buildProductMatches(cartItems);
    const currentPrice = buildStorePrice(currentStore, productMatches, currentStoreProducts);
    const cheaperPrice = buildStorePrice(cheaperStore, productMatches, cheaperStoreProducts);

    expect(currentPrice.totalPrice).toBeCloseTo(15.90 * 2 + 29.90, 2); // 61.70
    expect(cheaperPrice.totalPrice).toBeCloseTo(13.50 * 2 + 27.00, 2); // 54.00

    const comparison = buildComparisonResult(productMatches, [currentPrice, cheaperPrice], "current");
    expect(comparison.cheapestStoreId).toBe("cheaper");
    expect(comparison.savingVsCurrent).toBeCloseTo(61.70 - 54.00, 2); // 7.70
    expect(comparison.actualCartTotal).toBeCloseTo(15.90 * 2 + 29.90, 2); // 61.70
  });

  it("household cap in full pipeline: 4 kaffe, max 2 at deal price", () => {
    const cartItems: CartItem[] = [
      {
        productId: "kaffe-1",
        retailerProductId: "ret-kaffe",
        name: "Kaffe 500g",
        quantity: 4,
        price: { currency: "SEK", amount: "85.00" },
        finalPrice: { currency: "SEK", amount: "85.00" },
      },
    ];

    const storeProducts: Product[] = [
      makeProduct({
        productId: "kaffe-1",
        retailerProductId: "ret-kaffe",
        price: { amount: "85.00", currency: "SEK" }, // shelf price
      }),
    ];

    const iframeResults = new Map([
      ["ret-kaffe", { price: 67.50, available: true, maxDealUnits: 2 }],
    ]);

    const store = makeStore({ accountId: "s1" });
    const productMatches = buildProductMatches(cartItems);
    const storePrice = buildStorePrice(store, productMatches, storeProducts, iframeResults);

    // 2 × 67.50 (deal) + 2 × 85.00 (shelf) = 135 + 170 = 305
    expect(storePrice.totalPrice).toBeCloseTo(305, 2);
    expect(storePrice.products[0].price).toBe(67.50);
    expect(storePrice.availableCount).toBe(1);
  });
});
