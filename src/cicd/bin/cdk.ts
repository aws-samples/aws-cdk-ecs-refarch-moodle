#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { CICDStack } from '../lib/ecs-moodle-cicd-stack';

const app = new cdk.App();
new CICDStack(app, 'ecs-moodle-cicd-stack', {
  EcsClusterName: 'moodle-ecs-cluster',
  EcsVpcId: 'vpc-0a4345bbf75052b68',
  MoodleServiceName: 'ecs-moodle-stack-moodleserviceService319611B4-fPpvC93CxuED',
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION
  }
});