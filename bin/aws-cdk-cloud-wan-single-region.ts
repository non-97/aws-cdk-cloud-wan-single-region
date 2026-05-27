#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib/core';
import { AwsCdkCloudWanSingleRegionStack } from '../lib/aws-cdk-cloud-wan-single-region-stack';

const app = new cdk.App();
new AwsCdkCloudWanSingleRegionStack(app, 'AwsCdkCloudWanSingleRegionStack', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: 'ap-northeast-1',
  },
});
