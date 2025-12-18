# Modernize Moodle LMS with AWS serverless containers

This repository contains an [AWS Cloud Development Kit (AWS CDK)](https://aws.amazon.com/cdk/) application to deploy a highly-available, elastic, and scalable Moodle LMS application using AWS serverless technologies. The solution leverages [Amazon Elastic Container Services (Amazon ECS)](https://aws.amazon.com/ecs/) with [AWS Fargate](https://aws.amazon.com/fargate/) for serverless container orchestration, [Amazon Aurora Serverless v2](https://aws.amazon.com/rds/aurora/serverless/) for the database, and [Amazon ElastiCache Serverless](https://aws.amazon.com/elasticache/features/#Serverless) for caching. For workloads requiring more predictable performance or specific instance sizing, the solution also supports provisioned alternatives for both the database (Aurora Provisioned or RDS) and cache (ElastiCache Provisioned) layers.

**For detailed background and architecture overview, please visit the blog post:** [How to run Moodle LMS on serverless containers with AWS](https://aws.amazon.com/blogs/publicsector/modernize-moodle-lms-aws-serverless-containers/)

## Prerequisites

1. [Install Node.js](https://nodejs.org/) (version 18 or later)
1. [Install and configure AWS Command Line Interface (AWS CLI)](https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html) with your AWS Identity and Access Management (IAM) user
1. [Install AWS CDK](https://docs.aws.amazon.com/cdk/v2/guide/getting-started.html#getting-started-install)
1. [Install Docker](https://docs.docker.com/get-docker/) and ensure it's running (or an alternative like [Finch](https://github.com/runfinch/finch))
1. [Install Git](https://git-scm.com/downloads)
1. Clone this repository:
   ```bash
   git clone https://github.com/aws-samples/aws-cdk-ecs-refarch-moodle.git
   cd aws-cdk-ecs-refarch-moodle
   ```

## Setting up domain name and TLS certificate

### Option 1: Automated setup with Route 53 (Recommended)

If you already have a Route 53 hosted zone configured in your AWS account with a resolvable public domain, this option will automatically handle certificate creation and DNS configuration.

If you don't have a domain yet, you can [register a new domain with Amazon Route 53](https://docs.aws.amazon.com/Route53/latest/DeveloperGuide/domain-register.html).

1. Ensure your domain is properly configured:
   - Your Route 53 hosted zone must be publicly resolvable
   - The domain's nameservers must be pointing to the Route 53 hosted zone
   - You can verify this by running: `dig NS yourdomain.com` or `nslookup -type=NS yourdomain.com`

1. The CDK deployment will automatically:
   - Create and validate ACM certificates for both the ALB and CloudFront
   - Create the necessary DNS records in Route 53
   - Configure the domain for your Moodle deployment

### Option 2: Manual certificate and DNS setup

If you prefer to manage certificates or DNS manually:

1. Set up a public domain name. If you don't have one yet, you can use [Amazon Route 53 to register a new domain](https://docs.aws.amazon.com/Route53/latest/DeveloperGuide/domain-register.html).

1. Request two public certificates for your domain name using ACM:
   - The first certificate is for the Application Load Balancer (ALB) in the region where this solution will be deployed (e.g., `us-west-2`)
   - The second certificate is for CloudFront, which must be in the `us-east-1` region
   - Use your domain name (e.g., `moodle.example.com` or `*.example.com`)
   - Note the certificate Amazon Resource Names (ARNs) for use in the deployment steps

## Deployment steps

1. Set the AWS_REGION environment variable for your desired deployment region:
   ```bash
   export AWS_REGION=us-west-2  # Replace with your preferred region
   ```
   
   This ensures that AWS CLI commands and CDK deployment target the correct region.

1. Navigate to the CDK app directory:
   ```bash
   cd src/cdk
   ```

1. Install dependencies:
   ```bash
   npm install
   ```

1. Configure the context in the file `src/cdk/cdk.json`:
   
   **If you followed Option 1 (automated Route 53 setup):**
   - `app-config/hostedZoneId`: Your Route 53 hosted zone ID
   - `app-config/domain`: Domain name for your Moodle application (e.g., `moodle.example.com`)
   - `app-config/albCertificateArn`: Leave as empty string `""`
   - `app-config/cfCertificateArn`: Leave as empty string `""`
   
   **If you followed Option 2 (manual certificate setup):**
   - `app-config/albCertificateArn`: ARN of the ACM certificate for the ALB (in your deployment region)
   - `app-config/cfCertificateArn`: ARN of the ACM certificate for CloudFront (must be in `us-east-1`)
   - `app-config/domain`: Domain name for your Moodle application (e.g., `moodle.example.com`)
   - `app-config/hostedZoneId`: Leave as empty string `""` (unless using Route 53 for DNS records)
   
   **Common configuration for both options:**
   
   CloudFront Configuration:
   - `app-config/enableCloudFront`: Set to `true` to deploy CloudFront distribution (default), or `false` to access Moodle directly via ALB (default: `true`)
     - When `true`: Moodle is accessed through CloudFront with the ALB in private subnets
     - When `false`: Moodle is accessed directly via the ALB in public subnets (CloudFront is not deployed)
   - `app-config/cfDistributionOriginTimeoutSeconds`: CloudFront origin response timeout in seconds (default: `60`) - only used when `enableCloudFront` is `true`
   
   Container Configuration:
   - `app-config/containerPlatform`: Set to `"ARM"` or `"X86"` based on your preference (default: `"ARM"`)
   
   ECS Service Configuration:
   - `app-config/serviceReplicaDesiredCount`: Number of Moodle container replicas to run - **must be set to `1` for initial deployment** (Moodle installation requires a single instance; can be scaled up after initial setup is complete)
   - `app-config/serviceHealthCheckGracePeriodSeconds`: Health check grace period in seconds (default: `1800` for initial deployment to allow time for Moodle to be installed and configured)
   
   Database Configuration:
   - `app-config/rdsEngine`: Database engine - `"aurora-serverless"`, `"aurora"`, `"mysql"`, or `"mariadb"` (default: `"aurora-serverless"`)
   - `app-config/rdsEngineVersion`: Database engine version (default: `"8.0.mysql_aurora.3.10.0"` for Aurora) - see available versions: [Aurora MySQL](https://docs.aws.amazon.com/cdk/api/v2/docs/aws-cdk-lib.aws_rds.AuroraMysqlEngineVersion.html), [MySQL](https://docs.aws.amazon.com/cdk/api/v2/docs/aws-cdk-lib.aws_rds.MysqlEngineVersion.html), [MariaDB](https://docs.aws.amazon.com/cdk/api/v2/docs/aws-cdk-lib.aws_rds.MariaDbEngineVersion.html)
   - `app-config/rdsInstanceType`: Instance type for provisioned databases (e.g., `"t4g.medium"`, `"m5.large"`) - only used when `rdsEngine` is `"aurora"`, `"mysql"`, or `"mariadb"`. Default is `""` (empty string) for Aurora Serverless; set to a valid instance type when using provisioned databases
   - `app-config/auroraServerlessMinCapacity`: Minimum Aurora Serverless capacity in ACUs (default: `0.5`) - only used when `rdsEngine` is `"aurora-serverless"`. Set to `""` (empty string) when using provisioned databases
   - `app-config/auroraServerlessMaxCapacity`: Maximum Aurora Serverless capacity in ACUs (default: `10`) - only used when `rdsEngine` is `"aurora-serverless"`. Set to `""` (empty string) when using provisioned databases
   - `app-config/rdsEventSubscriptionEmailAddress`: Email address for RDS event notifications (e.g., `"user@example.com"`)
   
   Cache Configuration:
   - `app-config/cacheEngine`: Cache engine - `"valkey"` or `"redis"` (default: `"valkey"`)
   - `app-config/cacheDeploymentMode`: Cache mode - `"serverless"` or `"provisioned"` (default: `"serverless"`)
   - `app-config/cacheServerlessMaxStorageGB`: Maximum storage in GB for serverless cache (default: `10`) - only used when `cacheDeploymentMode` is `"serverless"`. Set to `""` (empty string) when using provisioned cache
   - `app-config/cacheServerlessMinCapacity`: Minimum ECPU capacity for serverless cache (default: `1`) - only used when `cacheDeploymentMode` is `"serverless"`. Set to `""` (empty string) when using provisioned cache
   - `app-config/cacheServerlessMaxCapacity`: Maximum ECPU capacity for serverless cache (default: `100`) - only used when `cacheDeploymentMode` is `"serverless"`. Set to `""` (empty string) when using provisioned cache
   - `app-config/cacheProvisionedInstanceType`: Instance type for provisioned cache (e.g., `"cache.t3.micro"`, `"cache.m5.large"`) - only used when `cacheDeploymentMode` is `"provisioned"`. Default is `""` (empty string) for serverless cache; set to a valid instance type when using provisioned cache
   
1. **(Optional)** If using Finch instead of Docker, set the environment variable:
   ```bash
   export CDK_DOCKER=finch
   ```

1. Bootstrap CDK (only needed once per account/region):
   ```bash
   cdk bootstrap
   ```

1. Deploy the CDK application:
   ```bash
   cdk deploy --all
   ```
   
   Note: CDK will automatically build the Moodle container image, create an ECR repository, and push the image during deployment.

1. Once successfully deployed, Moodle begins first-time installation, which takes approximately 15-20 minutes. Check the progress by viewing the logs in the Amazon ECS console.

1. After installation completes, you can access the application:
   - **If CloudFront is enabled** (`enableCloudFront: true`): Use the CloudFront URL shown in the deployment output `CLOUDFRONTDNSNAME`
   - **If CloudFront is disabled** (`enableCloudFront: false`): Use the ALB URL shown in the deployment output `MOODLEDNSNAME` 

## Post-deployment steps

1. Retrieve Moodle credentials:
   - Username: Found in the `MOODLEUSERNAME` output
   - Password: Fetch from AWS Secrets Manager using the ARN in the `MOODLEPASSWORDSECRETARN` output

1. Configure Moodle caching for improved performance:
   - Use the cache endpoint from the `MOODLECACHEENDPOINTADDRESSANDPORT` output 
   - Follow the [official Moodle documentation for adding cache store instances](https://docs.moodle.org/en/Caching#Adding_a_cache_store_instance)
     - **Important:** When configuring the cache store, ensure the "Use TLS encryption" option is selected (required for ElastiCache Serverless, recommended for provisioned instances with encryption enabled)
   - Set the Application and Session cache to use the Redis/Valkey cache store instance

1. Scale the Moodle instances:
   - Configure `app-config/serviceReplicaDesiredCount` in `src/cdk/cdk.json` to set the number of replicas
   - Optionally adjust `app-config/serviceHealthCheckGracePeriodSeconds` from 1800 to 300 seconds after initial deployment
   - Run `cdk diff` to preview changes, then `cdk deploy --all` to apply

1. **(Optional - only required if you followed Option 2 for manual certificate setup)** Configure CloudFront access:
   - Create DNS records for your domain pointing to the CloudFront distribution from the `CLOUDFRONTDNSNAME` output
   - If using Route 53: Create Alias records (A and AAAA) pointing to the CloudFront distribution
   - If using another DNS provider: Create a CNAME record pointing to the CloudFront distribution DNS name
   - Example: `moodle.example.com` → `abcd1234efgh.cloudfront.net`
   - **Note:** If you followed Option 1 (automated Route 53 setup), Alias records were created automatically during deployment

## Cleanup

To delete the application infrastructure and avoid ongoing costs:

1. Navigate to the CDK app directory:
   ```bash
   cd src/cdk
   ```

1. Destroy the CDK application:
   ```bash
   cdk destroy --all
   ```

1. **(Optional)** Delete the ECR repository created by CDK:
   ```bash
   # List ECR repositories to find the CDK-created repository name
   aws ecr describe-repositories --region ${AWS_REGION} --query 'repositories[?contains(repositoryName, `cdk`)].repositoryName' --output table
   
   # Delete the repository (replace <repository-name> with the actual name from above)
   aws ecr delete-repository --repository-name <repository-name> --region ${AWS_REGION} --force
   ```
   
   Note: CDK automatically creates an ECR repository with a generated name (typically containing "cdk" and a hash). The `cdk destroy` command does not automatically delete ECR repositories that contain images.

## Architecture

This solution deploys:
- Amazon ECS with AWS Fargate for running Moodle containers
- Application Load Balancer for distributing traffic
- Amazon Aurora Serverless v2 or provisioned for the database
- Amazon ElastiCache (Redis or Valkey) in serverless or provisioned mode for caching
- Amazon EFS for shared file storage
- Amazon CloudFront for content delivery
- AWS Secrets Manager for credential management
- Amazon VPC with public and private subnets

For more details, see the [blog post](https://aws.amazon.com/blogs/publicsector/modernize-moodle-lms-aws-serverless-containers/).
