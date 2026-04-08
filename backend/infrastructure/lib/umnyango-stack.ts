import * as path from 'path';
import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambdaNodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2';
import * as apigwv2integrations from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as location from 'aws-cdk-lib/aws-location';

export class UmNyangoStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // -------------------------------------------------------------------------
    // 1. DynamoDB — sessions table
    // -------------------------------------------------------------------------
    const sessionsTable = new dynamodb.Table(this, 'SessionsTable', {
      tableName: 'umnyango-sessions',
      partitionKey: { name: 'sessionPin', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: 'expiresAt',
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // -------------------------------------------------------------------------
    // 1b. Amazon Location Service — Place Index for clinic search
    // -------------------------------------------------------------------------
    const placeIndex = new location.CfnPlaceIndex(this, 'PlaceIndex', {
      indexName:    'umnyango-place-index',
      dataSource:   'Esri',
      description:  'UmNyango clinic and facility search',
      pricingPlan:  'RequestBasedUsage',
    });

    // -------------------------------------------------------------------------
    // 2. Shared Lambda defaults
    // -------------------------------------------------------------------------
    const lambdaRoot = path.resolve(__dirname, '../../lambdas');

    // Read model ID from CDK context or fall back to the inference profile ARN.
    // Override at deploy time: cdk deploy --context bedrockModelId=<arn>
    const bedrockModelId: string =
      this.node.tryGetContext('bedrockModelId') ??
      process.env.BEDROCK_MODEL_ID ??
      'arn:aws:bedrock:us-east-1:022499005421:inference-profile/global.anthropic.claude-sonnet-4-6';

    const sharedEnv: Record<string, string> = {
      AWS_NODEJS_CONNECTION_REUSE_ENABLED: '1',
      DYNAMODB_TABLE: sessionsTable.tableName,
      BEDROCK_MODEL_ID: bedrockModelId,
      LOCATION_PLACE_INDEX: placeIndex.indexName,
    };

    const sharedBundling: lambdaNodejs.BundlingOptions = {
      // Lambda ESM — externalise AWS SDK (provided by the runtime)
      externalModules: [
        '@aws-sdk/client-bedrock-runtime',
        '@aws-sdk/client-polly',
        '@aws-sdk/client-dynamodb',
        '@aws-sdk/lib-dynamodb',
        '@aws-sdk/client-location',
        '@aws-sdk/client-transcribe',
        '@aws-sdk/client-transcribe-streaming',
        '@aws-sdk/client-apigatewaymanagementapi',
        '@aws-sdk/client-translate',
        '@aws-sdk/client-comprehend',
      ],
      format: lambdaNodejs.OutputFormat.ESM,
      target: 'node20',
      mainFields: ['module', 'main'],
    };

    // -------------------------------------------------------------------------
    // 3a. Triage Lambda
    // -------------------------------------------------------------------------
    const triageFn = new lambdaNodejs.NodejsFunction(this, 'TriageFunction', {
      functionName: 'umnyango-triage',
      entry: path.join(lambdaRoot, 'triage/index.mjs'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_20_X,
      timeout: cdk.Duration.seconds(30),
      memorySize: 512,
      environment: sharedEnv,
      bundling: sharedBundling,
    });

    // -------------------------------------------------------------------------
    // 3b. Clinics Lambda
    // -------------------------------------------------------------------------
    const clinicsFn = new lambdaNodejs.NodejsFunction(this, 'ClinicsFunction', {
      functionName: 'umnyango-clinics',
      entry: path.join(lambdaRoot, 'clinics/index.mjs'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_20_X,
      timeout: cdk.Duration.seconds(15),
      memorySize: 256,
      environment: sharedEnv,
      bundling: sharedBundling,
    });

    // -------------------------------------------------------------------------
    // 3c. Session Lambda
    // -------------------------------------------------------------------------
    const sessionFn = new lambdaNodejs.NodejsFunction(this, 'SessionFunction', {
      functionName: 'umnyango-session',
      entry: path.join(lambdaRoot, 'session/index.mjs'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_20_X,
      timeout: cdk.Duration.seconds(10),
      memorySize: 256,
      environment: sharedEnv,
      bundling: sharedBundling,
    });

    // -------------------------------------------------------------------------
    // 3d. Translate Lambda
    // -------------------------------------------------------------------------
    const translateFn = new lambdaNodejs.NodejsFunction(this, 'TranslateFunction', {
      functionName: 'umnyango-translate',
      entry: path.join(lambdaRoot, 'translate/index.mjs'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_20_X,
      timeout: cdk.Duration.seconds(15),
      memorySize: 256,
      environment: { AWS_NODEJS_CONNECTION_REUSE_ENABLED: '1' },
      bundling: sharedBundling,
    });

    // -------------------------------------------------------------------------
    // 3e. Transcribe Lambda (WebSocket handler) — MUST bundle streaming clients
    // @aws-sdk/client-transcribe-streaming and @aws-sdk/client-apigatewaymanagementapi
    // are NOT included in the Lambda Node 20 managed runtime, so they must be
    // bundled into the deployment package rather than externalised.
    // -------------------------------------------------------------------------
    const transcribeFn = new lambdaNodejs.NodejsFunction(this, 'TranscribeFunction', {
      functionName: 'umnyango-transcribe',
      entry: path.join(lambdaRoot, 'transcribe/index.mjs'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_20_X,
      timeout: cdk.Duration.seconds(60), // needs time to stream PCM at real-time pace
      memorySize: 512,
      environment: { AWS_NODEJS_CONNECTION_REUSE_ENABLED: '1' },
      bundling: {
        // Bundle streaming SDK inline (not in Lambda runtime).
        // DynamoDB clients ARE in the Node 20 runtime — mark as external.
        externalModules: [
          '@aws-sdk/client-dynamodb',
          '@aws-sdk/lib-dynamodb',
        ],
        format: lambdaNodejs.OutputFormat.ESM,
        target: 'node20',
        mainFields: ['module', 'main'],
      },
    });

    // -------------------------------------------------------------------------
    // 4. IAM permissions
    // -------------------------------------------------------------------------

    // Comprehend — language detection
    triageFn.addToRolePolicy(new iam.PolicyStatement({
      sid: 'ComprehendDetect',
      effect: iam.Effect.ALLOW,
      actions: ['comprehend:DetectDominantLanguage'],
      resources: ['*'],
    }));

    // Bedrock — invoke the configured model (foundation model or inference profile)
    // The inference profile ARN also requires bedrock:GetInferenceProfile
    triageFn.addToRolePolicy(new iam.PolicyStatement({
      sid: 'BedrockInvokeModel',
      effect: iam.Effect.ALLOW,
      actions: [
        'bedrock:InvokeModel',
        'bedrock:InvokeModelWithResponseStream',
        'bedrock:GetInferenceProfile',
        'bedrock:ListInferenceProfiles',
      ],
      resources: [
        bedrockModelId,
        // Also allow the underlying foundation model the profile routes to
        `arn:aws:bedrock:*::foundation-model/anthropic.claude-sonnet-4-5`,
        `arn:aws:bedrock:*::foundation-model/anthropic.claude-sonnet-4-6`,
      ],
    }));

    // Polly — synthesise speech
    triageFn.addToRolePolicy(new iam.PolicyStatement({
      sid: 'PollySynthesise',
      effect: iam.Effect.ALLOW,
      actions: ['polly:SynthesizeSpeech'],
      resources: ['*'],
    }));

    // Transcribe — async transcription jobs (future use)
    triageFn.addToRolePolicy(new iam.PolicyStatement({
      sid: 'TranscribeJobs',
      effect: iam.Effect.ALLOW,
      actions: [
        'transcribe:StartTranscriptionJob',
        'transcribe:GetTranscriptionJob',
      ],
      resources: ['*'],
    }));

    // Translate — multilingual support (future use)
    triageFn.addToRolePolicy(new iam.PolicyStatement({
      sid: 'TranslateText',
      effect: iam.Effect.ALLOW,
      actions: ['translate:TranslateText'],
      resources: ['*'],
    }));

    // DynamoDB — triage Lambda reads/writes sessions (e.g. to persist condition category)
    sessionsTable.grantReadWriteData(triageFn);

    // DynamoDB — session Lambda creates session records
    sessionsTable.grantReadWriteData(sessionFn);

    // DynamoDB — clinics Lambda reads only (future clinic table)
    sessionsTable.grantReadData(clinicsFn);

    // Location Service — clinics Lambda searches the place index
    clinicsFn.addToRolePolicy(new iam.PolicyStatement({
      sid: 'LocationSearch',
      effect: iam.Effect.ALLOW,
      actions: ['geo:SearchPlaceIndexForText', 'geo:SearchPlaceIndexForPosition'],
      resources: [`arn:aws:geo:${this.region}:${this.account}:place-index/${placeIndex.indexName}`],
    }));

    // Translate Lambda — Amazon Translate + Polly + Comprehend (for auto source detection)
    translateFn.addToRolePolicy(new iam.PolicyStatement({
      sid: 'TranslateLambdaPerms',
      effect: iam.Effect.ALLOW,
      actions: [
        'translate:TranslateText',
        'polly:SynthesizeSpeech',
        'comprehend:DetectDominantLanguage',
      ],
      resources: ['*'],
    }));

    // Transcribe Lambda — Transcribe Streaming + manage WebSocket connections
    transcribeFn.addToRolePolicy(new iam.PolicyStatement({
      sid: 'TranscribeStreamingPerms',
      effect: iam.Effect.ALLOW,
      actions: ['transcribe:StartStreamTranscription'],
      resources: ['*'],
    }));

    // Transcribe Lambda needs DynamoDB to store audio chunks between WS messages
    sessionsTable.grantReadWriteData(transcribeFn);
    transcribeFn.addEnvironment('DYNAMODB_TABLE', sessionsTable.tableName);

    // -------------------------------------------------------------------------
    // 5. WebSocket API (for real-time Transcribe streaming)
    // -------------------------------------------------------------------------
    const wsApi = new apigwv2.WebSocketApi(this, 'TranscribeWsApi', {
      apiName: 'umnyango-transcribe-ws',
      connectRouteOptions: {
        integration: new apigwv2integrations.WebSocketLambdaIntegration('WsConnect', transcribeFn),
      },
      disconnectRouteOptions: {
        integration: new apigwv2integrations.WebSocketLambdaIntegration('WsDisconnect', transcribeFn),
      },
    });

    // Custom route: action = "transcribe"
    wsApi.addRoute('transcribe', {
      integration: new apigwv2integrations.WebSocketLambdaIntegration('WsTranscribe', transcribeFn),
    });

    const wsStage = new apigwv2.WebSocketStage(this, 'TranscribeWsStage', {
      webSocketApi: wsApi,
      stageName:    'prod',
      autoDeploy:   true,
    });

    // Grant transcribe Lambda permission to post back to WebSocket connections
    transcribeFn.addToRolePolicy(new iam.PolicyStatement({
      sid: 'ApiGwManageConnections',
      effect: iam.Effect.ALLOW,
      actions: ['execute-api:ManageConnections'],
      resources: [`arn:aws:execute-api:${this.region}:${this.account}:${wsApi.apiId}/${wsStage.stageName}/POST/@connections/*`],
    }));

    // -------------------------------------------------------------------------
    // 5. API Gateway REST API
    // -------------------------------------------------------------------------
    const api = new apigateway.RestApi(this, 'UmNyangoApi', {
      restApiName: 'umnyango-api',
      description: 'UmNyango voice triage API',
      deployOptions: {
        stageName: 'prod',
      },
      defaultCorsPreflightOptions: {
        allowOrigins: apigateway.Cors.ALL_ORIGINS,
        allowMethods: apigateway.Cors.ALL_METHODS,
        allowHeaders: [
          'Content-Type',
          'Authorization',
          'X-Amz-Date',
          'X-Api-Key',
          'X-Amz-Security-Token',
        ],
      },
    });

    // POST /triage
    const triageResource = api.root.addResource('triage');
    triageResource.addMethod(
      'POST',
      new apigateway.LambdaIntegration(triageFn, { proxy: true }),
    );

    // POST /session
    const sessionResource = api.root.addResource('session');
    sessionResource.addMethod(
      'POST',
      new apigateway.LambdaIntegration(sessionFn, { proxy: true }),
    );

    // GET /clinics
    const clinicsResource = api.root.addResource('clinics');
    clinicsResource.addMethod(
      'GET',
      new apigateway.LambdaIntegration(clinicsFn, { proxy: true }),
    );

    // POST /translate
    const translateResource = api.root.addResource('translate');
    translateResource.addMethod(
      'POST',
      new apigateway.LambdaIntegration(translateFn, { proxy: true }),
    );

    // -------------------------------------------------------------------------
    // 6. Outputs
    // -------------------------------------------------------------------------
    new cdk.CfnOutput(this, 'ApiGatewayUrl', {
      description: 'API Gateway base URL — set this as VITE_API_URL in frontend/.env',
      value: api.url,
      exportName: 'UmNyangoApiUrl',
    });

    new cdk.CfnOutput(this, 'SessionsTableName', {
      description: 'DynamoDB sessions table name',
      value: sessionsTable.tableName,
    });

    new cdk.CfnOutput(this, 'TranscribeWsUrl', {
      description: 'WebSocket URL for Transcribe streaming — set as VITE_TRANSCRIBE_WS_URL in frontend/.env',
      value: wsStage.url,
      exportName: 'UmNyangoTranscribeWsUrl',
    });
  }
}
