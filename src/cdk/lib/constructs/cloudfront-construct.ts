import * as cdk from 'aws-cdk-lib';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { Construct } from 'constructs';

export interface CloudFrontConstructProps {
  loadBalancer: elbv2.ApplicationLoadBalancer;
  cfCustomHeaderSecret: secretsmanager.Secret;
  cfCertificateArn: string;
  cfWafArn: string;
  domain: string;
  cfDistributionOriginTimeoutSeconds?: number;
}

export class CloudFrontConstruct extends Construct {
  public readonly distribution: cloudfront.Distribution;

  constructor(scope: Construct, id: string, props: CloudFrontConstructProps) {
    super(scope, id);

    // Create VPC Origin for CloudFront distribution with custom header
    const vpcOrigin = origins.VpcOrigin.withApplicationLoadBalancer(props.loadBalancer, {
      httpsPort: 443,
      originSslProtocols: [cloudfront.OriginSslPolicy.TLS_V1_2],
      protocolPolicy: cloudfront.OriginProtocolPolicy.HTTPS_ONLY,
      vpcOriginName: 'moodle-alb-vpc-origin',
      customHeaders: {
        'X-Origin-Verify': props.cfCustomHeaderSecret.secretValue.unsafeUnwrap()
      },
      ...(props.cfDistributionOriginTimeoutSeconds && {
        readTimeout: cdk.Duration.seconds(props.cfDistributionOriginTimeoutSeconds)
      })
    });

    // CloudFront distribution with private ALB origin
    this.distribution = new cloudfront.Distribution(this, 'distribution', {
      comment: `Moodle distribution for ${props.domain}`,
      defaultBehavior: {
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        origin: vpcOrigin,
        cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
        originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER
      },
      domainNames: [props.domain],
      certificate: acm.Certificate.fromCertificateArn(this, 'cf-cert', props.cfCertificateArn),
      webAclId: props.cfWafArn,
    });
  }
}