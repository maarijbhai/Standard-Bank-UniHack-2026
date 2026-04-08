import { useRef, useState, useCallback, useEffect } from 'react';
import './VoiceTriage.css';

const API_BASE = (() => {
  const raw = import.meta.env.VITE_API_URL as string | undefined;
  if (!raw || !raw.startsWith('http')) return '';
  return raw.replace(/\/$/, '');
})();

const WS_URL = (() => {
  const raw = import.meta.env.VITE_TRANSCRIBE_WS_URL as string | undefined;
  if (!raw || !raw.startsWith('wss://')) return '';
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
interface HistoryEntry { role: 'user' | 'assistant'; content: string; }
interface DebugEntry   { ts: string; msg: string; }
type AppState = 'idle' | 'listening' | 'loading' | 'followup' | 'result' | 'error';

// ---------------------------------------------------------------------------
// Language / translate config
// ---------------------------------------------------------------------------
const TRANSLATE_LANGUAGES = [
  { code: 'en', name: 'English' },
  { code: 'af', name: 'Afrikaans' },
  { code: 'zu', name: 'Zulu' },
  { code: 'xh', name: 'Xhosa' },
  { code: 'st', name: 'Sotho' },
  { code: 'tn', name: 'Tswana' },
  { code: 'fr', name: 'French' },
  { code: 'pt', name: 'Portuguese' },
  { code: 'es', name: 'Spanish' },
  { code: 'de', name: 'German' },
];

// ---------------------------------------------------------------------------
// UI constants
// ---------------------------------------------------------------------------
const URGENCY_LABEL: Record<TriageResult['urgency'], string> = {
  emergency: '🚨 Emergency', urgent: '⚠️ Urgent', routine: '✅ Routine',
};
const URGENCY_COLOR: Record<TriageResult['urgency'], string> = {
  emergency: '#c0392b', urgent: '#e67e22', routine: '#27ae60',
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
  const [appState,         setAppState]         = useState<AppState>('idle');
  const [triage,           setTriage]           = useState<TriageResult | null>(null);
  const [followUpQ,        setFollowUpQ]        = useState('');
  const [textInput,        setTextInput]        = useState('');
  const [interimText,      setInterimText]      = useState('');   // live Transcribe partials
  const [interimLang,      setInterimLang]      = useState('');   // detected lang from partials
  const [errorMsg,         setErrorMsg]         = useState('');
  const [debugLog,         setDebugLog]         = useState<DebugEntry[]>([]);
  const [showDebug,        setShowDebug]        = useState(false);
  const [inputMode,        setInputMode]        = useState<'voice' | 'text'>('voice');
  const [detectedLang,     setDetectedLang]     = useState('');
  const [detectedLangName, setDetectedLangName] = useState('');
  const [translateTarget,  setTranslateTarget]  = useState('');
  const [translatedText,   setTranslatedText]   = useState('');
  const [translating,      setTranslating]      = useState(false);

  const historyRef        = useRef<HistoryEntry[]>([]);
  const detectedLangRef   = useRef('');
  const mediaRecorderRef  = useRef<MediaRecorder | null>(null);
  const audioChunksRef    = useRef<Blob[]>([]);
  const wsRef             = useRef<WebSocket | null>(null);
  const wsTimeoutRef      = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pressStartTimeRef = useRef(0);

  const log = useCallback((msg: string) => {
    const ts = new Date().toISOString().slice(11, 23);
    console.log(`[UmNyango ${ts}] ${msg}`);
    setDebugLog(prev => [...prev.slice(-29), { ts, msg }]);
  }, []);

  useEffect(() => {
    log(`API_BASE = "${API_BASE}"`);
    log(`WS_URL = "${WS_URL}"`);
    if (!API_BASE) { setErrorMsg('VITE_API_URL not set. Check frontend/.env'); setAppState('error'); }
    else if (!WS_URL) log('WARN: VITE_TRANSCRIBE_WS_URL not set — voice input unavailable');
  }, [log]);

  // -------------------------------------------------------------------------
  // Core triage submit
  // -------------------------------------------------------------------------
  const submitText = useCallback(async (text: string) => {
    log(`Submitting (${text.length} chars) | history=${historyRef.current.length}`);
    if (!text.trim()) { setAppState('idle'); return; }

    setAppState('loading');
    setTriage(null);
    setTranslatedText('');
    setErrorMsg('');

    try {
      const res = await fetch(`${API_BASE}/triage`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({
          text:             text.trim(),
          history:          historyRef.current,
          detectedLanguage: detectedLangRef.current || undefined,
        }),
      });

      log(`Status: ${res.status}`);
      const rawText = await res.text();
      log(`Body: ${rawText.slice(0, 200)}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${rawText.slice(0, 120)}`);

      let data: { triage: TriageResult; audio?: string; detectedLanguage?: string; detectedLanguageName?: string };
      try { data = JSON.parse(rawText); } catch { throw new Error(`Invalid JSON: ${rawText.slice(0, 80)}`); }
      if (!data.triage) throw new Error('Missing triage in response');

      const t = data.triage;
      if (data.detectedLanguage) {
        detectedLangRef.current = data.detectedLanguage;
        setDetectedLang(data.detectedLanguage);
        setDetectedLangName(data.detectedLanguageName ?? data.detectedLanguage);
        log(`Detected language: ${data.detectedLanguageName} (${data.detectedLanguage})`);
      }

      historyRef.current = [
        ...historyRef.current,
        { role: 'user',      content: text.trim() },
        { role: 'assistant', content: JSON.stringify(t) },
      ];

      if (data.audio) {
        const audio = new Audio(`data:audio/mp3;base64,${data.audio}`);
        audio.play().catch(e => log(`Autoplay blocked: ${e.message}`));
      }

      if (t.needs_more_info && t.follow_up_question) {
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
  // Translate
  // -------------------------------------------------------------------------
  const handleTranslate = useCallback(async (targetLang: string) => {
    if (!triage || !targetLang) return;
    const textToTranslate = [triage.summary, ...triage.benefits].join('. ');
    setTranslating(true);
    setTranslatedText('');
    log(`Translating to ${targetLang}`);
    try {
      const res  = await fetch(`${API_BASE}/translate`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ text: textToTranslate, targetLanguage: targetLang }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      setTranslatedText(data.translatedText);
      log(`Translation received`);
      if (data.audio) {
        const audio = new Audio(`data:audio/mp3;base64,${data.audio}`);
        audio.play().catch(e => log(`Translate audio blocked: ${e.message}`));
      }
    } catch (err: unknown) {
      log(`TRANSLATE ERROR: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setTranslating(false);
    }
  }, [triage, log]);

  // -------------------------------------------------------------------------
  // WebSocket — sends audio, receives partial + final transcript from Transcribe
  // -------------------------------------------------------------------------
  const sendOverWebSocket = useCallback((audioBase64: string) => {
    setAppState('loading');
    setInterimText('');
    setInterimLang('');
    log('Connecting WebSocket…');

    const ws = new WebSocket(WS_URL);
    wsRef.current = ws;

    wsTimeoutRef.current = setTimeout(() => {
      log('WS timeout — no response from transcribe Lambda');
      ws.close();
      setErrorMsg('Transcription timed out. Please try again.');
      setAppState('error');
    }, 28000);

    ws.onopen = () => {
      log('WS connected — sending audio in chunks');

      // API Gateway WebSocket max message size is 128KB.
      // Split the base64 audio into chunks and send sequentially.
      const CHUNK_SIZE = 32768; // 32KB per chunk (safe under 128KB JSON envelope)
      const totalChunks = Math.ceil(audioBase64.length / CHUNK_SIZE);
      log(`Sending ${totalChunks} chunks (${audioBase64.length} chars total)`);

      for (let i = 0; i < totalChunks; i++) {
        const chunk = audioBase64.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE);
        ws.send(JSON.stringify({
          action:      'transcribe',
          chunk,
          chunkIndex:  i,
          totalChunks,
        }));
      }
    };

    ws.onmessage = (event) => {
      if (wsTimeoutRef.current) { clearTimeout(wsTimeoutRef.current); wsTimeoutRef.current = null; }
      try {
        const msg = JSON.parse(event.data as string);

        if (msg.type === 'partial') {
          // Show live Transcribe partial results — these are in the detected language
          setInterimText(msg.text ?? '');
          if (msg.detectedLanguage) setInterimLang(msg.detectedLanguage);
          setAppState('listening'); // keep in listening state while partials arrive
        } else if (msg.type === 'transcript') {
          log(`Transcript received, lang=${msg.detectedLanguage}`);
          ws.close();
          wsRef.current = null;
          setInterimText('');
          if (msg.detectedLanguage) {
            detectedLangRef.current = msg.detectedLanguage.split('-')[0];
          }
          submitText(msg.transcript);
        } else if (msg.type === 'error') {
          log(`WS error: ${msg.message}`);
          setErrorMsg(msg.message ?? 'Transcription failed.');
          setAppState('error');
          ws.close();
        }
      } catch {
        log('WS: failed to parse message');
      }
    };

    ws.onerror = () => {
      if (wsTimeoutRef.current) { clearTimeout(wsTimeoutRef.current); wsTimeoutRef.current = null; }
      log('WS connection error');
      setErrorMsg('Could not connect to transcription service. Check VITE_TRANSCRIBE_WS_URL.');
      setAppState('error');
    };

    ws.onclose = () => { log('WS closed'); wsRef.current = null; };
  }, [log, submitText]);

  // -------------------------------------------------------------------------
  // MediaRecorder — captures audio while button held
  // -------------------------------------------------------------------------
  const startListening = useCallback(async () => {
    if (!WS_URL) { setErrorMsg('VITE_TRANSCRIBE_WS_URL not set.'); setAppState('error'); return; }
    if (!navigator.mediaDevices?.getUserMedia) {
      setErrorMsg('Microphone not supported in this browser.');
      setAppState('error');
      return;
    }
    try {
      const stream   = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
        ? 'audio/webm;codecs=opus' : 'audio/webm';

      const recorder = new MediaRecorder(stream, { mimeType });
      audioChunksRef.current = [];

      recorder.ondataavailable = (e) => { if (e.data.size > 0) audioChunksRef.current.push(e.data); };

      recorder.onstop = async () => {
        stream.getTracks().forEach(t => t.stop());
        log(`Recording stopped — ${audioChunksRef.current.length} chunks`);

        const webmBlob    = new Blob(audioChunksRef.current, { type: mimeType });

        // Transcribe IdentifyMultipleLanguages requires PCM audio.
        // Decode the WebM/Opus blob via Web Audio API and convert to 16-bit PCM.
        try {
          const arrayBuffer  = await webmBlob.arrayBuffer();
          const audioCtx     = new AudioContext({ sampleRate: 16000 });
          const decoded      = await audioCtx.decodeAudioData(arrayBuffer);
          audioCtx.close();

          // Mix down to mono, resample to 16kHz (AudioContext handles resampling)
          const pcmFloat = decoded.getChannelData(0); // mono channel
          const pcm16    = new Int16Array(pcmFloat.length);
          for (let i = 0; i < pcmFloat.length; i++) {
            const s = Math.max(-1, Math.min(1, pcmFloat[i]));
            pcm16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
          }

          // Convert Int16Array to base64
          const bytes  = new Uint8Array(pcm16.buffer);
          let binary   = '';
          for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
          const base64 = btoa(binary);

          log(`PCM encoded — ${base64.length} base64 chars (${pcmFloat.length} samples @ 16kHz)`);
          sendOverWebSocket(base64);
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          log(`PCM conversion error: ${msg}`);
          setErrorMsg(`Audio processing failed: ${msg}`);
          setAppState('error');
        }
      };

      recorder.start(100);
      mediaRecorderRef.current  = recorder;
      pressStartTimeRef.current = Date.now();
      setAppState('listening');
      log('MediaRecorder started');
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      log(`Mic error: ${msg}`);
      setErrorMsg(`Microphone error: ${msg}`);
      setAppState('error');
    }
  }, [log, sendOverWebSocket]);

  const stopListening = useCallback(() => {
    const held = Date.now() - pressStartTimeRef.current;
    log(`Released after ${held}ms`);
    if (held < 400) {
      log('Too short — ignoring');
      mediaRecorderRef.current?.stop();
      mediaRecorderRef.current = null;
      audioChunksRef.current   = [];
      setAppState('idle');
      return;
    }
    log('Stopping recorder — will send audio on onstop');
    mediaRecorderRef.current?.stop();
    mediaRecorderRef.current = null;
  }, [log]);

  // -------------------------------------------------------------------------
  // Text input
  // -------------------------------------------------------------------------
  const handleTextSubmit = useCallback((e: React.FormEvent) => {
    e.preventDefault();
    const val = textInput.trim();
    if (!val) return;
    setTextInput('');
    submitText(val);
  }, [textInput, submitText]);

  const onPressStart = useCallback((e: React.MouseEvent | React.TouchEvent) => {
    e.preventDefault();
    if (appState === 'loading') return;
    void startListening();
  }, [appState, startListening]);

  const onPressEnd = useCallback((e: React.MouseEvent | React.TouchEvent) => {
    e.preventDefault();
    if (appState !== 'listening') return;
    stopListening();
  }, [appState, stopListening]);

  const handleReset = () => {
    if (wsTimeoutRef.current) { clearTimeout(wsTimeoutRef.current); wsTimeoutRef.current = null; }
    wsRef.current?.close();
    wsRef.current = null;
    mediaRecorderRef.current?.stop();
    mediaRecorderRef.current = null;
    audioChunksRef.current   = [];
    historyRef.current       = [];
    detectedLangRef.current  = '';
    setAppState('idle');
    setTriage(null);
    setFollowUpQ('');
    setTextInput('');
    setInterimText('');
    setInterimLang('');
    setErrorMsg('');
    setDetectedLang('');
    setDetectedLangName('');
    setTranslatedText('');
    setTranslateTarget('');
    log('Reset');
  };

  // -------------------------------------------------------------------------
  // Input panel
  // -------------------------------------------------------------------------
  const renderInputPanel = (hint?: string) => (
    <div className="vt-input-panel">
      {hint && <p className="vt-followup-question" role="status">{hint}</p>}
      <div className="vt-mode-toggle" role="group" aria-label="Input mode">
        <button className={`vt-mode-btn ${inputMode === 'voice' ? 'vt-mode-btn--active' : ''}`} onClick={() => setInputMode('voice')}>🎙️ Voice</button>
        <button className={`vt-mode-btn ${inputMode === 'text'  ? 'vt-mode-btn--active' : ''}`} onClick={() => setInputMode('text')}>⌨️ Type</button>
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
          {appState === 'listening' && interimText && (
            <div className="vt-interim-text" aria-live="polite">
              {interimLang && interimLang !== 'en-ZA' && (
                <span className="vt-interim-lang">🌍 {interimLang.split('-')[0].toUpperCase()}</span>
              )}
              {interimText}
            </div>
          )}
        </div>
      ) : (
        <form className="vt-text-form" onSubmit={handleTextSubmit}>
          <textarea
            className="vt-text-input"
            value={textInput}
            onChange={e => setTextInput(e.target.value)}
            placeholder="Type your symptoms here…"
            rows={3}
            onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleTextSubmit(e as unknown as React.FormEvent); } }}
          />
          <button type="submit" className="vt-submit-btn" disabled={!textInput.trim()}>Send →</button>
        </form>
      )}
    </div>
  );

  // -------------------------------------------------------------------------
  // Translate panel
  // -------------------------------------------------------------------------
  const renderTranslatePanel = () => (
    <div className="vt-translate-panel">
      <p className="vt-translate-label">Translate output to:</p>
      <div className="vt-translate-row">
        <select
          className="vt-lang-select vt-translate-select"
          value={translateTarget}
          onChange={e => { const l = e.target.value; setTranslateTarget(l); setTranslatedText(''); if (l) handleTranslate(l); }}
          aria-label="Select translation language"
          disabled={translating}
        >
          <option value="">— choose language —</option>
          {TRANSLATE_LANGUAGES.map(l => <option key={l.code} value={l.code}>{l.name}</option>)}
        </select>
        {translating && <span className="vt-translate-spinner" aria-label="Translating…">⏳</span>}
      </div>
      {translatedText && (
        <div className="vt-translated-text" aria-live="polite">
          <p className="vt-label">{TRANSLATE_LANGUAGES.find(l => l.code === translateTarget)?.name ?? ''} translation</p>
          <p>{translatedText}</p>
        </div>
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
        {(appState === 'idle' || appState === 'listening') && renderInputPanel()}

        {appState === 'loading' && (
          <div className="vt-loading" role="status" aria-live="polite">
            <div className="vt-spinner" aria-hidden="true" />
            <p>Checking your symptoms…</p>
          </div>
        )}

        {appState === 'followup' && triage && (
          <div className="vt-followup-section">
            <div className="vt-urgency-badge" style={{ backgroundColor: URGENCY_COLOR[triage.urgency] }}>
              {URGENCY_LABEL[triage.urgency]} — more info needed
            </div>
            <div className="vt-card"><p className="vt-summary">{triage.summary}</p></div>
            {renderInputPanel(followUpQ)}
          </div>
        )}

        {appState === 'result' && triage && (
          <div className="vt-result" aria-live="polite">
            {detectedLangName && detectedLang !== 'en' && (
              <div className="vt-lang-badge">🌍 Detected: {detectedLangName}</div>
            )}
            <div className="vt-urgency-badge" style={{ backgroundColor: URGENCY_COLOR[triage.urgency] }} role="status">
              {URGENCY_LABEL[triage.urgency]}
            </div>
            <div className="vt-card"><p className="vt-summary">{triage.summary}</p></div>
            <div className="vt-card">
              <p className="vt-label">Recommended facility</p>
              <p className="vt-value">{CLINIC_LABEL[triage.clinic_type]}</p>
            </div>
            {triage.benefits.length > 0 && (
              <div className="vt-card">
                <p className="vt-label">You may qualify for</p>
                <ul className="vt-benefits">{triage.benefits.map(b => <li key={b}>{b}</li>)}</ul>
              </div>
            )}
            {triage.refer_emergency && (
              <div className="vt-emergency-banner" role="alert">
                🚨 Please go to the nearest emergency room now.
              </div>
            )}
            {renderTranslatePanel()}
            <button className="vt-reset-btn" onClick={handleReset}>Start over</button>
          </div>
        )}

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
              <div className="vt-debug-row"><span className="vt-debug-label">API_BASE</span><span className={`vt-debug-val ${!API_BASE ? 'vt-debug-err' : ''}`}>{API_BASE || '⚠ NOT SET'}</span></div>
              <div className="vt-debug-row"><span className="vt-debug-label">WS_URL</span><span className={`vt-debug-val ${!WS_URL ? 'vt-debug-err' : ''}`}>{WS_URL ? '✓ set' : '⚠ NOT SET'}</span></div>
              <div className="vt-debug-row"><span className="vt-debug-label">State</span><span className="vt-debug-val">{appState}</span></div>
              <div className="vt-debug-row"><span className="vt-debug-label">Lang</span><span className="vt-debug-val">{detectedLangName || '—'} ({detectedLang || '—'})</span></div>
              <div className="vt-debug-row"><span className="vt-debug-label">History</span><span className="vt-debug-val">{historyRef.current.length} turns</span></div>
              <div className="vt-debug-log">
                {debugLog.length === 0
                  ? <span className="vt-debug-empty">No events yet</span>
                  : [...debugLog].reverse().map((e, i) => (
                    <div key={i} className="vt-debug-entry">
                      <span className="vt-debug-ts">{e.ts}</span><span>{e.msg}</span>
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
