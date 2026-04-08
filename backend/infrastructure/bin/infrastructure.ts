#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { UmNyangoStack } from '../lib/umnyango-stack';

const app = new cdk.App();

new UmNyangoStack(app, 'UmNyangoStack', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION ?? 'us-east-1',
  },
  description: 'UmNyango — privacy-first voice health triage (hackathon)',
});
