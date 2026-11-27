import * as cdk from 'aws-cdk-lib';
import * as cloudtrail from 'aws-cdk-lib/aws-cloudtrail';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';

export interface NetworkConstructProps {
  enableFlowLogs?: boolean;
  enableCloudTrail?: boolean;
  // CloudFront VPC origin connections to an internal ALB are terminated by
  // VPC Block Public Access unless the ALB's private subnets are excluded.
  allowCloudFrontVpcOriginIngress?: boolean;
}

export class NetworkConstruct extends Construct {
  public readonly vpc: ec2.Vpc;
  public readonly cloudTrail?: cloudtrail.Trail;

  constructor(scope: Construct, id: string, props: NetworkConstructProps = {}) {
    super(scope, id);

    // VPC with flow logs
    this.vpc = new ec2.Vpc(this, 'vpc', {
      maxAzs: 2,
      ...(props.enableFlowLogs !== false && {
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
      })
    });

    // VPC Endpoints for private subnet connectivity
    this.vpc.addInterfaceEndpoint('ecr-vpc-endpoint', {
      service: ec2.InterfaceVpcEndpointAwsService.ECR
    });
    
    this.vpc.addInterfaceEndpoint('ecr-dkr-vpc-endpoint', {
      service: ec2.InterfaceVpcEndpointAwsService.ECR_DOCKER
    });
    
    this.vpc.addGatewayEndpoint('s3-vpc-endpoint', {
      service: ec2.GatewayVpcEndpointAwsService.S3
    });
    
    this.vpc.addInterfaceEndpoint('secrets-manager-vpc-endpoint', {
      service: ec2.InterfaceVpcEndpointAwsService.SECRETS_MANAGER
    });
    
    this.vpc.addInterfaceEndpoint('cloudwatch-logs-vpc-endpoint', {
      service: ec2.InterfaceVpcEndpointAwsService.CLOUDWATCH_LOGS
    });

    // Subnet-scoped exclusions keep the rest of the VPC under the account's BPA mode.
    // These subnets have no IGW route, and the ALB security group only admits the
    // CloudFront origin-facing prefix list, so bidirectional mode adds no other path.
    if (props.allowCloudFrontVpcOriginIngress) {
      this.vpc.privateSubnets.forEach((subnet, index) => {
        new ec2.CfnVPCBlockPublicAccessExclusion(this, `bpa-exclusion-private-${index}`, {
          subnetId: subnet.subnetId,
          internetGatewayExclusionMode: 'allow-bidirectional',
          tags: [{ key: 'Purpose', value: 'CloudFront VPC origin ingress' }]
        });
      });
    }
    // CloudTrail (optional)
    if (props.enableCloudTrail !== false) {
      const trailBucket = new s3.Bucket(this, 'cloudtrail-bucket', {
        blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
        enforceSSL: true,
        encryption: s3.BucketEncryption.S3_MANAGED
      });
      
      this.cloudTrail = new cloudtrail.Trail(this, 'cloudtrail-trail', {
        bucket: trailBucket
      });
    }
  }
}