/**
 * Pharmacies Lambda — POST /compare-prices
 *
 * Request:  { medicationName: string, userLat: number, userLng: number }
 * Response: { medication: string, officialPrice: number, pharmacies: PharmacyResult[] }
 *
 * Flow:
 *  1. Fetch official SA medicine price from MedicationPrices DynamoDB table
 *  2. Search Amazon Location Service for nearby pharmacies within 5km
 *  3. For each pharmacy, check PharmacyPrices for a cached local price;
 *     if missing, apply a ±20% variance to the official price
 *  4. Return sorted cheapest → most expensive with distance
 *
 * Privacy: never log user coordinates or medication names.
 */

import { DynamoDBClient }                                    from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand }    from '@aws-sdk/lib-dynamodb';
import { LocationClient, SearchPlaceIndexForTextCommand }    from '@aws-sdk/client-location';

const REGION                  = process.env.AWS_REGION          ?? 'us-east-1';
const MEDICATION_PRICES_TABLE = process.env.MEDICATION_PRICES_TABLE ?? 'impilo-medication-prices';
const PHARMACY_PRICES_TABLE   = process.env.PHARMACY_PRICES_TABLE   ?? 'impilo-pharmacy-prices';
const PLACE_INDEX             = process.env.LOCATION_PLACE_INDEX    ?? 'umnyango-place-index';
const SEARCH_RADIUS_KM        = 5;
const MAX_PHARMACIES          = 8;

const ddb      = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }));
const location = new LocationClient({ region: REGION });

// ---------------------------------------------------------------------------
// Haversine distance in km
// ---------------------------------------------------------------------------
function haversineKm(lat1, lon1, lat2, lon2) {
  const R    = 6371;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a    = Math.sin(dLat / 2) ** 2 +
               Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}
function toRad(deg) { return deg * Math.PI / 180; }

// ---------------------------------------------------------------------------
// Deterministic price variance — same pharmacy always gets same markup
// so results are stable across calls (no random jitter on refresh)
// ---------------------------------------------------------------------------
function stableVariance(pharmacyId, officialPrice) {
  // Hash the pharmacyId to a number in [0, 1)
  let hash = 0;
  for (let i = 0; i < pharmacyId.length; i++) {
    hash = (hash * 31 + pharmacyId.charCodeAt(i)) & 0xffffffff;
  }
  const norm    = (hash >>> 0) / 0xffffffff; // 0..1
  const factor  = 0.85 + norm * 0.35;        // 0.85x to 1.20x (±15-20%)
  return Math.round(officialPrice * factor * 100) / 100;
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------
export const handler = async (event, context) => {
  console.log('compare_prices_received', { requestId: context.awsRequestId });

  try {
    const body = JSON.parse(event.body ?? '{}');
    const { medicationName, userLat, userLng } = body;

    if (!medicationName || typeof medicationName !== 'string') {
      return httpResponse(400, { error: 'Missing required field: medicationName' });
    }

    // Cape Town fallback if coordinates missing or invalid
    const lat = typeof userLat === 'number' && !isNaN(userLat) ? userLat : -33.9249;
    const lng = typeof userLng === 'number' && !isNaN(userLng) ? userLng : 18.4241;

    // ── Step 1: Official price from DynamoDB ──────────────────────────────
    const medResult = await ddb.send(new GetCommand({
      TableName: MEDICATION_PRICES_TABLE,
      Key:       { medicationName: medicationName.trim() },
    }));

    const officialPrice = medResult.Item?.priceZAR ?? null;
    const unit          = medResult.Item?.unit      ?? 'per pack';
    const category      = medResult.Item?.category  ?? 'General';

    // ── Step 2: Nearby pharmacies via Location Service ────────────────────
    const searchTerms = ['pharmacy', 'Clicks', 'Dis-Chem', 'Medirite', 'Clicks pharmacy'];
    const allPharmacies = [];
    const seen = new Set();

    for (const term of searchTerms) {
      try {
        const result = await location.send(new SearchPlaceIndexForTextCommand({
          IndexName:       PLACE_INDEX,
          Text:            term,
          BiasPosition:    [lng, lat],
          MaxResults:      10,
          FilterCountries: ['ZAF'],
        }));

        for (const place of result.Results ?? []) {
          const p = place.Place;
          if (!p?.Geometry?.Point) continue;
          const label = p.Label ?? '';
          if (seen.has(label)) continue;

          const [pLng, pLat] = p.Geometry.Point;
          const distKm = haversineKm(lat, lng, pLat, pLng);
          if (distKm > SEARCH_RADIUS_KM) continue;

          seen.add(label);
          const parts = label.split(',');
          const name  = parts[0]?.trim() ?? term;
          const addr  = parts.slice(1, 3).join(',').trim();

          // Stable ID from name + address
          const pharmacyId = `${name}|${addr}`.toLowerCase().replace(/\s+/g, '-');

          allPharmacies.push({ pharmacyId, name, address: addr, distanceKm: Math.round(distKm * 10) / 10 });
        }
      } catch { /* continue on individual search failure */ }

      if (allPharmacies.length >= MAX_PHARMACIES) break;
    }

    // ── Step 3: Price per pharmacy ────────────────────────────────────────
    const results = await Promise.all(
      allPharmacies.slice(0, MAX_PHARMACIES).map(async (pharmacy) => {
        // Check cache
        const cached = await ddb.send(new GetCommand({
          TableName: PHARMACY_PRICES_TABLE,
          Key:       { pharmacyId: pharmacy.pharmacyId, medicationName: medicationName.trim() },
        })).catch(() => null);

        let price;
        let priceSource;

        if (cached?.Item?.priceZAR) {
          price       = cached.Item.priceZAR;
          priceSource = 'local';
        } else if (officialPrice !== null) {
          price       = stableVariance(pharmacy.pharmacyId, officialPrice);
          priceSource = 'estimated';
          // Cache the estimated price for future calls
          await ddb.send(new PutCommand({
            TableName: PHARMACY_PRICES_TABLE,
            Item: {
              pharmacyId:     pharmacy.pharmacyId,
              medicationName: medicationName.trim(),
              priceZAR:       price,
              priceSource:    'estimated',
              cachedAt:       Date.now(),
              expiresAt:      Math.floor(Date.now() / 1000) + 86400, // 24h TTL
            },
          })).catch(() => null);
        } else {
          price       = null;
          priceSource = 'unavailable';
        }

        return {
          pharmacyId:  pharmacy.pharmacyId,
          name:        pharmacy.name,
          address:     pharmacy.address,
          distanceKm:  pharmacy.distanceKm,
          priceZAR:    price,
          priceSource,
        };
      })
    );

    // Sort cheapest first (nulls last)
    results.sort((a, b) => {
      if (a.priceZAR === null) return 1;
      if (b.priceZAR === null) return -1;
      return a.priceZAR - b.priceZAR;
    });

    console.log('compare_prices_completed', {
      requestId:      context.awsRequestId,
      pharmacyCount:  results.length,
      hasOfficialPrice: officialPrice !== null,
    });

    return httpResponse(200, {
      medication:    medicationName.trim(),
      officialPrice,
      unit,
      category,
      pharmacies:    results,
    });
  } catch (err) {
    console.error('compare_prices_error', {
      requestId: context.awsRequestId,
      code:      err.name,
      msg:       err.message,
    });
    return httpResponse(500, { error: 'Price comparison unavailable.', debug_error: err.message });
  }
};

function httpResponse(statusCode, body) {
  return {
    statusCode,
    headers: {
      'Content-Type':                'application/json',
      'Access-Control-Allow-Origin': '*',
    },
    body: JSON.stringify(body),
  };
}
