/**
 * Triage Lambda — POST /triage
 *
 * Request:  { text: string, history?: Turn[], detectedLanguage?: string }
 * Response: { triage: TriageResult, audio: string (base64 mp3), audioFormat: 'mp3',
 *             detectedLanguage: string, detectedLanguageName: string }
 *
 * Language flow:
 *  1. Amazon Comprehend DetectDominantLanguage identifies the input language
 *  2. Claude is instructed to respond in that language
 *  3. Polly uses the matching neural voice for that language
 *
 * Privacy: never log user text, Bedrock responses, or PII.
 */

import { BedrockRuntimeClient, InvokeModelCommand }         from '@aws-sdk/client-bedrock-runtime';
import { PollyClient, SynthesizeSpeechCommand }             from '@aws-sdk/client-polly';
import { ComprehendClient, DetectDominantLanguageCommand }  from '@aws-sdk/client-comprehend';

const REGION   = process.env.AWS_REGION ?? 'us-east-1';
const MODEL_ID = process.env.BEDROCK_MODEL_ID;
if (!MODEL_ID) throw new Error('BEDROCK_MODEL_ID environment variable is not set');

const bedrock    = new BedrockRuntimeClient({ region: REGION });
const polly      = new PollyClient({ region: REGION });
const comprehend = new ComprehendClient({ region: REGION });

// ---------------------------------------------------------------------------
// Language config — Comprehend code → display name, Polly voice, language code
// Supported SA languages with neural Polly voices
// ---------------------------------------------------------------------------
const LANGUAGE_CONFIG = {
  'en': { name: 'English',   pollyVoice: 'Ayanda', pollyLang: 'en-ZA', translateCode: 'en' },
  'af': { name: 'Afrikaans', pollyVoice: 'Ruben',  pollyLang: 'nl-NL', translateCode: 'af' },
  'zu': { name: 'Zulu',      pollyVoice: 'Ayanda', pollyLang: 'en-ZA', translateCode: 'zu' }, // Polly has no Zulu voice — use Ayanda + translated text
  'xh': { name: 'Xhosa',     pollyVoice: 'Ayanda', pollyLang: 'en-ZA', translateCode: 'xh' },
  'st': { name: 'Sotho',     pollyVoice: 'Ayanda', pollyLang: 'en-ZA', translateCode: 'st' },
  'tn': { name: 'Tswana',    pollyVoice: 'Ayanda', pollyLang: 'en-ZA', translateCode: 'tn' },
};
const FALLBACK_LANG = 'en';

// ---------------------------------------------------------------------------
// Step 1 — Detect language with Comprehend
// ---------------------------------------------------------------------------
async function detectLanguage(text) {
  try {
    const result = await comprehend.send(
      new DetectDominantLanguageCommand({ Text: text })
    );
    const top = result.Languages?.[0];
    if (top && top.Score > 0.5 && LANGUAGE_CONFIG[top.LanguageCode]) {
      return top.LanguageCode;
    }
  } catch (e) {
    console.error('comprehend_detect_failed', { code: e.name });
  }
  return FALLBACK_LANG;
}

// ---------------------------------------------------------------------------
// Step 2 — Bedrock triage with language instruction
// ---------------------------------------------------------------------------
function buildSystemPrompt(langCode) {
  const langName = LANGUAGE_CONFIG[langCode]?.name ?? 'English';
  return `You are UmNyango, a compassionate South African public healthcare triage assistant.

CRITICAL: The patient is communicating in ${langName}. You MUST write ALL text fields (summary, follow_up_question, benefits) in ${langName}. Do NOT use English unless the detected language is English.

RESPONSE RULES:
1. Respond ONLY with a valid JSON object. No markdown fences, no prose outside the JSON.
2. Match this exact structure:
{
  "urgency": "emergency" | "urgent" | "routine",
  "clinic_type": "emergency_room" | "chc" | "clinic" | "pharmacy",
  "summary": "<2 sentences max, Grade 6 reading level, written in ${langName}>",
  "benefits": ["<applicable SA programme, written in ${langName}>"],
  "refer_emergency": true | false,
  "needs_more_info": true | false,
  "follow_up_question": "<one short question in ${langName}, or empty string>"
}

TRIAGE LOGIC:
- needs_more_info=true when symptoms are vague (e.g. "I feel sick", "I have pain").
- Chest pain, difficulty breathing, stroke symptoms, severe bleeding, loss of consciousness → urgency=emergency, refer_emergency=true, needs_more_info=false.
- High fever (>39°C), severe headache, persistent vomiting, signs of infection → urgency=urgent.
- Mild symptoms, no red flags → urgency=routine.

FOLLOW-UP RULES:
- ONE question only, under 15 words, in ${langName}.
- Ask about: duration, severity (1-10), location, or associated symptoms.

LANGUAGE RULES:
- Grade 6 reading level. Short sentences.
- Stigma-safe: "wellness support" not "ARVs", "chest illness programme" not "TB treatment" — translated appropriately.
- Never repeat the patient's exact words in the summary.

SA BENEFITS: Free Emergency Care at Public Hospitals, SASSA Social Relief, Free ARV Wellness Support, Free TB/Chest Illness Programme, Child Support Grant, Disability Grant, Free Maternal Health Services.`;
}

async function invokeBedrock(userText, history, langCode) {
  const messages = [...history, { role: 'user', content: userText }];
  const payload  = {
    anthropic_version: 'bedrock-2023-05-31',
    max_tokens: 700,
    system:     buildSystemPrompt(langCode),
    messages,
  };

  const raw     = await bedrock.send(new InvokeModelCommand({
    modelId:     MODEL_ID,
    contentType: 'application/json',
    accept:      'application/json',
    body:        JSON.stringify(payload),
  }));
  const decoded = JSON.parse(Buffer.from(raw.body).toString('utf-8'));
  const text    = decoded?.content?.[0]?.text;
  if (!text) throw new Error('BEDROCK_EMPTY_RESPONSE');

  const cleaned = text.replace(/^```json\s*/i, '').replace(/```\s*$/i, '').trim();
  const triage  = JSON.parse(cleaned);
  validateTriage(triage);
  return triage;
}

function validateTriage(obj) {
  const urgencies   = ['emergency', 'urgent', 'routine'];
  const clinicTypes = ['emergency_room', 'chc', 'clinic', 'pharmacy'];
  if (!urgencies.includes(obj.urgency))           throw new Error('INVALID_URGENCY');
  if (!clinicTypes.includes(obj.clinic_type))     throw new Error('INVALID_CLINIC_TYPE');
  if (typeof obj.summary !== 'string' || !obj.summary.trim()) throw new Error('MISSING_SUMMARY');
  if (!Array.isArray(obj.benefits))               throw new Error('INVALID_BENEFITS');
  if (typeof obj.refer_emergency !== 'boolean')   throw new Error('INVALID_REFER_EMERGENCY');
  if (typeof obj.needs_more_info !== 'boolean')   obj.needs_more_info = false;
  if (typeof obj.follow_up_question !== 'string') obj.follow_up_question = '';
}

// ---------------------------------------------------------------------------
// Step 3 — Polly synthesis with language-appropriate voice
// ---------------------------------------------------------------------------
async function synthesiseSpeech(text, langCode) {
  const cfg = LANGUAGE_CONFIG[langCode] ?? LANGUAGE_CONFIG[FALLBACK_LANG];

  const tryVoice = async (voiceId, langCodePolly) => {
    const result = await polly.send(new SynthesizeSpeechCommand({
      Text:         text,
      OutputFormat: 'mp3',
      VoiceId:      voiceId,
      Engine:       'neural',
      LanguageCode: langCodePolly,
    }));
    const chunks = [];
    for await (const chunk of result.AudioStream) chunks.push(chunk);
    return Buffer.concat(chunks).toString('base64');
  };

  try {
    return await tryVoice(cfg.pollyVoice, cfg.pollyLang);
  } catch {
    console.error('polly_primary_failed_falling_back', { langCode });
    // Universal fallback — Ayanda en-ZA, then Joanna en-US
    try { return await tryVoice('Ayanda', 'en-ZA'); }
    catch { return await tryVoice('Joanna', 'en-US'); }
  }
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------
export const handler = async (event, context) => {
  const startTime = Date.now();
  console.log('triage_request_received', { requestId: context.awsRequestId });

  try {
    const body = JSON.parse(event.body ?? '{}');
    if (!body.text || typeof body.text !== 'string' || !body.text.trim()) {
      return httpResponse(400, { error: 'Missing or empty required field: text' });
    }

    const history = Array.isArray(body.history) ? body.history : [];
    const text    = body.text.trim();

    // 1 — Detect language (use caller-provided value on follow-up turns to stay consistent)
    const langCode = body.detectedLanguage && LANGUAGE_CONFIG[body.detectedLanguage]
      ? body.detectedLanguage
      : await detectLanguage(text);

    const langConfig = LANGUAGE_CONFIG[langCode] ?? LANGUAGE_CONFIG[FALLBACK_LANG];

    // 2 — Triage via Bedrock
    const triage = await invokeBedrock(text, history, langCode);

    // 3 — Synthesise audio in detected language
    const spokenText = triage.needs_more_info && triage.follow_up_question
      ? `${triage.summary} ${triage.follow_up_question}`
      : triage.summary;

    const audioBase64 = await synthesiseSpeech(spokenText, langCode);

    console.log('triage_request_completed', {
      requestId:       context.awsRequestId,
      durationMs:      Date.now() - startTime,
      urgency:         triage.urgency,
      detectedLang:    langCode,
      needs_more_info: triage.needs_more_info,
    });

    return httpResponse(200, {
      triage,
      audio:                audioBase64,
      audioFormat:          'mp3',
      detectedLanguage:     langCode,
      detectedLanguageName: langConfig.name,
    });
  } catch (err) {
    console.error('triage_request_error', {
      requestId:  context.awsRequestId,
      durationMs: Date.now() - startTime,
      errorCode:  err.name,
      errorMsg:   err.message, // TEMP — remove before final deploy
    });
    return httpResponse(500, {
      error:       'Triage service unavailable. Please try again.',
      debug_error: err.message, // TEMP
    });
  }
};

function httpResponse(statusCode, body) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    body: JSON.stringify(body),
  };
}
