import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { CacheConstruct } from './constructs/cache-construct';
import { CloudFrontConstruct } from './constructs/cloudfront-construct';
import { ComputeConstruct } from './constructs/compute-construct';
import { DatabaseConstruct } from './constructs/database-construct';
import { DnsConstruct } from './constructs/dns-construct';
import { LoadBalancerConstruct } from './constructs/load-balancer-construct';
import { NetworkConstruct } from './constructs/network-construct';
import { StorageConstruct } from './constructs/storage-construct';

export interface EcsMoodleStackProps extends cdk.StackProps {
  enableCloudFront: boolean;
  useExistingAlbCertificate: boolean;
  hostedZoneId: string;
  albCertificateArn: string;
  cfCertificateArn?: string;
  domain: string;
  cfWafArn?: string;
  moodleImageUri: string;
  containerPlatform: string;
  serviceReplicaDesiredCount: number;
  serviceHealthCheckGracePeriodSeconds: number;
  cfDistributionOriginTimeoutSeconds: number;
  rdsEventSubscriptionEmailAddress: string;
  rdsEngine: string;
  rdsEngineVersion: string;
  rdsInstanceType: string;
  auroraServerlessMinCapacity?: number;
  auroraServerlessMaxCapacity?: number;
  cacheEngine: 'redis' | 'valkey';
  cacheDeploymentMode: 'provisioned' | 'serverless';
  cacheServerlessMaxStorageGB: number;
  cacheServerlessMaxCapacity: number;
  cacheServerlessMinCapacity: number;
  cacheProvisionedInstanceType: string;
}

export class EcsMoodleStack extends cdk.Stack {
  public readonly distributionArn?: string;

  constructor(scope: cdk.App, id: string, props: EcsMoodleStackProps) {
    super(scope, id, props);

    // 1. Network Infrastructure
    const network = new NetworkConstruct(this, 'Network');

    // 2. Database
    const database = new DatabaseConstruct(this, 'Database', {
      vpc: network.vpc,
      rdsEngine: props.rdsEngine,
      rdsEngineVersion: props.rdsEngineVersion,
      rdsInstanceType: props.rdsInstanceType,
      auroraServerlessMinCapacity: props.auroraServerlessMinCapacity,
      auroraServerlessMaxCapacity: props.auroraServerlessMaxCapacity,
      rdsEventSubscriptionEmailAddress: props.rdsEventSubscriptionEmailAddress
    });

    // 3. Cache
    const cache = new CacheConstruct(this, 'Cache', {
      vpc: network.vpc,
      cacheEngine: props.cacheEngine,
      cacheDeploymentMode: props.cacheDeploymentMode,
      cacheServerlessMaxStorageGB: props.cacheServerlessMaxStorageGB,
      cacheServerlessMaxCapacity: props.cacheServerlessMaxCapacity,
      cacheServerlessMinCapacity: props.cacheServerlessMinCapacity,
      cacheProvisionedInstanceType: props.cacheProvisionedInstanceType
    });

    // 4. Storage
    const storage = new StorageConstruct(this, 'Storage', {
      vpc: network.vpc
    });

    // 5. Compute
    const compute = new ComputeConstruct(this, 'Compute', {
      vpc: network.vpc,
      database: database.database,
      fileSystem: storage.fileSystem,
      accessPoint: storage.accessPoint,
      cacheSecurityGroup: cache.securityGroup,
      containerPlatform: props.containerPlatform,
      serviceReplicaDesiredCount: props.serviceReplicaDesiredCount,
      serviceHealthCheckGracePeriodSeconds: props.serviceHealthCheckGracePeriodSeconds,
      rdsEngine: props.rdsEngine,
      databaseName: database.databaseName,
      databaseUsername: database.databaseUsername,
      domain: props.domain,
      moodleImageUri: props.moodleImageUri
    });

    // Generate CloudFront custom header secret if CloudFront is enabled
    let cfCustomHeaderSecret: secretsmanager.Secret | undefined;
    if (props.enableCloudFront) {
      cfCustomHeaderSecret = new secretsmanager.Secret(this, 'cf-custom-header-secret', {
        generateSecretString: {
          excludePunctuation: true,
          passwordLength: 32
        }
      });
    }

    // 6. Load Balancer
    const loadBalancer = new LoadBalancerConstruct(this, 'LoadBalancer', {
      vpc: network.vpc,
      service: compute.service,
      enableCloudFront: props.enableCloudFront,
      useExistingAlbCertificate: props.useExistingAlbCertificate,
      albCertificateArn: props.albCertificateArn,
      hostedZoneId: props.hostedZoneId,
      domain: props.domain,
      cfCustomHeaderSecret
    });

    // 7. CloudFront (optional)
    let cloudFront: CloudFrontConstruct | undefined;
    if (props.enableCloudFront && cfCustomHeaderSecret && props.cfCertificateArn && props.cfWafArn) {
      cloudFront = new CloudFrontConstruct(this, 'CloudFront', {
        loadBalancer: loadBalancer.loadBalancer,
        cfCustomHeaderSecret,
        cfCertificateArn: props.cfCertificateArn,
        cfWafArn: props.cfWafArn,
        domain: props.domain,
        cfDistributionOriginTimeoutSeconds: props.cfDistributionOriginTimeoutSeconds
      });

      this.distributionArn = cloudFront.distribution.distributionArn;
    }

    // 8. DNS (only if not using existing certificates)
    if (!props.useExistingAlbCertificate) {
      new DnsConstruct(this, 'DNS', {
        hostedZoneId: props.hostedZoneId,
        domain: props.domain,
        enableCloudFront: props.enableCloudFront,
        distribution: cloudFront?.distribution,
        loadBalancer: loadBalancer.loadBalancer
      });
    }

    // Outputs
    this.createOutputs(props, loadBalancer, cloudFront, compute, cache);
  }

  private createOutputs(
    props: EcsMoodleStackProps,
    loadBalancer: LoadBalancerConstruct,
    cloudFront: CloudFrontConstruct | undefined,
    compute: ComputeConstruct,
    cache: CacheConstruct
  ): void {
    new cdk.CfnOutput(this, 'APPLICATION-LOAD-BALANCER-DNS-NAME', {
      value: loadBalancer.loadBalancer.loadBalancerDnsName
    });
    
    if (props.enableCloudFront && cloudFront) {
      new cdk.CfnOutput(this, 'CLOUDFRONT-DNS-NAME', {
        value: (!props.useExistingAlbCertificate) ? props.domain : cloudFront.distribution.distributionDomainName
      });
      new cdk.CfnOutput(this, 'MOODLE-CLOUDFRONT-DIST-ID', {
        value: cloudFront.distribution.distributionId
      });
    } else {
      new cdk.CfnOutput(this, 'MOODLE-DNS-NAME', {
        value: (!props.useExistingAlbCertificate) ? props.domain : loadBalancer.loadBalancer.loadBalancerDnsName
      });
    }
    
    new cdk.CfnOutput(this, 'MOODLE-USERNAME', {
      value: 'moodleadmin'
    });
    new cdk.CfnOutput(this, 'MOODLE-PASSWORD-SECRET-ARN', {
      value: compute.moodlePasswordSecret.secretArn
    });
    new cdk.CfnOutput(this, 'MOODLE-CACHE-ENDPOINT-ADDRESS-AND-PORT', {
      value: cache.endpoint
    });
    new cdk.CfnOutput(this, 'ECS-CLUSTER-NAME', {
      value: compute.cluster.clusterName
    });
    new cdk.CfnOutput(this, 'ECS-VPC-ID', {
      value: compute.cluster.vpc.vpcId
    });
    new cdk.CfnOutput(this, 'MOODLE-SERVICE-NAME', {
      value: compute.service.serviceName
    });
  }
}