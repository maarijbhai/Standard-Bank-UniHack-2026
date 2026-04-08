UmNyango: Project Specification & Requirements Document
1. Executive Summary & Problem Statement
Accessing public healthcare in South Africa is severely restricted by language barriers, administrative unpredictability, and social stigma. Currently, 84% of patients delay clinic visits due to queue uncertainty. Furthermore, patients with chronic conditions (e.g., HIV/TB) frequently abandon digital health tools because existing systems expose sensitive medical data on shared devices.

The Solution: UmNyango (isiZulu for "health/wellness pathway") is a privacy-first, voice-activated Progressive Web App (PWA) designed for low-end Android devices. It enables marginalized patients to speak their symptoms in their native language and receive immediate, spoken triage advice, local clinic routing, and benefit eligibility—all without typing a single word or exposing personally identifiable information (PII).

2. Technical Architecture & Stack
This project operates on a strictly serverless AWS architecture.

Frontend: React PWA built with Vite and TypeScript. Hosted on Amazon S3 and distributed via Amazon CloudFront.

API Layer: Amazon API Gateway (RESTful) with CORS fully enabled.

Compute: AWS Lambda functions.

Constraint: All Lambdas MUST utilize Node.js 20.x ESM format.

Constraint: All AWS SDK integrations MUST use AWS SDK v3 with modular imports (e.g., @aws-sdk/client-bedrock-runtime).

AI & Machine Learning:

Amazon Bedrock: anthropic.claude-sonnet-4-5 (hosted in us-east-1) for medical triage reasoning.

Amazon Polly: Neural text-to-speech (Voice ID: 'Ayanda' for South African English).

Browser Native (POC Fallback): webkitSpeechRecognition handles speech-to-text on the frontend to accelerate the hackathon demo, passing text to the backend.

Database & Geospatial: * Amazon DynamoDB: On-demand table for session state management.

Amazon Location Service: Esri data provider for spatial queries.

3. Strict Security & Privacy Constraints (Trust-by-Design)
Zero PII Data Vault: The system must NEVER store names, ID numbers, or free-text symptom descriptions.

No Frontend AWS SDK Calls: The React application must NEVER interact directly with Bedrock, Polly, or DynamoDB. All interactions must route through the API Gateway to Lambda.

CloudWatch Logging Ban: Lambda functions MUST NOT console.log() user input text, transcribed speech, or raw Bedrock responses.

Enum-Based Conditions: Any persistent user health data must be stored strictly as generic enumerations (e.g., CHRONIC_HIV, TB_RISK, GENERAL).

Stigma-Safe UI: Responses must use generic phrasing (e.g., "wellness boost" instead of "ARVs") to prevent over-the-shoulder privacy breaches.

4. Functional Requirements
4.1. Voice-Activated Smart Triage (The Core Loop)
Frontend: The PWA features a "Hold to Speak" button. It captures user audio, converts it to text using the browser's native speech recognition, and sends a JSON payload { "text": "spoken string" } to the /triage endpoint.

Backend: The triage Lambda receives the text and invokes Amazon Bedrock.

AI Instructions: Bedrock acts as a South African public healthcare triage assistant. It analyzes the symptoms and outputs a strict JSON response (defined in Section 5).

Audio Synthesis: The Lambda takes the summary from Bedrock's JSON and passes it to Amazon Polly to generate an MP3 audio stream.

Return: The Lambda returns both the structured JSON and the base64-encoded MP3 back to the frontend to be played aloud automatically.

4.2. Geospatial Clinic Routing
The application must map the user's HTML5 Geolocation to the three nearest public health facilities using Amazon Location Service.

Must display the facility type (Emergency Room, CHC, Clinic) and an estimated busyness level.

4.3. Anonymous Session Management
Users authenticate transparently via an auto-generated, anonymous 6-digit PIN.

Sessions are stored in DynamoDB with a Time-To-Live (TTL) of 24 hours.

5. API Contracts & Data Models
5.1. DynamoDB Schema (umnyango-sessions)
Partition Key: sessionPin (String) - e.g., "482019"

Attributes:

conditionCategory (String) - Enum value only.

createdAt (Number) - Unix timestamp.

expiresAt (Number) - Unix timestamp for TTL (created + 24h).

5.2. Bedrock System Prompt Output Schema
The Claude Sonnet model MUST be prompted to return only valid JSON matching this exact structure. No markdown wrapping or conversational filler:

JSON
{
  "urgency": "emergency|urgent|routine",
  "clinic_type": "emergency_room|chc|clinic|pharmacy",
  "summary": "Plain language explanation in 2 sentences max. Grade 6 reading level.",
  "benefits": ["Array of applicable SA programmes e.g., 'Free ARVs', 'SASSA Relief'"],
  "refer_emergency": true|false
}
5.3. API Gateway Endpoints
POST /triage

Request Body: { "text": "I have a severe headache" }

Response Body (200 OK):

JSON
{
  "triage": {
    "urgency": "urgent",
    "clinic_type": "clinic",
    "summary": "You should visit a clinic today for that headache.",
    "benefits": [],
    "refer_emergency": false
  },
  "audio": "base64_encoded_mp3_string",
  "audioFormat": "mp3"
}
6. Kiro Development Directives
When executing tasks against this specification, Kiro must:

Ensure all environment variables (VITE_API_URL, AWS_REGION, DYNAMODB_TABLE, BEDROCK_MODEL_ID) are read from .env files.

Gracefully handle Loading, Success, and Error states in the React UI.

Prioritize the completion of the POST /triage endpoint and the VoiceTriage.tsx frontend component above all other tasks, as this forms the core hackathon proof-of-concept.