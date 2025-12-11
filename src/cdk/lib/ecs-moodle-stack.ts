import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as cloudtrail from 'aws-cdk-lib/aws-cloudtrail';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { Platform } from 'aws-cdk-lib/aws-ecr-assets';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as efs from 'aws-cdk-lib/aws-efs';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as elasticache from 'aws-cdk-lib/aws-elasticache';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as subscriptions from 'aws-cdk-lib/aws-sns-subscriptions';
import * as targets from 'aws-cdk-lib/aws-route53-targets';
import * as cdk from 'aws-cdk-lib';



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

  // Local Variables
  private readonly MoodleDatabaseName = 'moodledb';
  private readonly MoodleDatabaseUsername = 'dbadmin';

  constructor(scope: cdk.App, id: string, props: EcsMoodleStackProps) {
    super(scope, id, props);

    // Derive domainName from domain
    const domainParts = props.domain.split('.');
    const domainName = domainParts.slice(1).join('.');

    // Default containerPlatform to X86 if not defined
    const containerPlatform = props.containerPlatform || 'X86';
    if (!['ARM', 'X86'].includes(containerPlatform)) {
      throw new Error('containerPlatform must be either "ARM" or "X86"');
    }

    // Default rdsEngine to mysql if not set
    const rdsEngine = props.rdsEngine || 'mysql';

    // Get Aurora Serverless capacity from props with defaults
    const serverlessMinCapacity = props.auroraServerlessMinCapacity ?? 0.5;
    const serverlessMaxCapacity = props.auroraServerlessMaxCapacity ?? 100;

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
    const rdsEngineVersion = (!props.rdsEngine && !props.rdsEngineVersion) ? getLatestVersion(rdsEngine) : props.rdsEngineVersion;
    if (!['mariadb', 'mysql', 'aurora', 'aurora-serverless'].includes(rdsEngine)) {
      throw new Error('rdsEngine must be either "mariadb", "mysql", "aurora", or "aurora-serverless"');
    }

    // Validate engine version
    const validVersions: Record<string, string[]> = {
      mysql: Object.values(rds.MysqlEngineVersion).map(v => v.mysqlFullVersion),
      mariadb: Object.values(rds.MariaDbEngineVersion).map(v => v.mariaDbFullVersion),
      aurora: Object.values(rds.AuroraMysqlEngineVersion).map(v => v.auroraMysqlFullVersion),
      'aurora-serverless': Object.values(rds.AuroraMysqlEngineVersion).map(v => v.auroraMysqlFullVersion)
    };

    if (!validVersions[rdsEngine].includes(rdsEngineVersion)) {
      throw new Error(`Invalid rdsEngineVersion "${rdsEngineVersion}" for engine "${rdsEngine}". Valid versions: ${validVersions[rdsEngine].join(', ')}`);
    }

    // Validate RDS instance type format
    const validInstanceTypePattern = /^(db\.)?(t2|t3|t4g|m5|m6g|m7g|r5|r6g|r7g)\.(micro|small|medium|large|xlarge|2xlarge|4xlarge|8xlarge|12xlarge|16xlarge|24xlarge)$/;
    if (!validInstanceTypePattern.test(props.rdsInstanceType)) {
      throw new Error(`Invalid rdsInstanceType "${props.rdsInstanceType}". Must be a valid RDS instance type (e.g., db.t3.micro, t3.small, m5.large)`);
    }

    // Database insights support check
    const supportsDatabaseInsights = (instanceType: string): boolean => {
      const unsupportedTypes = ['t2.micro', 't2.small', 't3.micro', 't3.small', 't4g.micro', 't4g.small'];
      return !unsupportedTypes.includes(instanceType.replace('db.', ''));
    };

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
      const validCacheInstancePattern = /^cache\.(t2|t3|t4g|m4|m5|m6g|m7g|r4|r5|r6g|r7g)\.(micro|small|medium|large|xlarge|2xlarge|4xlarge|10xlarge|12xlarge|16xlarge|24xlarge)$/;
      if (!validCacheInstancePattern.test(props.cacheProvisionedInstanceType)) {
        throw new Error(`Invalid cacheProvisionedInstanceType "${props.cacheProvisionedInstanceType}". Must be a valid ElastiCache instance type (e.g., cache.t3.micro, cache.m5.large)`);
      }
    }

    // Set defaults if not provided
    const cacheServerlessMaxStorageGB = props.cacheServerlessMaxStorageGB || 100;
    const cacheServerlessMaxCapacity = props.cacheServerlessMaxCapacity || 100;
    const cacheServerlessMinCapacity = props.cacheServerlessMinCapacity || 1;

    // CloudTrail
    const trailBucket = new s3.Bucket(this, 'cloudtrail-bucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      encryption: s3.BucketEncryption.S3_MANAGED
    });
    const trail = new cloudtrail.Trail(this, 'cloudtrail-trail', {
      bucket: trailBucket
    });

    // VPC
    const vpc = new ec2.Vpc(this, 'moodle-vpc', {
      maxAzs: 2,
      flowLogs: {
        'flowlog-to-cloudwatch': {
          trafficType: ec2.FlowLogTrafficType.ALL,
          destination: ec2.FlowLogDestination.toCloudWatchLogs(
            new logs.LogGroup(this, 'vpc-flow-logs', {
              retention: logs.RetentionDays.ONE_WEEK,
              removalPolicy: cdk.RemovalPolicy.DESTROY
            })
          )
        }
      }
    });

    // VPC Endpoints for private subnet connectivity
    vpc.addInterfaceEndpoint('ecr-vpc-endpoint', {
      service: ec2.InterfaceVpcEndpointAwsService.ECR
    });
    vpc.addInterfaceEndpoint('ecr-dkr-vpc-endpoint', {
      service: ec2.InterfaceVpcEndpointAwsService.ECR_DOCKER
    });
    vpc.addGatewayEndpoint('s3-vpc-endpoint', {
      service: ec2.GatewayVpcEndpointAwsService.S3
    });
    vpc.addInterfaceEndpoint('secrets-manager-vpc-endpoint', {
      service: ec2.InterfaceVpcEndpointAwsService.SECRETS_MANAGER
    });
    vpc.addInterfaceEndpoint('cloudwatch-logs-vpc-endpoint', {
      service: ec2.InterfaceVpcEndpointAwsService.CLOUDWATCH_LOGS
    });
    
    // ECS Cluster
    const cluster = new ecs.Cluster(this, 'ecs-cluster', {
      vpc: vpc,
      clusterName: 'moodle-ecs-cluster',
      containerInsightsV2: ecs.ContainerInsights.ENABLED,
      enableFargateCapacityProviders: true
    });

    // RDS - Dynamic engine configuration
    const getEngineConfig = () => {
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
    };

    // Database - RDS Instance or Aurora Cluster
    let moodleDb: rds.DatabaseInstance | rds.DatabaseCluster;

    if (rdsEngine === 'aurora' || rdsEngine === 'aurora-serverless') {
      if (rdsEngine === 'aurora-serverless') {
        const serverlessInstance = rds.ClusterInstance.serverlessV2('serverless', {
          performanceInsightRetention: rds.PerformanceInsightRetention.MONTHS_15
        }

        );

        moodleDb = new rds.DatabaseCluster(this, 'moodle-aurora-cluster', {
          engine: getEngineConfig() as rds.IClusterEngine,
          vpc: vpc,
          vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
          writer: serverlessInstance,
          serverlessV2MinCapacity: serverlessMinCapacity,
          serverlessV2MaxCapacity: serverlessMaxCapacity,
          defaultDatabaseName: this.MoodleDatabaseName,
          credentials: rds.Credentials.fromGeneratedSecret(this.MoodleDatabaseUsername, {
            excludeCharacters: '(" %+~`#$&*()|[]{}:;<>?!\'/^-,@_=\\'
          }),
          databaseInsightsMode: rds.DatabaseInsightsMode.ADVANCED,
          performanceInsightRetention: rds.PerformanceInsightRetention.MONTHS_15,
          backup: { retention: cdk.Duration.days(7) },
          storageEncrypted: true
        });
      } else {
        const writerInstance = rds.ClusterInstance.provisioned('writer', {
          instanceType: new ec2.InstanceType(props.rdsInstanceType)
        });

        moodleDb = new rds.DatabaseCluster(this, 'moodle-aurora-cluster', {
          engine: getEngineConfig() as rds.IClusterEngine,
          vpc: vpc,
          vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
          writer: writerInstance,
          defaultDatabaseName: this.MoodleDatabaseName,
          credentials: rds.Credentials.fromGeneratedSecret(this.MoodleDatabaseUsername, {
            excludeCharacters: '(" %+~`#$&*()|[]{}:;<>?!\'/^-,@_=\\'
          }),
          databaseInsightsMode: rds.DatabaseInsightsMode.ADVANCED,
          performanceInsightRetention: rds.PerformanceInsightRetention.MONTHS_15,
          backup: { retention: cdk.Duration.days(7) },
          storageEncrypted: true
        });

        // Store instance references for later dependency management
        (moodleDb as any).writerInstance = writerInstance;
      }
    } else {
      moodleDb = new rds.DatabaseInstance(this, 'moodle-db', {
        engine: getEngineConfig() as rds.IInstanceEngine,
        vpc: vpc,
        vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
        instanceType: new ec2.InstanceType(props.rdsInstanceType),
        allocatedStorage: 30,
        maxAllocatedStorage: 300,
        storageType: rds.StorageType.GP3,
        autoMinorVersionUpgrade: true,
        multiAz: true,
        databaseName: this.MoodleDatabaseName,
        credentials: rds.Credentials.fromGeneratedSecret(this.MoodleDatabaseUsername, {
          excludeCharacters: '(" %+~`#$&*()|[]{}:;<>?!\'/^-,@_=\\'
        }),
        ...(supportsDatabaseInsights(props.rdsInstanceType) && {
          databaseInsightsMode: rds.DatabaseInsightsMode.ADVANCED,
          performanceInsightRetention: rds.PerformanceInsightRetention.MONTHS_15
        }),
        backupRetention: cdk.Duration.days(7),
        storageEncrypted: true
      });
    }
    const rdsEventSubscriptionTopic = new sns.Topic(this, 'rds-event-subscription-topic', {});
    rdsEventSubscriptionTopic.addSubscription(new subscriptions.EmailSubscription(props.rdsEventSubscriptionEmailAddress));
    const rdsEventSubscription = new rds.CfnEventSubscription(this, 'rds-event-subscription', {
      enabled: true,
      snsTopicArn: rdsEventSubscriptionTopic.topicArn,
      sourceType: 'db-instance',
      eventCategories: ['availability', 'configuration change', 'failure', 'maintenance', 'low storage']
    });

    // EFS
    const moodleEfs = new efs.FileSystem(this, 'moodle-efs', {
      vpc: vpc,
      lifecyclePolicy: efs.LifecyclePolicy.AFTER_30_DAYS,
      outOfInfrequentAccessPolicy: efs.OutOfInfrequentAccessPolicy.AFTER_1_ACCESS,
      performanceMode: efs.PerformanceMode.GENERAL_PURPOSE,
      throughputMode: efs.ThroughputMode.ELASTIC,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      enableAutomaticBackups: true
    });
    const moodleEfsAccessPoint = moodleEfs.addAccessPoint('moodle-efs-access-point', {
      path: '/'
    });

    // ElastiCache - Redis or Valkey
    const cacheSG = new ec2.SecurityGroup(this, 'moodle-cache-sg', {
      vpc: vpc
    });

    const cacheSubnetGroup = new elasticache.CfnSubnetGroup(this, 'cache-subnet-group', {
      cacheSubnetGroupName: `${cdk.Names.uniqueId(this)}-cache-subnet-group`,
      description: `Moodle ${props.cacheEngine.toUpperCase()} Subnet Group`,
      subnetIds: vpc.selectSubnets({ subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS }).subnetIds
    });

    let cacheEndpoint: string;
    if (props.cacheDeploymentMode === 'serverless') {
      const moodleServerlessCache = new elasticache.CfnServerlessCache(this, `moodle-${props.cacheEngine}-serverless-cache`, {
        serverlessCacheName: `moodle-${props.cacheEngine}-serverless`,
        engine: props.cacheEngine,
        majorEngineVersion: props.cacheEngine === 'redis' ? '7' : '8',
        cacheUsageLimits: {
          dataStorage: {
            maximum: cacheServerlessMaxStorageGB,
            unit: 'GB'
          },
          ecpuPerSecond: {
            maximum: (cacheServerlessMaxCapacity) * 1000,
            minimum: (cacheServerlessMinCapacity) * 1000
          }
        },
        subnetIds: vpc.selectSubnets({ subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS }).subnetIds,
        securityGroupIds: [cacheSG.securityGroupId]
      });
      cacheEndpoint = `${moodleServerlessCache.attrEndpointAddress}:${moodleServerlessCache.attrEndpointPort}`;
    } else {
      const moodleProvisionedCache = new elasticache.CfnReplicationGroup(this, `moodle-${props.cacheEngine}-provisioned-cache`, {
        replicationGroupDescription: `Moodle ${props.cacheEngine.toUpperCase()}`,
        cacheNodeType: props.cacheProvisionedInstanceType,
        engine: props.cacheEngine,
        numCacheClusters: 2,
        multiAzEnabled: true,
        automaticFailoverEnabled: true,
        autoMinorVersionUpgrade: true,
        cacheSubnetGroupName: `${cdk.Names.uniqueId(this)}-cache-subnet-group`,
        securityGroupIds: [cacheSG.securityGroupId],
        transitEncryptionEnabled: true,
        atRestEncryptionEnabled: true
      });
      moodleProvisionedCache.addDependency(cacheSubnetGroup);
      cacheEndpoint = `${moodleProvisionedCache.attrPrimaryEndPointAddress}:${moodleProvisionedCache.attrPrimaryEndPointPort}`;
    }

    // Moodle ECS Task Definition
    const moodleTaskDefinition = new ecs.FargateTaskDefinition(this, 'moodle-task-def', {
      cpu: 2048,
      memoryLimitMiB: 4096,
      runtimePlatform: {
        cpuArchitecture: containerPlatform === 'ARM' ? ecs.CpuArchitecture.ARM64 : ecs.CpuArchitecture.X86_64,
        operatingSystemFamily: ecs.OperatingSystemFamily.LINUX
      }
    });

    moodleTaskDefinition.addToExecutionRolePolicy(iam.PolicyStatement.fromJson({
      "Effect": "Allow",
      "Action": [
        "ecr:GetAuthorizationToken",
        "ecr:BatchCheckLayerAvailability",
        "ecr:GetDownloadUrlForLayer",
        "ecr:BatchGetImage",
        "logs:CreateLogStream",
        "logs:PutLogEvents"
      ],
      "Resource": "*"
    }));

    // Add ECS Exec permissions to task role
    moodleTaskDefinition.addToTaskRolePolicy(iam.PolicyStatement.fromJson({
      "Effect": "Allow",
      "Action": [
        "ssmmessages:CreateControlChannel",
        "ssmmessages:CreateDataChannel",
        "ssmmessages:OpenControlChannel",
        "ssmmessages:OpenDataChannel"
      ],
      "Resource": "*"
    }));

    // EFS Volume
    moodleTaskDefinition.addVolume({
      name: 'moodle',
      efsVolumeConfiguration: {
        fileSystemId: moodleEfs.fileSystemId,
        transitEncryption: "ENABLED",
        authorizationConfig: {
          accessPointId: moodleEfsAccessPoint.accessPointId
        }
      }
    });

    // Moodle container image
    const moodleImage = ecs.ContainerImage.fromAsset('../image/src', {
      platform: containerPlatform === 'ARM' ? Platform.LINUX_ARM64 : Platform.LINUX_AMD64
    });

    // Moodle container definition
    const moodlePasswordSecret = new secretsmanager.Secret(this, 'moodle-password-secret');
    const moodleContainerDefinition = moodleTaskDefinition.addContainer('moodle-container', {
      containerName: 'moodle',
      image: moodleImage,
      memoryLimitMiB: 4096,
      portMappings: [{ containerPort: 8080 }],
      stopTimeout: cdk.Duration.seconds(30),
      environment: {
        'MOODLE_DATABASE_TYPE': (rdsEngine === 'aurora' || rdsEngine === 'aurora-serverless') ? 'auroramysql' : (rdsEngine === 'mysql' ? 'mysqli' : 'mariadb'),
        'MOODLE_DATABASE_HOST': (rdsEngine === 'aurora' || rdsEngine === 'aurora-serverless') ? (moodleDb as rds.DatabaseCluster).clusterEndpoint.hostname : (moodleDb as rds.DatabaseInstance).instanceEndpoint.hostname,
        'MOODLE_DATABASE_PORT_NUMBER': (rdsEngine === 'aurora' || rdsEngine === 'aurora-serverless') ? (moodleDb as rds.DatabaseCluster).clusterEndpoint.port.toString() : (moodleDb as rds.DatabaseInstance).instanceEndpoint.port.toString(),
        'MOODLE_DATABASE_NAME': this.MoodleDatabaseName,
        'MOODLE_DATABASE_USER': this.MoodleDatabaseUsername,
        'MOODLE_USERNAME': 'moodleadmin',
        'MOODLE_EMAIL': 'hello@example.com',
        'MOODLE_SITE_NAME': 'Scalable Moodle on ECS Fargate',
        'MOODLE_DNS_NAME': props.domain
      },
      secrets: {
        'MOODLE_DATABASE_PASSWORD': ecs.Secret.fromSecretsManager(moodleDb.secret!, 'password'),
        'MOODLE_PASSWORD': ecs.Secret.fromSecretsManager(moodlePasswordSecret)
      },
      logging: ecs.LogDrivers.awsLogs({ streamPrefix: 'ecs-moodle' })
    });
    moodleContainerDefinition.addMountPoints(
      {
        sourceVolume: 'moodle',
        containerPath: '/mnt/moodle',
        readOnly: false
      } 
  );

    // Moodle ECS Service
    const moodleService = new ecs.FargateService(this, 'moodle-service', {
      cluster: cluster,
      taskDefinition: moodleTaskDefinition,
      desiredCount: props.serviceReplicaDesiredCount,
      capacityProviderStrategies: [ // Every 1 task which uses FARGATE, 3 tasks will use FARGATE_SPOT (25% / 75%)
        {
          capacityProvider: 'FARGATE_SPOT',
          weight: 3
        },
        {
          capacityProvider: 'FARGATE',
          weight: 1,
          base: 1
        }
      ],
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      enableECSManagedTags: true,
      maxHealthyPercent: 200,
      minHealthyPercent: 50,
      healthCheckGracePeriod: cdk.Duration.seconds(props.serviceHealthCheckGracePeriodSeconds),
      circuitBreaker: { rollback: true },
      enableExecuteCommand: true
    });
    moodleService.node.addDependency(cluster);

    // Add dependencies on Aurora instances
    if (rdsEngine === 'aurora' || rdsEngine === 'aurora-serverless') {
      const cfnService = moodleService.node.defaultChild as ecs.CfnService;
      const dbCluster = moodleDb as rds.DatabaseCluster;

      // Find and depend on the actual CloudFormation DB instances
      for (const child of dbCluster.node.children) {
        if (child.node.defaultChild && child.node.defaultChild.constructor.name === 'CfnDBInstance') {
          cfnService.addDependency(child.node.defaultChild as cdk.CfnResource);
        }
      }
    }

    // Moodle ECS Service Task Auto Scaling
    const moodleServiceScaling = moodleService.autoScaleTaskCount({ minCapacity: props.serviceReplicaDesiredCount, maxCapacity: 10 });
    moodleServiceScaling.scaleOnCpuUtilization('cpu-scaling', {
      targetUtilizationPercent: 50
    });

    // Allow access using Security Groups
    moodleDb.connections.allowDefaultPortFrom(moodleService, 'From Moodle ECS Service');
    moodleEfs.connections.allowDefaultPortFrom(moodleService, 'From Moodle ECS Service');
    cacheSG.connections.allowFrom(moodleService, ec2.Port.tcp(6379), 'From Moodle ECS Service');

    let albCertificateArn: string;
    let hostedZone: route53.IHostedZone | undefined;

    if (!props.useExistingAlbCertificate) {
      // Import existing hosted zone
      hostedZone = route53.HostedZone.fromHostedZoneAttributes(this, 'hosted-zone', {
        hostedZoneId: props.hostedZoneId,
        zoneName: domainName
      });

      // ALB certificate
      const albCertificate = new acm.Certificate(this, 'alb-certificate', {
        domainName: props.domain,
        validation: acm.CertificateValidation.fromDns(hostedZone)
      });

      albCertificateArn = albCertificate.certificateArn

    } else {
      albCertificateArn = props.albCertificateArn;
    }

    // Generate a secret value for CloudFront custom header verification (only if CloudFront is enabled)
    let cfCustomHeaderSecret: secretsmanager.Secret | undefined;
    if (props.enableCloudFront) {
      cfCustomHeaderSecret = new secretsmanager.Secret(this, 'cf-custom-header-secret', {
        generateSecretString: {
          excludePunctuation: true,
          passwordLength: 32
        }
      });
    }

    // Moodle Load Balancer - private (accessed via CloudFront) or public (direct access)
    const alb = new elbv2.ApplicationLoadBalancer(this, 'moodle-alb', {
      loadBalancerName: props.enableCloudFront ? 'moodle-ecs-alb' : 'moodle-ecs-alb-direct',
      vpc: vpc,
      internetFacing: !props.enableCloudFront, // Public if CloudFront is disabled
      vpcSubnets: { 
        subnetType: props.enableCloudFront 
          ? ec2.SubnetType.PRIVATE_WITH_EGRESS 
          : ec2.SubnetType.PUBLIC 
      }
    });
    // Create target group for Moodle service
    const moodleTargetGroup = new elbv2.ApplicationTargetGroup(this, props.enableCloudFront ? 'moodle-service-tg' : 'moodle-service-direct-tg', {
      vpc: vpc,
      port: 8080,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targets: [
        moodleService.loadBalancerTarget({
          containerName: 'moodle',
          containerPort: 8080,
          protocol: ecs.Protocol.TCP
        })
      ],
      healthCheck: {
        timeout: cdk.Duration.seconds(20),
        path: '/',
        healthyHttpCodes: '200,303'
      }
    });

    const httpsListener = alb.addListener('https-listener', {
      port: 443,
      protocol: elbv2.ApplicationProtocol.HTTPS,
      open: !props.enableCloudFront, // Open to internet if CloudFront is disabled
      certificates: [elbv2.ListenerCertificate.fromArn(albCertificateArn)],
      defaultAction: props.enableCloudFront 
        ? elbv2.ListenerAction.fixedResponse(403, {
            contentType: 'text/plain',
            messageBody: 'Access denied'
          })
        : elbv2.ListenerAction.forward([moodleTargetGroup])
    });

    // Add rule to only allow requests with correct custom header (only if CloudFront is enabled)
    if (props.enableCloudFront && cfCustomHeaderSecret) {
      httpsListener.addAction('allow-cloudfront', {
        priority: 1,
        conditions: [
          elbv2.ListenerCondition.httpHeader('X-Origin-Verify', [
            cfCustomHeaderSecret.secretValue.unsafeUnwrap()
          ])
        ],
        action: elbv2.ListenerAction.forward([moodleTargetGroup])
      });
    }

    // Create CloudFront distribution only if enabled
    let cf: cloudfront.Distribution | undefined;
    if (props.enableCloudFront && cfCustomHeaderSecret && props.cfCertificateArn && props.cfWafArn) {
      // Create VPC Origin for CloudFront distribution with custom header
      const vpcOrigin = origins.VpcOrigin.withApplicationLoadBalancer(alb, {
        httpsPort: 443,
        originSslProtocols: [cloudfront.OriginSslPolicy.TLS_V1_2],
        protocolPolicy: cloudfront.OriginProtocolPolicy.HTTPS_ONLY,
        vpcOriginName: 'moodle-alb-vpc-origin',
        customHeaders: {
          'X-Origin-Verify': cfCustomHeaderSecret.secretValue.unsafeUnwrap()
        }
      });

      // CloudFront distribution with private ALB origin (HTTP/3 disabled for VPC Origin compatibility)
      cf = new cloudfront.Distribution(this, 'moodle-ecs-dist', {
        comment: `Moodle distribution for ${props.domain}`,
        defaultBehavior: {
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          origin: vpcOrigin,
          cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
          originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER
        },
        domainNames: [props.domain],
        certificate: acm.Certificate.fromCertificateArn(this, 'cFcert', props.cfCertificateArn),
        webAclId: props.cfWafArn,
      });

      // Export distribution ARN for logging setup in us-east-1
      this.distributionArn = cf.distributionArn;
    }

    // Configure ALB security based on CloudFront enablement
    if (props.enableCloudFront) {
      const cfPrefixList = ec2.PrefixList.fromLookup(this, 'cloudfront-prefix-list', {
        prefixListName: 'com.amazonaws.global.cloudfront.origin-facing'
      });

      // Allow traffic from CloudFront VPC Origin managed prefix list
      alb.connections.allowFrom(
        ec2.Peer.prefixList(cfPrefixList.prefixListId),
        ec2.Port.tcp(443),
        'Allow CloudFront VPC Origin (managed prefix list) to access private ALB'
      );
    } else {
      // ALB is already configured as internet-facing and open=true for direct access
      // No additional security group rules needed as the listener is already open
    }

    if (!props.useExistingAlbCertificate && hostedZone) {
      if (props.enableCloudFront && cf) {
        // Route53 records for CloudFront
        new route53.ARecord(this, 'domain-alias-a-record', {
          zone: hostedZone,
          recordName: props.domain,
          target: route53.RecordTarget.fromAlias(new targets.CloudFrontTarget(cf))
        });
        new route53.AaaaRecord(this, 'domain-alias-aaaa-record', {
          zone: hostedZone,
          recordName: props.domain,
          target: route53.RecordTarget.fromAlias(new targets.CloudFrontTarget(cf))
        });
      } else {
        // Route53 records for direct ALB access
        new route53.ARecord(this, 'domain-alias-a-record', {
          zone: hostedZone,
          recordName: props.domain,
          target: route53.RecordTarget.fromAlias(new targets.LoadBalancerTarget(alb))
        });
        new route53.AaaaRecord(this, 'domain-alias-aaaa-record', {
          zone: hostedZone,
          recordName: props.domain,
          target: route53.RecordTarget.fromAlias(new targets.LoadBalancerTarget(alb))
        });
      }
    }

    // Outputs
    new cdk.CfnOutput(this, 'APPLICATION-LOAD-BALANCER-DNS-NAME', {
      value: alb.loadBalancerDnsName
    });
    
    if (props.enableCloudFront && cf) {
      new cdk.CfnOutput(this, 'CLOUDFRONT-DNS-NAME', {
        value: (!props.useExistingAlbCertificate) ? props.domain : cf.distributionDomainName
      });
      new cdk.CfnOutput(this, 'MOODLE-CLOUDFRONT-DIST-ID', {
        value: cf.distributionId
      });
    } else {
      new cdk.CfnOutput(this, 'MOODLE-DNS-NAME', {
        value: (!props.useExistingAlbCertificate) ? props.domain : alb.loadBalancerDnsName
      });
    }
    
    new cdk.CfnOutput(this, 'MOODLE-USERNAME', {
      value: 'moodleadmin'
    });
    new cdk.CfnOutput(this, 'MOODLE-PASSWORD-SECRET-ARN', {
      value: moodlePasswordSecret.secretArn
    });
    new cdk.CfnOutput(this, 'MOODLE-CACHE-ENDPOINT-ADDRESS-AND-PORT', {
      value: cacheEndpoint
    });
    new cdk.CfnOutput(this, 'ECS-CLUSTER-NAME', {
      value: cluster.clusterName
    });
    new cdk.CfnOutput(this, 'ECS-VPC-ID', {
      value: vpc.vpcId
    });
    new cdk.CfnOutput(this, 'MOODLE-SERVICE-NAME', {
      value: moodleService.serviceName
    });
  }
}
