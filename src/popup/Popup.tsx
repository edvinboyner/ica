import React, { useEffect, useState } from "react";
import StoreComparison from "./StoreComparison";
import type { ComparisonResult } from "../api/types";

type View = "idle" | "loading" | "result" | "error";

export default function Popup() {
  const [view, setView] = useState<View>("idle");
  const [zipCode, setZipCode] = useState("");
  const [savedZip, setSavedZip] = useState<string | null>(null);
  const [storeId, setStoreId] = useState<string | null>(null);
  const [result, setResult] = useState<ComparisonResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editingZip, setEditingZip] = useState(false);

  // Load persisted state on mount
  useEffect(() => {
    chrome.runtime.sendMessage({ type: "GET_STATE" }, (resp) => {
      if (resp) {
        setStoreId(resp.storeId ?? null);
        setSavedZip(resp.zipCode ?? null);
        if (resp.zipCode) setZipCode(resp.zipCode);
      }
    });
  }, []);

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
          <div className="text-center py-8 space-y-3">
            <div className="inline-block w-8 h-8 border-4 border-[#e3000b] border-t-transparent rounded-full animate-spin" />
            <p className="text-sm text-gray-500">Hämtar priser från alla butiker…</p>
          </div>
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
          <div className="space-y-3">
            <StoreComparison result={result} />
            <button
              onClick={() => { setView("idle"); setResult(null); }}
              className="w-full border border-gray-300 text-gray-600 text-sm py-2 rounded-lg hover:bg-gray-50"
            >
              Jämför igen
            </button>
          </div>
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
