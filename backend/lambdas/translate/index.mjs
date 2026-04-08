/**
 * Translate Lambda — POST /translate
 *
 * Request:  { text: string, targetLanguage: string (BCP-47 e.g. "af", "zu", "en") }
 * Response: { translatedText: string, audio: string (base64 mp3), audioFormat: 'mp3' }
 *
 * Privacy: never log input text or translations.
 */

import { TranslateClient, TranslateTextCommand } from '@aws-sdk/client-translate';
import { PollyClient, SynthesizeSpeechCommand }  from '@aws-sdk/client-polly';

const REGION = process.env.AWS_REGION ?? 'us-east-1';

const translateClient = new TranslateClient({ region: REGION });
const polly           = new PollyClient({ region: REGION });

// Language → Polly voice mapping (neural where available)
const POLLY_VOICE_MAP = {
  'en': { voiceId: 'Ayanda', langCode: 'en-ZA', engine: 'neural' },
  'af': { voiceId: 'Ruben',  langCode: 'nl-NL', engine: 'neural' }, // Afrikaans — closest neural voice
  'zu': { voiceId: 'Ayanda', langCode: 'en-ZA', engine: 'neural' }, // No Zulu Polly voice — read in English
  'xh': { voiceId: 'Ayanda', langCode: 'en-ZA', engine: 'neural' },
  'st': { voiceId: 'Ayanda', langCode: 'en-ZA', engine: 'neural' },
  'tn': { voiceId: 'Ayanda', langCode: 'en-ZA', engine: 'neural' },
  'fr': { voiceId: 'Lea',    langCode: 'fr-FR', engine: 'neural' },
  'pt': { voiceId: 'Ines',   langCode: 'pt-PT', engine: 'neural' },
  'es': { voiceId: 'Lucia',  langCode: 'es-ES', engine: 'neural' },
  'de': { voiceId: 'Vicki',  langCode: 'de-DE', engine: 'neural' },
};
const FALLBACK_VOICE = { voiceId: 'Joanna', langCode: 'en-US', engine: 'neural' };

export const handler = async (event, context) => {
  const startTime = Date.now();
  console.log('translate_request_received', { requestId: context.awsRequestId });

  try {
    const body = JSON.parse(event.body ?? '{}');

    if (!body.text || typeof body.text !== 'string' || !body.text.trim()) {
      return httpResponse(400, { error: 'Missing required field: text' });
    }
    if (!body.targetLanguage || typeof body.targetLanguage !== 'string') {
      return httpResponse(400, { error: 'Missing required field: targetLanguage' });
    }

    const text           = body.text.trim();
    const targetLanguage = body.targetLanguage.toLowerCase().split('-')[0]; // normalise "en-ZA" → "en"

    // Step 1 — Translate
    const translateResult = await translateClient.send(new TranslateTextCommand({
      Text:               text,
      SourceLanguageCode: 'auto',
      TargetLanguageCode: targetLanguage,
    }));
    const translatedText = translateResult.TranslatedText;

    // Step 2 — Synthesise in target language
    const voiceCfg = POLLY_VOICE_MAP[targetLanguage] ?? FALLBACK_VOICE;
    const audioBase64 = await synthesise(translatedText, voiceCfg);

    console.log('translate_request_completed', {
      requestId:  context.awsRequestId,
      durationMs: Date.now() - startTime,
      targetLang: targetLanguage,
    });

    return httpResponse(200, {
      translatedText,
      audio:       audioBase64,
      audioFormat: 'mp3',
    });
  } catch (err) {
    console.error('translate_request_error', {
      requestId:  context.awsRequestId,
      durationMs: Date.now() - startTime,
      errorCode:  err.name,
      errorMsg:   err.message, // TEMP
    });
    return httpResponse(500, {
      error:       'Translation service unavailable.',
      debug_error: err.message, // TEMP
    });
  }
};

async function synthesise(text, { voiceId, langCode, engine }) {
  const tryVoice = async (v, l, e) => {
    const result = await polly.send(new SynthesizeSpeechCommand({
      Text: text, OutputFormat: 'mp3', VoiceId: v, Engine: e, LanguageCode: l,
    }));
    const chunks = [];
    for await (const chunk of result.AudioStream) chunks.push(chunk);
    return Buffer.concat(chunks).toString('base64');
  };
  try {
    return await tryVoice(voiceId, langCode, engine);
  } catch {
    return await tryVoice(FALLBACK_VOICE.voiceId, FALLBACK_VOICE.langCode, FALLBACK_VOICE.engine);
  }
}

function httpResponse(statusCode, body) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    body: JSON.stringify(body),
  };
}
