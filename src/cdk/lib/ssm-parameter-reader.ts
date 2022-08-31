import { Construct } from 'constructs';
import { AwsCustomResource, AwsSdkCall } from 'aws-cdk-lib/custom-resources';
import * as iam from 'aws-cdk-lib/aws-iam';

interface SSMParameterReaderProps {
  parameterName: string;
  region: string;
}

export class SSMParameterReader extends AwsCustomResource {
  constructor(scope: Construct, name: string, props: SSMParameterReaderProps) {
    const { parameterName, region } = props;

    const ssmAwsSdkCall: AwsSdkCall = {
      service: 'SSM',
      action: 'getParameter',
      parameters: {
        Name: parameterName
      },
      region: region,
      physicalResourceId: { id: Date.now().toString() } // Update physical id to always fetch the latest version
    };

    super(scope, name, { 
      onUpdate: ssmAwsSdkCall, 
      policy: {
        statements: [ 
          new iam.PolicyStatement({
            resources: [ '*' ],
            actions: [ 'ssm:GetParameter' ],
            effect: iam.Effect.ALLOW,
          })
        ]
      }
    });
  }

  public getParameterValue(): string {
    return this.getResponseField('Parameter.Value').toString();
  }
}