import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { Platform } from 'aws-cdk-lib/aws-ecr-assets';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as efs from 'aws-cdk-lib/aws-efs';

import * as rds from 'aws-cdk-lib/aws-rds';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { Construct } from 'constructs';

export interface ComputeConstructProps {
  vpc: ec2.IVpc;
  database: rds.DatabaseInstance | rds.DatabaseCluster;
  fileSystem: efs.FileSystem;
  accessPoint: efs.AccessPoint;
  cacheSecurityGroup: ec2.ISecurityGroup;
  containerPlatform: string;
  serviceReplicaDesiredCount: number;
  serviceHealthCheckGracePeriodSeconds: number;
  rdsEngine: string;
  databaseName: string;
  databaseUsername: string;
  domain: string;
  moodleImageUri?: string;
}

export class ComputeConstruct extends Construct {
  public readonly cluster: ecs.Cluster;
  public readonly service: ecs.FargateService;
  public readonly taskDefinition: ecs.FargateTaskDefinition;
  public readonly moodlePasswordSecret: secretsmanager.Secret;

  constructor(scope: Construct, id: string, props: ComputeConstructProps) {
    super(scope, id);

    // Validate container platform
    const containerPlatform = props.containerPlatform || 'X86';
    if (!['ARM', 'X86'].includes(containerPlatform)) {
      throw new Error('containerPlatform must be either "ARM" or "X86"');
    }

    // ECS Cluster
    this.cluster = new ecs.Cluster(this, 'cluster', {
      vpc: props.vpc,
      clusterName: 'moodle-ecs-cluster',
      containerInsightsV2: ecs.ContainerInsights.ENABLED,
      enableFargateCapacityProviders: true
    });

    // Moodle Password Secret
    this.moodlePasswordSecret = new secretsmanager.Secret(this, 'moodle-password-secret');

    // Task Definition
    this.taskDefinition = this.createTaskDefinition(containerPlatform, props);

    // ECS Service
    this.service = this.createService(props);

    // Auto Scaling
    this.setupAutoScaling(props.serviceReplicaDesiredCount);

    // Security Group Rules
    this.setupSecurityGroupRules(props);
  }

  private createTaskDefinition(
    containerPlatform: string,
    props: ComputeConstructProps
  ): ecs.FargateTaskDefinition {
    const taskDefinition = new ecs.FargateTaskDefinition(this, 'task-def', {
      cpu: 2048,
      memoryLimitMiB: 4096,
      runtimePlatform: {
        cpuArchitecture: containerPlatform === 'ARM' ? ecs.CpuArchitecture.ARM64 : ecs.CpuArchitecture.X86_64,
        operatingSystemFamily: ecs.OperatingSystemFamily.LINUX
      }
    });

    // EFS Volume
    taskDefinition.addVolume({
      name: 'moodle',
      efsVolumeConfiguration: {
        fileSystemId: props.fileSystem.fileSystemId,
        transitEncryption: "ENABLED",
        authorizationConfig: {
          accessPointId: props.accessPoint.accessPointId
        }
      }
    });

    // Container Image
    const moodleImage = props.moodleImageUri 
      ? ecs.ContainerImage.fromRegistry(props.moodleImageUri)
      : ecs.ContainerImage.fromAsset('../image/src', {
          platform: containerPlatform === 'ARM' ? Platform.LINUX_ARM64 : Platform.LINUX_AMD64
        });

    // Container Definition
    const containerDefinition = taskDefinition.addContainer('moodle-container', {
      containerName: 'moodle',
      image: moodleImage,
      memoryLimitMiB: 4096,
      portMappings: [{ containerPort: 8080 }],
      stopTimeout: cdk.Duration.seconds(30),
      environment: this.getEnvironmentVariables(props),
      secrets: {
        'MOODLE_DATABASE_PASSWORD': ecs.Secret.fromSecretsManager(props.database.secret!, 'password'),
        'MOODLE_PASSWORD': ecs.Secret.fromSecretsManager(this.moodlePasswordSecret)
      },
      logging: ecs.LogDrivers.awsLogs({ streamPrefix: 'ecs-moodle' })
    });

    // Mount EFS
    containerDefinition.addMountPoints({
      sourceVolume: 'moodle',
      containerPath: '/mnt/moodle',
      readOnly: false
    });

    return taskDefinition;
  }

  private getEnvironmentVariables(props: ComputeConstructProps): Record<string, string> {
    const isAurora = props.rdsEngine === 'aurora' || props.rdsEngine === 'aurora-serverless';
    const isCluster = props.database instanceof rds.DatabaseCluster;

    return {
      'MOODLE_DATABASE_TYPE': isAurora ? 'auroramysql' : (props.rdsEngine === 'mysql' ? 'mysqli' : 'mariadb'),
      'MOODLE_DATABASE_HOST': isCluster 
        ? (props.database as rds.DatabaseCluster).clusterEndpoint.hostname
        : (props.database as rds.DatabaseInstance).instanceEndpoint.hostname,
      'MOODLE_DATABASE_PORT_NUMBER': isCluster
        ? (props.database as rds.DatabaseCluster).clusterEndpoint.port.toString()
        : (props.database as rds.DatabaseInstance).instanceEndpoint.port.toString(),
      'MOODLE_DATABASE_NAME': props.databaseName,
      'MOODLE_DATABASE_USER': props.databaseUsername,
      'MOODLE_USERNAME': 'moodleadmin',
      'MOODLE_EMAIL': 'hello@example.com',
      'MOODLE_SITE_NAME': 'Scalable Moodle on ECS Fargate',
      'MOODLE_DNS_NAME': props.domain
    };
  }

  private createService(props: ComputeConstructProps): ecs.FargateService {
    const service = new ecs.FargateService(this, 'service', {
      cluster: this.cluster,
      taskDefinition: this.taskDefinition,
      desiredCount: props.serviceReplicaDesiredCount,
      capacityProviderStrategies: [
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
    });

    service.node.addDependency(this.cluster);

    // Add dependencies on Aurora instances if applicable
    if (props.rdsEngine === 'aurora' || props.rdsEngine === 'aurora-serverless') {
      const cfnService = service.node.defaultChild as ecs.CfnService;
      const dbCluster = props.database as rds.DatabaseCluster;

      for (const child of dbCluster.node.children) {
        if (child.node.defaultChild && child.node.defaultChild.constructor.name === 'CfnDBInstance') {
          cfnService.addDependency(child.node.defaultChild as cdk.CfnResource);
        }
      }
    }

    return service;
  }

  private setupAutoScaling(minCapacity: number): void {
    const scaling = this.service.autoScaleTaskCount({ 
      minCapacity, 
      maxCapacity: 10 
    });
    
    scaling.scaleOnCpuUtilization('cpu-scaling', {
      targetUtilizationPercent: 50
    });
  }

  private setupSecurityGroupRules(props: ComputeConstructProps): void {
    // Allow access to database
    props.database.connections.allowDefaultPortFrom(this.service, 'From Moodle ECS Service');
    
    // Allow access to EFS
    props.fileSystem.connections.allowDefaultPortFrom(this.service, 'From Moodle ECS Service');
    
    // Allow access to cache
    props.cacheSecurityGroup.connections.allowFrom(
      this.service, 
      ec2.Port.tcp(6379), 
      'From Moodle ECS Service'
    );
  }
}