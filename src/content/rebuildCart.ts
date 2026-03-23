// Rebuild cart via DOM clicks — runs in MAIN world via scripting.executeScript
// This bypasses WAF which blocks programmatic API calls.

interface RebuildItem {
  productId: string;
  retailerProductId?: string;
  name: string;
  quantity: number;
}

function showOverlay(msg: string) {
  let el = document.getElementById("ica-rebuild-overlay");
  if (!el) {
    el = document.createElement("div");
    el.id = "ica-rebuild-overlay";
    el.style.cssText = [
      "position:fixed", "top:16px", "right:16px", "z-index:99999",
      "background:#1a5c2e", "color:#fff", "padding:12px 16px",
      "border-radius:8px", "font:14px/1.4 system-ui,sans-serif",
      "box-shadow:0 4px 12px rgba(0,0,0,.25)", "max-width:320px",
      "white-space:pre-line",
    ].join(";");
    document.body.appendChild(el);
  }
  el.textContent = msg;
}

function removeOverlay() {
  document.getElementById("ica-rebuild-overlay")?.remove();
}

function sleep(ms: number) {
  return new Promise<void>((r) => setTimeout(r, ms));
}

/** Navigate SPA to search and wait for product buttons to appear */
async function navigateAndWait(storeId: string, searchTerm: string): Promise<void> {
  document.querySelectorAll('[data-testid="product-card"]').forEach((el) => el.remove());

  const url = `/stores/${storeId}/search?q=${encodeURIComponent(searchTerm)}`;
  window.history.pushState({}, "", url);
  window.dispatchEvent(new PopStateEvent("popstate"));

  await new Promise<void>((resolve) => {
    const timeout = setTimeout(resolve, 3000);
    const observer = new MutationObserver(() => {
      if (document.querySelector('button[aria-label^="Lägg till"]')) {
        clearTimeout(timeout);
        observer.disconnect();
        resolve();
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
  });
}

/** Find the correct Add-button by matching product name in aria-label */
function findAddButton(retailerProductId?: string, name?: string): HTMLElement | null {
  const allBtns = [
    ...document.querySelectorAll<HTMLElement>('button[aria-label^="Lägg till"]'),
  ].filter((b) => b.offsetParent !== null);

  if (!allBtns.length) return null;

  if (name && !name.match(/^[0-9a-f-]{36}$/i)) {
    const nameLower = name.toLowerCase();

    // Try exact match: aria-label contains full product name
    const exact = allBtns.find((b) =>
      b.getAttribute("aria-label")?.toLowerCase().includes(nameLower)
    );
    if (exact) return exact;

    // Try matching on all significant words (>3 chars)
    const words = name.split(" ").filter((w) => w.length > 3).map((w) => w.toLowerCase());
    const byWords = allBtns.find((b) => {
      const label = b.getAttribute("aria-label")?.toLowerCase() ?? "";
      return words.every((w) => label.includes(w));
    });
    if (byWords) return byWords;

    // Partial: majority of words match
    const byMost = allBtns.find((b) => {
      const label = b.getAttribute("aria-label")?.toLowerCase() ?? "";
      const matched = words.filter((w) => label.includes(w)).length;
      return matched >= Math.ceil(words.length * 0.6);
    });
    if (byMost) return byMost;
  }

  // Fallback: first visible button
  return allBtns[0];
}

async function rebuildCart(items: RebuildItem[], storeId: string) {
  const failed: string[] = [];
  let added = 0;

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const displayName = /^[0-9a-f-]{36}$/i.test(item.name) ? item.retailerProductId ?? item.name : item.name;
    showOverlay(`Återskapar varukorg…\n${i + 1}/${items.length}: ${displayName}`);

    const searchTerm = /^[0-9a-f-]{36}$/i.test(item.name)
      ? (item.retailerProductId ?? item.productId)
      : item.name;
    await navigateAndWait(storeId, searchTerm);
    await sleep(300);

    // Retry once if button not found immediately (React may still be rendering)
    let btn = findAddButton(item.retailerProductId, item.name);
    if (!btn) {
      await sleep(800);
      btn = findAddButton(item.retailerProductId, item.name);
    }
    if (!btn) {
      failed.push(displayName);
      continue;
    }

    // Extra delay before clicking — let React finish rendering
    await sleep(500);

    // First click: the "Lägg till" button
    btn.click();
    await sleep(800);

    // For quantity > 1: find the "+" increment button and click it (q-1) more times
    for (let q = 1; q < item.quantity; q++) {
      // After first click, "Lägg till" is replaced by a stepper — find "Öka antalet av {name}"
      const plusBtn = document.querySelector<HTMLElement>(
        `button[aria-label^="Öka antalet"]`
      );
      if (plusBtn) {
        plusBtn.click();
        await sleep(500);
      }
    }
    added++;
    await sleep(300);
  }

  if (failed.length === 0) {
    showOverlay(`✓ Alla ${added} varor tillagda!`);
  } else {
    showOverlay(
      `✓ ${added}/${items.length} varor tillagda.\nSaknas: ${failed.join(", ")}`
    );
  }
  setTimeout(removeOverlay, 8000);
}

// Expose to window so service worker can call it after injection
(window as any).__icaRebuildCart = rebuildCart;
