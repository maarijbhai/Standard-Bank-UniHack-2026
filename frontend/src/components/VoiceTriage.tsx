import { useRef, useState, useCallback, useEffect } from 'react';
import './VoiceTriage.css';

// ---------------------------------------------------------------------------
// Env validation — shown in UI debug panel
// ---------------------------------------------------------------------------
const API_BASE = (() => {
  const raw = import.meta.env.VITE_API_URL as string | undefined;
  if (!raw || !raw.startsWith('http')) return '';
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

interface DebugEntry {
  ts: string;
  msg: string;
}

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
  const [debugLog, setDebugLog] = useState<DebugEntry[]>([]);
  const [showDebug, setShowDebug] = useState(true);

  const recognitionRef = useRef<SpeechRecognition | null>(null);
  const transcriptRef = useRef('');
  // Track whether we intentionally stopped recognition (vs browser auto-stop)
  const intentionalStopRef = useRef(false);

  const log = useCallback((msg: string) => {
    const ts = new Date().toISOString().slice(11, 23);
    console.log(`[UmNyango ${ts}] ${msg}`);
    setDebugLog(prev => [...prev.slice(-19), { ts, msg }]);
  }, []);

  // Env check on mount
  useEffect(() => {
    log(`API_BASE = "${API_BASE}"`);
    log(`SpeechRecognition available: ${'webkitSpeechRecognition' in window || 'SpeechRecognition' in window}`);
    if (!API_BASE) {
      setErrorMsg('VITE_API_URL is not set or invalid. Check frontend/.env');
      setAppState('error');
    }
  }, [log]);

  // -------------------------------------------------------------------------
  // Speech recognition
  // -------------------------------------------------------------------------
  const startListening = useCallback(() => {
    if (!('webkitSpeechRecognition' in window) && !('SpeechRecognition' in window)) {
      setErrorMsg('Speech recognition not supported. Use Chrome on Android/desktop.');
      setAppState('error');
      return;
    }

    const SpeechRecognitionAPI = window.SpeechRecognition ?? window.webkitSpeechRecognition;
    const recognition = new SpeechRecognitionAPI();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = 'en-ZA';

    transcriptRef.current = '';
    intentionalStopRef.current = false;

    recognition.onstart = () => log('STT: recognition started');

    recognition.onresult = (event: SpeechRecognitionEvent) => {
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const chunk = event.results[i][0].transcript;
        if (event.results[i].isFinal) {
          transcriptRef.current += chunk + ' ';
          log(`STT final chunk: "${chunk}"`);
        }
      }
    };

    recognition.onerror = (event: SpeechRecognitionErrorEvent) => {
      log(`STT error: ${event.error}`);
      if (event.error === 'no-speech') {
        // non-fatal — user just didn't speak yet
        return;
      }
      setErrorMsg(`Microphone error: ${event.error}. Check permissions.`);
      setAppState('error');
    };

    // onend fires when recognition stops for ANY reason (intentional or not)
    recognition.onend = () => {
      log(`STT: recognition ended (intentional=${intentionalStopRef.current})`);
      // If the browser stopped recognition before the user released the button,
      // submit whatever we have so far
      if (!intentionalStopRef.current && appState === 'listening') {
        submitTranscript();
      }
    };

    recognition.start();
    recognitionRef.current = recognition;
    setAppState('listening');
    log('STT: start() called');
  }, [log]); // eslint-disable-line react-hooks/exhaustive-deps

  const submitTranscript = useCallback(async () => {
    const text = transcriptRef.current.trim();
    log(`Submitting transcript: "${text}" (length=${text.length})`);

    if (!text) {
      log('Empty transcript — returning to idle');
      setAppState('idle');
      return;
    }

    setAppState('loading');
    setTriage(null);
    setErrorMsg('');

    const url = `${API_BASE}/triage`;
    log(`POST ${url}`);

    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      });

      log(`Response status: ${res.status} ${res.statusText}`);

      const rawText = await res.text();
      log(`Response body (first 200 chars): ${rawText.slice(0, 200)}`);

      if (!res.ok) {
        throw new Error(`HTTP ${res.status}: ${rawText.slice(0, 120)}`);
      }

      let data: { triage: TriageResult; audio?: string };
      try {
        data = JSON.parse(rawText);
      } catch {
        throw new Error(`Invalid JSON from server: ${rawText.slice(0, 120)}`);
      }

      if (!data.triage) {
        throw new Error(`Missing triage field in response: ${rawText.slice(0, 120)}`);
      }

      log(`Triage OK — urgency=${data.triage.urgency} clinic=${data.triage.clinic_type}`);
      setTriage(data.triage);
      setAppState('result');

      if (data.audio) {
        log('Playing Polly audio');
        const audio = new Audio(`data:audio/mp3;base64,${data.audio}`);
        audio.play().catch((e) => log(`Audio autoplay blocked: ${e.message}`));
      } else {
        log('No audio in response');
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      log(`FETCH ERROR: ${msg}`);
      setErrorMsg(`Request failed: ${msg}`);
      setAppState('error');
    }
  }, [log]);

  const stopListeningAndSubmit = useCallback(async () => {
    intentionalStopRef.current = true;
    recognitionRef.current?.stop();
    recognitionRef.current = null;
    log('STT: stop() called by user');
    await submitTranscript();
  }, [log, submitTranscript]);

  // -------------------------------------------------------------------------
  // Press handlers
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
    log('Reset to idle');
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

        {appState === 'loading' && (
          <div className="vt-loading" role="status" aria-live="polite">
            <div className="vt-spinner" aria-hidden="true" />
            <p>Checking your symptoms…</p>
          </div>
        )}

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
                  {triage.benefits.map((b) => <li key={b}>{b}</li>)}
                </ul>
              </div>
            )}
            {triage.refer_emergency && (
              <div className="vt-emergency-banner" role="alert">
                🚨 Please go to the nearest emergency room now.
              </div>
            )}
            <button className="vt-reset-btn" onClick={handleReset}>Speak again</button>
          </div>
        )}

        {appState === 'error' && (
          <div className="vt-error" role="alert">
            <p>{errorMsg}</p>
            <button className="vt-reset-btn" onClick={handleReset}>Try again</button>
          </div>
        )}

        {/* ---------------------------------------------------------------- */}
        {/* DEBUG PANEL — remove before production                           */}
        {/* ---------------------------------------------------------------- */}
        <div className="vt-debug">
          <button
            className="vt-debug-toggle"
            onClick={() => setShowDebug(p => !p)}
          >
            🛠 Debug {showDebug ? '▲' : '▼'}
          </button>
          {showDebug && (
            <div className="vt-debug-body">
              <div className="vt-debug-row">
                <span className="vt-debug-label">API_BASE</span>
                <span className={`vt-debug-val ${!API_BASE ? 'vt-debug-err' : ''}`}>
                  {API_BASE || '⚠ NOT SET'}
                </span>
              </div>
              <div className="vt-debug-row">
                <span className="vt-debug-label">State</span>
                <span className="vt-debug-val">{appState}</span>
              </div>
              <div className="vt-debug-log">
                {debugLog.length === 0
                  ? <span className="vt-debug-empty">No events yet</span>
                  : [...debugLog].reverse().map((e, i) => (
                    <div key={i} className="vt-debug-entry">
                      <span className="vt-debug-ts">{e.ts}</span>
                      <span>{e.msg}</span>
                    </div>
                  ))
                }
              </div>
              <button
                className="vt-debug-clear"
                onClick={() => setDebugLog([])}
              >
                Clear log
              </button>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
