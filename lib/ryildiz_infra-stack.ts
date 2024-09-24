import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";

import * as route53 from "aws-cdk-lib/aws-route53";
import * as acm from "aws-cdk-lib/aws-certificatemanager";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as ecs from "aws-cdk-lib/aws-ecs";
import * as ecs_patterns from "aws-cdk-lib/aws-ecs-patterns";
import { ApplicationProtocol } from "aws-cdk-lib/aws-elasticloadbalancingv2";
import { LoadBalancerTarget } from "aws-cdk-lib/aws-route53-targets";

export class RyildizInfraStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const ecsClusterName = "rozaydin-test-cluster";
    const domainName = "test.ridvanozaydin.com";
    const zoneName = "ridvanozaydin.com";
    const serviceName = "rozaydin-test-service";

    // use existing default vpc
    const vpc = ec2.Vpc.fromLookup(this, "default", {
      isDefault: true,
    });

    const domainZone = route53.HostedZone.fromLookup(this, "HostedZone", {
      domainName: zoneName,
    });

    // create a new certificate
    const certificate = new acm.Certificate(this, "Certificate", {
      domainName,
      certificateName: domainName, // Optionally provide an certificate name
      validation: acm.CertificateValidation.fromDns(domainZone),
    });

    const cluster = new ecs.Cluster(this, "Cluster", {
      vpc: vpc,
      clusterName: "rozaydin-test-cluster",
    });

    const appLoadBalancerService =
      new ecs_patterns.ApplicationLoadBalancedFargateService(
        this,
        ecsClusterName,
        {
          cluster: cluster, // Required
          cpu: 512, // Default is 256
          desiredCount: 1, // Default is 1,
          assignPublicIp: true,
          taskImageOptions: {
            // image: ecs.ContainerImage.fromAsset('./image') // build and upload an image directly from a Dockerfile in your source directory.
            image: ecs.ContainerImage.fromRegistry("amazon/amazon-ecs-sample"),
            environment: {
              // TEST_ENVIRONMENT_VARIABLE1: "test environment variable 1 value",
              // TEST_ENVIRONMENT_VARIABLE2: "test environment variable 2 value",
            },
          },
          protocol: ApplicationProtocol.HTTPS,
          redirectHTTP: true,
          certificate,
          serviceName,
          memoryLimitMiB: 2048, // Default is 512
          publicLoadBalancer: true, // Default is true
        }
      );

    new route53.ARecord(this, "HttpsFargateAlbARecord", {
      zone: domainZone,
      recordName: domainName,
      target: route53.RecordTarget.fromAlias(
        new LoadBalancerTarget(appLoadBalancerService.loadBalancer)
      ),
    });
  }
}
