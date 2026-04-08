import { useRef, useState, useCallback, useEffect } from 'react';
import './VoiceTriage.css';

// Validate env at module load — surfaces misconfigured .env immediately in console
const API_BASE = (() => {
  const raw = import.meta.env.VITE_API_URL as string | undefined;
  if (!raw || !raw.startsWith('http')) {
    console.error(
      '[UmNyango] VITE_API_URL is missing or invalid.\n' +
      'Copy frontend/.env.example to frontend/.env and set VITE_API_URL to your API Gateway URL.'
    );
    return '';
  }
  // Strip accidental trailing slash so /triage always joins cleanly
  return raw.replace(/\/$/, '');
})();

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
interface TriageResult {
  urgency: 'emergency' | 'urgent' | 'routine';
  clinic_type: 'emergency_room' | 'chc' | 'clinic' | 'pharmacy';
  summary: string;
  benefits: string[];
  refer_emergency: boolean;
}

type AppState = 'idle' | 'listening' | 'loading' | 'result' | 'error';

// Extend window for webkit prefix
declare global {
  interface Window {
    webkitSpeechRecognition: new () => SpeechRecognition;
  }
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const URGENCY_LABEL: Record<TriageResult['urgency'], string> = {
  emergency: '🚨 Emergency',
  urgent: '⚠️ Urgent',
  routine: '✅ Routine',
};

const URGENCY_COLOR: Record<TriageResult['urgency'], string> = {
  emergency: '#c0392b',
  urgent: '#e67e22',
  routine: '#27ae60',
};

const CLINIC_LABEL: Record<TriageResult['clinic_type'], string> = {
  emergency_room: 'Emergency Room',
  chc: 'Community Health Centre',
  clinic: 'Clinic',
  pharmacy: 'Pharmacy',
};

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------
export default function VoiceTriage() {
  const [appState, setAppState] = useState<AppState>('idle');
  const [triage, setTriage] = useState<TriageResult | null>(null);
  const [errorMsg, setErrorMsg] = useState('');

  const recognitionRef = useRef<SpeechRecognition | null>(null);
  const transcriptRef = useRef('');

  // Warn in the UI if env is misconfigured
  useEffect(() => {
    if (!API_BASE) {
      setErrorMsg('App is misconfigured: VITE_API_URL is not set. Check your frontend/.env file.');
      setAppState('error');
    }
  }, []);

  // -------------------------------------------------------------------------
  // Speech recognition helpers
  // -------------------------------------------------------------------------
  const startListening = useCallback(() => {
    if (!('webkitSpeechRecognition' in window) && !('SpeechRecognition' in window)) {
      setErrorMsg('Speech recognition is not supported in this browser. Please use Chrome on Android.');
      setAppState('error');
      return;
    }

    const SpeechRecognitionAPI =
      window.SpeechRecognition ?? window.webkitSpeechRecognition;

    const recognition = new SpeechRecognitionAPI();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = 'en-ZA';

    transcriptRef.current = '';

    recognition.onresult = (event: SpeechRecognitionEvent) => {
      let interim = '';
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const chunk = event.results[i][0].transcript;
        if (event.results[i].isFinal) {
          transcriptRef.current += chunk + ' ';
        } else {
          interim += chunk;
        }
      }
      // interim is intentionally discarded — we only send final transcript
      void interim;
    };

    recognition.onerror = () => {
      setErrorMsg('Could not capture audio. Please check microphone permissions.');
      setAppState('error');
    };

    recognition.start();
    recognitionRef.current = recognition;
    setAppState('listening');
  }, []);

  const stopListeningAndSubmit = useCallback(async () => {
    recognitionRef.current?.stop();
    recognitionRef.current = null;

    const text = transcriptRef.current.trim();
    if (!text) {
      setAppState('idle');
      return;
    }

    setAppState('loading');
    setTriage(null);
    setErrorMsg('');

    try {
      const res = await fetch(`${API_BASE}/triage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      });

      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      const data = await res.json();
      setTriage(data.triage);
      setAppState('result');

      // Auto-play Polly audio
      if (data.audio) {
        const audio = new Audio(`data:audio/mp3;base64,${data.audio}`);
        audio.play().catch(() => {
          // Autoplay blocked — user can replay manually (not a critical failure)
        });
      }
    } catch {
      setErrorMsg('Something went wrong. Please try again.');
      setAppState('error');
    }
  }, []);

  // -------------------------------------------------------------------------
  // Touch / mouse handlers (hold-to-speak)
  // -------------------------------------------------------------------------
  const handlePressStart = useCallback((e: React.MouseEvent | React.TouchEvent) => {
    e.preventDefault();
    if (appState === 'loading') return;
    startListening();
  }, [appState, startListening]);

  const handlePressEnd = useCallback((e: React.MouseEvent | React.TouchEvent) => {
    e.preventDefault();
    if (appState !== 'listening') return;
    stopListeningAndSubmit();
  }, [appState, stopListeningAndSubmit]);

  const handleReset = () => {
    setAppState('idle');
    setTriage(null);
    setErrorMsg('');
    transcriptRef.current = '';
  };

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------
  return (
    <div className="vt-container">
      <header className="vt-header">
        <h1 className="vt-title">UmNyango</h1>
        <p className="vt-subtitle">Your wellness pathway</p>
      </header>

      <main className="vt-main">
        {/* Hold-to-speak button */}
        {(appState === 'idle' || appState === 'listening') && (
          <div className="vt-speak-section">
            <button
              className={`vt-speak-btn ${appState === 'listening' ? 'vt-speak-btn--active' : ''}`}
              onMouseDown={handlePressStart}
              onMouseUp={handlePressEnd}
              onMouseLeave={appState === 'listening' ? handlePressEnd : undefined}
              onTouchStart={handlePressStart}
              onTouchEnd={handlePressEnd}
              aria-label={appState === 'listening' ? 'Listening — release to send' : 'Hold to speak'}
              aria-pressed={appState === 'listening'}
            >
              <span className="vt-speak-icon" aria-hidden="true">
                {appState === 'listening' ? '🔴' : '🎙️'}
              </span>
            </button>
            <p className="vt-hint">
              {appState === 'listening' ? 'Listening… release when done' : 'Hold to speak'}
            </p>
          </div>
        )}

        {/* Loading */}
        {appState === 'loading' && (
          <div className="vt-loading" role="status" aria-live="polite">
            <div className="vt-spinner" aria-hidden="true" />
            <p>Checking your symptoms…</p>
          </div>
        )}

        {/* Result */}
        {appState === 'result' && triage && (
          <div className="vt-result" aria-live="polite">
            <div
              className="vt-urgency-badge"
              style={{ backgroundColor: URGENCY_COLOR[triage.urgency] }}
              role="status"
            >
              {URGENCY_LABEL[triage.urgency]}
            </div>

            <div className="vt-card">
              <p className="vt-summary">{triage.summary}</p>
            </div>

            <div className="vt-card">
              <p className="vt-label">Recommended facility</p>
              <p className="vt-value">{CLINIC_LABEL[triage.clinic_type]}</p>
            </div>

            {triage.benefits.length > 0 && (
              <div className="vt-card">
                <p className="vt-label">You may qualify for</p>
                <ul className="vt-benefits">
                  {triage.benefits.map((b) => (
                    <li key={b}>{b}</li>
                  ))}
                </ul>
              </div>
            )}

            {triage.refer_emergency && (
              <div className="vt-emergency-banner" role="alert">
                🚨 Please go to the nearest emergency room now.
              </div>
            )}

            <button className="vt-reset-btn" onClick={handleReset}>
              Speak again
            </button>
          </div>
        )}

        {/* Error */}
        {appState === 'error' && (
          <div className="vt-error" role="alert">
            <p>{errorMsg}</p>
            <button className="vt-reset-btn" onClick={handleReset}>
              Try again
            </button>
          </div>
        )}
      </main>
    </div>
  );
}
