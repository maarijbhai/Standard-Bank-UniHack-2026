/**
 * usePrices — Nearby Pharmacy Price Comparison hook
 *
 * Usage:
 *   const { compare, result, loading, error, reset } = usePrices();
 *   compare('Panado');
 */

import { useState, useCallback } from 'react';

// Cape Town city centre fallback — used when geolocation is denied or unavailable
const CAPE_TOWN_FALLBACK = { lat: -33.9249, lng: 18.4241 };

const API_BASE = (() => {
  const raw = import.meta.env.VITE_API_URL as string | undefined;
  return raw ? raw.replace(/\/$/, '') : '';
})();

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
export interface PharmacyResult {
  pharmacyId:  string;
  name:        string;
  address:     string;
  distanceKm:  number;
  priceZAR:    number | null;
  priceSource: 'local' | 'estimated' | 'unavailable';
}

export interface PriceComparisonResult {
  medication:    string;
  officialPrice: number | null;
  unit:          string;
  category:      string;
  pharmacies:    PharmacyResult[];
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------
export function usePrices() {
  const [result,  setResult]  = useState<PriceComparisonResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error,   setError]   = useState<string | null>(null);

  const getCoords = (): Promise<{ lat: number; lng: number }> =>
    new Promise((resolve) => {
      if (!navigator.geolocation) {
        resolve(CAPE_TOWN_FALLBACK);
        return;
      }
      navigator.geolocation.getCurrentPosition(
        (pos) => resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
        ()    => resolve(CAPE_TOWN_FALLBACK), // fallback on denial/timeout
        { timeout: 8000, maximumAge: 60000 }
      );
    });

  const compare = useCallback(async (medicationName: string) => {
    if (!medicationName.trim()) return;
    setLoading(true);
    setResult(null);
    setError(null);

    try {
      const { lat, lng } = await getCoords();

      const res = await fetch(`${API_BASE}/compare-prices`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ medicationName: medicationName.trim(), userLat: lat, userLng: lng }),
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.debug_error ?? data.error ?? `HTTP ${res.status}`);

      setResult(data as PriceComparisonResult);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  const reset = useCallback(() => {
    setResult(null);
    setError(null);
  }, []);

  return { compare, result, loading, error, reset };
}
