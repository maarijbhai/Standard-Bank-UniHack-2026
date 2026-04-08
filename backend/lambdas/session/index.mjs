/**
 * Session Lambda — POST /session
 *
 * Generates an anonymous 6-digit PIN and creates a DynamoDB session record.
 * TTL: 24 hours from creation.
 *
 * Returns: { sessionPin: string }
 *
 * Privacy rules:
 *  - sessionPin is random and non-identifying
 *  - conditionCategory stored as enum only (e.g. GENERAL, CHRONIC_HIV, TB_RISK)
 *  - NEVER log the PIN or any user-supplied data
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: process.env.AWS_REGION }));

export const handler = async (event, context) => {
  console.log('session_create_received', { requestId: context.awsRequestId });

  try {
    const sessionPin = String(Math.floor(100000 + Math.random() * 900000));
    const now = Math.floor(Date.now() / 1000);
    const ttl = now + 86400; // 24 hours

    await ddb.send(new PutCommand({
      TableName: process.env.DYNAMODB_TABLE,
      Item: {
        sessionPin,
        conditionCategory: 'GENERAL',
        createdAt: now,
        expiresAt: ttl,
      },
    }));

    console.log('session_create_completed', { requestId: context.awsRequestId });

    return response(200, { sessionPin });
  } catch (err) {
    console.error('session_create_error', { requestId: context.awsRequestId, code: err.name });
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
