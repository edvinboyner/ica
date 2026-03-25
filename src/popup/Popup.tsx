import React, { useEffect, useRef, useState } from "react";
import StoreComparison from "./StoreComparison";
import type {
  ComparisonResult,
  RebuildSessionState,
  ComparisonProgressState,
} from "../api/types";

type View = "idle" | "loading" | "result" | "error";

export default function Popup() {
  const [view, setView] = useState<View>("idle");
  const [zipCode, setZipCode] = useState("");
  const [savedZip, setSavedZip] = useState<string | null>(null);
  const [storeId, setStoreId] = useState<string | null>(null);
  const [result, setResult] = useState<ComparisonResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editingZip, setEditingZip] = useState(false);
  const [rebuildState, setRebuildState] = useState<RebuildSessionState | null>(
    null
  );
  const [cartStale, setCartStale] = useState(false);
  const [comparisonUpdatedAt, setComparisonUpdatedAt] = useState<number | null>(
    null
  );
  const [comparisonProgress, setComparisonProgress] =
    useState<ComparisonProgressState | null>(null);

  // Load persisted state on mount
  useEffect(() => {
    chrome.runtime.sendMessage({ type: "GET_STATE" }, (resp) => {
      if (resp) {
        // Use stored storeId as initial value; active-tab query below may override it
        setStoreId((prev) => prev ?? resp.storeId ?? null);
        setSavedZip(resp.zipCode ?? null);
        if (resp.zipCode) setZipCode(resp.zipCode);
      }
    });

    // Query the active tab in each open window and prefer the ICA tab the user
    // is currently on. This fixes the multi-tab bug where the last-stored storeId
    // (from a different ICA tab) was used instead of the currently active one.
    chrome.tabs.query({ active: true }, (tabs) => {
      for (const tab of tabs) {
        if (!tab.id || !tab.url?.includes("handlaprivatkund.ica.se")) continue;
        chrome.tabs.sendMessage(
          tab.id,
          { type: "GET_INITIAL_STATE" },
          (resp) => {
            if (chrome.runtime.lastError || !resp?.storeId) return;
            setStoreId(resp.storeId as string);
          }
        );
        break; // use first matching active ICA tab
      }
    });

    chrome.storage.session.get(
      ["rebuildState", "comparisonCache", "comparisonProgress"],
      (session) => {
        if (session.rebuildState) {
          setRebuildState(session.rebuildState as RebuildSessionState);
        }
        const cache = session.comparisonCache as
          | { timestamp: number; results: ComparisonResult }
          | undefined;
        // Cached result takes priority — comparison is complete
        if (cache?.results) {
          setResult(cache.results);
          setComparisonUpdatedAt(cache.timestamp);
          setView("result");
          return;
        }
        // No cache yet but progress exists — comparison is running
        if (session.comparisonProgress) {
          setComparisonProgress(
            session.comparisonProgress as ComparisonProgressState
          );
          setView("loading");
        }
      }
    );
  }, []);

  useEffect(() => {
    const onMsg = (msg: { type?: string }) => {
      if (
        typeof msg?.type === "string" &&
        (msg.type === "REBUILD_STARTED" ||
          msg.type === "REBUILD_PROGRESS" ||
          msg.type === "REBUILD_COMPLETE")
      ) {
        chrome.storage.session.get("rebuildState", (r) => {
          setRebuildState((r.rebuildState as RebuildSessionState) ?? null);
        });
      }
    };
    chrome.runtime.onMessage.addListener(onMsg);
    return () => chrome.runtime.onMessage.removeListener(onMsg);
  }, []);

  useEffect(() => {
    // chrome.storage.session.onChanged skickar bara (changes), inte areaName —
    // ett felaktigt area-check gjorde att inga uppdateringar nådde UI.
    const onChange = (changes: Record<string, chrome.storage.StorageChange>) => {
      if (changes.rebuildState) {
        setRebuildState(
          (changes.rebuildState.newValue as RebuildSessionState) ?? null
        );
      }
      if (changes.comparisonCache?.newValue) {
        const nv = changes.comparisonCache.newValue as {
          timestamp: number;
          results: ComparisonResult;
        };
        if (nv?.results) {
          setResult(nv.results);
          setComparisonUpdatedAt(nv.timestamp);
          setView("result");
          setCartStale(false);
        }
      }
      if (changes.comparisonProgress) {
        const progress =
          (changes.comparisonProgress.newValue as ComparisonProgressState) ??
          null;
        setComparisonProgress(progress);
        // If comparison starts while popup shows idle/error, switch to loading
        if (progress) {
          setView((v) => (v === "idle" || v === "error" ? "loading" : v));
        }
      }
    };
    chrome.storage.session.onChanged.addListener(onChange);
    return () => chrome.storage.session.onChanged.removeListener(onChange);
  }, []);

  useEffect(() => {
    if (view !== "result" || !result) return;
    chrome.runtime.sendMessage(
      { type: "CHECK_CART_FINGERPRINT" },
      (resp: { stale?: boolean; uncertain?: boolean }) => {
        if (chrome.runtime.lastError) return;
        if (resp?.uncertain) {
          setCartStale(false);
          return;
        }
        setCartStale(resp?.stale === true);
      }
    );
  }, [view, result]);

  useEffect(() => {
    if (view !== "loading") return;
    chrome.storage.session.get("comparisonProgress", (r) => {
      if (r.comparisonProgress) {
        setComparisonProgress(r.comparisonProgress as ComparisonProgressState);
      }
    });
  }, [view]);

  async function saveZip(zip: string) {
    await new Promise<void>((resolve) =>
      chrome.runtime.sendMessage({ type: "SAVE_ZIP", zipCode: zip }, () =>
        resolve()
      )
    );
    setSavedZip(zip);
    setEditingZip(false);
  }

  async function runComparison() {
    const zip = savedZip ?? zipCode;
    if (!zip) {
      setError("Ange ditt postnummer för att fortsätta.");
      setView("error");
      return;
    }

    setView("loading");
    setError(null);
    setComparisonProgress(null);
    chrome.storage.session.get("comparisonProgress", (r) => {
      if (r.comparisonProgress) {
        setComparisonProgress(r.comparisonProgress as ComparisonProgressState);
      }
    });

    chrome.runtime.sendMessage(
      { type: "GET_COMPARISON", zipCode: zip, storeId: storeId ?? undefined },
      (resp) => {
        if (!resp) {
          setError("Inget svar från service worker.");
          setView("error");
          return;
        }
        if (resp.type === "COMPARISON_RESULT") {
          setResult(resp.data);
          setComparisonUpdatedAt(Date.now());
          setCartStale(false);
          setView("result");
        } else {
          setError(humanizeError(resp.error));
          setView("error");
        }
      }
    );
  }

  return (
    <div className="bg-white min-h-screen">
      {/* Header */}
      <div className="bg-[#e3000b] px-4 py-3 flex items-center gap-2">
        <span className="text-white font-bold text-lg leading-none">ICA</span>
        <span className="text-white text-sm">Prisjämförelse</span>
      </div>

      <div className="p-4 space-y-4">
        {/* Zip input */}
        <ZipSection
          savedZip={savedZip}
          zipCode={zipCode}
          editingZip={editingZip}
          storeId={storeId}
          onZipChange={setZipCode}
          onSaveZip={saveZip}
          onEditZip={() => setEditingZip(true)}
        />

        {/* Status / action */}
        {view === "idle" && (
          <button
            onClick={runComparison}
            disabled={!storeId && !savedZip}
            className="w-full bg-[#e3000b] disabled:bg-gray-300 text-white font-semibold py-2.5 rounded-lg transition-colors hover:bg-[#c20009] active:bg-[#a80007]"
          >
            Jämför priser
          </button>
        )}

        {view === "loading" && (
          <ComparisonLoadingPanel progress={comparisonProgress} />
        )}

        {view === "error" && (
          <div className="space-y-3">
            <div className="bg-red-50 border border-red-200 rounded-lg p-3 text-sm text-red-700">
              {error}
            </div>
            <button
              onClick={() => setView("idle")}
              className="w-full border border-gray-300 text-gray-700 font-medium py-2 rounded-lg hover:bg-gray-50"
            >
              Försök igen
            </button>
          </div>
        )}

        {view === "result" && result && (
          <StoreComparison
            result={result}
            rebuildState={rebuildState}
            cartStale={cartStale}
            comparisonUpdatedAt={comparisonUpdatedAt}
            onRefreshComparison={runComparison}
            liveStoreId={storeId}
          />
        )}

        {!storeId && view === "idle" && (
          <p className="text-xs text-gray-400 text-center">
            Besök{" "}
            <a
              href="https://handlaprivatkund.ica.se"
              target="_blank"
              rel="noreferrer"
              className="underline"
            >
              handlaprivatkund.ica.se
            </a>{" "}
            och logga in för att aktivera extensionen.
          </p>
        )}
      </div>
    </div>
  );
}

// ─── Sub-components ───────────────────────────────────────────────────────────

/**
 * Maps all comparison steps to a single continuously-increasing 0–100 scale.
 * cart+stores_list: 0–8 %
 * store_catalogues: 8–82 %
 * iframe_fallback:  82–98 %
 * Never resets — the bar only moves forward.
 */
function computeUnifiedPercent(p: ComparisonProgressState | null): number {
  if (!p) return 0;
  const frac = p.total > 0 ? p.current / p.total : 0;
  switch (p.step) {
    case "cart":          return 3;
    case "stores_list":   return 8;
    case "store_catalogues": return 8 + Math.round(frac * 74);
    case "iframe_fallback":  return 82 + Math.round(frac * 16);
    default: return 0;
  }
}

function ComparisonLoadingPanel({
  progress,
}: {
  progress: ComparisonProgressState | null;
}) {
  // Live clock — ticks every 500 ms so the countdown updates in real time.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(id);
  }, []);

  // Ref so we can read the start time without adding it to effect deps.
  const runStartRef = useRef<number | null>(null);
  const [totalEstimate, setTotalEstimate] = useState<number>(0);
  const [iframeEstimate, setIframeEstimate] = useState<number>(3);

  const step = progress?.step;
  const total = progress?.total ?? 0;

  useEffect(() => {
    if (!step) {
      // Comparison finished or not started — reset.
      runStartRef.current = null;
      setTotalEstimate(0);
      return;
    }
    if (runStartRef.current === null) {
      // First step seen — start the clock immediately with a rough initial
      // estimate (15 s covers most carts; will be refined below).
      runStartRef.current = Date.now();
      setTotalEstimate(15);
    }
    if (step === "store_catalogues") {
      // Refine: now we know the store count. Buffer includes time for iframe phase.
      const elapsed = (Date.now() - runStartRef.current!) / 1000;
      const catalogEst = Math.max(3, Math.ceil(total / 10));
      setTotalEstimate(elapsed + catalogEst + 10); // +10 s iframe buffer
    } else if (step === "iframe_fallback") {
      // Update bar animation duration but do NOT reset totalEstimate — that would
      // cause the countdown to jump back up if the catalog phase ran long.
      // The existing estimate keeps ticking down smoothly; bar CSS handles visuals.
      const ifrEst = Math.max(2, Math.ceil(total / 30) * 0.85);
      setIframeEstimate(ifrEst);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, total]);

  const pct = computeUnifiedPercent(progress);
  const label = progress?.detail ?? "Startar jämförelse…";

  const isIframePhase = step === "iframe_fallback";
  const iframeDone = isIframePhase && total > 0 && progress?.current === total;

  // iframe_fallback bar: CSS transition animates 82 → 98 % over iframeEstimate s.
  // store_catalogues bar: real progress updates drive it incrementally.
  const barPct = isIframePhase ? 98 : pct;
  const barTransition = isIframePhase
    ? `width ${iframeDone ? "0.4s ease-out" : `${iframeEstimate}s linear`}`
    : "width 0.5s ease-out";

  // Single countdown from the very first step; falls back to pct% only when done.
  let leftLabel: string;
  if (runStartRef.current !== null && !iframeDone) {
    const elapsed = (now - runStartRef.current) / 1000;
    const remaining = Math.max(1, Math.round(totalEstimate - elapsed));
    leftLabel = `~${remaining}s`;
  } else {
    leftLabel = `${pct}%`;
  }

  return (
    <div className="py-6 space-y-3">
      <div className="relative h-2.5 bg-gray-200 rounded-full overflow-hidden">
        <div
          className="h-full bg-[#e3000b] rounded-full"
          style={{ width: `${barPct}%`, transition: barTransition }}
        />
      </div>
      <div className="flex items-center justify-between text-[11px] text-gray-500">
        <span className="tabular-nums font-medium">{leftLabel}</span>
        <span className="truncate max-w-[220px] text-right">{label}</span>
      </div>
    </div>
  );
}

function ZipSection({
  savedZip,
  zipCode,
  editingZip,
  storeId,
  onZipChange,
  onSaveZip,
  onEditZip,
}: {
  savedZip: string | null;
  zipCode: string;
  editingZip: boolean;
  storeId: string | null;
  onZipChange: (v: string) => void;
  onSaveZip: (v: string) => void;
  onEditZip: () => void;
}) {
  const [localZip, setLocalZip] = useState(zipCode);

  useEffect(() => {
    setLocalZip(zipCode);
  }, [zipCode]);

  if (savedZip && !editingZip) {
    return (
      <div className="flex items-center justify-between bg-gray-50 rounded-lg px-3 py-2">
        <div>
          <span className="text-xs text-gray-500">Postnummer</span>
          <p className="text-sm font-medium text-gray-800">{savedZip}</p>
        </div>
        <div className="flex items-center gap-2">
          {storeId && (
            <span className="text-xs bg-green-100 text-green-700 px-2 py-0.5 rounded-full">
              Ansluten
            </span>
          )}
          <button
            onClick={onEditZip}
            className="text-xs text-gray-500 underline hover:text-gray-700"
          >
            Ändra
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <label className="text-xs font-medium text-gray-600">
        Ditt postnummer (för hemleverans)
      </label>
      <div className="flex gap-2">
        <input
          type="text"
          inputMode="numeric"
          maxLength={6}
          placeholder="12345"
          value={localZip}
          onChange={(e) => {
            const v = e.target.value.replace(/\D/g, "").slice(0, 5);
            setLocalZip(v);
            onZipChange(v);
          }}
          className="flex-1 border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#e3000b] focus:border-transparent"
        />
        <button
          onClick={() => localZip.length === 5 && onSaveZip(localZip)}
          disabled={localZip.length !== 5}
          className="bg-[#e3000b] disabled:bg-gray-200 text-white text-sm font-medium px-4 rounded-lg"
        >
          Spara
        </button>
      </div>
    </div>
  );
}

function humanizeError(code: string): string {
  if (code?.includes("NOT_LOGGED_IN"))
    return "Du är inte inloggad på ICA. Logga in på handlaprivatkund.ica.se och försök igen.";
  if (code?.includes("EMPTY_CART"))
    return "Din varukorg är tom. Lägg till varor och försök igen.";
  if (code?.includes("NO_STORES"))
    return "Inga butiker med hemleverans hittades för det angivna postnumret.";
  if (code?.includes("NO_STORE"))
    return "Kunde inte läsa aktuell butik. Besök handlaprivatkund.ica.se och logga in.";
  if (code?.includes("NO_ZIP"))
    return "Ange ditt postnummer för att hitta butiker i närheten.";
  return `Något gick fel: ${code}`;
}
