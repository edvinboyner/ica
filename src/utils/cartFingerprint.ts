import type { CartItem, ProductMatch } from "../api/types";

function djb2Hex(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) + h) ^ s.charCodeAt(i);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

/** Deterministic fingerprint: sorted productId:quantity pairs */
export function fingerprintFromCartItems(
  items: Pick<CartItem, "productId" | "quantity">[]
): string {
  const pairs = items
    .map((i) => `${i.productId}:${i.quantity}`)
    .sort()
    .join("|");
  return djb2Hex(pairs);
}

export function fingerprintFromProductMatches(
  items: Pick<ProductMatch, "productId" | "quantity">[]
): string {
  return fingerprintFromCartItems(items);
}
