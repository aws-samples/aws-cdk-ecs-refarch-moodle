import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as targets from 'aws-cdk-lib/aws-route53-targets';
import { Construct } from 'constructs';

export interface DnsConstructProps {
  hostedZoneId: string;
  domain: string;
  enableCloudFront: boolean;
  distribution?: cloudfront.Distribution;
  loadBalancer?: elbv2.ApplicationLoadBalancer;
}

export class DnsConstruct extends Construct {
  public readonly hostedZone: route53.IHostedZone;

  constructor(scope: Construct, id: string, props: DnsConstructProps) {
    super(scope, id);

    // Derive domain name from full domain
    const domainParts = props.domain.split('.');
    const domainName = domainParts.slice(1).join('.');

    // Import existing hosted zone
    this.hostedZone = route53.HostedZone.fromHostedZoneAttributes(this, 'hosted-zone', {
      hostedZoneId: props.hostedZoneId,
      zoneName: domainName
    });

    // Create DNS records based on configuration
    if (props.enableCloudFront && props.distribution) {
      this.createCloudFrontRecords(props.domain, props.distribution);
    } else if (props.loadBalancer) {
      this.createLoadBalancerRecords(props.domain, props.loadBalancer);
    }
  }

  private createCloudFrontRecords(domain: string, distribution: cloudfront.Distribution): void {
    // Route53 records for CloudFront
    new route53.ARecord(this, 'domain-alias-a-record', {
      zone: this.hostedZone,
      recordName: domain,
      target: route53.RecordTarget.fromAlias(new targets.CloudFrontTarget(distribution))
    });

    new route53.AaaaRecord(this, 'domain-alias-aaaa-record', {
      zone: this.hostedZone,
      recordName: domain,
      target: route53.RecordTarget.fromAlias(new targets.CloudFrontTarget(distribution))
    });
  }

  private createLoadBalancerRecords(domain: string, loadBalancer: elbv2.ApplicationLoadBalancer): void {
    // Route53 records for direct ALB access
    new route53.ARecord(this, 'domain-alias-a-record', {
      zone: this.hostedZone,
      recordName: domain,
      target: route53.RecordTarget.fromAlias(new targets.LoadBalancerTarget(loadBalancer))
    });

    new route53.AaaaRecord(this, 'domain-alias-aaaa-record', {
      zone: this.hostedZone,
      recordName: domain,
      target: route53.RecordTarget.fromAlias(new targets.LoadBalancerTarget(loadBalancer))
    });
  }
}