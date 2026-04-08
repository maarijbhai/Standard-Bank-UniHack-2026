/**
 * Triage Lambda — POST /triage
 *
 * Supports multi-turn conversation via optional `history` array.
 * Request:  { text: string, history?: { role: 'user'|'assistant', content: string }[] }
 * Response: { triage: TriageResult, audio: string (base64 mp3), audioFormat: 'mp3' }
 *
 * Privacy rules:
 *  - NEVER log user input text, Bedrock responses, or PII to CloudWatch
 *  - Log operational metadata only (requestId, latency, urgency enum)
 */

import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';
import { PollyClient, SynthesizeSpeechCommand } from '@aws-sdk/client-polly';

const REGION = process.env.AWS_REGION ?? 'us-east-1';
const MODEL_ID = process.env.BEDROCK_MODEL_ID;
if (!MODEL_ID) throw new Error('BEDROCK_MODEL_ID environment variable is not set');

const bedrock = new BedrockRuntimeClient({ region: REGION });
const polly   = new PollyClient({ region: REGION });

// ---------------------------------------------------------------------------
// System prompt
// ---------------------------------------------------------------------------
const SYSTEM_PROMPT = `You are UmNyango, a compassionate South African public healthcare triage assistant.
Your job is to help patients in South Africa understand their symptoms and find the right care.

RESPONSE RULES — you MUST follow these exactly:
1. Respond ONLY with a valid JSON object. No markdown fences, no prose outside the JSON.
2. The JSON must match this exact structure:
{
  "urgency": "emergency" | "urgent" | "routine",
  "clinic_type": "emergency_room" | "chc" | "clinic" | "pharmacy",
  "summary": "<2 sentences max, Grade 6 reading level, plain English>",
  "benefits": ["<applicable SA programme>"],
  "refer_emergency": true | false,
  "needs_more_info": true | false,
  "follow_up_question": "<one short question to ask the patient, or empty string if not needed>"
}

TRIAGE LOGIC:
- Set needs_more_info=true and provide a follow_up_question when the symptoms are vague or could indicate multiple conditions of very different urgency (e.g. "I feel sick", "I have pain").
- Set needs_more_info=false when you have enough information to triage confidently.
- For chest pain, difficulty breathing, stroke symptoms, severe bleeding, or loss of consciousness: always urgency=emergency, refer_emergency=true, needs_more_info=false.
- For high fever (>39°C), severe headache, persistent vomiting, or signs of infection: urgency=urgent.
- For mild symptoms with no red flags: urgency=routine.

FOLLOW-UP QUESTION RULES:
- Ask only ONE question at a time.
- Keep it short — under 15 words.
- Ask about: duration, severity (1-10), location, associated symptoms, or relevant history.
- Examples: "How long have you had this pain?" / "Is the pain sharp or dull?" / "Do you have a fever too?"
- If the patient has already answered follow-up questions and you have enough context, set needs_more_info=false.

LANGUAGE RULES:
- Grade 6 reading level. Short sentences. Simple words.
- Stigma-safe: say "wellness support" not "ARVs", "chest illness programme" not "TB treatment".
- Never repeat the patient's exact words back in the summary.
- Never add fields outside the schema.

SA BENEFITS to consider: Free Emergency Care at Public Hospitals, SASSA Social Relief, Free ARV Wellness Support, Free TB/Chest Illness Programme, Child Support Grant, Disability Grant, Free Maternal Health Services.`;

// ---------------------------------------------------------------------------
// Bedrock invocation — supports multi-turn history
// ---------------------------------------------------------------------------
async function invokeBedrock(userText, history = []) {
  // Build message array: prior turns + new user message
  const messages = [
    ...history,
    { role: 'user', content: userText },
  ];

  const payload = {
    anthropic_version: 'bedrock-2023-05-31',
    max_tokens: 600,
    system: SYSTEM_PROMPT,
    messages,
  };

  const command = new InvokeModelCommand({
    modelId: MODEL_ID,
    contentType: 'application/json',
    accept: 'application/json',
    body: JSON.stringify(payload),
  });

  const raw     = await bedrock.send(command);
  const decoded = JSON.parse(Buffer.from(raw.body).toString('utf-8'));
  const text    = decoded?.content?.[0]?.text;
  if (!text) throw new Error('BEDROCK_EMPTY_RESPONSE');

  // Strip any accidental markdown fences before parsing
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
  // Normalise optional fields
  if (typeof obj.needs_more_info !== 'boolean')   obj.needs_more_info = false;
  if (typeof obj.follow_up_question !== 'string') obj.follow_up_question = '';
}

// ---------------------------------------------------------------------------
// Polly — synthesise the text the user should hear
// (summary + follow-up question if present)
// ---------------------------------------------------------------------------
async function synthesiseSpeech(text) {
  const tryPolly = async (voiceId, languageCode) => {
    const result = await polly.send(new SynthesizeSpeechCommand({
      Text: text,
      OutputFormat: 'mp3',
      VoiceId: voiceId,
      Engine: 'neural',
      LanguageCode: languageCode,
    }));
    const chunks = [];
    for await (const chunk of result.AudioStream) chunks.push(chunk);
    return Buffer.concat(chunks).toString('base64');
  };

  try {
    return await tryPolly('Ayanda', 'en-ZA');
  } catch {
    console.error('polly_ayanda_failed_falling_back');
    return await tryPolly('Joanna', 'en-US');
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

    // Validate history shape if provided
    const history = Array.isArray(body.history) ? body.history : [];

    // Step 1 — Bedrock triage (with conversation history)
    const triage = await invokeBedrock(body.text.trim(), history);

    // Step 2 — Synthesise audio
    // If a follow-up question is needed, speak the summary + question together
    const spokenText = triage.needs_more_info && triage.follow_up_question
      ? `${triage.summary} ${triage.follow_up_question}`
      : triage.summary;

    const audioBase64 = await synthesiseSpeech(spokenText);

    console.log('triage_request_completed', {
      requestId:    context.awsRequestId,
      durationMs:   Date.now() - startTime,
      urgency:      triage.urgency,
      needs_more_info: triage.needs_more_info,
    });

    return httpResponse(200, {
      triage,
      audio:       audioBase64,
      audioFormat: 'mp3',
    });
  } catch (err) {
    console.error('triage_request_error', {
      requestId:  context.awsRequestId,
      durationMs: Date.now() - startTime,
      errorCode:  err.name,
      errorMsg:   err.message, // TEMP debug — remove before final deploy
    });

    return httpResponse(500, {
      error:       'Triage service unavailable. Please try again.',
      debug_error: err.message, // TEMP — remove before final deploy
    });
  }
};

function httpResponse(statusCode, body) {
  return {
    statusCode,
    headers: {
      'Content-Type':                'application/json',
      'Access-Control-Allow-Origin': '*',
    },
    body: JSON.stringify(body),
  };
}
