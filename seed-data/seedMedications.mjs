/**
 * seedMedications.mjs
 *
 * Seeds the impilo-medication-prices DynamoDB table with common SA OTC medicines.
 * Prices are approximate South African retail prices (ZAR) as of 2025.
 *
 * Usage:
 *   AWS_REGION=us-east-1 node seed-data/seedMedications.mjs
 */

import { DynamoDBClient }                          from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, BatchWriteCommand } from '@aws-sdk/lib-dynamodb';

const REGION = process.env.AWS_REGION ?? 'us-east-1';
const TABLE  = process.env.MEDICATION_PRICES_TABLE ?? 'impilo-medication-prices';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }));

const MEDICATIONS = [
  // Pain & Fever
  { medicationName: 'Panado',              priceZAR: 32.99,  unit: 'per 24 tablets', category: 'Pain & Fever' },
  { medicationName: 'Paracetamol 500mg',   priceZAR: 28.50,  unit: 'per 20 tablets', category: 'Pain & Fever' },
  { medicationName: 'Ibuprofen 200mg',     priceZAR: 35.00,  unit: 'per 24 tablets', category: 'Pain & Fever' },
  { medicationName: 'Nurofen',             priceZAR: 52.99,  unit: 'per 24 tablets', category: 'Pain & Fever' },
  { medicationName: 'Aspirin 300mg',       priceZAR: 22.00,  unit: 'per 20 tablets', category: 'Pain & Fever' },

  // Cold & Flu
  { medicationName: 'Strepsils',           priceZAR: 45.99,  unit: 'per 24 lozenges', category: 'Cold & Flu' },
  { medicationName: 'Corenza C',           priceZAR: 58.99,  unit: 'per 20 tablets',  category: 'Cold & Flu' },
  { medicationName: 'Sinutab',             priceZAR: 49.99,  unit: 'per 20 tablets',  category: 'Cold & Flu' },
  { medicationName: 'Demazin',             priceZAR: 55.00,  unit: 'per 20 tablets',  category: 'Cold & Flu' },
  { medicationName: 'Vicks VapoRub',       priceZAR: 62.99,  unit: 'per 50g jar',     category: 'Cold & Flu' },

  // Stomach & Digestion
  { medicationName: 'Buscopan',            priceZAR: 68.99,  unit: 'per 20 tablets',  category: 'Stomach' },
  { medicationName: 'Imodium',             priceZAR: 72.99,  unit: 'per 12 capsules', category: 'Stomach' },
  { medicationName: 'Gaviscon',            priceZAR: 89.99,  unit: 'per 300ml',       category: 'Stomach' },
  { medicationName: 'Rennies',             priceZAR: 38.99,  unit: 'per 24 tablets',  category: 'Stomach' },
  { medicationName: 'Rehydrate',           priceZAR: 29.99,  unit: 'per 6 sachets',   category: 'Stomach' },

  // Allergy
  { medicationName: 'Allergex',            priceZAR: 42.99,  unit: 'per 30 tablets',  category: 'Allergy' },
  { medicationName: 'Cetirizine 10mg',     priceZAR: 38.00,  unit: 'per 30 tablets',  category: 'Allergy' },
  { medicationName: 'Loratadine 10mg',     priceZAR: 35.00,  unit: 'per 30 tablets',  category: 'Allergy' },

  // Skin
  { medicationName: 'Betadine',            priceZAR: 55.99,  unit: 'per 30ml',        category: 'Skin' },
  { medicationName: 'Savlon',              priceZAR: 48.99,  unit: 'per 100ml',       category: 'Skin' },
  { medicationName: 'Calamine Lotion',     priceZAR: 32.99,  unit: 'per 100ml',       category: 'Skin' },

  // Vitamins
  { medicationName: 'Vitamin C 500mg',     priceZAR: 45.99,  unit: 'per 30 tablets',  category: 'Vitamins' },
  { medicationName: 'Berocca',             priceZAR: 89.99,  unit: 'per 15 tablets',  category: 'Vitamins' },
  { medicationName: 'Zinc 10mg',           priceZAR: 28.99,  unit: 'per 30 tablets',  category: 'Vitamins' },
];

function chunk(arr, size) {
  const chunks = [];
  for (let i = 0; i < arr.length; i += size) chunks.push(arr.slice(i, i + size));
  return chunks;
}

async function seed() {
  console.log(`Seeding ${MEDICATIONS.length} medications into "${TABLE}"…`);
  const batches = chunk(MEDICATIONS, 25);
  for (const batch of batches) {
    await ddb.send(new BatchWriteCommand({
      RequestItems: {
        [TABLE]: batch.map(item => ({ PutRequest: { Item: item } })),
      },
    }));
  }
  console.log('Done.');
}

seed().catch(err => { console.error(err.message); process.exit(1); });
