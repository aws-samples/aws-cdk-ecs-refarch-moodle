#!/usr/bin/env node
import cdk = require('aws-cdk-lib');
import { EcsMoodleStack } from '../lib/ecs-moodle-stack';

const app = new cdk.App();
new EcsMoodleStack(app, 'ecs-moodle-stack', {
  AlbCertificateArn: 'arn:aws:acm:ap-southeast-1:608092540606:certificate/f01bb055-1358-4d73-93ca-8735c114c93b',
  CFCertificateArn: 'arn:aws:acm:us-east-1:608092540606:certificate/fb6a6a70-357d-41eb-b1ac-92c6c4300cfe',
  CFDomain: 'swift-ecs-moodle.awsome.my.id',
  MoodleImageUri: '608092540606.dkr.ecr.ap-southeast-1.amazonaws.com/moodle-image:latest'
});