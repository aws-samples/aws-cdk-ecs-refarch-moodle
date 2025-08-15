import * as cdk from 'aws-cdk-lib';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as wafv2 from 'aws-cdk-lib/aws-wafv2';

export interface CloudFrontInfraStackProps extends cdk.StackProps {
  useExistingCfCertificate: boolean;
  domainName: string;
  hostName: string;
  hostedZoneId: string;
}

export class CloudFrontInfraStack extends cdk.Stack {
  public readonly cfCertificate: acm.ICertificate;
  public readonly cfWafArn: string;

  constructor(scope: cdk.App, id: string, props: CloudFrontInfraStackProps) {
    super(scope, id, props);

    // WAFv2 for CloudFront
    var cfWaf = new wafv2.CfnWebACL(this, 'cf-waf', {
      name: 'moodle-cf-waf-acl',
      description: 'Web ACL for Moodle CloudFront',
      scope: 'CLOUDFRONT',
      visibilityConfig: {
        sampledRequestsEnabled: true,
        cloudWatchMetricsEnabled: true,
        metricName: 'moodle-waf-metrics'
      },
      defaultAction: {
        allow: {}
      },
      rules: [
        {
          name: 'AWS-AWSManagedRulesAmazonIpReputationList',
          priority: 0,
          statement: {
            managedRuleGroupStatement: {
              vendorName: 'AWS',
              name: 'AWSManagedRulesAmazonIpReputationList',
              excludedRules: []
            }
          },
          overrideAction: {
            none: {}
          },
          visibilityConfig: {
            sampledRequestsEnabled: true,
            cloudWatchMetricsEnabled: true,
            metricName: 'AWS-AWSManagedRulesAmazonIpReputationList-metrics'
          }
        }
      ]
    });
    this.cfWafArn = cfWaf.attrArn

    if (!props.useExistingCfCertificate) {
      // Import existing hosted zone
      const hostedZone = route53.HostedZone.fromHostedZoneAttributes(this, 'hosted-zone', {
        hostedZoneId: props.hostedZoneId,
        zoneName: props.domainName
      });

      // CloudFront certificate
      this.cfCertificate = new acm.Certificate(this, 'cf-new-certificate', {
        domainName: `${props.hostName}.${props.domainName}`,
        validation: acm.CertificateValidation.fromDns(hostedZone)
      });
    }

    // Outputs
    new cdk.CfnOutput(this, 'CLOUDFRONT-WAF-WEB-ACL-ARN', {
      value: cfWaf.attrArn
    });
  }
}
