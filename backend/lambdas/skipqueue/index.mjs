/**
 * SkipQueue Lambda — POST /skipqueue
 *
 * Request:  { clinicId: string, clinicName: string, preferredTime: string (ISO) }
 * Response: { bookingId, clinicName, pickupTime, estimatedWait, instructions[] }
 *
 * Generates a unique booking, stores it in DynamoDB with a 24h TTL,
 * and returns a QR-ready bookingId for express collection.
 */

import { randomUUID }                                    from 'crypto';
import { DynamoDBClient }                                from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand, GetCommand } from '@aws-sdk/lib-dynamodb';

const REGION         = process.env.AWS_REGION      ?? 'us-east-1';
const SKIPQUEUE_TABLE = process.env.SKIPQUEUE_TABLE ?? 'impilo-skipqueue-bookings';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }));

export const handler = async (event, context) => {
  console.log('skipqueue_request', { requestId: context.awsRequestId });

  // Handle CORS preflight
  if (event.httpMethod === 'OPTIONS') {
    return httpResponse(200, {});
  }

  try {
    const body = JSON.parse(event.body ?? '{}');
    const { clinicId, clinicName, preferredTime } = body;

    if (!clinicId || !preferredTime) {
      return httpResponse(400, { error: 'Missing required fields: clinicId, preferredTime' });
    }

    const bookingId  = randomUUID();
    const pickupTime = preferredTime; // client sends chosen slot as ISO string
    const now        = Math.floor(Date.now() / 1000);

    const booking = {
      bookingId,
      clinicId:      clinicId.trim(),
      clinicName:    (clinicName ?? clinicId).trim(),
      pickupTime,
      estimatedWait: '< 10 minutes',
      status:        'CONFIRMED',
      createdAt:     now,
      expiresAt:     now + 86400, // 24h TTL
    };

    await ddb.send(new PutCommand({
      TableName: SKIPQUEUE_TABLE,
      Item:      booking,
    }));

    console.log('skipqueue_booked', { requestId: context.awsRequestId });

    return httpResponse(200, {
      bookingId,
      clinicName:    booking.clinicName,
      pickupTime,
      estimatedWait: booking.estimatedWait,
      instructions: [
        'Show this QR code at the express collection counter.',
        'Your medication will be pre-prepared and ready for collection.',
        'Collect within your 30-minute pickup window to keep your slot.',
      ],
    });
  } catch (err) {
    console.error('skipqueue_error', {
      requestId: context.awsRequestId,
      code:      err.name,
      msg:       err.message,
    });
    return httpResponse(500, { error: 'Booking failed. Please try again.', debug_error: err.message });
  }
};

function httpResponse(statusCode, body) {
  return {
    statusCode,
    headers: {
      'Content-Type':                'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    },
    body: JSON.stringify(body),
  };
}
