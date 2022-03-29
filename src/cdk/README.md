# Deploying Moodle on ECS with Fargate

This document describes the steps to deploy Moodle on ECS with Fargate as part of Moodle LMS on AWS Serverless Containers solution. For the solution overview, refer to the main [document](../../README.md).

___

## High-Level Architecture

![Moodle on ECS Fargate Architecture](/docs/images/moodle-ecs-stack.jpg "Moodle on ECS Fargate Architecture")

___

## Prerequisites

### Domain Name
You will need a public domain name in order to request a public certificate in AWS ACM. If you don't have a public domain name yet, consider using Amazon Route 53 to register a new domain: https://docs.aws.amazon.com/Route53/latest/DeveloperGuide/domain-register.html. This domain name will also be used for CloudFront alternative domain name.

### Tools
1. Install and configure AWS CLI with your IAM user: https://aws.amazon.com/cli/
2. Install CDK: https://docs.aws.amazon.com/cdk/v2/guide/getting_started.html#getting_started_install
3. Install Docker: https://docs.docker.com/engine/install/

___

## Publishing Moodle Container Image on Amazon Elastic Container Registry
Before deploying the solution, you must first build the Moodle container image and publish it into Amazon Elastic Container Registry.
1. From the top directory, run `docker build -t moodle-image src/image/src`
2. Authenticate to your default registry.
    ```
    aws ecr get-login-password --region [your-region] | docker login --username AWS --password-stdin [your-aws-account-id].dkr.ecr.[your-region].amazonaws.com
    ```
3. Create a new ECR Repository to hold the image.
    ```
    aws ecr create-repository \
    --repository-name moodle-image \
    --region [your-region]
    ```
4. Tag the image to push to your repository.
    ```
    docker tag moodle-image:latest [your-aws-account-id].dkr.ecr.[your-region].amazonaws.com/moodle-image:latest
    ```
5. Push the image.
    ```
    docker push [your-aws-account-id].dkr.ecr.[your-region].amazonaws.com/moodle-image:latest
    ``` 

___

## Deployment
The following are the steps to deploy the solution:
1. [Request two public certificates](https://docs.aws.amazon.com/acm/latest/userguide/gs-acm-request-public.html) for your domain name using AWS Certificate Manager (ACM). The first one is for the Application Load Balancer where your solution will be deployed (e.g. `ap-southeast-1`), the second one is for the CloudFront in the `us-east-1` region. Note the certificate ARNs to be used in the next step.
2. Replace the `AlbCertificateArn` and `CFCertificateArn` property in the file `src/cdk/bin/cdk.ts` with your ACM certificate ARN. 
3. Replace the `CFDomain` property in the file `src/cdk/bin/cdk.ts` with the domain name that you would like to use with CloudFront.
4. Replace the `MoodleImageUri` property in the file `src/cdk/bin/cdk.ts` with the Moodle container image URI that you've pushed before, e.g. `[your-aws-account-id].dkr.ecr.[your-region].amazonaws.com/moodle-image:latest`.
5. Go to this directory `cd src/cdk` and then run `npm install`.
6. Run `cdk bootstrap` (You only need to perform this once)
7. Run `cdk deploy` to deploy this solution.
8. Once successfully deployed, Moodle will begin first-time installation and it will take approximately 15 - 20 minutes. You can check the progress by checking at the logs in ECS console.
9. Once it is completed, you can access the application endpoint on the ALB endpoint described in the deployment output `APPLICATIONLOADBALANCERDNSNAME`.
10. (Optional) You can configure a domain record for the ALB endpoint to clear the SSL warning.
11. Use the username described in `MOODLEUSERNAME` output and fetch the password on Secrets Manager with the ARN described in the `MOODLEPASSWORDSECRETARN` output.
12. Finally, to improve Moodle application performance, configure Moodle caching using the ElastiCache Redis endpoint described in the `MOODLEREDISPRIMARYENDPOINTADDRESSANDPORT` output.
    - Add the cache store instance using the ElastiCache Redis endpoint. Refer to the following documentation: [Adding cache store instances](https://docs.moodle.org/311/en/Caching#Adding_cache_store_instances)
    - Set the `Application` cache to use the Redis cache store instance added previously. Refer to the following documentation: [Setting the stores that get used when no mapping is present](https://docs.moodle.org/311/en/Caching#Setting_the_stores_that_get_used_when_no_mapping_is_present)
13. Scale the number of `desiredCount` and `minCapacity` to adjust the number of replicas. Also configure the `healthCheckGracePeriod` from 30 minutes to 120 seconds in the `src/cdk/lib/ecs-moodle-stack.ts`. Below is an example:
````
// Moodle ECS Service
const moodleService = new ecs.FargateService(this, 'moodle-service', {
  cluster: cluster,
  taskDefinition: moodleTaskDefinition,
  desiredCount: 4, // Modify the desiredCount
  capacityProviderStrategies: [ // Every 1 task which uses FARGATE, 3 tasks will use FARGATE_SPOT (25% / 75%)
    {
      capacityProvider: 'FARGATE_SPOT',
      weight: 3
    },
    {
      capacityProvider: 'FARGATE',
      weight: 1
    }
  ],
  vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_NAT },
  enableECSManagedTags: true,
  maxHealthyPercent: 200,
  minHealthyPercent: 50,
  healthCheckGracePeriod: cdk.Duration.seconds(120) // Modify the healthCheckGracePeriod
});

// Moodle ECS Service Task Auto Scaling
const moodleServiceScaling = moodleService.autoScaleTaskCount({ minCapacity: 4, maxCapacity: 10 } ); // Modify the minCapacity
moodleServiceScaling.scaleOnCpuUtilization('cpu-scaling', {
  targetUtilizationPercent: 50
});
````
14. Due to the Moodle software design, some long-running operations are being done synchronously. For example, administrator would like to install a plugin and then submit the request; Instead of performing the task in the background, Moodle will process the request and browser will wait for the Moodle server to finish the installation and return the response where it can take sometime to complete. The current CloudFront origin response timeout is being set to the maximum allowed by default which is 60 seconds. We recommend to increase this to 180 seconds to avoid issues caused by CloudFront dropping the connection while operations are still running. For more details, please refer to this [documentation](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/distribution-web-values-specify.html#DownloadDistValuesOriginResponseTimeout).

___

## Next Steps: Deploying CI/CD Infrastructure Stack
Next you can continue to [Deploying CI/CD Infrastructure Stack](../cicd/README.md).

___

## Teardown
You should consider deleting the application infrastructure once you no longer need it to save costs. Use `cdk destroy` to delete the CDK application.