/**
 * uploadClinics.mjs
 *
 * Batch-uploads a local clinics.json file into DynamoDB.
 * Uses AWS SDK v3 with modular imports and handles rate limits via
 * exponential backoff on UnprocessedItems.
 *
 * Usage:
 *   DYNAMODB_TABLE=umnyango-clinics AWS_REGION=us-east-1 node uploadClinics.mjs
 *
 * Expected clinics.json format (place in the same /seed-data directory):
 * ---------------------------------------------------------------------------
 * [
 *   {
 *     "clinicId": "clinic-001",
 *     "name": "Gugulethu Community Health Centre",
 *     "type": "chc",
 *     "lat": -33.9734,
 *     "lng": 18.5694,
 *     "address": "Washington Street, Gugulethu, Cape Town, 7750",
 *     "has_hiv_unit": true,
 *     "has_tb_unit": true,
 *     "phone": "021 637 1234"
 *   },
 *   {
 *     "clinicId": "clinic-002",
 *     "name": "Diepsloot Clinic",
 *     "type": "clinic",
 *     "lat": -25.9322,
 *     "lng": 28.0106,
 *     "address": "Extension 1, Diepsloot, Johannesburg, 2189",
 *     "has_hiv_unit": true,
 *     "has_tb_unit": false,
 *     "phone": "011 531 5600"
 *   },
 *   {
 *     "clinicId": "clinic-003",
 *     "name": "Umlazi F Section Clinic",
 *     "type": "clinic",
 *     "lat": -29.9786,
 *     "lng": 30.8869,
 *     "address": "F Section, Umlazi, Durban, 4066",
 *     "has_hiv_unit": false,
 *     "has_tb_unit": true,
 *     "phone": "031 906 1234"
 *   }
 * ]
 * ---------------------------------------------------------------------------
 */

import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, BatchWriteCommand } from '@aws-sdk/lib-dynamodb';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const TABLE = process.env.DYNAMODB_TABLE;
const REGION = process.env.AWS_REGION ?? 'us-east-1';
const BATCH_SIZE = 25; // DynamoDB BatchWrite hard limit
const MAX_RETRIES = 5;
const BASE_DELAY_MS = 200;

if (!TABLE) {
  console.error('ERROR: DYNAMODB_TABLE environment variable is not set.');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// DynamoDB client
// ---------------------------------------------------------------------------
const client = DynamoDBDocumentClient.from(
  new DynamoDBClient({ region: REGION }),
  { marshallOptions: { removeUndefinedValues: true } }
);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Split an array into chunks of at most `size` items. */
function chunk(arr, size) {
  const chunks = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}

/** Exponential backoff sleep. */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Write one batch of up to 25 items, retrying UnprocessedItems with
 * exponential backoff to handle DynamoDB rate limits gracefully.
 */
async function writeBatchWithRetry(items, attempt = 0) {
  const requestItems = {
    [TABLE]: items.map((item) => ({ PutRequest: { Item: item } })),
  };

  const { UnprocessedItems } = await client.send(
    new BatchWriteCommand({ RequestItems: requestItems })
  );

  const unprocessed = UnprocessedItems?.[TABLE];

  if (!unprocessed || unprocessed.length === 0) return;

  if (attempt >= MAX_RETRIES) {
    console.error(
      `Failed to write ${unprocessed.length} item(s) after ${MAX_RETRIES} retries.`
    );
    throw new Error('MAX_RETRIES_EXCEEDED');
  }

  const delayMs = BASE_DELAY_MS * Math.pow(2, attempt);
  console.warn(
    `  ⚠ ${unprocessed.length} unprocessed item(s) — retrying in ${delayMs}ms (attempt ${attempt + 1}/${MAX_RETRIES})`
  );
  await sleep(delayMs);

  const retryItems = unprocessed.map((r) => r.PutRequest.Item);
  await writeBatchWithRetry(retryItems, attempt + 1);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const filePath = resolve(__dirname, 'clinics.json');

  let clinics;
  try {
    clinics = JSON.parse(readFileSync(filePath, 'utf-8'));
  } catch {
    console.error(`ERROR: Could not read clinics.json at ${filePath}`);
    console.error('Create the file using the sample format in the comments at the top of this script.');
    process.exit(1);
  }

  if (!Array.isArray(clinics) || clinics.length === 0) {
    console.error('ERROR: clinics.json must be a non-empty JSON array.');
    process.exit(1);
  }

  console.log(`Uploading ${clinics.length} clinic(s) to table "${TABLE}" in ${REGION}…`);

  const batches = chunk(clinics, BATCH_SIZE);
  let uploaded = 0;

  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i];
    console.log(`  Batch ${i + 1}/${batches.length} — ${batch.length} item(s)`);
    await writeBatchWithRetry(batch);
    uploaded += batch.length;
  }

  console.log(`Done. ${uploaded} clinic(s) uploaded successfully.`);
}

main().catch((err) => {
  console.error('Upload failed:', err.message);
  process.exit(1);
});
