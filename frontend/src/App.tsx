import { useState } from 'react';
import VoiceTriage from './components/VoiceTriage';
import PriceComparison from './components/PriceComparison';
import './App.css';

type Tab = 'triage' | 'prices';

export default function App() {
  const [activeTab, setActiveTab] = useState<Tab>('triage');

  return (
    <div className="app-shell">
      <div className="app-content">
        {activeTab === 'triage' && <VoiceTriage />}
        {activeTab === 'prices' && (
          <div className="app-tab-page">
            <PriceComparison />
          </div>
        )}
      </div>

      {/* Bottom tab bar */}
      <nav className="app-tab-bar" role="tablist" aria-label="Main navigation">
        <button
          role="tab"
          aria-selected={activeTab === 'triage'}
          className={`app-tab ${activeTab === 'triage' ? 'app-tab--active' : ''}`}
          onClick={() => setActiveTab('triage')}
        >
          <span className="app-tab-icon">🩺</span>
          <span className="app-tab-label">Triage</span>
        </button>
        <button
          role="tab"
          aria-selected={activeTab === 'prices'}
          className={`app-tab ${activeTab === 'prices' ? 'app-tab--active' : ''}`}
          onClick={() => setActiveTab('prices')}
        >
          <span className="app-tab-icon">💊</span>
          <span className="app-tab-label">Prices</span>
        </button>
      </nav>
    </div>
  );
}
