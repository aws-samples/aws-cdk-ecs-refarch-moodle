import * as cdk from 'aws-cdk-lib';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { Construct } from 'constructs';

export interface LoadBalancerConstructProps {
  vpc: ec2.IVpc;
  service: ecs.FargateService;
  enableCloudFront: boolean;
  useExistingAlbCertificate: boolean;
  albCertificateArn?: string;
  hostedZoneId?: string;
  domain: string;
  cfCustomHeaderSecret?: secretsmanager.Secret;
}

export class LoadBalancerConstruct extends Construct {
  public readonly loadBalancer: elbv2.ApplicationLoadBalancer;
  public readonly targetGroup: elbv2.ApplicationTargetGroup;
  public readonly httpsListener: elbv2.ApplicationListener;

  constructor(scope: Construct, id: string, props: LoadBalancerConstructProps) {
    super(scope, id);

    // Determine certificate ARN
    const albCertificateArn = this.getCertificateArn(props);

    // Create Application Load Balancer
    this.loadBalancer = new elbv2.ApplicationLoadBalancer(this, 'alb', {
      loadBalancerName: props.enableCloudFront ? 'moodle-ecs-alb' : 'moodle-ecs-alb-direct',
      vpc: props.vpc,
      internetFacing: !props.enableCloudFront,
      vpcSubnets: { 
        subnetType: props.enableCloudFront 
          ? ec2.SubnetType.PRIVATE_WITH_EGRESS 
          : ec2.SubnetType.PUBLIC 
      }
    });

    // Create Target Group
    this.targetGroup = new elbv2.ApplicationTargetGroup(this, 'target-group', {
      vpc: props.vpc,
      port: 8080,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targets: [
        props.service.loadBalancerTarget({
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

    // Create HTTPS Listener
    this.httpsListener = this.loadBalancer.addListener('https-listener', {
      port: 443,
      protocol: elbv2.ApplicationProtocol.HTTPS,
      open: !props.enableCloudFront,
      certificates: [elbv2.ListenerCertificate.fromArn(albCertificateArn)],
      defaultAction: props.enableCloudFront 
        ? elbv2.ListenerAction.fixedResponse(403, {
            contentType: 'text/plain',
            messageBody: 'Access denied'
          })
        : elbv2.ListenerAction.forward([this.targetGroup])
    });

    // Configure CloudFront-specific rules
    if (props.enableCloudFront && props.cfCustomHeaderSecret) {
      this.setupCloudFrontAccess(props.cfCustomHeaderSecret);
    }

    // Configure security groups
    this.setupSecurityGroups(props.enableCloudFront);
  }

  private getCertificateArn(props: LoadBalancerConstructProps): string {
    if (props.useExistingAlbCertificate && props.albCertificateArn) {
      return props.albCertificateArn;
    }

    if (!props.hostedZoneId) {
      throw new Error('hostedZoneId is required when not using existing ALB certificate');
    }

    // Derive domain name from full domain
    const domainParts = props.domain.split('.');
    const domainName = domainParts.slice(1).join('.');

    // Import existing hosted zone
    const hostedZone = route53.HostedZone.fromHostedZoneAttributes(this, 'hosted-zone', {
      hostedZoneId: props.hostedZoneId,
      zoneName: domainName
    });

    // Create new certificate
    const certificate = new acm.Certificate(this, 'alb-certificate', {
      domainName: props.domain,
      validation: acm.CertificateValidation.fromDns(hostedZone)
    });

    return certificate.certificateArn;
  }

  private setupCloudFrontAccess(cfCustomHeaderSecret: secretsmanager.Secret): void {
    // Add rule to only allow requests with correct custom header
    this.httpsListener.addAction('allow-cloudfront', {
      priority: 1,
      conditions: [
        elbv2.ListenerCondition.httpHeader('X-Origin-Verify', [
          cfCustomHeaderSecret.secretValue.unsafeUnwrap()
        ])
      ],
      action: elbv2.ListenerAction.forward([this.targetGroup])
    });
  }

  private setupSecurityGroups(enableCloudFront: boolean): void {
    if (enableCloudFront) {
      const cfPrefixList = ec2.PrefixList.fromLookup(this, 'cloudfront-prefix-list', {
        prefixListName: 'com.amazonaws.global.cloudfront.origin-facing'
      });

      // Allow traffic from CloudFront VPC Origin managed prefix list
      this.loadBalancer.connections.allowFrom(
        ec2.Peer.prefixList(cfPrefixList.prefixListId),
        ec2.Port.tcp(443),
        'Allow CloudFront VPC Origin (managed prefix list) to access private ALB'
      );
    }
    // For direct access, ALB is already configured as internet-facing with open=true
  }
}