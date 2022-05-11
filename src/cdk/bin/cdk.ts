#!/usr/bin/env node
import cdk = require('aws-cdk-lib');
import { EcsMoodleStack } from '../lib/ecs-moodle-stack';
import { AwsSolutionsChecks } from 'cdk-nag';

const app = new cdk.App();
new EcsMoodleStack(app, 'ecs-moodle-stack', {
  albCertificateArn: app.node.tryGetContext('app-config/albCertificateArn'),
  cfCertificateArn: app.node.tryGetContext('app-config/cfCertificateArn'),
  cfDomain: app.node.tryGetContext('app-config/cfDomain'),
  moodleImageUri: app.node.tryGetContext('app-config/moodleImageUri'),
  serviceReplicaDesiredCount: app.node.tryGetContext('app-config/serviceReplicaDesiredCount'),
  serviceHealthCheckGracePeriodSeconds: app.node.tryGetContext('app-config/serviceHealthCheckGracePeriodSeconds'),
  cfDistributionOriginTimeoutSeconds: app.node.tryGetContext('app-config/cfDistributionOriginTimeoutSeconds')
});

cdk.Aspects.of(app).add(new AwsSolutionsChecks({ verbose: true }));