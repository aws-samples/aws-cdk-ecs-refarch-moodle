import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as efs from 'aws-cdk-lib/aws-efs';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as elasticache from 'aws-cdk-lib/aws-elasticache';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as cdk from 'aws-cdk-lib';
import * as cdknag from 'cdk-nag';

export interface EcsMoodleStackProps extends cdk.StackProps {
  albCertificateArn: string;
  cfCertificateArn: string;
  cfDomain: string;
  moodleImageUri: string;
  serviceReplicaDesiredCount: number;
  serviceHealthCheckGracePeriodSeconds: number;
  cfDistributionOriginTimeoutSeconds: number;
}

export class EcsMoodleStack extends cdk.Stack {
  // Local Variables
  private readonly MoodleDatabaseName = 'moodledb';
  private readonly MoodleDatabaseUsername = 'dbadmin';

  // Configurable Variables
  private readonly RdsInstanceType = 'r5.large';
  private readonly ElasticacheRedisInstanceType = 'cache.r6g.large';
  
  constructor(scope: cdk.App, id: string, props: EcsMoodleStackProps) {
    super(scope, id, props);

    // VPC
    const vpc = new ec2.Vpc(this, 'moodle-vpc', {
      maxAzs: 2,
      flowLogs: {
        'flowlog-to-cloudwatch': {
          trafficType: ec2.FlowLogTrafficType.ALL
        }
      }
    });
    const redisSG = new ec2.SecurityGroup(this, 'moodle-redis-sg', {
      vpc: vpc
    });

    // ECS Cluster
    const cluster = new ecs.Cluster(this, 'ecs-cluster', {
      vpc: vpc,
      clusterName: 'moodle-ecs-cluster',
      containerInsights: true,
      enableFargateCapacityProviders: true
    });

    // RDS
    const moodleDb = new rds.DatabaseInstance(this, 'moodle-db', {
      engine: rds.DatabaseInstanceEngine.mysql({ version: rds.MysqlEngineVersion.VER_5_7_34}),
      vpc: vpc,
      vpcSubnets: { 
        subnetType: ec2.SubnetType.PRIVATE_WITH_NAT
      },
      instanceType: new ec2.InstanceType(this.RdsInstanceType),
      allocatedStorage: 30,
      maxAllocatedStorage: 300,
      storageType: rds.StorageType.GP2,
      autoMinorVersionUpgrade: true,
      multiAz: true,
      databaseName: this.MoodleDatabaseName,
      credentials: rds.Credentials.fromGeneratedSecret(this.MoodleDatabaseUsername, { excludeCharacters: '(" %+~`#$&*()|[]{}:;<>?!\'/^-,@_=\\' }), // Punctuations are causing issue with Moodle connecting to the database
      enablePerformanceInsights: true,
      backupRetention: cdk.Duration.days(7),
      storageEncrypted: true,
      deletionProtection: true
    });
    cdknag.NagSuppressions.addResourceSuppressions(moodleDb, [
      {
        id: 'AwsSolutions-SMG4',
        reason: 'Moodle does not support Secrets Manager integration.'
      }
    ], true);
    cdknag.NagSuppressions.addResourceSuppressions(moodleDb, [
      {
        id: 'AwsSolutions-RDS11',
        reason: 'Optional security through obfuscation.'
      }
    ]);

    // EFS
    const moodleEfs = new efs.FileSystem(this, 'moodle-efs', {
      vpc: vpc,
      lifecyclePolicy: efs.LifecyclePolicy.AFTER_30_DAYS,
      outOfInfrequentAccessPolicy: efs.OutOfInfrequentAccessPolicy.AFTER_1_ACCESS,
      performanceMode: efs.PerformanceMode.GENERAL_PURPOSE,
      throughputMode: efs.ThroughputMode.BURSTING,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      enableAutomaticBackups: true
    });

    // ElastiCache Redis
    const redisSubnetGroup = new elasticache.CfnSubnetGroup(this, 'redis-subnet-group', {
      cacheSubnetGroupName: 'moodle-redis-private-subnet-group',
      description: 'Moodle Redis Subnet Group',
      subnetIds: vpc.selectSubnets({ subnetType: ec2.SubnetType.PRIVATE_WITH_NAT }).subnetIds
    });

    const moodleRedis = new elasticache.CfnReplicationGroup(this, 'moodle-redis', {
      replicationGroupDescription: 'Moodle Redis',
      cacheNodeType: this.ElasticacheRedisInstanceType,
      engine: 'redis',
      numCacheClusters: 2,
      multiAzEnabled: true,
      automaticFailoverEnabled: true,
      autoMinorVersionUpgrade: true,
      cacheSubnetGroupName: 'moodle-redis-private-subnet-group',
      securityGroupIds: [ redisSG.securityGroupId ],
      atRestEncryptionEnabled: true,
      transitEncryptionEnabled: true
    });
    moodleRedis.addDependsOn(redisSubnetGroup);
    cdknag.NagSuppressions.addResourceSuppressions(moodleRedis, [
      {
        id: 'AwsSolutions-AEC5',
        reason: 'Optional security through obfuscation.'
      }
    ]);
    cdknag.NagSuppressions.addResourceSuppressions(moodleRedis, [
      {
        id: 'AwsSolutions-AEC6',
        reason: 'No way to use secrets manager to supply the AuthToken.'
      }
    ]);

    // Moodle ECS Task Definition
    const moodleTaskDefinition = new ecs.FargateTaskDefinition(this, 'moodle-task-def', {
      cpu: 2048,
      memoryLimitMiB: 4096
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

    // EFS Volume
    const moodleVolume = {
      name: 'moodle',
      efsVolumeConfiguration: {
        fileSystemId: moodleEfs.fileSystemId
      }
    };
    moodleTaskDefinition.addVolume(moodleVolume);

    // Workaround for the issue: https://github.com/aws/aws-cdk/issues/15025
    // Add the correct case
    (moodleTaskDefinition.node.defaultChild as ecs.CfnTaskDefinition).addPropertyOverride(`Volumes.0.EFSVolumeConfiguration`, {
        FilesystemId: moodleEfs.fileSystemId,
    });
    // Delete the wrong case
    (moodleTaskDefinition.node.defaultChild as ecs.CfnTaskDefinition).addPropertyDeletionOverride(`Volumes.0.EfsVolumeConfiguration`);
    // End workaround for the issue: https://github.com/aws/aws-cdk/issues/15025

    // Moodle container definition
    const moodlePasswordSecret = new secretsmanager.Secret(this, 'moodle-password-secret');
    const moodleContainerDefinition = moodleTaskDefinition.addContainer('moodle-container', {
      containerName: 'moodle',
      image: ecs.ContainerImage.fromRegistry(props.moodleImageUri),
      memoryLimitMiB: 4096,
      portMappings: [{ containerPort: 8080 }],
      stopTimeout: cdk.Duration.seconds(120),
      environment: {
        'MOODLE_DATABASE_TYPE': 'mysqli',
        'MOODLE_DATABASE_HOST': moodleDb.dbInstanceEndpointAddress,
        'MOODLE_DATABASE_PORT_NUMBER': moodleDb.dbInstanceEndpointPort,
        'MOODLE_DATABASE_NAME': this.MoodleDatabaseName,
        'MOODLE_DATABASE_USER': this.MoodleDatabaseUsername,
        'MOODLE_USERNAME': 'moodleadmin',
        'MOODLE_EMAIL': 'hello@example.com',
        'MOODLE_SITE_NAME': 'Scalable Moodle on ECS Fargate',
        'MOODLE_SKIP_BOOTSTRAP': 'no',
        'MOODLE_SKIP_INSTALL': 'no',
        'BITNAMI_DEBUG': 'true'
      },
      secrets: {
        'MOODLE_DATABASE_PASSWORD': ecs.Secret.fromSecretsManager(moodleDb.secret!, 'password'),
        'MOODLE_PASSWORD': ecs.Secret.fromSecretsManager(moodlePasswordSecret)
      },
      logging: ecs.LogDrivers.awsLogs({ streamPrefix: 'ecs-moodle' })
    });
    moodleContainerDefinition.addMountPoints({
      sourceVolume: 'moodle',
      containerPath: '/bitnami',
      readOnly: false
    });

    cdknag.NagSuppressions.addResourceSuppressions(moodleTaskDefinition, [
      {
        id: 'AwsSolutions-ECS2',
        reason: 'Secrets are injected properly.'
      }
    ]);
    cdknag.NagSuppressions.addResourceSuppressions(moodleTaskDefinition, [
      {
        id: 'AwsSolutions-IAM5',
        reason: 'Default IAM permissions from CDK abstraction.'
      }
    ], true);
    cdknag.NagSuppressions.addResourceSuppressions(moodlePasswordSecret, [
      {
        id: 'AwsSolutions-SMG4',
        reason: 'The password is for Moodle Admin credentials which will be resetted through Moodle GUI.'
      }
    ]);

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
          weight: 1
        }
      ],
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_NAT },
      enableECSManagedTags: true,
      maxHealthyPercent: 200,
      minHealthyPercent: 50,
      healthCheckGracePeriod: cdk.Duration.seconds(props.serviceHealthCheckGracePeriodSeconds),
      circuitBreaker: { rollback: true }
    });

    // Moodle ECS Service Task Auto Scaling
    const moodleServiceScaling = moodleService.autoScaleTaskCount({ minCapacity: props.serviceReplicaDesiredCount, maxCapacity: 10 } );
    moodleServiceScaling.scaleOnCpuUtilization('cpu-scaling', {
      targetUtilizationPercent: 50
    });

    // Allow access using Security Groups
    moodleDb.connections.allowDefaultPortFrom(moodleService, 'From Moodle ECS Service');
    moodleEfs.connections.allowDefaultPortFrom(moodleService, 'From Moodle ECS Service');
    redisSG.connections.allowFrom(moodleService, ec2.Port.tcp(6379), 'From Moodle ECS Service');

    // Moodle Load Balancer
    const alb = new elbv2.ApplicationLoadBalancer(this, 'moodle-alb', {
      loadBalancerName: 'moodle-ecs-alb',
      vpc: vpc,
      internetFacing: true,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC }
    });
    const httpListener = alb.addListener('http-listener', { 
      port: 80, 
      protocol: elbv2.ApplicationProtocol.HTTP,
      open: true,
      defaultAction: elbv2.ListenerAction.redirect({ protocol: 'HTTPS', port: '443', permanent: true })
    });
    const httpsListener = alb.addListener('https-listener', { 
      port: 443,
      protocol: elbv2.ApplicationProtocol.HTTPS,
      open: true,
      certificates: [ elbv2.ListenerCertificate.fromArn(props.albCertificateArn) ]
    });
    const targetGroup = httpsListener.addTargets('moodle-service-tg', {
      port: 8080,
      targets: [
        moodleService.loadBalancerTarget({
          containerName: 'moodle',
          containerPort: 8080,
          protocol: ecs.Protocol.TCP
        })
      ]
    });
    cdknag.NagSuppressions.addResourceSuppressions(alb, [
      {
        id: 'AwsSolutions-ELB2',
        reason: 'Setting the access logs on the ALB throws new error "Unsupported feature flag". Surpressing it for now.'
      }
    ]);
    cdknag.NagSuppressions.addResourceSuppressions(alb, [
      {
        id: 'AwsSolutions-EC23',
        reason: 'ALB is open for TCP 80 and TCP 443 for incoming HTTP and HTTPS.'
      }
    ], true);

    // cloudfront distribution
    const cf = new cloudfront.Distribution(this, 'moodle-ecs-dist', {
      defaultBehavior: {
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        origin: new origins.LoadBalancerV2Origin(alb, {
          readTimeout: cdk.Duration.seconds(props.cfDistributionOriginTimeoutSeconds)
        }),
        cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
        originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER
      },
      domainNames: [props.cfDomain.toString()],
      certificate: acm.Certificate.fromCertificateArn(this, 'cFcert', props.cfCertificateArn.toString())
    });
    cdknag.NagSuppressions.addResourceSuppressions(cf, [
      {
        id: 'AwsSolutions-CFR1',
        reason: 'Geo restriction is not required.'
      }
    ]);
    cdknag.NagSuppressions.addResourceSuppressions(cf, [
      {
        id: 'AwsSolutions-CFR2',
        reason: 'WAF is out of scope from this technical content.'
      }
    ]);
    cdknag.NagSuppressions.addResourceSuppressions(cf, [
      {
        id: 'AwsSolutions-CFR3',
        reason: 'Access logs is out of scope from this technical content.'
      }
    ]);

    // Outputs
    new cdk.CfnOutput(this, 'APPLICATION-LOAD-BALANCER-DNS-NAME', {
      value: alb.loadBalancerDnsName
    });
    new cdk.CfnOutput(this, 'MOODLE-USERNAME', {
      value: 'moodleadmin'
    });
    new cdk.CfnOutput(this, 'MOODLE-PASSWORD-SECRET-ARN', {
      value: moodlePasswordSecret.secretArn
    });
    new cdk.CfnOutput(this, 'MOODLE-REDIS-PRIMARY-ENDPOINT-ADDRESS-AND-PORT', {
      value: `${moodleRedis.attrPrimaryEndPointAddress}:${moodleRedis.attrPrimaryEndPointPort}`
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
    new cdk.CfnOutput(this, 'MOODLE-CLOUDFRONT-NAME', {
      value: cloudfront.Distribution.name
    });
  }
}
