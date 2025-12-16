import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as subscriptions from 'aws-cdk-lib/aws-sns-subscriptions';
import { Construct } from 'constructs';

export interface DatabaseConstructProps {
  vpc: ec2.IVpc;
  rdsEngine: string;
  rdsEngineVersion?: string;
  rdsInstanceType: string;
  auroraServerlessMinCapacity?: number;
  auroraServerlessMaxCapacity?: number;
  rdsEventSubscriptionEmailAddress: string;
  databaseName?: string;
  databaseUsername?: string;
}

export class DatabaseConstruct extends Construct {
  public readonly database: rds.DatabaseInstance | rds.DatabaseCluster;
  public readonly databaseName: string;
  public readonly databaseUsername: string;

  constructor(scope: Construct, id: string, props: DatabaseConstructProps) {
    super(scope, id);

    // Default values
    this.databaseName = props.databaseName || 'moodledb';
    this.databaseUsername = props.databaseUsername || 'dbadmin';

    // Default rdsEngine to mysql if not set
    const rdsEngine = props.rdsEngine || 'mysql';

    // Get Aurora Serverless capacity from props with defaults
    const serverlessMinCapacity = props.auroraServerlessMinCapacity ?? 0.5;
    const serverlessMaxCapacity = props.auroraServerlessMaxCapacity ?? 100;

    // Validation
    this.validateEngineAndVersion(rdsEngine, props.rdsEngineVersion);
    this.validateInstanceType(props.rdsInstanceType);

    // Get latest available version for the engine
    const getLatestVersion = (engine: string) => {
      if (engine === 'mysql') {
        const versions = Object.values(rds.MysqlEngineVersion).map(v => v.mysqlFullVersion);
        return versions[versions.length - 1];
      } else {
        const versions = Object.values(rds.MariaDbEngineVersion).map(v => v.mariaDbFullVersion);
        return versions[versions.length - 1];
      }
    };

    // Default rdsEngineVersion to latest if both rdsEngine and rdsEngineVersion are not defined
    const rdsEngineVersion = (!props.rdsEngine && !props.rdsEngineVersion) 
      ? getLatestVersion(rdsEngine) 
      : props.rdsEngineVersion;

    // Database - RDS Instance or Aurora Cluster
    if (rdsEngine === 'aurora' || rdsEngine === 'aurora-serverless') {
      this.database = this.createAuroraCluster(
        props.vpc,
        rdsEngine,
        rdsEngineVersion!,
        props.rdsInstanceType,
        serverlessMinCapacity,
        serverlessMaxCapacity
      );
    } else {
      this.database = this.createRdsInstance(
        props.vpc,
        rdsEngine,
        rdsEngineVersion!,
        props.rdsInstanceType
      );
    }

    // RDS Event Subscription
    this.createEventSubscription(props.rdsEventSubscriptionEmailAddress);
  }

  private validateEngineAndVersion(rdsEngine: string, rdsEngineVersion?: string): void {
    if (!['mariadb', 'mysql', 'aurora', 'aurora-serverless'].includes(rdsEngine)) {
      throw new Error('rdsEngine must be either "mariadb", "mysql", "aurora", or "aurora-serverless"');
    }

    if (rdsEngineVersion) {
      const validVersions: Record<string, string[]> = {
        mysql: Object.values(rds.MysqlEngineVersion).map(v => v.mysqlFullVersion),
        mariadb: Object.values(rds.MariaDbEngineVersion).map(v => v.mariaDbFullVersion),
        aurora: Object.values(rds.AuroraMysqlEngineVersion).map(v => v.auroraMysqlFullVersion),
        'aurora-serverless': Object.values(rds.AuroraMysqlEngineVersion).map(v => v.auroraMysqlFullVersion)
      };

      if (!validVersions[rdsEngine].includes(rdsEngineVersion)) {
        throw new Error(`Invalid rdsEngineVersion "${rdsEngineVersion}" for engine "${rdsEngine}". Valid versions: ${validVersions[rdsEngine].join(', ')}`);
      }
    }
  }

  private validateInstanceType(instanceType: string): void {
    const validInstanceTypePattern = /^(db\.)?(t2|t3|t4g|m5|m6g|m7g|r5|r6g|r7g)\.(micro|small|medium|large|xlarge|2xlarge|4xlarge|8xlarge|12xlarge|16xlarge|24xlarge)$/;
    if (!validInstanceTypePattern.test(instanceType)) {
      throw new Error(`Invalid rdsInstanceType "${instanceType}". Must be a valid RDS instance type (e.g., db.t3.micro, t3.small, m5.large)`);
    }
  }

  private getEngineConfig(rdsEngine: string, rdsEngineVersion: string) {
    if (rdsEngine === 'mysql') {
      const version = Object.values(rds.MysqlEngineVersion).find(v => v.mysqlFullVersion === rdsEngineVersion);
      return rds.DatabaseInstanceEngine.mysql({ version: version! });
    } else if (rdsEngine === 'aurora' || rdsEngine === 'aurora-serverless') {
      const version = Object.values(rds.AuroraMysqlEngineVersion).find(v => v.auroraMysqlFullVersion === rdsEngineVersion);
      return rds.DatabaseClusterEngine.auroraMysql({ version: version! });
    } else {
      const version = Object.values(rds.MariaDbEngineVersion).find(v => v.mariaDbFullVersion === rdsEngineVersion);
      return rds.DatabaseInstanceEngine.mariaDb({ version: version! });
    }
  }

  private supportsDatabaseInsights(instanceType: string): boolean {
    const unsupportedTypes = ['t2.micro', 't2.small', 't3.micro', 't3.small', 't4g.micro', 't4g.small'];
    return !unsupportedTypes.includes(instanceType.replace('db.', ''));
  }

  private createAuroraCluster(
    vpc: ec2.IVpc,
    rdsEngine: string,
    rdsEngineVersion: string,
    instanceType: string,
    serverlessMinCapacity: number,
    serverlessMaxCapacity: number
  ): rds.DatabaseCluster {
    const engine = this.getEngineConfig(rdsEngine, rdsEngineVersion) as rds.IClusterEngine;

    if (rdsEngine === 'aurora-serverless') {
      const serverlessInstance = rds.ClusterInstance.serverlessV2('serverless', {
        performanceInsightRetention: rds.PerformanceInsightRetention.MONTHS_15
      });

      return new rds.DatabaseCluster(this, 'aurora-cluster', {
        engine,
        vpc,
        vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
        writer: serverlessInstance,
        serverlessV2MinCapacity: serverlessMinCapacity,
        serverlessV2MaxCapacity: serverlessMaxCapacity,
        defaultDatabaseName: this.databaseName,
        credentials: rds.Credentials.fromGeneratedSecret(this.databaseUsername, {
          excludeCharacters: '(" %+~`#$&*()|[]{}:;<>?!\'/^-,@_=\\'
        }),
        databaseInsightsMode: rds.DatabaseInsightsMode.ADVANCED,
        performanceInsightRetention: rds.PerformanceInsightRetention.MONTHS_15,
        backup: { retention: cdk.Duration.days(7) },
        storageEncrypted: true
      });
    } else {
      const writerInstance = rds.ClusterInstance.provisioned('writer', {
        instanceType: new ec2.InstanceType(instanceType)
      });

      return new rds.DatabaseCluster(this, 'aurora-cluster', {
        engine,
        vpc,
        vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
        writer: writerInstance,
        defaultDatabaseName: this.databaseName,
        credentials: rds.Credentials.fromGeneratedSecret(this.databaseUsername, {
          excludeCharacters: '(" %+~`#$&*()|[]{}:;<>?!\'/^-,@_=\\'
        }),
        databaseInsightsMode: rds.DatabaseInsightsMode.ADVANCED,
        performanceInsightRetention: rds.PerformanceInsightRetention.MONTHS_15,
        backup: { retention: cdk.Duration.days(7) },
        storageEncrypted: true
      });
    }
  }

  private createRdsInstance(
    vpc: ec2.IVpc,
    rdsEngine: string,
    rdsEngineVersion: string,
    instanceType: string
  ): rds.DatabaseInstance {
    const engine = this.getEngineConfig(rdsEngine, rdsEngineVersion) as rds.IInstanceEngine;

    return new rds.DatabaseInstance(this, 'rds-instance', {
      engine,
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      instanceType: new ec2.InstanceType(instanceType),
      allocatedStorage: 30,
      maxAllocatedStorage: 300,
      storageType: rds.StorageType.GP3,
      autoMinorVersionUpgrade: true,
      multiAz: true,
      databaseName: this.databaseName,
      credentials: rds.Credentials.fromGeneratedSecret(this.databaseUsername, {
        excludeCharacters: '(" %+~`#$&*()|[]{}:;<>?!\'/^-,@_=\\'
      }),
      ...(this.supportsDatabaseInsights(instanceType) && {
        databaseInsightsMode: rds.DatabaseInsightsMode.ADVANCED,
        performanceInsightRetention: rds.PerformanceInsightRetention.MONTHS_15
      }),
      backupRetention: cdk.Duration.days(7),
      storageEncrypted: true
    });
  }

  private createEventSubscription(emailAddress: string): void {
    const rdsEventSubscriptionTopic = new sns.Topic(this, 'rds-event-subscription-topic');
    rdsEventSubscriptionTopic.addSubscription(new subscriptions.EmailSubscription(emailAddress));
    
    new rds.CfnEventSubscription(this, 'rds-event-subscription', {
      enabled: true,
      snsTopicArn: rdsEventSubscriptionTopic.topicArn,
      sourceType: 'db-instance',
      eventCategories: ['availability', 'configuration change', 'failure', 'maintenance', 'low storage']
    });
  }
}