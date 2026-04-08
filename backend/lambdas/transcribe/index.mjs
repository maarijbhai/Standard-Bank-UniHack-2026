/**
 * Transcribe Lambda — WebSocket routes: $connect, $disconnect, transcribe
 *
 * Receives a complete base64-encoded WebM/Opus audio blob, streams it through
 * Amazon Transcribe Streaming with automatic language identification, and sends
 * partial results back over the WebSocket in real-time as they arrive.
 *
 * Messages sent to client:
 *   { type: 'partial',    text: string, detectedLanguage: string }  — interim results
 *   { type: 'transcript', transcript: string, detectedLanguage: string, detectedLanguageName: string }
 *   { type: 'error',      message: string }
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
} from '@aws-sdk/client-apigatewaymanagementapi';

const REGION = process.env.AWS_REGION ?? 'us-east-1';

const LANGUAGE_NAMES = {
  'en-US': 'English', 'en-GB': 'English', 'en-AU': 'English', 'en-ZA': 'English',
  'af-ZA': 'Afrikaans',
  'zu-ZA': 'Zulu',
  'xh-ZA': 'Xhosa',
};

export const handler = async (event) => {
  const { routeKey, connectionId, domainName, stage } = event.requestContext;
  const callbackUrl = `https://${domainName}/${stage}`;
  const apigw = new ApiGatewayManagementApiClient({ endpoint: callbackUrl, region: REGION });

  if (routeKey === '$connect') {
    console.log('ws_connect', { connectionId });
    return { statusCode: 200 };
  }

  if (routeKey === '$disconnect') {
    console.log('ws_disconnect', { connectionId });
    return { statusCode: 200 };
  }

  if (routeKey === 'transcribe') {
    let body;
    try {
      body = JSON.parse(event.body ?? '{}');
    } catch {
      await send(apigw, connectionId, { type: 'error', message: 'Invalid JSON payload' });
      return { statusCode: 400 };
    }

    const audioBase64 = body.audio;
    if (!audioBase64 || typeof audioBase64 !== 'string') {
      await send(apigw, connectionId, { type: 'error', message: 'Missing audio field' });
      return { statusCode: 400 };
    }

    const audioBuffer = Buffer.from(audioBase64, 'base64');
    console.log('transcribe_request', { connectionId, bytes: audioBuffer.length });

    try {
      const { transcript, detectedLanguage } =
        await transcribeAudio(audioBuffer, apigw, connectionId);

      const langName = LANGUAGE_NAMES[detectedLanguage] ?? 'English';
      console.log('transcribe_complete', { connectionId, detectedLanguage });

      await send(apigw, connectionId, {
        type:                 'transcript',
        transcript:           transcript.trim(),
        detectedLanguage,
        detectedLanguageName: langName,
      });
    } catch (err) {
      console.error('transcribe_error', {
        connectionId,
        errorName:    err.name,
        errorMessage: err.message,
      });
      await send(apigw, connectionId, {
        type:    'error',
        message: `Transcription failed: ${err.name} — ${err.message}`,
      });
    }

    return { statusCode: 200 };
  }

  return { statusCode: 400 };
};

// ---------------------------------------------------------------------------
// Transcribe Streaming — streams partial results back over WebSocket
// ---------------------------------------------------------------------------
async function transcribeAudio(audioBuffer, apigw, connectionId) {
  const client     = new TranscribeStreamingClient({ region: REGION });
  const CHUNK_SIZE = 32768;

  async function* audioStream() {
    for (let offset = 0; offset < audioBuffer.length; offset += CHUNK_SIZE) {
      yield { AudioEvent: { AudioChunk: audioBuffer.slice(offset, offset + CHUNK_SIZE) } };
    }
  }

  // IMPORTANT: Do NOT include LanguageCode when using IdentifyMultipleLanguages.
  const command = new StartStreamTranscriptionCommand({
    IdentifyMultipleLanguages: true,
    LanguageOptions:           'en-ZA,af-ZA,zu-ZA',
    MediaEncoding:             'ogg-opus',
    MediaSampleRateHertz:      48000,
    AudioStream:               audioStream(),
  });

  const response = await client.send(command);

  let finalTranscript  = '';
  let detectedLanguage = 'en-ZA';
  let partialBuffer    = '';

  for await (const event of response.TranscriptResultStream) {
    if (!event.TranscriptEvent) continue;

    const results = event.TranscriptEvent.Transcript?.Results ?? [];

    for (const result of results) {
      const text = result.Alternatives?.[0]?.Transcript ?? '';

      // Track detected language from any result
      if (result.LanguageCode) detectedLanguage = result.LanguageCode;

      if (result.IsPartial) {
        // Send partial result to client for live display
        if (text !== partialBuffer) {
          partialBuffer = text;
          await send(apigw, connectionId, {
            type:             'partial',
            text:             finalTranscript + ' ' + text,
            detectedLanguage,
          });
        }
      } else {
        // Final result — append to transcript
        if (text) {
          finalTranscript += (finalTranscript ? ' ' : '') + text;
          partialBuffer    = '';
          // Send updated running transcript
          await send(apigw, connectionId, {
            type:             'partial',
            text:             finalTranscript,
            detectedLanguage,
          });
        }
      }
    }
  }

  return { transcript: finalTranscript, detectedLanguage };
}

async function send(apigw, connectionId, payload) {
  try {
    await apigw.send(new PostToConnectionCommand({
      ConnectionId: connectionId,
      Data:         Buffer.from(JSON.stringify(payload)),
    }));
  } catch (err) {
    if (err.name !== 'GoneException') {
      console.error('ws_send_error', { connectionId, code: err.name });
    }
  }
}
