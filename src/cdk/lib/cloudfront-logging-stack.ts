import * as cdk from 'aws-cdk-lib';
import * as logs from 'aws-cdk-lib/aws-logs';

export interface CloudFrontLoggingStackProps extends cdk.StackProps {
  distributionArn: string;
}

export class CloudFrontLoggingStack extends cdk.Stack {
  constructor(scope: cdk.App, id: string, props: CloudFrontLoggingStackProps) {
    super(scope, id, props);

    // CloudWatch Logs group for CloudFront logs (must be in us-east-1)
    const cfLogGroup = new logs.LogGroup(this, 'cloudfront-logs', {
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: cdk.RemovalPolicy.DESTROY
    });

    // Create delivery destination for CloudWatch Logs
    const deliveryDestination = new logs.CfnDeliveryDestination(this, 'cloudfront-delivery-destination', {
      name: `moodle-cf-logs-dest-${cdk.Stack.of(this).account}`,
      destinationResourceArn: cfLogGroup.logGroupArn
    });

    // Create delivery source for CloudFront logs
    const deliverySource = new logs.CfnDeliverySource(this, 'cloudfront-delivery-source', {
      name: `moodle-cf-logs-source-${cdk.Stack.of(this).account}`,
      resourceArn: props.distributionArn,
      logType: 'ACCESS_LOGS'
    });

    // Create delivery to connect source to destination
    const delivery = new logs.CfnDelivery(this, 'cloudfront-log-delivery', {
      deliverySourceName: deliverySource.name,
      deliveryDestinationArn: deliveryDestination.attrArn
    });

    // Ensure delivery source is created before delivery
    delivery.addDependency(deliverySource);
  }
}
