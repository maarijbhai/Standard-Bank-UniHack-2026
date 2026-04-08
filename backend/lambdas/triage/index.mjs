/**
 * Triage Lambda — POST /triage
 *
 * Flow: user text → Bedrock (Claude) → triage JSON → Polly (Ayanda) → base64 MP3
 *
 * Privacy rules (enforced):
 *  - NEVER log user input text, Bedrock responses, or any PII to CloudWatch
 *  - Log operational metadata only (requestId, latency, error codes)
 */

import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';
import { PollyClient, SynthesizeSpeechCommand } from '@aws-sdk/client-polly';

const REGION = process.env.AWS_REGION ?? 'us-east-1';
const MODEL_ID = process.env.BEDROCK_MODEL_ID ?? 'anthropic.claude-sonnet-4-5';

const bedrock = new BedrockRuntimeClient({ region: REGION });
const polly = new PollyClient({ region: REGION });

// ---------------------------------------------------------------------------
// System prompt — enforces strict JSON output and Grade 6 reading level
// ---------------------------------------------------------------------------
const SYSTEM_PROMPT = `You are a South African public healthcare triage assistant.
Analyse the patient's symptoms and respond ONLY with a valid JSON object — no markdown, no prose, no extra keys.

The JSON must match this exact structure:
{
  "urgency": "emergency" | "urgent" | "routine",
  "clinic_type": "emergency_room" | "chc" | "clinic" | "pharmacy",
  "summary": "<plain-language explanation, max 2 sentences, Grade 6 reading level>",
  "benefits": ["<applicable SA programme e.g. Free ARVs, SASSA Relief>"],
  "refer_emergency": true | false
}

Rules:
- Write the summary at a Grade 6 reading level. Use short words and simple sentences.
- Use stigma-safe language. Say "wellness support" instead of "ARVs". Say "chest illness programme" instead of "TB treatment".
- Never include the patient's words verbatim in the summary.
- Never add fields outside the schema above.
- Never wrap the JSON in markdown code fences.`;

// ---------------------------------------------------------------------------
// Bedrock invocation
// ---------------------------------------------------------------------------
async function invokeBedrock(userText) {
  const payload = {
    anthropic_version: 'bedrock-2023-05-31',
    max_tokens: 512,
    system: SYSTEM_PROMPT,
    messages: [
      {
        role: 'user',
        content: userText,
      },
    ],
  };

  const command = new InvokeModelCommand({
    modelId: MODEL_ID,
    contentType: 'application/json',
    accept: 'application/json',
    body: JSON.stringify(payload),
  });

  const raw = await bedrock.send(command);
  const decoded = JSON.parse(Buffer.from(raw.body).toString('utf-8'));

  // Claude returns content as an array of blocks; grab the first text block
  const text = decoded?.content?.[0]?.text;
  if (!text) throw new Error('BEDROCK_EMPTY_RESPONSE');

  // Parse and validate the triage JSON
  const triage = JSON.parse(text);
  validateTriage(triage);

  return triage;
}

function validateTriage(obj) {
  const urgencies = ['emergency', 'urgent', 'routine'];
  const clinicTypes = ['emergency_room', 'chc', 'clinic', 'pharmacy'];

  if (!urgencies.includes(obj.urgency)) throw new Error('INVALID_URGENCY');
  if (!clinicTypes.includes(obj.clinic_type)) throw new Error('INVALID_CLINIC_TYPE');
  if (typeof obj.summary !== 'string' || obj.summary.trim() === '') throw new Error('MISSING_SUMMARY');
  if (!Array.isArray(obj.benefits)) throw new Error('INVALID_BENEFITS');
  if (typeof obj.refer_emergency !== 'boolean') throw new Error('INVALID_REFER_EMERGENCY');
}

// ---------------------------------------------------------------------------
// Polly invocation
// ---------------------------------------------------------------------------
async function synthesiseSpeech(summary) {
  const command = new SynthesizeSpeechCommand({
    Text: summary,
    OutputFormat: 'mp3',
    VoiceId: 'Ayanda',
    Engine: 'neural',
    LanguageCode: 'en-ZA',
  });

  const result = await polly.send(command);

  // AudioStream is a readable stream — collect all chunks into a Buffer
  const chunks = [];
  for await (const chunk of result.AudioStream) {
    chunks.push(chunk);
  }

  return Buffer.concat(chunks).toString('base64');
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------
export const handler = async (event, context) => {
  const startTime = Date.now();
  console.log('triage_request_received', { requestId: context.awsRequestId });

  try {
    const body = JSON.parse(event.body ?? '{}');

    if (!body.text || typeof body.text !== 'string' || body.text.trim() === '') {
      return httpResponse(400, { error: 'Missing or empty required field: text' });
    }

    // Step 1 — Bedrock triage
    const triage = await invokeBedrock(body.text.trim());

    // Step 2 — Polly audio synthesis from the triage summary
    const audioBase64 = await synthesiseSpeech(triage.summary);

    console.log('triage_request_completed', {
      requestId: context.awsRequestId,
      durationMs: Date.now() - startTime,
      urgency: triage.urgency,          // safe to log — not PII
      clinic_type: triage.clinic_type,  // safe to log — not PII
    });

    return httpResponse(200, {
      triage,
      audio: audioBase64,
      audioFormat: 'mp3',
    });
  } catch (err) {
    console.error('triage_request_error', {
      requestId: context.awsRequestId,
      durationMs: Date.now() - startTime,
      errorCode: err.name,
      // intentionally NOT logging err.message — may echo user input
    });

    return httpResponse(500, { error: 'Triage service unavailable. Please try again.' });
  }
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function httpResponse(statusCode, body) {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    },
    body: JSON.stringify(body),
  };
}
