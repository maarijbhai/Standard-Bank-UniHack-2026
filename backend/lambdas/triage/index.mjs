/**
 * Triage Lambda — POST /triage
 *
 * Receives: { text: string }
 * Invokes:  Bedrock (Claude) for triage JSON, then Polly for audio synthesis
 * Returns:  { triage: TriageResult, audio: string (base64 mp3), audioFormat: "mp3" }
 *
 * Privacy rules:
 *  - NEVER log user input text or Bedrock responses to CloudWatch
 *  - Log operational metadata only (requestId, latency)
 */

export const handler = async (event, context) => {
  const startTime = Date.now();
  console.log('triage_request_received', { requestId: context.awsRequestId });

  try {
    const body = JSON.parse(event.body ?? '{}');

    if (!body.text || typeof body.text !== 'string') {
      return response(400, { error: 'Missing required field: text' });
    }

    // TODO: invoke Bedrock for triage JSON
    // TODO: invoke Polly for audio synthesis

    console.log('triage_request_completed', {
      requestId: context.awsRequestId,
      durationMs: Date.now() - startTime,
    });

    return response(200, {
      triage: null,   // placeholder
      audio: null,    // placeholder
      audioFormat: 'mp3',
    });
  } catch (err) {
    console.error('triage_request_error', { requestId: context.awsRequestId, code: err.name });
    return response(500, { error: 'Internal server error' });
  }
};

function response(statusCode, body) {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    },
    body: JSON.stringify(body),
  };
}
