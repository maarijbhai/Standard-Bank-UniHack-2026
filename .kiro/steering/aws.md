# AWS Development Rules for UmNyango

These rules are mandatory for all AWS-related code in this project. No exceptions.

## 1. AWS SDK Version

Always use AWS SDK v3 with modular imports. Never use v2 (`aws-sdk`).

```ts
// correct
import { BedrockRuntimeClient, InvokeModelCommand } from "@aws-sdk/client-bedrock-runtime";
import { PollyClient, SynthesizeSpeechCommand } from "@aws-sdk/client-polly";
import { DynamoDBDocumentClient, PutCommand } from "@aws-sdk/lib-dynamodb";

// wrong — never do this
import AWS from "aws-sdk";
```

## 2. Lambda Runtime

All Lambda functions must use Node.js 20.x with ESM format.

- `"type": "module"` in package.json, or use `.mjs` file extension
- Handler exports must use ESM `export const handler = async (event) => {}`
- No CommonJS `require()` or `module.exports`

## 3. CloudWatch Logging Ban (Privacy)

Lambda functions MUST NOT log any of the following to CloudWatch:

- User input text or transcribed speech
- Raw or parsed Bedrock responses
- Any data that could identify a user

Permitted logging: operational metadata only (e.g., request IDs, latency, error codes — never error message bodies that may echo user input).

```ts
// wrong
console.log("User said:", event.body.text);
console.log("Bedrock response:", bedrockResult);

// correct
console.log("triage_request_received", { requestId: context.awsRequestId });
```

## 4. Bedrock Model

- Model ID: `anthropic.claude-sonnet-4-5`
- Region: `us-east-1`
- Read model ID from the `BEDROCK_MODEL_ID` environment variable — never hardcode it

```ts
const modelId = process.env.BEDROCK_MODEL_ID; // "anthropic.claude-sonnet-4-5"
```

## 5. No Direct AWS Calls from the Frontend

The React PWA must never import or call any AWS SDK directly. All AWS interactions (Bedrock, Polly, DynamoDB, Location Service) must go through API Gateway → Lambda.

```ts
// wrong — never in frontend code
import { BedrockRuntimeClient } from "@aws-sdk/client-bedrock-runtime";

// correct — frontend only calls the API Gateway URL
const res = await fetch(`${import.meta.env.VITE_API_URL}/triage`, { method: "POST", body: JSON.stringify({ text }) });
```
