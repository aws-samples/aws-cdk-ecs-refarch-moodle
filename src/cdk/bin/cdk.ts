#!/usr/bin/env node
import cdk = require('aws-cdk-lib');
import { EcsMoodleStack } from '../lib/ecs-moodle-stack';
import { CloudFrontWAFWebAclStack } from '../lib/cloudfront-waf-web-acl-stack';

const app = new cdk.App();

new CloudFrontWAFWebAclStack(app, 'cloudfront-waf-web-acl-stack', {
  env: {
    region: 'us-east-1'
  }
});

new EcsMoodleStack(app, 'ecs-moodle-stack', {
  albCertificateArn: app.node.tryGetContext('app-config/albCertificateArn'),
  cfCertificateArn: app.node.tryGetContext('app-config/cfCertificateArn'),
  cfDomain: app.node.tryGetContext('app-config/cfDomain'),
  moodleImageUri: app.node.tryGetContext('app-config/moodleImageUri'),
  serviceReplicaDesiredCount: app.node.tryGetContext('app-config/serviceReplicaDesiredCount'),
  serviceHealthCheckGracePeriodSeconds: app.node.tryGetContext('app-config/serviceHealthCheckGracePeriodSeconds'),
  cfDistributionOriginTimeoutSeconds: app.node.tryGetContext('app-config/cfDistributionOriginTimeoutSeconds'),
  rdsEventSubscriptionEmailAddress: app.node.tryGetContext('app-config/rdsEventSubscriptionEmailAddress')
});