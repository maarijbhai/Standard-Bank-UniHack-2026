/**
 * Transcribe Lambda — WebSocket routes: $connect, $disconnect, transcribe
 *
 * Flow:
 *  1. Client connects via WebSocket
 *  2. Client sends { action: "transcribe", audio: "<base64 PCM chunk>" } frames
 *     while the user holds the button
 *  3. Client sends { action: "stop" } when the user releases
 *  4. Lambda accumulates audio chunks, then calls Amazon Transcribe Streaming
 *     with automatic language identification (en-ZA, af-ZA, zu-ZA)
 *  5. Lambda sends back { transcript, detectedLanguage, detectedLanguageName }
 *     over the WebSocket connection
 *
 * Privacy: never log audio data, transcripts, or user identifiers.
 */

import {
  TranscribeStreamingClient,
  StartStreamTranscriptionCommand,
} from '@aws-sdk/client-transcribe-streaming';
import {
  ApiGatewayManagementApiClient,
  PostToConnectionCommand,
  DeleteConnectionCommand,
} from '@aws-sdk/client-apigatewaymanagementapi';

const REGION = process.env.AWS_REGION ?? 'us-east-1';

// In-memory store for audio chunks per connection (Lambda is single-invocation per WS message)
// We use a DynamoDB-backed approach via the connection ID passed in each message instead.
// Audio chunks are accumulated client-side and sent as a single "stop" payload.

const LANGUAGE_NAMES = {
  'en-US': 'English', 'en-GB': 'English', 'en-AU': 'English', 'en-ZA': 'English',
  'af-ZA': 'Afrikaans',
  'zu-ZA': 'Zulu',
};

export const handler = async (event) => {
  const routeKey      = event.requestContext.routeKey;
  const connectionId  = event.requestContext.connectionId;
  const domainName    = event.requestContext.domainName;
  const stage         = event.requestContext.stage;
  const callbackUrl   = `https://${domainName}/${stage}`;

  const apigw = new ApiGatewayManagementApiClient({ endpoint: callbackUrl, region: REGION });

  // ── $connect ──────────────────────────────────────────────────────────────
  if (routeKey === '$connect') {
    console.log('ws_connect', { connectionId });
    return { statusCode: 200 };
  }

  // ── $disconnect ───────────────────────────────────────────────────────────
  if (routeKey === '$disconnect') {
    console.log('ws_disconnect', { connectionId });
    return { statusCode: 200 };
  }

  // ── transcribe ────────────────────────────────────────────────────────────
  if (routeKey === 'transcribe') {
    let body;
    try {
      body = JSON.parse(event.body ?? '{}');
    } catch {
      await send(apigw, connectionId, { error: 'Invalid JSON' });
      return { statusCode: 400 };
    }

    // Client sends the complete audio as a single base64-encoded WebM/Opus blob
    const audioBase64 = body.audio;
    if (!audioBase64 || typeof audioBase64 !== 'string') {
      await send(apigw, connectionId, { error: 'Missing audio field' });
      return { statusCode: 400 };
    }

    const audioBuffer = Buffer.from(audioBase64, 'base64');
    console.log('transcribe_request', { connectionId, bytes: audioBuffer.length });

    try {
      const { transcript, detectedLanguage } = await transcribeAudio(audioBuffer);

      const langName = LANGUAGE_NAMES[detectedLanguage] ?? detectedLanguage;
      console.log('transcribe_complete', { connectionId, detectedLanguage, chars: transcript.length });

      await send(apigw, connectionId, {
        type:                 'transcript',
        transcript,
        detectedLanguage,
        detectedLanguageName: langName,
      });
    } catch (err) {
      console.error('transcribe_error', { connectionId, code: err.name });
      await send(apigw, connectionId, { type: 'error', message: 'Transcription failed. Please try again.' });
    }

    return { statusCode: 200 };
  }

  return { statusCode: 400 };
};

// ---------------------------------------------------------------------------
// Amazon Transcribe Streaming — automatic language identification
// ---------------------------------------------------------------------------
async function transcribeAudio(audioBuffer) {
  const client = new TranscribeStreamingClient({ region: REGION });

  // Transcribe Streaming expects PCM audio. We receive WebM/Opus from MediaRecorder.
  // We send it as-is and use the OGG_OPUS media format which Transcribe supports.
  const CHUNK_SIZE = 8192;

  async function* audioStream() {
    for (let offset = 0; offset < audioBuffer.length; offset += CHUNK_SIZE) {
      yield { AudioEvent: { AudioChunk: audioBuffer.slice(offset, offset + CHUNK_SIZE) } };
    }
  }

  const command = new StartStreamTranscriptionCommand({
    LanguageCode:                    undefined, // must be omitted when using auto-detection
    IdentifyMultipleLanguages:       true,
    LanguageOptions:                 'en-ZA,af-ZA,zu-ZA',
    MediaEncoding:                   'ogg-opus',
    MediaSampleRateHertz:            48000,
    AudioStream:                     audioStream(),
  });

  const response = await client.send(command);

  let transcript         = '';
  let detectedLanguage   = 'en-ZA';

  for await (const event of response.TranscriptResultStream) {
    if (event.TranscriptEvent) {
      const results = event.TranscriptEvent.Transcript?.Results ?? [];
      for (const result of results) {
        if (!result.IsPartial && result.Alternatives?.[0]?.Transcript) {
          transcript += result.Alternatives[0].Transcript + ' ';
        }
        if (result.LanguageCode) {
          detectedLanguage = result.LanguageCode;
        }
      }
    }
  }

  return { transcript: transcript.trim(), detectedLanguage };
}

// ---------------------------------------------------------------------------
// Helper — send message back to WebSocket client
// ---------------------------------------------------------------------------
async function send(apigw, connectionId, payload) {
  try {
    await apigw.send(new PostToConnectionCommand({
      ConnectionId: connectionId,
      Data:         Buffer.from(JSON.stringify(payload)),
    }));
  } catch (err) {
    if (err.name === 'GoneException') {
      console.log('ws_connection_gone', { connectionId });
    } else {
      console.error('ws_send_error', { connectionId, code: err.name });
    }
  }
}
