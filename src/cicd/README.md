# Deploying CI/CD Infrastructure Stack

This document describes the overview and steps to deploy CI/CD infrastructure as part of Moodle LMS on AWS Serverless Containers solution. For the solution overview, refer to the main [document](../../README.md).

___

## High-Level Architecture

![CI/CD Architecture](../../docs/images/moodle-cicd-stack.jpg "CI/CD Architecture")

___

## Prerequisites
Before you perform the following deployment steps, please make sure that you have successfully deployed the Moodle on ECS with Fargate described in this [document](../../README.md).

___

## Deployment
The following are the steps to deploy the CDK application:
1. Replace the `EcsClusterName`, `EcsVpcId`, `MoodleServiceName` property in the file `bin/cdk.ts` with the output from the Moodle on ECS CDK application. You can also find the output in the AWS CloudFormation console.
2. Run `cdk deploy` to deploy this solution.
3. Once successfully deployed, the CodePipeline will automatically start its first execution. You can inspect the execution on the AWS CodePipeline console.

___

## Next Steps
Refer to the conclusion and next steps section in the main [document](../../README.md).

___

## Teardown
You should consider deleting the application infrastructure once you no longer need it to save costs. Use `cdk destroy` to delete the CDK application.