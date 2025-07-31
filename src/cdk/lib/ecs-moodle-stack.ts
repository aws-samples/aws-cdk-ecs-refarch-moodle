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
import * as cloudtrail from 'aws-cdk-lib/aws-cloudtrail';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as subscriptions from 'aws-cdk-lib/aws-sns-subscriptions';
import * as cdk from 'aws-cdk-lib';
import { SSMParameterReader } from './ssm-parameter-reader';

export interface EcsMoodleStackProps extends cdk.StackProps {
  albCertificateArn: string;
  cfCertificateArn: string;
  cfDomain: string;
  moodleImageUri: string;
  serviceReplicaDesiredCount: number;
  serviceHealthCheckGracePeriodSeconds: number;
  cfDistributionOriginTimeoutSeconds: number;
  rdsEventSubscriptionEmailAddress: string;
  rdsInstanceType: string;
  elastiCacheRedisInstanceType: string;
}

export class EcsMoodleStack extends cdk.Stack {
  // Local Variables
  private readonly MoodleDatabaseName = 'moodledb';
  private readonly MoodleDatabaseUsername = 'dbadmin';
  
  constructor(scope: cdk.App, id: string, props: EcsMoodleStackProps) {
    super(scope, id, props);

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
          trafficType: ec2.FlowLogTrafficType.ALL
        }
      }
    });
    // Amazon ECS tasks hosted on Fargate using platform version 1.4.0 or later require both Amazon ECR VPC endpoints and the Amazon S3 gateway endpoints.
    // Reference: https://docs.aws.amazon.com/AmazonECR/latest/userguide/vpc-endpoints.html#ecr-setting-up-vpc-create
    const ecrVpcEndpoint = vpc.addInterfaceEndpoint('ecr-vpc-endpoint', {
      service: ec2.InterfaceVpcEndpointAwsService.ECR
    });
    const s3VpcEndpoint = vpc.addGatewayEndpoint('s3-vpc-endpoint', {
      service: ec2.GatewayVpcEndpointAwsService.S3
    });

    // ECS Cluster
    const cluster = new ecs.Cluster(this, 'ecs-cluster', {
      vpc: vpc,
      clusterName: 'moodle-ecs-cluster',
      containerInsightsV2: ecs.ContainerInsights.ENABLED,
      enableFargateCapacityProviders: true
    });

    // RDS
    const moodleDb = new rds.DatabaseInstance(this, 'moodle-db', {
      engine: rds.DatabaseInstanceEngine.mysql({ version: rds.MysqlEngineVersion.VER_8_4_4}),
      vpc: vpc,
      vpcSubnets: { 
        subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS
      },
      instanceType: new ec2.InstanceType(props.rdsInstanceType),
      allocatedStorage: 30,
      maxAllocatedStorage: 300,
      storageType: rds.StorageType.GP2,
      autoMinorVersionUpgrade: true,
      multiAz: true,
      databaseName: this.MoodleDatabaseName,
      credentials: rds.Credentials.fromGeneratedSecret(this.MoodleDatabaseUsername, { excludeCharacters: '(" %+~`#$&*()|[]{}:;<>?!\'/^-,@_=\\' }), // Punctuations are causing issue with Moodle connecting to the database
      enablePerformanceInsights: true,
      backupRetention: cdk.Duration.days(7),
      storageEncrypted: true
    });
    const rdsEventSubscriptionTopic = new sns.Topic(this, 'rds-event-subscription-topic', { });
    rdsEventSubscriptionTopic.addSubscription(new subscriptions.EmailSubscription(props.rdsEventSubscriptionEmailAddress));
    const rdsEventSubscription = new rds.CfnEventSubscription(this, 'rds-event-subscription', {
      enabled: true,
      snsTopicArn: rdsEventSubscriptionTopic.topicArn,
      sourceType: 'db-instance',
      eventCategories: [ 'availability', 'configuration change', 'failure', 'maintenance', 'low storage']
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

    // ElastiCache Redis
    const redisSG = new ec2.SecurityGroup(this, 'moodle-redis-sg', {
      vpc: vpc
    });

    const redisSubnetGroup = new elasticache.CfnSubnetGroup(this, 'redis-subnet-group', {
      cacheSubnetGroupName: `${cdk.Names.uniqueId(this)}-redis-subnet-group`,
      description: 'Moodle Redis Subnet Group',
      subnetIds: vpc.selectSubnets({ subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS }).subnetIds
    });

    const moodleRedis = new elasticache.CfnReplicationGroup(this, 'moodle-redis', {
      replicationGroupDescription: 'Moodle Redis',
      cacheNodeType: props.elastiCacheRedisInstanceType,
      engine: 'redis',
      numCacheClusters: 2,
      multiAzEnabled: true,
      automaticFailoverEnabled: true,
      autoMinorVersionUpgrade: true,
      cacheSubnetGroupName: `${cdk.Names.uniqueId(this)}-redis-subnet-group`,
      securityGroupIds: [ redisSG.securityGroupId ],
      atRestEncryptionEnabled: true
    });
    moodleRedis.addDependency(redisSubnetGroup);

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
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      enableECSManagedTags: true,
      maxHealthyPercent: 200,
      minHealthyPercent: 50,
      healthCheckGracePeriod: cdk.Duration.seconds(props.serviceHealthCheckGracePeriodSeconds),
      circuitBreaker: { rollback: true }
    });
    moodleService.node.addDependency(cluster);
    
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
      ],
      healthCheck: {
        timeout: cdk.Duration.seconds(20)
      }
    });

    // CloudFront distribution
    const cfWafWebAclArnReader = new SSMParameterReader(this, 'cf-waf-web-acl-arn-ssm-param-reader', {
      parameterName: 'cf-waf-web-acl-arn',
      region: 'us-east-1'
    })

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
      domainNames: [props.cfDomain],
      certificate: acm.Certificate.fromCertificateArn(this, 'cFcert', props.cfCertificateArn.toString()),
      webAclId: cfWafWebAclArnReader.getParameterValue()
    });

    // Outputs
    new cdk.CfnOutput(this, 'APPLICATION-LOAD-BALANCER-DNS-NAME', {
      value: alb.loadBalancerDnsName
    });
    new cdk.CfnOutput(this, 'CLOUDFRONT-DNS-NAME', {
      value: cf.distributionDomainName
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
    new cdk.CfnOutput(this, 'MOODLE-CLOUDFRONT-DIST-ID', {
      value: cf.distributionId
    });
  }
}
