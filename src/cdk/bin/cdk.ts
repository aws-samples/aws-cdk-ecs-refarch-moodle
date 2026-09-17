#!/usr/bin/env node
import cdk = require('aws-cdk-lib');
import { EcsMoodleStack } from '../lib/ecs-moodle-stack';
import { CloudFrontInfraStack } from '../lib/cloudfront-infra-stack';
import { CloudFrontLoggingStack } from '../lib/cloudfront-logging-stack';

const app = new cdk.App();

const domain = app.node.tryGetContext('app-config/domain');
const hostedZoneId = app.node.tryGetContext('app-config/hostedZoneId');

// Coerce a context value to a boolean. CDK context from a JSON file arrives as a
// real boolean, but values passed via `--context key=value` on the CLI arrive as
// strings, so "false" must not be treated as truthy.
function contextBoolean(value: unknown, defaultValue: boolean): boolean {
  if (value === undefined || value === null || value === '') {
    return defaultValue;
  }
  if (typeof value === 'boolean') {
    return value;
  }
  const normalized = String(value).trim().toLowerCase();
  if (normalized === 'true') {
    return true;
  }
  if (normalized === 'false') {
    return false;
  }
  throw new Error(`Expected a boolean value but received: ${String(value)}`);
}

// ALB scheme: controls whether the ALB is internal or internet-facing.
const albScheme = app.node.tryGetContext('app-config/albScheme');
// Whether the ALB is hardened as a CloudFront origin (custom-header rule, 403
// default action, restricted ingress via the CloudFront prefix list) and owns
// the origin-verification secret.
const albCloudFrontOrigin = contextBoolean(app.node.tryGetContext('app-config/albCloudFrontOrigin'), true);
// Whether THIS stack builds the CloudFront distribution (plus its cert/WAF infra
// and logging). When false, a separate stack is expected to own the distribution.
const deployCloudFront = contextBoolean(app.node.tryGetContext('app-config/deployCloudFront'), true);
let cfCertificateArn = app.node.tryGetContext('app-config/cfCertificateArn');
let albCertificateArn = app.node.tryGetContext('app-config/albCertificateArn')

// Validate required configuration
if (!domain) {
  throw new Error('domain must be set in the CDK context');
}

// Validate ALB scheme configuration
if (albScheme !== 'internal' && albScheme !== 'internet-facing') {
  throw new Error("app-config/albScheme must be set to either 'internal' or 'internet-facing'");
}
const albInternetFacing = albScheme === 'internet-facing';

// This stack can only build a CloudFront distribution when the ALB is a
// CloudFront origin (hardened) and internal (reachable only via the VPC origin).
if (deployCloudFront && !albCloudFrontOrigin) {
  throw new Error(
    "app-config/deployCloudFront cannot be true when app-config/albCloudFrontOrigin is false; " +
    "a CloudFront distribution requires the ALB to be configured as a CloudFront origin"
  );
}
if (deployCloudFront && albInternetFacing) {
  throw new Error(
    "app-config/albScheme cannot be 'internet-facing' when app-config/deployCloudFront is true; " +
    "a CloudFront-fronted ALB must be 'internal'"
  );
}

// A hardened CloudFront origin must be internal so it is only reachable via the
// CloudFront VPC origin. A public (internet-facing) CloudFront origin is not
// supported.
if (albCloudFrontOrigin && albInternetFacing) {
  throw new Error(
    "app-config/albScheme cannot be 'internet-facing' when app-config/albCloudFrontOrigin is true; " +
    "a CloudFront origin ALB must be 'internal'"
  );
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

if (deployCloudFront) {
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
  crossRegionReferences: deployCloudFront,
  deployCloudFront: deployCloudFront,
  albCloudFrontOrigin: albCloudFrontOrigin,
  albInternetFacing: albInternetFacing,
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

// Create logging stack in us-east-1 with distribution ARN (only if this stack deploys CloudFront)
if (deployCloudFront) {
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
    const domainPattern = /^(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)(?:\.(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?))+$/;
    if (!domainPattern.test(domain)) {
      throw new Error(`Invalid domain format: ${domain}`);
    }
    
    return false; // Create new certificate
  }
}
