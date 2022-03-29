#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { CICDStack } from '../lib/ecs-moodle-cicd-stack';

const app = new cdk.App();
new CICDStack(app, 'ecs-moodle-cicd-stack', {
  EcsClusterName: '',
  EcsVpcId: '',
  MoodleServiceName: '',
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION
  }
});