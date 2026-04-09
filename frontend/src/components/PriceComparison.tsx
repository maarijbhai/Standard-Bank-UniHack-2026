/**
 * PriceComparison — Nearby Pharmacy Price Comparison
 *
 * Lets the user search for a medication and see prices at nearby pharmacies,
 * sorted cheapest first, with distance and price source indicators.
 */

import { useState } from 'react';
import { usePrices, type PharmacyResult } from '../hooks/usePrices';
import './PriceComparison.css';

// Common SA medications for quick-select chips
const QUICK_MEDS = [
  'Panado', 'Strepsils', 'Ibuprofen 200mg', 'Corenza C',
  'Buscopan', 'Imodium', 'Allergex', 'Vitamin C 500mg',
];

export default function PriceComparison() {
  const [query, setQuery]   = useState('');
  const { compare, result, loading, error, reset } = usePrices();

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (query.trim()) compare(query.trim());
  };

  const handleChip = (med: string) => {
    setQuery(med);
    compare(med);
  };

  const cheapest = result?.pharmacies.find(p => p.priceZAR !== null);

  return (
    <div className="pc-container">
      <div className="pc-header">
        <span className="pc-icon">💊</span>
        <div>
          <h2 className="pc-title">Price Comparison</h2>
          <p className="pc-sub">Find the cheapest pharmacy near you</p>
        </div>
      </div>

      {/* Search */}
      <form className="pc-form" onSubmit={handleSubmit}>
        <input
          className="pc-input"
          type="text"
          value={query}
          onChange={e => { setQuery(e.target.value); if (result) reset(); }}
          placeholder="Search medication (e.g. Panado, Strepsils…)"
          aria-label="Medication name"
        />
        <button
          type="submit"
          className="pc-search-btn"
          disabled={!query.trim() || loading}
        >
          {loading ? '…' : 'Search'}
        </button>
      </form>

      {/* Quick-select chips */}
      {!result && !loading && (
        <div className="pc-chips" role="group" aria-label="Common medications">
          {QUICK_MEDS.map(med => (
            <button key={med} className="pc-chip" onClick={() => handleChip(med)}>
              {med}
            </button>
          ))}
        </div>
      )}

      {/* Loading */}
      {loading && (
        <div className="pc-loading" role="status" aria-live="polite">
          <div className="pc-spinner" aria-hidden="true" />
          <p>Finding prices near you…</p>
        </div>
      )}

      {/* Error */}
      {error && (
        <div className="pc-error" role="alert">
          <p>{error}</p>
          <button className="pc-retry-btn" onClick={() => compare(query)}>Retry</button>
        </div>
      )}

      {/* Results */}
      {result && !loading && (
        <div className="pc-results" aria-live="polite">
          <div className="pc-result-header">
            <div>
              <p className="pc-med-name">{result.medication}</p>
              <p className="pc-med-meta">{result.category} · {result.unit}</p>
            </div>
            {result.officialPrice && (
              <div className="pc-official-price">
                <span className="pc-official-label">Official</span>
                <span className="pc-official-val">R{result.officialPrice.toFixed(2)}</span>
              </div>
            )}
          </div>

          {cheapest && (
            <div className="pc-best-deal">
              🏆 Best deal: <strong>{cheapest.name}</strong> — R{cheapest.priceZAR!.toFixed(2)} ({cheapest.distanceKm} km)
            </div>
          )}

          <div className="pc-list">
            {result.pharmacies.map((p, i) => (
              <PharmacyCard key={p.pharmacyId} pharmacy={p} rank={i + 1} isCheapest={i === 0 && p.priceZAR !== null} />
            ))}
          </div>

          <button className="pc-reset-btn" onClick={() => { reset(); setQuery(''); }}>
            Search again
          </button>
        </div>
      )}
    </div>
  );
}

function PharmacyCard({ pharmacy, rank, isCheapest }: {
  pharmacy: PharmacyResult;
  rank: number;
  isCheapest: boolean;
}) {
  return (
    <div className={`pc-card ${isCheapest ? 'pc-card--best' : ''}`}>
      <div className="pc-card-rank">{isCheapest ? '🏆' : `#${rank}`}</div>
      <div className="pc-card-body">
        <p className="pc-card-name">{pharmacy.name}</p>
        <p className="pc-card-addr">{pharmacy.address}</p>
        <div className="pc-card-meta">
          <span className="pc-card-dist">📍 {pharmacy.distanceKm} km</span>
          {pharmacy.priceSource === 'estimated' && (
            <span className="pc-card-est">~estimated</span>
          )}
        </div>
      </div>
      <div className="pc-card-price">
        {pharmacy.priceZAR !== null
          ? <><span className="pc-price-val">R{pharmacy.priceZAR.toFixed(2)}</span></>
          : <span className="pc-price-na">N/A</span>
        }
      </div>
    </div>
  );
}
