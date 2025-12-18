#!/usr/bin/env node
import cdk = require('aws-cdk-lib');
import { EcsMoodleStack } from '../lib/ecs-moodle-stack';
import { CloudFrontInfraStack } from '../lib/cloudfront-infra-stack';
import { CloudFrontLoggingStack } from '../lib/cloudfront-logging-stack';

const app = new cdk.App();

const domain = app.node.tryGetContext('app-config/domain');
const hostedZoneId = app.node.tryGetContext('app-config/hostedZoneId');
const enableCloudFront = app.node.tryGetContext('app-config/enableCloudFront') ?? true;
let cfCertificateArn = app.node.tryGetContext('app-config/cfCertificateArn');
let albCertificateArn = app.node.tryGetContext('app-config/albCertificateArn')

// Validate required configuration
if (!domain) {
  throw new Error('domain must be set in the CDK context');
}

// Derive hostName and domainName from domain
const domainParts = domain.split('.');
const hostName = domainParts[0];
const domainName = domainParts.slice(1).join('.');

const useExistingCfCertificate = validateCertificateConfiguration(
  cfCertificateArn,
  hostedZoneId,
  domain
);

const useExistingAlbCertificate = validateCertificateConfiguration(
  albCertificateArn,
  hostedZoneId,
  domain
);

let cloudFrontInfraStack: CloudFrontInfraStack | undefined;
let cfWafArn: string | undefined;

if (enableCloudFront) {
  cloudFrontInfraStack = new CloudFrontInfraStack(app, 'cloudfront-infra-stack', {
    env: {
      region: 'us-east-1',
      account: process.env.CDK_DEFAULT_ACCOUNT
    },
    useExistingCfCertificate: useExistingCfCertificate,
    domainName: domainName,
    hostName: hostName,
    hostedZoneId: hostedZoneId,
  });

  if (!useExistingCfCertificate) {
    cfCertificateArn = cloudFrontInfraStack.cfCertificate.certificateArn;
  }
  
  cfWafArn = cloudFrontInfraStack.cfWafArn;
}

const ecsMoodleStack = new EcsMoodleStack(app, 'ecs-moodle-stack', {
  env: {
    region: process.env.CDK_DEFAULT_REGION,
    account: process.env.CDK_DEFAULT_ACCOUNT
  },
  crossRegionReferences: enableCloudFront,
  enableCloudFront: enableCloudFront,
  useExistingAlbCertificate: useExistingAlbCertificate,
  hostedZoneId: app.node.tryGetContext('app-config/hostedZoneId'),
  albCertificateArn: albCertificateArn,
  cfCertificateArn: cfCertificateArn,
  domain: domain,
  cfWafArn: cfWafArn,
  moodleImageUri: app.node.tryGetContext('app-config/moodleImageUri'),
  containerPlatform: app.node.tryGetContext('app-config/containerPlatform'),
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
  cacheProvisionedInstanceType: app.node.tryGetContext('app-config/cacheProvisionedInstanceType'),
  cacheServerlessMaxStorageGB: app.node.tryGetContext('app-config/cacheServerlessMaxStorageGB'),
  cacheServerlessMaxCapacity: app.node.tryGetContext('app-config/cacheServerlessMaxCapacity'),
  cacheServerlessMinCapacity: app.node.tryGetContext('app-config/cacheServerlessMinCapacity')
});

if (cloudFrontInfraStack) {
  ecsMoodleStack.addDependency(cloudFrontInfraStack);
}

// Create logging stack in us-east-1 with distribution ARN (only if CloudFront is enabled)
if (enableCloudFront) {
  const cloudFrontLoggingStack = new CloudFrontLoggingStack(app, 'cloudfront-logging-stack', {
    env: {
      region: 'us-east-1',
      account: process.env.CDK_DEFAULT_ACCOUNT
    },
    crossRegionReferences: true,
    distributionArn: ecsMoodleStack.distributionArn!
  });
  cloudFrontLoggingStack.addDependency(ecsMoodleStack);
}


function validateCertificateConfiguration(
  certificateArn: string,
  hostedZoneId: string,
  domain: string
): boolean {
  if (certificateArn && certificateArn !== "") {
    // Validate ACM certificate ARN format
    const acmArnPattern = /^arn:aws:acm:[a-z0-9-]+:\d{12}:certificate\/[a-f0-9-]+$/;
    if (!acmArnPattern.test(certificateArn)) {
      throw new Error(`Invalid ACM certificate ARN format: ${certificateArn}`);
    }
    return true; // Use existing certificate
  } else {
    // Validate hosted zone configuration
    if (!hostedZoneId || hostedZoneId === "") {
      throw new Error('hostedZoneId must be set when certificate ARN is not provided');
    }
    // Validate hosted zone ID format (starts with Z followed by alphanumeric)
    const hostedZonePattern = /^Z[A-Z0-9]+$/;
    if (!hostedZonePattern.test(hostedZoneId)) {
      throw new Error(`Invalid hosted zone ID format: ${hostedZoneId}`);
    }
    
    if (!domain || domain === "") {
      throw new Error('domain must be set when certificate ARN is not provided');
    }
    // Validate domain format (must have at least one dot)
    const domainPattern = /^[a-zA-Z0-9][a-zA-Z0-9-]{0,61}[a-zA-Z0-9]?(\.[a-zA-Z0-9][a-zA-Z0-9-]{0,61}[a-zA-Z0-9]?)+$/;
    if (!domainPattern.test(domain)) {
      throw new Error(`Invalid domain format: ${domain}`);
    }
    
    return false; // Create new certificate
  }
}
