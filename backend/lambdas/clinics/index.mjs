/**
 * Clinics Lambda — GET /clinics?lat=&lng=&type=
 *
 * Queries Amazon Location Service for nearby public health facilities.
 * Returns up to 5 results within SEARCH_RADIUS_KM, sorted by distance.
 *
 * Privacy: never log coordinates or user identifiers.
 */

import {
  LocationClient,
  SearchPlaceIndexForTextCommand,
} from '@aws-sdk/client-location';

const REGION           = process.env.AWS_REGION ?? 'us-east-1';
const PLACE_INDEX      = process.env.LOCATION_PLACE_INDEX ?? 'umnyango-place-index';
const SEARCH_RADIUS_KM = 15;
const MAX_RESULTS      = 5;

const location = new LocationClient({ region: REGION });

// Broader search terms that match Esri POI categories for SA
const SEARCH_TERMS = {
  emergency_room: ['hospital', 'emergency hospital', 'casualty hospital'],
  chc:            ['health centre', 'clinic', 'medical centre'],
  clinic:         ['clinic', 'medical clinic', 'health clinic', 'doctor'],
  pharmacy:       ['pharmacy', 'chemist', 'Clicks pharmacy', 'Dis-Chem', 'Medirite'],
};

export const handler = async (event, context) => {
  console.log('clinics_request_received', { requestId: context.awsRequestId });

  try {
    const { lat, lng, type } = event.queryStringParameters ?? {};

    if (!lat || !lng) {
      return httpResponse(400, { error: 'Missing required query params: lat, lng' });
    }

    const latitude  = parseFloat(lat);
    const longitude = parseFloat(lng);

    if (isNaN(latitude) || isNaN(longitude)) {
      return httpResponse(400, { error: 'Invalid lat/lng values' });
    }

    const clinicType = type ?? 'clinic';
    const terms      = SEARCH_TERMS[clinicType] ?? SEARCH_TERMS.clinic;

    const allResults = [];
    const seen       = new Set();

    for (const term of terms) {
      try {
        const result = await location.send(new SearchPlaceIndexForTextCommand({
          IndexName:      PLACE_INDEX,
          Text:           term,
          BiasPosition:   [longitude, latitude],
          MaxResults:     10,
          FilterCountries: ['ZAF'],
        }));

        for (const place of result.Results ?? []) {
          const p = place.Place;
          if (!p?.Geometry?.Point) continue;

          const label = p.Label ?? '';
          if (seen.has(label)) continue;

          const [pLng, pLat] = p.Geometry.Point;
          const distKm = haversineKm(latitude, longitude, pLat, pLng);

          if (distKm <= SEARCH_RADIUS_KM) {
            seen.add(label);
            // Extract name (first part before comma) and address (rest)
            const parts   = label.split(',');
            const name    = parts[0]?.trim() ?? term;
            const address = parts.slice(1).join(',').trim();

            allResults.push({
              name,
              address,
              lat:        pLat,
              lng:        pLng,
              distanceKm: Math.round(distKm * 10) / 10,
              type:       clinicType,
              phone:      '',
            });
          }
        }
      } catch (searchErr) {
        console.error('location_search_error', { term, code: searchErr.name, msg: searchErr.message });
      }

      // Stop early if we have enough results
      if (allResults.length >= MAX_RESULTS) break;
    }

    const clinics = allResults
      .sort((a, b) => a.distanceKm - b.distanceKm)
      .slice(0, MAX_RESULTS);

    console.log('clinics_request_completed', {
      requestId:  context.awsRequestId,
      count:      clinics.length,
      clinicType,
    });

    return httpResponse(200, { clinics });
  } catch (err) {
    console.error('clinics_request_error', {
      requestId: context.awsRequestId,
      code:      err.name,
      msg:       err.message,
    });
    return httpResponse(500, { error: 'Clinic search unavailable.', debug_error: err.message });
  }
};

function haversineKm(lat1, lon1, lat2, lon2) {
  const R    = 6371;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a    = Math.sin(dLat / 2) ** 2 +
               Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}
function toRad(deg) { return deg * Math.PI / 180; }

function httpResponse(statusCode, body) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    body: JSON.stringify(body),
  };
}
