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
  rdsEngine: app.node.tryGetContext('app-config/rdsEngine'),
  rdsEngineVersion: app.node.tryGetContext('app-config/rdsEngineVersion'),
  rdsInstanceType: app.node.tryGetContext('app-config/rdsInstanceType'),
  auroraServerlessMinCapacity: app.node.tryGetContext('app-config/auroraServerlessMinCapacity'),
  auroraServerlessMaxCapacity: app.node.tryGetContext('app-config/auroraServerlessMaxCapacity'),
  cacheEngine: app.node.tryGetContext('app-config/cacheEngine'),
  cacheDeploymentMode: app.node.tryGetContext('app-config/cacheDeploymentMode'),
  cacheServerlessMaxStorageGB: app.node.tryGetContext('app-config/cacheServerlessMaxStorageGB'),
  cacheServerlessMaxCapacity: app.node.tryGetContext('app-config/cacheServerlessMaxCapacity'),
  cacheServerlessMinCapacity: app.node.tryGetContext('app-config/cacheServerlessMinCapacity'),
  cacheProvisionedInstanceType: app.node.tryGetContext('app-config/cacheProvisionedInstanceType')
});
ecsMoodleStack.addDependency(cloudFrontWAFWebAclStack);