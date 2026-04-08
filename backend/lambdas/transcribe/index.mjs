/**
 * Transcribe Lambda — WebSocket routes: $connect, $disconnect, transcribe
 *
 * Receives a complete base64-encoded WebM/Opus audio blob from the client,
 * streams it through Amazon Transcribe Streaming with automatic language
 * identification (en-ZA, af-ZA, zu-ZA), and returns the transcript.
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
      const { transcript, detectedLanguage } = await transcribeAudio(audioBuffer);
      const langName = LANGUAGE_NAMES[detectedLanguage] ?? 'English';

      console.log('transcribe_complete', {
        connectionId,
        detectedLanguage,
        transcriptLength: transcript.length,
      });

      await send(apigw, connectionId, {
        type:                 'transcript',
        transcript:           transcript || '',
        detectedLanguage,
        detectedLanguageName: langName,
      });
    } catch (err) {
      console.error('transcribe_error', {
        connectionId,
        errorName:    err.name,
        errorMessage: err.message, // TEMP — remove before final deploy
      });
      await send(apigw, connectionId, {
        type:    'error',
        message: `Transcription failed: ${err.message}`, // TEMP
      });
    }

    return { statusCode: 200 };
  }

  return { statusCode: 400 };
};

// ---------------------------------------------------------------------------
// Transcribe Streaming with automatic language identification
// ---------------------------------------------------------------------------
async function transcribeAudio(audioBuffer) {
  const client    = new TranscribeStreamingClient({ region: REGION });
  const CHUNK_SIZE = 32768; // 32 KB chunks

  async function* audioStream() {
    for (let offset = 0; offset < audioBuffer.length; offset += CHUNK_SIZE) {
      yield { AudioEvent: { AudioChunk: audioBuffer.slice(offset, offset + CHUNK_SIZE) } };
    }
  }

  // NOTE: When using IdentifyMultipleLanguages, do NOT include LanguageCode at all.
  // LanguageOptions must be a comma-separated string of BCP-47 codes.
  const command = new StartStreamTranscriptionCommand({
    IdentifyMultipleLanguages: true,
    LanguageOptions:           'en-ZA,af-ZA,zu-ZA',
    MediaEncoding:             'ogg-opus',
    MediaSampleRateHertz:      48000,
    AudioStream:               audioStream(),
  });

  const response = await client.send(command);

  let transcript       = '';
  let detectedLanguage = 'en-ZA';

  for await (const event of response.TranscriptResultStream) {
    if (event.TranscriptEvent) {
      const results = event.TranscriptEvent.Transcript?.Results ?? [];
      for (const result of results) {
        // Only use final (non-partial) results
        if (!result.IsPartial) {
          const text = result.Alternatives?.[0]?.Transcript ?? '';
          if (text) transcript += text + ' ';
        }
        // LanguageCode is on the result object when multi-language detection is on
        if (result.LanguageCode) detectedLanguage = result.LanguageCode;
      }
    }
  }

  return { transcript: transcript.trim(), detectedLanguage };
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
