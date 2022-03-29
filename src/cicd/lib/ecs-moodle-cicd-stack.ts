import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as codepipeline from 'aws-cdk-lib/aws-codepipeline';
import * as codepipeline_actions from 'aws-cdk-lib/aws-codepipeline-actions';
import * as codebuild from 'aws-cdk-lib/aws-codebuild';
import * as codecommit from 'aws-cdk-lib/aws-codecommit';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';

export interface CICDStackProps extends cdk.StackProps {
  EcsClusterName: string;
  EcsVpcId: string;
  MoodleServiceName: string;
}

export class CICDStack extends cdk.Stack {
  // Configurable parameters
  private readonly CodePipelineName = 'cdk-ecs-moodle';
  private readonly CodeCommitRepoName = 'cdk-ecs-moodle';

  constructor(scope: Construct, id: string, props: CICDStackProps) {
    super(scope, id, props);

    // Container Registry
    const repository = new ecr.Repository(this, 'image-repo', {
      imageScanOnPush: true
    });

    const codeCommitRepo = new codecommit.Repository(this, 'moodle-codecommit-repo', {
      repositoryName: this.CodeCommitRepoName,
      code: codecommit.Code.fromDirectory('../image/', 'main')
    });

    // CI Pipeline
    const sourceOutput = new codepipeline.Artifact();
    const buildOutput = new codepipeline.Artifact();
    const buildProject = this.constructBuildProject(repository);

    const pipeline = new codepipeline.Pipeline(this, 'image-pipeline', {
      pipelineName: this.CodePipelineName,
      stages: [
        {
          stageName: 'Source',
          actions: [
            new codepipeline_actions.CodeCommitSourceAction({
              actionName: 'CodeCommit',
              repository: codeCommitRepo,
              branch: 'main',
              output: sourceOutput
            })
          ]
        },
        {
          stageName: 'Build',
          actions: [
            new codepipeline_actions.CodeBuildAction({
              actionName: 'CodeBuild',
              input: sourceOutput,
              project: buildProject,
              outputs: [ buildOutput ]
            })
          ]
        },
        {
          stageName: 'Deploy',
          actions: [
            new codepipeline_actions.EcsDeployAction({
              actionName: 'EcsDeploy',
              service: ecs.FargateService.fromFargateServiceAttributes(this, 'moodle-service', {
                cluster: ecs.Cluster.fromClusterAttributes(this, 'ecs-cluster', {
                  clusterName: props.EcsClusterName,
                  vpc: ec2.Vpc.fromLookup(this, 'moodle-vpc', {
                    vpcId: props.EcsVpcId
                  }),
                  securityGroups: []
                }),
                serviceName: props.MoodleServiceName
              }),
              imageFile: buildOutput.atPath('src/imagedefinitions.json'),
              deploymentTimeout: cdk.Duration.minutes(60)
            })
          ]
        }
      ]
    });
  }

  constructBuildProject(repository: ecr.Repository): codebuild.PipelineProject {
    const buildProject = new codebuild.PipelineProject(this, 'image-build', {
      environment: {
        privileged: true
      },
      buildSpec: codebuild.BuildSpec.fromObject({
        version: 0.2,
        env: {
          "exported-variables": [
            "CODEBUILD_RESOLVED_SOURCE_VERSION"
          ]
        },
        phases: {
          install: {
            commands: [

            ]
          },
          pre_build: {
            commands: [
              `aws ecr get-login-password --region ${this.region} | docker login --username AWS --password-stdin ${this.account}.dkr.ecr.${this.region}.amazonaws.com`,
              'imageversion="$(echo $CODEBUILD_RESOLVED_SOURCE_VERSION | cut -c1-8)"',
              `imageuri="${this.account}.dkr.ecr.${this.region}.amazonaws.com/${repository.repositoryName}:$imageversion"`
            ]
          },
          build: {
            commands: [
              'cd src/',
              `docker build . -t "$imageuri"`,
              `docker push $imageuri`
            ]
          },
          post_build: {
            commands: [
              `JSON_FMT='[{"name":"%s","imageUri":"%s"}]'`,
              'printf "$JSON_FMT" "moodle" "$imageuri" > imagedefinitions.json'
            ]
          }
        },
        artifacts: {
          files: [
              'src/*'
          ]
        }
      })
    });

    repository.grantPullPush(buildProject);
    return buildProject;
  }
}
