/**
 * Clinics Lambda — GET /clinics?lat=&lng=&type=
 *
 * Queries Amazon Location Service for nearby public health facilities.
 * Returns up to 5 results within SEARCH_RADIUS_KM, sorted by distance.
 *
 * Privacy: never log coordinates or user identifiers.
 */

import { LocationClient, SearchPlaceIndexForPositionCommand, SearchPlaceIndexForTextCommand } from '@aws-sdk/client-location';

const REGION           = process.env.AWS_REGION ?? 'us-east-1';
const PLACE_INDEX      = process.env.LOCATION_PLACE_INDEX ?? 'umnyango-place-index';
const SEARCH_RADIUS_KM = 10;
const MAX_RESULTS      = 5;

const location = new LocationClient({ region: REGION });

// Clinic type → search terms for Location Service
const SEARCH_TERMS = {
  emergency_room: ['emergency room', 'hospital emergency', 'casualty'],
  chc:            ['community health centre', 'CHC', 'health centre'],
  clinic:         ['clinic', 'health clinic', 'medical clinic'],
  pharmacy:       ['pharmacy', 'chemist', 'dispensary'],
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

    // Search for each term and merge results
    const allResults = [];
    for (const term of terms) {
      try {
        const result = await location.send(new SearchPlaceIndexForTextCommand({
          IndexName:  PLACE_INDEX,
          Text:       `${term} South Africa`,
          BiasPosition: [longitude, latitude],
          MaxResults: MAX_RESULTS,
          FilterCountries: ['ZAF'],
        }));

        for (const place of result.Results ?? []) {
          const p = place.Place;
          if (!p?.Geometry?.Point) continue;

          const [pLng, pLat] = p.Geometry.Point;
          const distKm = haversineKm(latitude, longitude, pLat, pLng);

          if (distKm <= SEARCH_RADIUS_KM) {
            allResults.push({
              name:     p.Label?.split(',')[0] ?? term,
              address:  p.Label ?? '',
              lat:      pLat,
              lng:      pLng,
              distanceKm: Math.round(distKm * 10) / 10,
              type:     clinicType,
              phone:    p.AddressNumber ?? '',
            });
          }
        }
      } catch (searchErr) {
        console.error('location_search_error', { term, code: searchErr.name });
      }
    }

    // Deduplicate by name, sort by distance
    const seen    = new Set();
    const clinics = allResults
      .filter(c => { if (seen.has(c.name)) return false; seen.add(c.name); return true; })
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

// Haversine distance in km
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
