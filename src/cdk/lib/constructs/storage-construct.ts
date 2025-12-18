import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as efs from 'aws-cdk-lib/aws-efs';
import { Construct } from 'constructs';

export interface StorageConstructProps {
  vpc: ec2.IVpc;
  lifecyclePolicy?: efs.LifecyclePolicy;
  performanceMode?: efs.PerformanceMode;
  throughputMode?: efs.ThroughputMode;
  enableAutomaticBackups?: boolean;
}

export class StorageConstruct extends Construct {
  public readonly fileSystem: efs.FileSystem;
  public readonly accessPoint: efs.AccessPoint;

  constructor(scope: Construct, id: string, props: StorageConstructProps) {
    super(scope, id);

    // EFS File System
    this.fileSystem = new efs.FileSystem(this, 'efs', {
      vpc: props.vpc,
      lifecyclePolicy: props.lifecyclePolicy || efs.LifecyclePolicy.AFTER_30_DAYS,
      outOfInfrequentAccessPolicy: efs.OutOfInfrequentAccessPolicy.AFTER_1_ACCESS,
      performanceMode: props.performanceMode || efs.PerformanceMode.GENERAL_PURPOSE,
      throughputMode: props.throughputMode || efs.ThroughputMode.ELASTIC,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      enableAutomaticBackups: props.enableAutomaticBackups !== false
    });

    // EFS Access Point
    this.accessPoint = this.fileSystem.addAccessPoint('access-point', {
      path: '/'
    });
  }
}