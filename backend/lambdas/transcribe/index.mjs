/**
 * Transcribe Lambda — WebSocket routes: $connect, $disconnect, transcribe
 *
 * Audio is sent as multiple chunks (API Gateway WS max message = 128KB).
 * The Lambda reassembles chunks in DynamoDB, then streams through Transcribe
 * once all chunks are received.
 *
 * Messages sent to client:
 *   { type: 'partial',    text, detectedLanguage }
 *   { type: 'transcript', transcript, detectedLanguage, detectedLanguageName }
 *   { type: 'error',      message }
 */

import {
  TranscribeStreamingClient,
  StartStreamTranscriptionCommand,
} from '@aws-sdk/client-transcribe-streaming';
import {
  ApiGatewayManagementApiClient,
  PostToConnectionCommand,
} from '@aws-sdk/client-apigatewaymanagementapi';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand, GetCommand, DeleteCommand } from '@aws-sdk/lib-dynamodb';

const REGION = process.env.AWS_REGION ?? 'us-east-1';
const TABLE  = process.env.DYNAMODB_TABLE;

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }));

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
    // Clean up any partial chunk state
    if (TABLE) {
      try {
        await ddb.send(new DeleteCommand({ TableName: TABLE, Key: { sessionPin: `ws_chunks_${connectionId}` } }));
      } catch { /* ignore */ }
    }
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

    const { chunk, chunkIndex, totalChunks } = body;

    if (typeof chunk !== 'string' || typeof chunkIndex !== 'number' || typeof totalChunks !== 'number') {
      await send(apigw, connectionId, { type: 'error', message: 'Invalid chunk payload' });
      return { statusCode: 400 };
    }

    console.log('chunk_received', { connectionId, chunkIndex, totalChunks, chunkLen: chunk.length });

    // Store chunk in DynamoDB
    const key = `ws_chunks_${connectionId}`;
    await ddb.send(new PutCommand({
      TableName: TABLE,
      Item: {
        sessionPin:  `${key}_${chunkIndex}`,
        chunk,
        chunkIndex,
        totalChunks,
        connectionId,
        expiresAt:   Math.floor(Date.now() / 1000) + 300,
      },
    }));

    // Acknowledge receipt so client sends the next chunk
    await send(apigw, connectionId, { type: 'ack', chunkIndex });

    // Check if all chunks received
    if (chunkIndex < totalChunks - 1) {
      return { statusCode: 200 };
    }

    // Last chunk received — reassemble all chunks
    console.log('all_chunks_received', { connectionId, totalChunks });

    // Retry fetching chunks — earlier Lambda invocations may still be writing
    const MAX_RETRIES = 5;
    const chunks = [];
    for (let i = 0; i < totalChunks; i++) {
      let item = null;
      for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
        const result = await ddb.send(new GetCommand({
          TableName: TABLE,
          Key: { sessionPin: `${key}_${i}` },
        }));
        if (result.Item) { item = result.Item; break; }
        // Wait with backoff before retrying
        await new Promise(r => setTimeout(r, 200 * (attempt + 1)));
      }
      if (!item) {
        await send(apigw, connectionId, { type: 'error', message: `Missing chunk ${i} after retries` });
        return { statusCode: 400 };
      }
      chunks.push(item.chunk);
      // Clean up chunk
      await ddb.send(new DeleteCommand({ TableName: TABLE, Key: { sessionPin: `${key}_${i}` } }));
    }

    const audioBase64 = chunks.join('');
    const audioBuffer = Buffer.from(audioBase64, 'base64');
    console.log('transcribe_start', { connectionId, bytes: audioBuffer.length });

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
      console.error('transcribe_error', { connectionId, name: err.name, msg: err.message });
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

  const command = new StartStreamTranscriptionCommand({
    IdentifyMultipleLanguages: true,
    LanguageOptions:           'en-ZA,af-ZA,zu-ZA',
    MediaEncoding:             'pcm',
    MediaSampleRateHertz:      16000,
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
      if (result.LanguageCode) detectedLanguage = result.LanguageCode;

      if (result.IsPartial) {
        if (text !== partialBuffer) {
          partialBuffer = text;
          await send(apigw, connectionId, {
            type:             'partial',
            text:             (finalTranscript + ' ' + text).trim(),
            detectedLanguage,
          });
        }
      } else if (text) {
        finalTranscript += (finalTranscript ? ' ' : '') + text;
        partialBuffer    = '';
        await send(apigw, connectionId, {
          type:             'partial',
          text:             finalTranscript,
          detectedLanguage,
        });
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
