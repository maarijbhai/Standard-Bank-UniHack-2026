import { useRef, useState, useCallback, useEffect } from 'react';
import './VoiceTriage.css';

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
  needs_more_info: boolean;
  follow_up_question: string;
}

interface HistoryEntry {
  role: 'user' | 'assistant';
  content: string;
}

type AppState = 'idle' | 'listening' | 'loading' | 'followup' | 'result' | 'error';

interface DebugEntry { ts: string; msg: string; }

declare global {
  interface Window { webkitSpeechRecognition: new () => SpeechRecognition; }
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const URGENCY_LABEL: Record<TriageResult['urgency'], string> = {
  emergency: '🚨 Emergency',
  urgent:    '⚠️ Urgent',
  routine:   '✅ Routine',
};
const URGENCY_COLOR: Record<TriageResult['urgency'], string> = {
  emergency: '#c0392b',
  urgent:    '#e67e22',
  routine:   '#27ae60',
};
const CLINIC_LABEL: Record<TriageResult['clinic_type'], string> = {
  emergency_room: 'Emergency Room',
  chc:            'Community Health Centre',
  clinic:         'Clinic',
  pharmacy:       'Pharmacy',
};

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------
export default function VoiceTriage() {
  const [appState,      setAppState]      = useState<AppState>('idle');
  const [triage,        setTriage]        = useState<TriageResult | null>(null);
  const [followUpQ,     setFollowUpQ]     = useState('');
  const [textInput,     setTextInput]     = useState('');
  const [errorMsg,      setErrorMsg]      = useState('');
  const [debugLog,      setDebugLog]      = useState<DebugEntry[]>([]);
  const [showDebug,     setShowDebug]     = useState(false);
  const [inputMode,     setInputMode]     = useState<'voice' | 'text'>('voice');

  // Conversation history for multi-turn context
  const historyRef         = useRef<HistoryEntry[]>([]);
  const recognitionRef     = useRef<SpeechRecognition | null>(null);
  const transcriptRef      = useRef('');
  const intentionalStopRef = useRef(false);
  const pressStartTimeRef  = useRef(0);

  const log = useCallback((msg: string) => {
    const ts = new Date().toISOString().slice(11, 23);
    console.log(`[UmNyango ${ts}] ${msg}`);
    setDebugLog(prev => [...prev.slice(-29), { ts, msg }]);
  }, []);

  useEffect(() => {
    log(`API_BASE = "${API_BASE}"`);
    log(`STT available: ${'webkitSpeechRecognition' in window || 'SpeechRecognition' in window}`);
    if (!API_BASE) {
      setErrorMsg('VITE_API_URL is not set. Check frontend/.env');
      setAppState('error');
    }
  }, [log]);

  // -------------------------------------------------------------------------
  // Core submit — sends text + history to /triage
  // -------------------------------------------------------------------------
  const submitText = useCallback(async (text: string) => {
    log(`Submitting: "${text}" | history length=${historyRef.current.length}`);
    if (!text.trim()) { setAppState('idle'); return; }

    setAppState('loading');
    setTriage(null);
    setErrorMsg('');

    const url = `${API_BASE}/triage`;
    log(`POST ${url}`);

    try {
      const res = await fetch(url, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ text: text.trim(), history: historyRef.current }),
      });

      log(`Status: ${res.status}`);
      const rawText = await res.text();
      log(`Body: ${rawText.slice(0, 200)}`);

      if (!res.ok) throw new Error(`HTTP ${res.status}: ${rawText.slice(0, 120)}`);

      let data: { triage: TriageResult; audio?: string };
      try { data = JSON.parse(rawText); }
      catch { throw new Error(`Invalid JSON: ${rawText.slice(0, 120)}`); }

      if (!data.triage) throw new Error('Missing triage in response');

      const t = data.triage;
      log(`Triage: urgency=${t.urgency} needs_more_info=${t.needs_more_info}`);

      // Append this turn to history for follow-up context
      historyRef.current = [
        ...historyRef.current,
        { role: 'user',      content: text.trim() },
        { role: 'assistant', content: JSON.stringify(t) },
      ];

      // Play audio
      if (data.audio) {
        const audio = new Audio(`data:audio/mp3;base64,${data.audio}`);
        audio.play().catch(e => log(`Autoplay blocked: ${e.message}`));
      }

      if (t.needs_more_info && t.follow_up_question) {
        // More context needed — show follow-up prompt
        setFollowUpQ(t.follow_up_question);
        setTriage(t);
        setAppState('followup');
      } else {
        setTriage(t);
        setAppState('result');
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      log(`ERROR: ${msg}`);
      setErrorMsg(`Request failed: ${msg}`);
      setAppState('error');
    }
  }, [log]);

  // -------------------------------------------------------------------------
  // Speech recognition
  // -------------------------------------------------------------------------
  const startListening = useCallback(() => {
    if (!('webkitSpeechRecognition' in window) && !('SpeechRecognition' in window)) {
      setErrorMsg('Speech recognition not supported. Use Chrome.');
      setAppState('error');
      return;
    }
    const API = window.SpeechRecognition ?? window.webkitSpeechRecognition;
    const rec = new API();
    rec.continuous      = true;
    rec.interimResults  = true;
    rec.lang            = 'en-ZA';

    transcriptRef.current      = '';
    intentionalStopRef.current = false;
    pressStartTimeRef.current  = Date.now();

    rec.onstart  = () => log('STT: started');
    rec.onresult = (e: SpeechRecognitionEvent) => {
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const chunk = e.results[i][0].transcript.trim();
        if (e.results[i].isFinal && chunk.length > 0) {
          transcriptRef.current += chunk + ' ';
          log(`STT chunk: "${chunk}"`);
        }
      }
    };
    rec.onerror = (e: SpeechRecognitionErrorEvent) => {
      log(`STT error: ${e.error}`);
      if (e.error !== 'no-speech') {
        setErrorMsg(`Mic error: ${e.error}`);
        setAppState('error');
      }
    };
    rec.onend = () => {
      log(`STT: ended (intentional=${intentionalStopRef.current})`);
      recognitionRef.current = null;
      submitText(transcriptRef.current.trim());
    };

    rec.start();
    recognitionRef.current = rec;
    setAppState('listening');
    log('STT: start() called');
  }, [log, submitText]);

  const stopListening = useCallback(() => {
    const held = Date.now() - pressStartTimeRef.current;
    log(`Released after ${held}ms`);
    if (held < 400) {
      log('Too short — ignoring');
      intentionalStopRef.current = true;
      recognitionRef.current?.stop();
      recognitionRef.current = null;
      setAppState('idle');
      return;
    }
    intentionalStopRef.current = true;
    log('STT: stop() — waiting for onend');
    recognitionRef.current?.stop();
  }, [log]);

  // -------------------------------------------------------------------------
  // Text input submit
  // -------------------------------------------------------------------------
  const handleTextSubmit = useCallback((e: React.FormEvent) => {
    e.preventDefault();
    const val = textInput.trim();
    if (!val) return;
    setTextInput('');
    submitText(val);
  }, [textInput, submitText]);

  // -------------------------------------------------------------------------
  // Press handlers
  // -------------------------------------------------------------------------
  const onPressStart = useCallback((e: React.MouseEvent | React.TouchEvent) => {
    e.preventDefault();
    if (appState === 'loading') return;
    startListening();
  }, [appState, startListening]);

  const onPressEnd = useCallback((e: React.MouseEvent | React.TouchEvent) => {
    e.preventDefault();
    if (appState !== 'listening') return;
    stopListening();
  }, [appState, stopListening]);

  const handleReset = () => {
    historyRef.current = [];
    setAppState('idle');
    setTriage(null);
    setFollowUpQ('');
    setTextInput('');
    setErrorMsg('');
    transcriptRef.current = '';
    log('Reset');
  };

  // -------------------------------------------------------------------------
  // Input panel — shared between idle and followup states
  // -------------------------------------------------------------------------
  const renderInputPanel = (hint?: string) => (
    <div className="vt-input-panel">
      {hint && <p className="vt-followup-question" role="status">{hint}</p>}

      {/* Mode toggle */}
      <div className="vt-mode-toggle" role="group" aria-label="Input mode">
        <button
          className={`vt-mode-btn ${inputMode === 'voice' ? 'vt-mode-btn--active' : ''}`}
          onClick={() => setInputMode('voice')}
        >🎙️ Voice</button>
        <button
          className={`vt-mode-btn ${inputMode === 'text' ? 'vt-mode-btn--active' : ''}`}
          onClick={() => setInputMode('text')}
        >⌨️ Type</button>
      </div>

      {inputMode === 'voice' ? (
        <div className="vt-speak-section">
          <button
            className={`vt-speak-btn ${appState === 'listening' ? 'vt-speak-btn--active' : ''}`}
            onMouseDown={onPressStart}
            onMouseUp={onPressEnd}
            onMouseLeave={appState === 'listening' ? onPressEnd : undefined}
            onTouchStart={onPressStart}
            onTouchEnd={onPressEnd}
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
      ) : (
        <form className="vt-text-form" onSubmit={handleTextSubmit}>
          <textarea
            className="vt-text-input"
            value={textInput}
            onChange={e => setTextInput(e.target.value)}
            placeholder="Type your symptoms here…"
            rows={3}
            onKeyDown={e => {
              if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleTextSubmit(e as unknown as React.FormEvent); }
            }}
          />
          <button
            type="submit"
            className="vt-submit-btn"
            disabled={!textInput.trim()}
          >Send →</button>
        </form>
      )}
    </div>
  );

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

        {/* IDLE / LISTENING */}
        {(appState === 'idle' || appState === 'listening') && renderInputPanel()}

        {/* LOADING */}
        {appState === 'loading' && (
          <div className="vt-loading" role="status" aria-live="polite">
            <div className="vt-spinner" aria-hidden="true" />
            <p>Checking your symptoms…</p>
          </div>
        )}

        {/* FOLLOW-UP */}
        {appState === 'followup' && triage && (
          <div className="vt-followup-section">
            {/* Show partial triage context */}
            <div
              className="vt-urgency-badge"
              style={{ backgroundColor: URGENCY_COLOR[triage.urgency] }}
            >
              {URGENCY_LABEL[triage.urgency]} — more info needed
            </div>
            <div className="vt-card">
              <p className="vt-summary">{triage.summary}</p>
            </div>
            {renderInputPanel(followUpQ)}
          </div>
        )}

        {/* RESULT */}
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
                  {triage.benefits.map(b => <li key={b}>{b}</li>)}
                </ul>
              </div>
            )}
            {triage.refer_emergency && (
              <div className="vt-emergency-banner" role="alert">
                🚨 Please go to the nearest emergency room now.
              </div>
            )}
            <button className="vt-reset-btn" onClick={handleReset}>Start over</button>
          </div>
        )}

        {/* ERROR */}
        {appState === 'error' && (
          <div className="vt-error" role="alert">
            <p>{errorMsg}</p>
            <button className="vt-reset-btn" onClick={handleReset}>Try again</button>
          </div>
        )}

        {/* DEBUG PANEL */}
        <div className="vt-debug">
          <button className="vt-debug-toggle" onClick={() => setShowDebug(p => !p)}>
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
              <div className="vt-debug-row">
                <span className="vt-debug-label">History</span>
                <span className="vt-debug-val">{historyRef.current.length} turns</span>
              </div>
              <div className="vt-debug-log">
                {debugLog.length === 0
                  ? <span className="vt-debug-empty">No events yet</span>
                  : [...debugLog].reverse().map((e, i) => (
                    <div key={i} className="vt-debug-entry">
                      <span className="vt-debug-ts">{e.ts}</span>
                      <span>{e.msg}</span>
                    </div>
                  ))}
              </div>
              <button className="vt-debug-clear" onClick={() => setDebugLog([])}>Clear</button>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
