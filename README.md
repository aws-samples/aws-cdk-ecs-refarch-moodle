# Moodle LMS on AWS Serverless Containers

Moodle is a popular open source learning management system (LMS). Many education institutions are using Moodle to provide an online learning platform for their students to achieve their learning goals. It is especially critical due to the impact of Covid-19 on the face-to-face learning process.

Moodle itself is a monolith application developed using PHP with database typically using MySQL or PostgreSQL. By default, Moodle stores its application data within the database and also in the filesystem directory called moodledata. To improve performance, Moodle also supports caching services such as Redis or Memcached. Below is the high-level visualization of the infrastructure components within Moodle.

![Moodle Generic Architecture](/docs/images/moodle-generic-architecture.jpg "Moodle Generic Architecture")

Many education institutions are deploying and running Moodle on a VM-based environment. They are looking to improve the scalability of their Moodle application, simplify the operations and deployment process, and also optimize its operating costs. One of the approach that we can use to achieve that is by using containers technology. Containers offer a way for developers to package the application code together with its dependencies and configuration, making the deployment of the application to be highly-portable, and can be easily automated to be more reliable and predictable.

In this repository, we will show how to deploy and run Moodle on AWS serverless containers technology and also implement CI/CD automation for the Moodle on containers.

___

## Solution Overview

AWS offers Amazon Elastic Container Services (ECS) which is a fully managed container orchestration service that makes it easy for you to deploy, manage, and scale containerized applications. Amazon ECS supports AWS Fargate to provide a serverless, pay-as-you-go compute engine for containerized workload that lets you focus on building applications without managing servers. 

AWS Fargate can be configured to use just the right amount of vCPU and memory for your task, so it reduce the need to overprovision compute therefore saving costs. To reduce the costs even further, AWS Fargate also allows customers to launch tasks on spare capacity for a steep discount up to 70% by using a purchase option called Fargate Spot.

Below is the high-level architecture for the solution.

![Solution Overview](/docs/images/solution-overview.jpg "Solution Overview")

The solution uses Cloud Development Kit (CDK) that allows users to define cloud application resources using familiar programming languages. The solution is deployed with high-availability using 2 Availability Zones with the following components:
- Moodle containerized application is based on [Bitnami Moodle Docker image](https://github.com/bitnami/bitnami-docker-moodle) with some modifications to enable Redis caching store. It is deployed on [Amazon ECS](https://aws.amazon.com/ecs/) using a combination of Fargate and Fargate Spot.
- [Amazon Elastic File System (Amazon EFS)](https://aws.amazon.com/efs/) is a simple, serverless, set-and-forget elastic file system that makes it easy to set up, scale, and cost-optimize file storage in AWS. 
  
  Amazon EFS is deployed to be mounted on the container to be used as underlying `moodle` and `moodledata` filesystem.
- [Amazon Relational Database Service (Amazon RDS)](https://aws.amazon.com/rds/) is a managed service that makes it easy to set up, operate, and scale a relational database in the cloud. It provides cost-efficient and resizable capacity, while managing time-consuming database administration tasks, freeing you up to focus on your applications and business. 

  The database for Moodle is deployed using Amazon RDS for MySQL.
- [Amazon ElastiCache](https://aws.amazon.com/elasticache/) is a web service that makes it easy to deploy and run Memcached or Redis protocol-compliant server nodes in the cloud. Amazon ElastiCache improves the performance of web applications by allowing you to retrieve information from a fast, managed, in-memory system, instead of relying entirely on slower disk-based databases. 

  To improve performance, ElastiCache Redis is deployed to be used as Application Cache store in Moodle configurations.
- [Elastic Load Balancing](https://aws.amazon.com/elasticloadbalancing/) automatically distributes your incoming traffic across multiple targets, such as EC2 instances, containers, and IP addresses, in one or more Availability Zones. It monitors the health of its registered targets, and routes traffic only to the healthy targets. Elastic Load Balancing scales your load balancer as your incoming traffic changes over time. It can automatically scale to the vast majority of workloads. Application Load Balancer functions at the application layer, the seventh layer of the Open Systems Interconnection (OSI) model. 

  The Moodle application endpoint is being exposed using a public Application Load Balancer (ALB) secured with TLS encryption with the certificate stored in AWS Certificate Manager.
- [Amazon CloudFront](https://aws.amazon.com/cloudfront/) is a web service that gives businesses and web application developers an easy and cost effective way to distribute content with low latency and high data transfer speeds. 

  Amazon CloudFront distribution is created in front of the Application Load Balancer to improve the performance of the application.
- [AWS Secrets Manager](https://aws.amazon.com/secrets-manager/) is a secrets management service that helps you protect access to your applications, services, and IT resources. This service enables you to easily rotate, manage, and retrieve database credentials, API keys, and other secrets throughout their lifecycle. Using Secrets Manager, you can secure and manage secrets used to access resources in the AWS Cloud, on third-party services, and on-premises. 

  AWS Secrets Manager is being used during CDK deployment to securely store sensitive data such as database password and Moodle administrator password
- [Amazon CloudWatch](https://aws.amazon.com/cloudwatch/) is a monitoring service for AWS cloud resources and the applications you run on AWS. You can use Amazon CloudWatch to collect and track metrics, collect and monitor log files, and set alarms. 

  Amazon CloudWatch Logs and CloudWatch Container Insights is enabled for the application to provide metrics and logs for Moodle application.

- [AWS CodeCommit](https://aws.amazon.com/codecommit/) is a secure, highly scalable, managed source control service that makes it easier for teams to collaborate on code. 

  CodeCommit is used to store the Dockerfile and can be used to store additional code if required. Code changes in the repository will trigger the pipeline to be executed.
- [AWS CodePipeline](https://aws.amazon.com/codepipeline/) is a continuous delivery service that enables you to model, visualize, and automate the steps required to release your software. 

  CodePipeline is being used to orchestrate the CI/CD process. Upon execution, CodePipeline Source Action will pull the latest source from the main branch of the CodeCommit repository. The Source is then passed to CodeBuild which will execute a couple of shell commands that will basically build the container image from the Dockerfile and then push the image into ECR repository.

- [AWS CodeBuild](https://aws.amazon.com/codebuild/) is a fully managed continuous integration service in the cloud. CodeBuild compiles source code, runs tests, and produces packages that are ready to deploy. CodeBuild eliminates the need to provision, manage, and scale your own build servers. 

  Once the CodeBuild Action has been completed, ECS Deploy Action is executed to deploy the container image that was built in the previous step into the ECS Service running our Moodle application. The deployment will use rolling upgrade strategy with automatic rollback mechanism if there are issues with the new deployment.

___

## Deploying the Solution

To make the deployment easier to follow, the deployment is split into 2 steps. To get started with deploying this solution in your AWS account, follow the steps below.

**Step 1:** [Deploying Moodle on ECS with Fargate](src/cdk/README.md)

**Step 2:** [Deploying CI/CD Infrastructure Stack](src/cicd/README.md)

___

## Next Steps

You can find more information about each of the AWS services used for this solution in the AWS updated guides:
- [Amazon ECS Developer Guide](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/Welcome.html)
- [Amazon EFS User Guide](https://docs.aws.amazon.com/efs/latest/ug/whatisefs.html)
- [Amazon RDS User Guide](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/Welcome.html)
- [ElastiCache for Redis User Guide](https://docs.aws.amazon.com/AmazonElastiCache/latest/red-ug/SelectEngine.html)
- [User Guide for Application Load Balancers](https://docs.aws.amazon.com/elasticloadbalancing/latest/application/introduction.html)
- [Amazon CloudFront Developer Guide](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/Introduction.html)
- [Amazon CloudWatch User Guide](https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/WhatIsCloudWatch.html)

Visit various blogs that features common use-cases and integrations within Moodle such as:
- [Create LTI-ready virtual classroom experiences with Amazon Chime SDK](https://aws.amazon.com/blogs/business-productivity/create-lti-ready-virtual-classroom-experiences-with-amazon-chime-sdk/)
- [Integrating Amazon AppStream 2.0 with your Learning Management System](https://aws.amazon.com/blogs/publicsector/integrating-amazon-appstream-2-0-with-your-learning-management-system/)

