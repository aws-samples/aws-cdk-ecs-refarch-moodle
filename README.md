# Modernizing Moodle LMS with AWS Serverless Containers

## Overview

This repository consists of an [AWS Cloud Development Kit (AWS CDK)](https://aws.amazon.com/cdk/) application to deploy a highly-available, elastic, and scalable Moodle LMS application using containers technology on AWS by leveraging [Amazon Elastic Container Services (Amazon ECS)](https://aws.amazon.com/ecs/) and [AWS Fargate](https://aws.amazon.com/fargate/). More details on upcoming blog post.

## Architecture

Below is the high-level architecture for the solution.

![Solution Overview](docs/images/solution-overview.jpg)

The solution is deployed with high-availability using 2 Availability Zones with the following components:

- [Amazon CloudFront](https://aws.amazon.com/cloudfront/) distribution is created as the endpoint for end-users to access the Moodle application. CloudFront improves the performance of the application by serving the content near to where the end-users are located with low latency. 
- [AWS WAF](https://aws.amazon.com/waf/) Web ACL is created and associated with the CloudFront distribution with Amazon IP reputation list rule enabled. You can also enable additional rules as needed in this Web ACL.
- Behind CloudFront, the Moodle application traffic is load-balanced using [Application Load Balancer (ALB)](https://aws.amazon.com/elasticloadbalancing/application-load-balancer/) and secured with encryption-in-transit with the TLS certificate stored in [AWS Certificate Manager (ACM)](https://aws.amazon.com/certificate-manager/). ALB automatically distributes the incoming traffic across multiple Moodle instances. It monitors the health of its registered targets, and routes traffic only to the healthy targets. ALB scales the load balancer as the incoming traffic changes over time. ALB functions at the application layer, the seventh layer of the Open Systems Interconnection (OSI) model. 
- As the core of the application, the Moodle instances is running on ECS using combination of Fargate and Fargate Spot. Amazon ECS service will automatically orchestrate multiple Amazon ECS tasks that is running the Moodle containers. The container image for the application is based on [Bitnami Moodle Docker image](https://github.com/bitnami/bitnami-docker-moodle) with some modifications to enable Redis caching integration. The container image is stored in [Amazon Elastic Container Registry (Amazon ECR)](https://aws.amazon.com/ecr/).
- To enable sharing of moodledata across multiple Moodle instances, a shared file system is required for this solution. [Amazon Elastic File System (Amazon EFS)](https://aws.amazon.com/efs/) is a simple, serverless, set-and-forget elastic file system that makes it easy to set up, scale, and cost-optimize file storage in AWS. Amazon EFS is deployed and mounted on the ECS tasks to be used as underlying moodle and moodledata filesystem.
- The Moodle database is also centralized and deployed into an [Amazon Relational Database Service (Amazon RDS)](https://aws.amazon.com/rds/) instance. Amazon RDS is a managed service that makes it easy to set up, operate, and scale a relational database in the cloud. It provides cost-efficient and resizable capacity, while managing time-consuming database administration tasks, allowing you to focus on your applications and business.
- To improve the overall performance of the application, Moodle has a built-in caching mechanism that make use of memory, filesystem, or external cache store such as Memcached or Redis. This solution use [Amazon ElastiCache for Redis](https://aws.amazon.com/elasticache/redis/) as a centralized cache store. ElastiCache for Redis makes it easy to deploy and run Redis protocol-compliant server nodes in AWS.
- [AWS Secrets Manager](https://aws.amazon.com/secrets-manager/) is being used during CDK deployment to securely store sensitive data such as database password and Moodle administrator password. AWS Secrets Manager is a secrets management service that helps you protect access to your applications, services, and IT resources.
- [Amazon CloudWatch](https://aws.amazon.com/cloudwatch/) is a monitoring service for AWS cloud resources and the applications you run on AWS. You can use Amazon CloudWatch to collect and track metrics, collect and monitor log files, and set alarms. Amazon CloudWatch Logs and CloudWatch Container Insights is enabled in this solution to provide metrics and logs information from Moodle application.

___

## Deployment

### Prerequisites

1. Install and configure AWS CLI with your IAM user and your preferred region: https://aws.amazon.com/cli/
2. Install CDK: https://docs.aws.amazon.com/cdk/v2/guide/getting_started.html#getting_started_install
3. Install Docker: https://docs.docker.com/engine/install/
4. Pull the source code into your machine
    ```
    git clone https://github.com/aws-samples/aws-cdk-ecs-refarch-moodle.git
    ```
    
### Setting up Domain Name and TLS Certificate
1. Setup a public domain name in order to request a public certificate in AWS Certificate Manager. If you don’t have a public domain name yet, you can use [Amazon Route 53](https://aws.amazon.com/route53/) to [register a new domain](https://docs.aws.amazon.com/Route53/latest/DeveloperGuide/domain-register.html). This domain name will also be used for CloudFront alternative domain name
2. [Request two public certificates](https://docs.aws.amazon.com/acm/latest/userguide/gs-acm-request-public.html) for your domain name using AWS Certificate Manager (ACM). The first one is for the Application Load Balancer where this solution will be deployed (e.g. ap-southeast-1), the second one is for the CloudFront in the us-east-1 region. For example: `moodle.example.com` or `*.example.com`. Note the certificate ARNs to be used in the deployment steps.

### Publishing Moodle Container Image into Amazon Elastic Container Registry (Amazon ECR)

Prior to deploying the solution, you must first build the Moodle container image locally and publish it into Amazon ECR.

1. From the top directory of the source code, run the following to build the container image
    ```
    docker build -t moodle-image src/image/src
    ```
2. Authenticate to your default AWS account registry.
    ```
    aws ecr get-login-password --region [your-region] | docker login --username AWS --password-stdin [your-aws-account-id].dkr.ecr.[your-region].amazonaws.com (http://amazonaws.com/)
    ```
3. Create a new ECR Repository to hold the image.
    ```
    aws ecr create-repository \
    --repository-name moodle-image \
    --region [your-region]
    ```
4. Tag the image to push to your repository.
    ```
    docker tag moodle-image:latest [your-aws-account-id].dkr.ecr.[your-region].amazonaws.com/moodle-image:latest (http://amazonaws.com/moodle-image:latest)
    ```
5. Push the image.
    ```
    docker push [your-aws-account-id].dkr.ecr.[your-region].amazonaws.com/moodle-image:latest (http://amazonaws.com/moodle-image:latest)
    ```

### Deployment Steps

1. Configure the context in the file `src/cdk/cdk.json`.
    - Configure `app-config/albCertificateArn` and `app-config/cfCertificateArn` with the ACM certificate ARN.
    - Configure the `app-config/cfDomain` for CloudFront with the same domain name as the public certificates that you’ve requested during the prerequisites step. For example: `moodle.example.com`.
    - Configure the `app-config/moodleImageUri` with the Moodle container image URI that you've pushed prior to deployment steps, for example `[your-aws-account-id].dkr.ecr.[your-region].amazonaws.com/moodle-image:latest`.
2. Go to the CDK app directory `cd src/cdk` and then run `npm install`.
3. Run `cdk bootstrap` to bootstrap CDK toolkit (You only need to perform this once).
4. Run `cdk deploy --all` to deploy the CDK app. This will deploy 2 stacks, the first one is deployed in `us-east-1` region containing AWS WAF Web ACL for CloudFront, the second one is the main stack which is deployed in the region that you've specified in your AWS CLI configuration.
5. Once successfully deployed, Moodle will begin first-time installation and it will take approximately 15 - 20 minutes. You can check the progress by checking at the logs in Amazon ECS console.
6. Once it is completed, you can access the application endpoint on the ALB endpoint described in the deployment output `APPLICATIONLOADBALANCERDNSNAME`.

### Post-Deployment Steps
1. (Optional) You can configure a DNS record to map into the ALB endpoint to clear the SSL warning in your web browser.
2. Login to the Moodle application by using the username described in `MOODLEUSERNAME` output and fetch the password on AWS Secrets Manager with the ARN described in the `MOODLEPASSWORDSECRETARN` output.
3. In order to improve Moodle application performance, configure Moodle caching using the Amazon ElastiCache Redis endpoint described in the `MOODLEREDISPRIMARYENDPOINTADDRESSANDPORT` output.
    - Add the cache store instance using the Amazon ElastiCache Redis endpoint. Refer to the official Moodle documentation: [Adding cache store instances](https://docs.moodle.org/311/en/Caching#Adding_cache_store_instances).
    - Set the Application cache to use the Redis cache store instance that was added in the previous step. Refer to the official Moodle documentation: [Setting the stores that get used when no mapping is present](https://docs.moodle.org/311/en/Caching#Setting_the_stores_that_get_used_when_no_mapping_is_present).
4. You can scale the number of the Moodle instance replicas by configuring `app-config/serviceReplicaDesiredCount` context in the file `src/cdk/cdk.json`. Then configure the `app-config/serviceHealthCheckGracePeriodSeconds` context from 1800 to 300 seconds. You can run `cdk diff` to view the comparison between the current version with the already-deployed version. You can then run `cdk deploy --all` again to apply the latest configurations.
5. To access the Moodle application from CloudFront endpoint, you will need to create a CNAME DNS record using the domain name that you’ve configured in step 1b with record value specified in `CLOUDFRONTDNSNAME` output. For example: `moodle.example.com`. 

    If you are getting 502 error, it might be the TLS handshake between CloudFront and ALB is failing because of the domain name in the TLS certificate for ALB does not match with the `Host` header forwarded from CloudFront (The `Host` header in this case will be the domain name that you are using to access CloudFront). 

> **Note on CloudFront Usage:** Due to the Moodle software design, some long-running operations are being done synchronously. For example, administrator would like to install a plugin and then submit the request. Instead of performing the task in the background, Moodle will process the request and browser will wait for the Moodle server to finish the installation and return the response where it can take sometime to complete. The current CloudFront origin response timeout is being set to the maximum allowed by default which is 60 seconds. We recommend to increase this to 180 seconds to avoid issues caused by CloudFront dropping the connection while operations are still running. You can submit the request to increase the timeout by [creating a case in the AWS Support Center](https://console.aws.amazon.com/support/home?region=us-east-1#/case/create?issueType=service-limit-increase&limitType=service-code-cloudfront-distributions). Once the request has been approved, you can configure the `app-config/cfDistributionOriginTimeoutSeconds` context to the duration that you’ve requested. Alternatively site administrator can use Application Load Balancer endpoint to perform long-running operations.

### Cleanup

You can run `cdk destroy --all` to delete the CDK application.
