import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";

import * as route53 from "aws-cdk-lib/aws-route53";
import * as acm from "aws-cdk-lib/aws-certificatemanager";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as ecs from "aws-cdk-lib/aws-ecs";
import * as iam from "aws-cdk-lib/aws-iam";
import * as ecr from "aws-cdk-lib/aws-ecr";
import * as ecrdeploy from "cdk-ecr-deployment";

import * as ecs_patterns from "aws-cdk-lib/aws-ecs-patterns";
import {
  ApplicationProtocol,
  ApplicationProtocolVersion,
  Protocol,
} from "aws-cdk-lib/aws-elasticloadbalancingv2";
import { LoadBalancerTarget } from "aws-cdk-lib/aws-route53-targets";
import { Duration } from "aws-cdk-lib";
import { DockerImageAsset } from "aws-cdk-lib/aws-ecr-assets";
import * as path from "node:path";
import { LoadBalancingProtocol } from "aws-cdk-lib/aws-elasticloadbalancing";
import { Port } from "aws-cdk-lib/aws-ec2";

export class RyildizInfraStack extends cdk.Stack {
  private PREFIX = "krs";
  private DOMAIN_NAME = "test.ridvanozaydin.com";
  private ZONE_NAME = "ridvanozaydin.com";
  private SERVICE_NAME = "krs-service";

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // use existing default vpc
    const vpc = ec2.Vpc.fromLookup(this, "default", {
      isDefault: true,
    });

    const ecsServiceSecurityGroup = new ec2.SecurityGroup(
      this,
      `${this.PREFIX}_ecs_service_sg`,
      {
        vpc: vpc,
        allowAllOutbound: true,
        description: `${this.PREFIX}_ecs_service_sg`,
      }
    );

    /* TODO change ec2.Peer.anyIpv4(), to ALB SG */

    ecsServiceSecurityGroup.addIngressRule(
      /*ec2.Peer.securityGroupId(albSecurityGroup.securityGroupId),*/
      ec2.Peer.anyIpv4(),
      Port.tcp(8080),
      "health check access"
    );

    ecsServiceSecurityGroup.addIngressRule(
      /*ec2.Peer.securityGroupId(albSecurityGroup.securityGroupId),*/
      ec2.Peer.anyIpv4(),
      Port.tcp(8443),
      "wss access"
    );

    // Create ECR registry
    const containerRegistry = new ecr.Repository(this, "ContainerRegistry", {
      emptyOnDelete: true,
      repositoryName: `${this.PREFIX}_registry`,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      lifecycleRules: [
        {
          description: "Keeps a maximum number of images to minimize storage",
          maxImageCount: 10,
        },
      ],
    });

    // build and push initial image into ECR registry

    const localContainerImage = new DockerImageAsset(this, "DockerImageAsset", {
      directory: path.join(__dirname, "../../krs-loyalty-be-fargate/"),
      buildArgs: {
        platform: "linux/amd64",
      },
      invalidation: {
        buildArgs: false,
      },
    });

    const dockerImageAssetHash = localContainerImage.assetHash;
    const destinationImageName = `${containerRegistry.repositoryUri}:${dockerImageAssetHash}`;
    const destinationImageNameLatest = `${containerRegistry.repositoryUri}:latest`;

    /* This is a workaround, since cdk does not provide a way to use custom ECR */
    // https://github.com/cdklabs/cdk-ecr-deployment

    const ecrDeployment = new ecrdeploy.ECRDeployment(
      this,
      "EcrDeployment:withHash",
      {
        src: new ecrdeploy.DockerImageName(localContainerImage.imageUri),
        dest: new ecrdeploy.DockerImageName(destinationImageName),
      }
    );

    const ecrDeploymentlatest = new ecrdeploy.ECRDeployment(
      this,
      "EcrDeployment:latest",
      {
        src: new ecrdeploy.DockerImageName(localContainerImage.imageUri),
        dest: new ecrdeploy.DockerImageName(destinationImageNameLatest),
      }
    );

    const domainZone = route53.HostedZone.fromLookup(this, "HostedZone", {
      domainName: this.ZONE_NAME,
    });

    const certificate = new acm.Certificate(this, "Certificate", {
      domainName: this.DOMAIN_NAME,
      certificateName: this.DOMAIN_NAME,
      validation: acm.CertificateValidation.fromDns(domainZone),
    });

    const cluster = new ecs.Cluster(this, "Cluster", {
      vpc: vpc,
      clusterName: `${this.PREFIX}_cluster`,
    });

    /**
     * Fargate services use the default VPC Security Group unless
     * one or more are provided using the securityGroups property
     * in the constructor.
     */

    /**
     * ApplicationMultipleTargetGroupsFargateService
     * if more than one application target group are needed,
     * instantiate one of the following:
     */

    const taskDefinition = new ecs.TaskDefinition(this, "ECSTaskDefinition", {
      compatibility: ecs.Compatibility.FARGATE,
      cpu: "512",
      memoryMiB: "2048",
    });

    const container = taskDefinition.addContainer("Container", {
      image: ecs.ContainerImage.fromEcrRepository(containerRegistry),
      portMappings: [
        {
          // for socket.io
          containerPort: 8443,
          protocol: ecs.Protocol.TCP,
        },
        {
          // for health check
          containerPort: 8080,
          protocol: ecs.Protocol.TCP,
        },
      ],
      healthCheck: {
        // health check for the task
        command: ["CMD-SHELL", "curl -f http://localhost:8080 || exit 1"],
        // the properties below are optional
        interval: Duration.minutes(1),
        retries: 3,
        startPeriod: Duration.minutes(1),
        timeout: Duration.minutes(1),
      },
      memoryLimitMiB: 2048,
      environment: {
        WEB_SOCKET_PORT: "8443",
        EXPRESS_PORT: "8080",
        USE_TEST_CARD_NUMBER: "true",
        TEST_CARD_NUMBER: "7020113200035014",
        RECEIPT_PRINTER_CHARACTER_PER_LINE: "48",
        RECEIPT_PRINTER_CHARACTER_ENCODING: "multilingual",
        // FOLLOWINGS SECRETS ARE AVAILABLE IN TERMINAL ALSO
        WEB_SOCKET_COMMUNICATION_SECRET: "eb8600ca-1122-43e5-8506-1fededbf5aee",
        WEB_SOCKET_INQUIRY_CHANNEL: "web.socket.inquiry.channel",
        WEB_SOCKET_RECEIPT_CHANNEL: "web.socket.receipt.channel",
      },
      containerName: `${this.PREFIX}_container`,
    });

    const appLoadBalancerService =
      new ecs_patterns.ApplicationLoadBalancedFargateService(
        this,
        "ApplicationLoadBalancedFargateService",
        {
          cluster: cluster,
          cpu: 512,
          desiredCount: 1,
          assignPublicIp: true,
          taskDefinition,
          /*
          taskImageOptions: {
            image: ecs.ContainerImage.fromEcrRepository(containerRegistry),
            environment: {
              WEB_SOCKET_PORT: "8443",
              EXPRESS_PORT: "8080",
              USE_TEST_CARD_NUMBER: "true",
              TEST_CARD_NUMBER: "7020113200035014",
              RECEIPT_PRINTER_CHARACTER_PER_LINE: "48",
              RECEIPT_PRINTER_CHARACTER_ENCODING: "multilingual",
              // FOLLOWINGS SECRETS ARE AVAILABLE IN TERMINAL ALSO
              WEB_SOCKET_COMMUNICATION_SECRET:
                "eb8600ca-1122-43e5-8506-1fededbf5aee",
              WEB_SOCKET_INQUIRY_CHANNEL: "web.socket.inquiry.channel",
              WEB_SOCKET_RECEIPT_CHANNEL: "web.socket.receipt.channel",
            },
            containerPort: 8443,
          },
          */
          // protocol: ApplicationProtocol.HTTPS,
          // targetProtocol: ApplicationProtocol.HTTP,
          securityGroups: [ecsServiceSecurityGroup],
          redirectHTTP: true,
          certificate,
          serviceName: this.SERVICE_NAME,
          memoryLimitMiB: 2048,
          publicLoadBalancer: true,
        }
      );

    // allow outbound traffic to 8080 for health checks
    const albSecurityGroups =
      appLoadBalancerService.loadBalancer.loadBalancerSecurityGroups;

    for (const albSecurityGroupName of albSecurityGroups) {
      const albSecurityGroup = ec2.SecurityGroup.fromSecurityGroupId(
        this,
        "albSecurityGroup",
        albSecurityGroupName,
        {}
      );

      albSecurityGroup.addEgressRule(
        ec2.Peer.securityGroupId(ecsServiceSecurityGroup.securityGroupId),
        Port.tcp(8080),
        "health check access",
        false
      );
    }

    // allow traffic from application load balancer

    // health check for target group
    appLoadBalancerService.targetGroup.configureHealthCheck({
      path: "/",
      port: "8080",
      protocol: Protocol.HTTP,
      interval: Duration.seconds(10),
      healthyHttpCodes: "200",
      healthyThresholdCount: 2,
      unhealthyThresholdCount: 2,
      timeout: Duration.seconds(4),
    });

    const aRecord = new route53.ARecord(this, "HttpsFargateAlbARecord", {
      zone: domainZone,
      recordName: this.DOMAIN_NAME,
      target: route53.RecordTarget.fromAlias(
        new LoadBalancerTarget(appLoadBalancerService.loadBalancer)
      ),
    });

    // create cicd user, and role it will assume

    const cicdUser = new iam.User(this, "iamUser", {
      userName: `${this.PREFIX}_cicd_user`,
    });

    const ecrPermission = new iam.PolicyDocument({
      statements: [
        new iam.PolicyStatement({
          actions: ["ecr:*"],
          resources: [containerRegistry.repositoryArn],
        }),
      ],
    });

    /*
    const ecsPermission = new iam.PolicyDocument({
      statements: [
        new iam.PolicyStatement({
          actions: ["ecs:*"],
          resources: [cluster.clusterArn],
        }),
      ],
    });
*/

    const cicdRole = new iam.Role(this, "iamRole", {
      assumedBy: new iam.ArnPrincipal(cicdUser.userArn),
      roleName: `${this.PREFIX}_cicd_role`,
      description: "CICD Role",
      inlinePolicies: {
        ECR_Permissins: ecrPermission,
      },
    });

    const stsPermissions = new iam.PolicyDocument({
      statements: [
        new iam.PolicyStatement({
          actions: ["sts:AssumeRole", "sts:TagSession"],
          resources: [cicdRole.roleArn],
        }),
      ],
    });

    const inlinePolicy = new iam.Policy(this, "cicdUserInlinePolicy", {
      document: stsPermissions,
    });

    cicdUser.attachInlinePolicy(inlinePolicy);
  }
}
