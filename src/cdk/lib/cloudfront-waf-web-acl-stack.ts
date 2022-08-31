import * as wafv2 from 'aws-cdk-lib/aws-wafv2';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as cdk from 'aws-cdk-lib';
import { StackProps } from 'aws-cdk-lib';

export class CloudFrontWAFWebAclStack extends cdk.Stack {

  constructor(scope: cdk.App, id: string, props: StackProps) {
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

    const ssmParam = new ssm.StringParameter(this, 'cf-waf-web-acl-arn-ssm-param', {
      parameterName: 'cf-waf-web-acl-arn',
      description: 'The WAFv2 Web ACL used for CloudFront for Moodle',
      stringValue: cfWaf.attrArn
    });

    // Outputs
    new cdk.CfnOutput(this, 'CLOUDFRONT-WAF-WEB-ACL-ARN', {
      value: cfWaf.attrArn
    });
  }
}
