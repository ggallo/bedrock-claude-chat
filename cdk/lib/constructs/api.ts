import { Construct } from "constructs";
import { CfnOutput, Duration } from "aws-cdk-lib";
import { ITable } from "aws-cdk-lib/aws-dynamodb";
import { HttpLambdaIntegration } from "aws-cdk-lib/aws-apigatewayv2-integrations";
import { HttpUserPoolAuthorizer } from "aws-cdk-lib/aws-apigatewayv2-authorizers";
import {
  DockerImageCode,
  DockerImageFunction,
  IFunction,
} from "aws-cdk-lib/aws-lambda";

import {
  LambdaRestApi,
  LambdaIntegration,
  CognitoUserPoolsAuthorizer,
  AuthorizationType,
  EndpointType
} from "aws-cdk-lib/aws-apigateway";

import {
  CorsHttpMethod,
  HttpApi,
  HttpMethod,
} from "aws-cdk-lib/aws-apigatewayv2";
import { Auth } from "./auth";
import { Platform } from "aws-cdk-lib/aws-ecr-assets";
import { Stack } from "aws-cdk-lib";
import * as iam from "aws-cdk-lib/aws-iam";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as path from "path";
import { IBucket } from "aws-cdk-lib/aws-s3";
import { ISecret } from "aws-cdk-lib/aws-secretsmanager";
import * as codebuild from "aws-cdk-lib/aws-codebuild";
import { UsageAnalysis } from "./usage-analysis";
export interface ApiProps {
  readonly vpc: ec2.IVpc;
  readonly subnets: ec2.ISubnet[];
  readonly apiGatewayEndpointId: string;
  readonly database: ITable;
  readonly dbSecrets?: ISecret;
  readonly corsAllowOrigins?: string[];
  readonly auth: Auth;
  readonly bedrockRegion: string;
  readonly tableAccessRole: iam.IRole;
  readonly documentBucket: IBucket;
  readonly largeMessageBucket: IBucket;
  readonly apiPublishProject?: codebuild.IProject;
  readonly bedrockKnowledgeBaseProject?: codebuild.IProject;
  readonly usageAnalysis?: UsageAnalysis;
  readonly enableMistral: boolean;
}

export class Api extends Construct {
  readonly api: LambdaRestApi;
  readonly privateUrl: string;
  readonly handler: IFunction;
  constructor(scope: Construct, id: string, props: ApiProps) {
    super(scope, id);

    const {
      database,
      tableAccessRole,
      corsAllowOrigins: allowOrigins = ["*"],
    } = props;

    const vpcEndpoint = ec2.InterfaceVpcEndpoint
      .fromInterfaceVpcEndpointAttributes(this, "APIGatewatVPCEndpoint", {
        port: 443,
        vpcEndpointId: props.apiGatewayEndpointId,
      });

    const usageAnalysisOutputLocation =
      `s3://${props.usageAnalysis?.resultOutputBucket.bucketName}` || "";

    const handlerRole = new iam.Role(this, "HandlerRole", {
      assumedBy: new iam.ServicePrincipal("lambda.amazonaws.com"),
    });
    handlerRole.addToPolicy(
      // Assume the table access role for row-level access control.
      new iam.PolicyStatement({
        actions: ["sts:AssumeRole"],
        resources: [tableAccessRole.roleArn],
      })
    );
    handlerRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ["bedrock:*"],
        resources: ["*"],
      })
    );
    handlerRole.addManagedPolicy(
      iam.ManagedPolicy.fromAwsManagedPolicyName(
        "service-role/AWSLambdaVPCAccessExecutionRole"
      )
    );

    if (props.apiPublishProject && props.bedrockKnowledgeBaseProject) {
      handlerRole.addToPolicy(
        new iam.PolicyStatement({
          effect: iam.Effect.ALLOW,
          actions: ["codebuild:StartBuild"],
          resources: [
            props.apiPublishProject.projectArn,
            props.bedrockKnowledgeBaseProject.projectArn,
          ],
        })
      );
      handlerRole.addToPolicy(
        new iam.PolicyStatement({
          effect: iam.Effect.ALLOW,
          actions: [
            "cloudformation:DescribeStacks",
            "cloudformation:DescribeStackEvents",
            "cloudformation:DescribeStackResource",
            "cloudformation:DescribeStackResources",
            "cloudformation:DeleteStack",
          ],
          resources: [`*`],
        })
      );
      handlerRole.addToPolicy(
        new iam.PolicyStatement({
          effect: iam.Effect.ALLOW,
          actions: ["codebuild:BatchGetBuilds"],
          resources: [
            props.apiPublishProject.projectArn,
            props.bedrockKnowledgeBaseProject.projectArn,
          ],
        })
      );
    }
    handlerRole.addToPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          "apigateway:GET",
          "apigateway:POST",
          "apigateway:PUT",
          "apigateway:DELETE",
        ],
        resources: [`arn:aws:apigateway:${Stack.of(this).region}::/*`],
      })
    );
    handlerRole.addToPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          "athena:GetWorkGroup",
          "athena:StartQueryExecution",
          "athena:StopQueryExecution",
          "athena:GetQueryExecution",
          "athena:GetQueryResults",
          "athena:GetDataCatalog",
        ],
        resources: [props.usageAnalysis?.workgroupArn || ""],
      })
    );
    handlerRole.addToPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ["glue:GetDatabase", "glue:GetDatabases"],
        resources: [
          props.usageAnalysis?.database.databaseArn || "",
          props.usageAnalysis?.database.catalogArn || "",
        ],
      })
    );
    handlerRole.addToPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          "glue:GetDatabase",
          "glue:GetTable",
          "glue:GetTables",
          "glue:GetPartition",
          "glue:GetPartitions",
        ],
        resources: [
          props.usageAnalysis?.database.databaseArn || "",
          props.usageAnalysis?.database.catalogArn || "",
          props.usageAnalysis?.ddbExportTable.tableArn || "",
        ],
      })
    );
    handlerRole.addToPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ["cognito-idp:AdminGetUser"],
        resources: [props.auth.userPool.userPoolArn],
      })
    );
    props.usageAnalysis?.resultOutputBucket.grantReadWrite(handlerRole);
    props.usageAnalysis?.ddbBucket.grantRead(handlerRole);
    props.largeMessageBucket.grantReadWrite(handlerRole);

    const handler = new DockerImageFunction(this, "Handler", {
      code: DockerImageCode.fromImageAsset(
        path.join(__dirname, "../../../backend"),
        {
          platform: Platform.LINUX_AMD64,
          file: "Dockerfile",
        }
      ),
      vpc: props.vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      memorySize: 1024,
      timeout: Duration.minutes(15),
      environment: {
        TABLE_NAME: database.tableName,
        CORS_ALLOW_ORIGINS: allowOrigins.join(","),
        USER_POOL_ID: props.auth.userPool.userPoolId,
        CLIENT_ID: props.auth.client.userPoolClientId,
        ACCOUNT: Stack.of(this).account,
        REGION: Stack.of(this).region,
        BEDROCK_REGION: props.bedrockRegion,
        TABLE_ACCESS_ROLE_ARN: tableAccessRole.roleArn,
        DB_SECRETS_ARN: props.dbSecrets?.secretArn || "",
        DOCUMENT_BUCKET: props.documentBucket.bucketName,
        LARGE_MESSAGE_BUCKET: props.largeMessageBucket.bucketName,
        PUBLISH_API_CODEBUILD_PROJECT_NAME: props.apiPublishProject?.projectName || "",
        KNOWLEDGE_BASE_CODEBUILD_PROJECT_NAME:
          props.bedrockKnowledgeBaseProject?.projectName || "",
        USAGE_ANALYSIS_DATABASE:
          props.usageAnalysis?.database.databaseName || "",
        USAGE_ANALYSIS_TABLE:
          props.usageAnalysis?.ddbExportTable.tableName || "",
        USAGE_ANALYSIS_WORKGROUP: props.usageAnalysis?.workgroupName || "",
        USAGE_ANALYSIS_OUTPUT_LOCATION: usageAnalysisOutputLocation,
        ENABLE_MISTRAL: props.enableMistral.toString(),
      },
      role: handlerRole,
    });
    if (props.dbSecrets) {
      props.dbSecrets.grantRead(handler)
    }

    const authorizer = new CognitoUserPoolsAuthorizer(this, "Authorizer", {
      cognitoUserPools: [props.auth.userPool]
    });

    const api = new LambdaRestApi(this, "Default", {
      handler: handler,
      proxy: true,
      defaultCorsPreflightOptions: {
        allowHeaders: ["*"],
        allowMethods: [
          CorsHttpMethod.GET,
          CorsHttpMethod.HEAD,
          CorsHttpMethod.OPTIONS,
          CorsHttpMethod.POST,
          CorsHttpMethod.PUT,
          CorsHttpMethod.PATCH,
          CorsHttpMethod.DELETE,
        ],
        allowOrigins: allowOrigins,
        allowCredentials: true,
        maxAge: Duration.days(10),
      },
      defaultMethodOptions: {
        authorizationType: AuthorizationType.COGNITO,
        authorizer
      },
      endpointConfiguration: {
        types: [ EndpointType.PRIVATE ],
        vpcEndpoints: [ vpcEndpoint ]
      },
      policy: new iam.PolicyDocument({
        statements: [
          new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            actions: ['execute-api:Invoke'],
            principals:[new iam.AnyPrincipal()],
            resources: [`arn:aws:execute-api:${Stack.of(this).region}:${Stack.of(this).account}:*`]
          })
        ]
      })
    });

    // let routeProps: any = {
    //   path: "/{proxy+}",
    //   integration,
    //   methods: [
    //     HttpMethod.GET,
    //     HttpMethod.POST,
    //     HttpMethod.PUT,
    //     HttpMethod.PATCH,
    //     HttpMethod.DELETE,
    //   ],
    //   authorizer,
    // };

    this.api = api;
    this.handler = handler;
    this.privateUrl = `https://${api.restApiId}-${vpcEndpoint.vpcEndpointId}.execute-api.${Stack.of(this).region}.amazonaws.com/prod/`

    new CfnOutput(this, "BackendApiUrl", { value: this.privateUrl });
  }
}
