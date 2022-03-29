#!/usr/bin/env node
import cdk = require('aws-cdk-lib');
import { EcsMoodleStack } from '../lib/ecs-moodle-stack';

const app = new cdk.App();
new EcsMoodleStack(app, 'ecs-moodle-stack', {
  AlbCertificateArn: '',
  CFCertificateArn: '',
  CFDomain: '',
  MoodleImageUri: ''
});