import { useState } from 'react';
import VoiceTriage from './components/VoiceTriage';
import PriceComparison from './components/PriceComparison';
import SkipQueue from './components/SkipQueue';
import ContinuityDashboard from './components/ContinuityDashboard';
import './App.css';

type Tab = 'triage' | 'prices' | 'skipqueue' | 'continuity';

export default function App() {
  const [activeTab,  setActiveTab]  = useState<Tab>('triage');
  const [priceQuery, setPriceQuery] = useState<string>('');

  const openPriceTab = (medicationName: string) => {
    setPriceQuery(medicationName);
    setActiveTab('prices');
  };

  return (
    <div className="app-shell">
      <div className="app-content">
        {activeTab === 'triage' && <VoiceTriage onComparePrices={openPriceTab} />}
        {activeTab === 'prices' && (
          <div className="app-tab-page">
            <PriceComparison initialQuery={priceQuery} onQueryConsumed={() => setPriceQuery('')} />
          </div>
        )}
        {activeTab === 'skipqueue' && (
          <div className="app-tab-page">
            <SkipQueue />
          </div>
        )}
        {activeTab === 'continuity' && (
          <div className="app-tab-page">
            <ContinuityDashboard />
          </div>
        )}
      </div>

      <nav className="app-tab-bar" role="tablist" aria-label="Main navigation">
        <button
          role="tab" aria-selected={activeTab === 'triage'}
          className={`app-tab ${activeTab === 'triage' ? 'app-tab--active' : ''}`}
          onClick={() => setActiveTab('triage')}
        >
          <span className="app-tab-icon">🩺</span>
          <span className="app-tab-label">Triage</span>
        </button>
        <button
          role="tab" aria-selected={activeTab === 'prices'}
          className={`app-tab ${activeTab === 'prices' ? 'app-tab--active' : ''}`}
          onClick={() => setActiveTab('prices')}
        >
          <span className="app-tab-icon">💊</span>
          <span className="app-tab-label">Prices</span>
        </button>
        <button
          role="tab" aria-selected={activeTab === 'skipqueue'}
          className={`app-tab ${activeTab === 'skipqueue' ? 'app-tab--active' : ''}`}
          onClick={() => setActiveTab('skipqueue')}
        >
          <span className="app-tab-icon">⏭️</span>
          <span className="app-tab-label">SkipQueue</span>
        </button>
        <button
          role="tab" aria-selected={activeTab === 'continuity'}
          className={`app-tab ${activeTab === 'continuity' ? 'app-tab--active' : ''}`}
          onClick={() => setActiveTab('continuity')}
        >
          <span className="app-tab-icon">📈</span>
          <span className="app-tab-label">My Health</span>
        </button>
      </nav>
    </div>
  );
}
