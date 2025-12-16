import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as elasticache from 'aws-cdk-lib/aws-elasticache';
import { Construct } from 'constructs';

export interface CacheConstructProps {
  vpc: ec2.IVpc;
  cacheEngine: 'redis' | 'valkey';
  cacheDeploymentMode: 'provisioned' | 'serverless';
  cacheServerlessMaxStorageGB?: number;
  cacheServerlessMaxCapacity?: number;
  cacheServerlessMinCapacity?: number;
  cacheProvisionedInstanceType?: string;
}

export class CacheConstruct extends Construct {
  public readonly securityGroup: ec2.SecurityGroup;
  public readonly endpoint: string;

  constructor(scope: Construct, id: string, props: CacheConstructProps) {
    super(scope, id);

    // Validate inputs
    this.validateCacheConfiguration(props);

    // Set defaults
    const cacheServerlessMaxStorageGB = props.cacheServerlessMaxStorageGB || 100;
    const cacheServerlessMaxCapacity = props.cacheServerlessMaxCapacity || 100;
    const cacheServerlessMinCapacity = props.cacheServerlessMinCapacity || 1;

    // Security Group
    this.securityGroup = new ec2.SecurityGroup(this, 'cache-sg', {
      vpc: props.vpc,
      description: `Security group for ${props.cacheEngine.toUpperCase()} cache`
    });

    // Subnet Group
    const cacheSubnetGroup = new elasticache.CfnSubnetGroup(this, 'cache-subnet-group', {
      cacheSubnetGroupName: `${cdk.Names.uniqueId(this)}-cache-subnet-group`,
      description: `${props.cacheEngine.toUpperCase()} Subnet Group`,
      subnetIds: props.vpc.selectSubnets({ subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS }).subnetIds
    });

    // Create cache based on deployment mode
    if (props.cacheDeploymentMode === 'serverless') {
      this.endpoint = this.createServerlessCache(
        props.cacheEngine,
        cacheServerlessMaxStorageGB,
        cacheServerlessMaxCapacity,
        cacheServerlessMinCapacity,
        props.vpc
      );
    } else {
      this.endpoint = this.createProvisionedCache(
        props.cacheEngine,
        props.cacheProvisionedInstanceType!,
        cacheSubnetGroup
      );
    }
  }

  private validateCacheConfiguration(props: CacheConstructProps): void {
    // Validate cache engine
    if (!['redis', 'valkey'].includes(props.cacheEngine)) {
      throw new Error('cacheEngine must be either "redis" or "valkey"');
    }

    // Validate cache deployment mode
    if (!['provisioned', 'serverless'].includes(props.cacheDeploymentMode)) {
      throw new Error('cacheDeploymentMode must be either "provisioned" or "serverless"');
    }

    // Validate cache instance type if using provisioned mode
    if (props.cacheDeploymentMode === 'provisioned') {
      if (!props.cacheProvisionedInstanceType) {
        throw new Error('cacheProvisionedInstanceType is required when using provisioned deployment mode');
      }

      const validCacheInstancePattern = /^cache\.(t2|t3|t4g|m4|m5|m6g|m7g|r4|r5|r6g|r7g)\.(micro|small|medium|large|xlarge|2xlarge|4xlarge|10xlarge|12xlarge|16xlarge|24xlarge)$/;
      if (!validCacheInstancePattern.test(props.cacheProvisionedInstanceType)) {
        throw new Error(`Invalid cacheProvisionedInstanceType "${props.cacheProvisionedInstanceType}". Must be a valid ElastiCache instance type (e.g., cache.t3.micro, cache.m5.large)`);
      }
    }
  }

  private createServerlessCache(
    cacheEngine: string,
    maxStorageGB: number,
    maxCapacity: number,
    minCapacity: number,
    vpc: ec2.IVpc
  ): string {
    const serverlessCache = new elasticache.CfnServerlessCache(this, 'serverless-cache', {
      serverlessCacheName: `${cacheEngine}-serverless`,
      engine: cacheEngine,
      majorEngineVersion: cacheEngine === 'redis' ? '7' : '8',
      cacheUsageLimits: {
        dataStorage: {
          maximum: maxStorageGB,
          unit: 'GB'
        },
        ecpuPerSecond: {
          maximum: maxCapacity * 1000,
          minimum: minCapacity * 1000
        }
      },
      subnetIds: vpc.selectSubnets({ subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS }).subnetIds,
      securityGroupIds: [this.securityGroup.securityGroupId]
    });

    return `${serverlessCache.attrEndpointAddress}:${serverlessCache.attrEndpointPort}`;
  }

  private createProvisionedCache(
    cacheEngine: string,
    instanceType: string,
    subnetGroup: elasticache.CfnSubnetGroup
  ): string {
    const provisionedCache = new elasticache.CfnReplicationGroup(this, 'provisioned-cache', {
      replicationGroupDescription: `${cacheEngine.toUpperCase()} Replication Group`,
      cacheNodeType: instanceType,
      engine: cacheEngine,
      numCacheClusters: 2,
      multiAzEnabled: true,
      automaticFailoverEnabled: true,
      autoMinorVersionUpgrade: true,
      cacheSubnetGroupName: subnetGroup.cacheSubnetGroupName!,
      securityGroupIds: [this.securityGroup.securityGroupId],
      transitEncryptionEnabled: true,
      atRestEncryptionEnabled: true
    });

    provisionedCache.addDependency(subnetGroup);

    return `${provisionedCache.attrPrimaryEndPointAddress}:${provisionedCache.attrPrimaryEndPointPort}`;
  }
}