import React, { useEffect, useState } from "react";
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
        setStoreId(resp.storeId ?? null);
        setSavedZip(resp.zipCode ?? null);
        if (resp.zipCode) setZipCode(resp.zipCode);
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
      { type: "GET_COMPARISON", zipCode: zip },
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

/** True % for steps with real sub-progress; 0 for indeterminate steps */
function comparisonProgressDeterminate(p: ComparisonProgressState): number {
  if (p.total <= 0) return 0;
  if (p.step === "store_catalogues" || p.step === "iframe_fallback") {
    return Math.min(100, Math.round((p.current / p.total) * 100));
  }
  return 0;
}

function isComparisonProgressIndeterminate(
  progress: ComparisonProgressState | null
): boolean {
  if (!progress) return true;
  // Varukorg + butikslista: ingen riktig del-progress från API → glidande stapel
  if (progress.step === "cart" || progress.step === "stores_list") return true;
  // Deterministic once we have actual counts
  if (
    (progress.step === "store_catalogues" || progress.step === "iframe_fallback") &&
    progress.total > 0 &&
    progress.current === 0
  ) {
    return true;
  }
  return false;
}

function ComparisonLoadingPanel({
  progress,
}: {
  progress: ComparisonProgressState | null;
}) {
  const indeterminate = isComparisonProgressIndeterminate(progress);
  const pct = progress ? comparisonProgressDeterminate(progress) : 0;
  const label = progress?.detail ?? "Startar jämförelse…";

  const hasCounts =
    progress !== null &&
    progress.total > 0 &&
    (progress.step === "store_catalogues" || progress.step === "iframe_fallback");

  const countLabel =
    progress?.step === "store_catalogues"
      ? "butiker"
      : "sökningar";

  return (
    <div className="py-6 space-y-4">
      <div className="relative h-3 bg-gray-200 rounded-full overflow-hidden">
        {indeterminate ? (
          <div className="ica-progress-indeterminate" aria-hidden />
        ) : (
          <div
            className="h-full bg-[#e3000b] transition-[width] duration-300 ease-out rounded-full"
            style={{ width: `${pct}%` }}
          />
        )}
      </div>
      <div className="flex justify-between text-[11px] text-gray-500 tabular-nums">
        <span>{!indeterminate && hasCounts ? `${pct}%` : "…"}</span>
        {hasCounts ? (
          <span>
            {progress!.current}/{progress!.total} {countLabel}
          </span>
        ) : null}
      </div>
      <p className="text-sm text-gray-700 leading-snug min-h-[2.5rem]">{label}</p>
      <div className="flex justify-center pt-1">
        <div className="w-7 h-7 border-[3px] border-[#e3000b] border-t-transparent rounded-full animate-spin" />
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
