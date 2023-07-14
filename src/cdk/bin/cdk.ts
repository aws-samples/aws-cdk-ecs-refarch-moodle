#!/usr/bin/env node
import cdk = require('aws-cdk-lib');
import { EcsMoodleStack } from '../lib/ecs-moodle-stack';
import { CloudFrontWAFWebAclStack } from '../lib/cloudfront-waf-web-acl-stack';

const app = new cdk.App();

const cloudFrontWAFWebAclStack = new CloudFrontWAFWebAclStack(app, 'cloudfront-waf-web-acl-stack', {
  env: {
    region: 'us-east-1'
  }
});

const ecsMoodleStack = new EcsMoodleStack(app, 'ecs-moodle-stack', {
  albCertificateArn: app.node.tryGetContext('app-config/albCertificateArn'),
  cfCertificateArn: app.node.tryGetContext('app-config/cfCertificateArn'),
  cfDomain: app.node.tryGetContext('app-config/cfDomain'),
  moodleImageUri: app.node.tryGetContext('app-config/moodleImageUri'),
  serviceReplicaDesiredCount: app.node.tryGetContext('app-config/serviceReplicaDesiredCount'),
  serviceHealthCheckGracePeriodSeconds: app.node.tryGetContext('app-config/serviceHealthCheckGracePeriodSeconds'),
  cfDistributionOriginTimeoutSeconds: app.node.tryGetContext('app-config/cfDistributionOriginTimeoutSeconds'),
  rdsEventSubscriptionEmailAddress: app.node.tryGetContext('app-config/rdsEventSubscriptionEmailAddress'),
  rdsInstanceType: app.node.tryGetContext('app-config/rdsInstanceType'),
  elastiCacheRedisInstanceType: app.node.tryGetContext('app-config/elastiCacheRedisInstanceType')
});
ecsMoodleStack.addDependency(cloudFrontWAFWebAclStack);