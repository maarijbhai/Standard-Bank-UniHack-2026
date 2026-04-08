/**
 * Clinics Lambda — GET /clinics
 *
 * Receives: query params { lat: number, lng: number }
 * Queries:  Amazon Location Service (Esri) for 3 nearest public health facilities
 * Returns:  { clinics: Clinic[] }
 *
 * Privacy rules:
 *  - Log operational metadata only — never log coordinates or user identifiers
 */

export const handler = async (event, context) => {
  console.log('clinics_request_received', { requestId: context.awsRequestId });

  try {
    const { lat, lng } = event.queryStringParameters ?? {};

    if (!lat || !lng) {
      return response(400, { error: 'Missing required query params: lat, lng' });
    }

    // TODO: query Amazon Location Service for nearest clinics

    return response(200, { clinics: [] }); // placeholder
  } catch (err) {
    console.error('clinics_request_error', { requestId: context.awsRequestId, code: err.name });
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
