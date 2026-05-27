import * as cdk from 'aws-cdk-lib/core';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as networkmanager from 'aws-cdk-lib/aws-networkmanager';
import { Construct } from 'constructs';
import { RFC1918_CIDRS, cloudWanTagKey } from '../network-config';

export interface PrivateVpcProps {
  /** VPC CIDR ブロック */
  readonly vpcCidr: string;
  /** Cloud WAN Core Network ID */
  readonly coreNetworkId: string;
  /** Cloud WAN Core Network ARN */
  readonly coreNetworkArn: string;
  /** Cloud WAN セグメント タグ値 (prod / dev) */
  readonly cloudWanSegmentTag: string;
}

/**
 * Prod / Dev の VPC を表す Construct。
 * Private Subnet に EC2 と EIC Endpoint を配置し、Cloud WAN Attachment 経由で
 * 全アウトバウンドを Core Network に送り出す。
 */
export class PrivateVpc extends Construct {
  public readonly vpc: ec2.IVpc;

  constructor(scope: Construct, id: string, props: PrivateVpcProps) {
    super(scope, id);

    const vpc = new ec2.Vpc(this, 'Vpc', {
      ipAddresses: ec2.IpAddresses.cidr(props.vpcCidr),
      maxAzs: 1,
      natGateways: 0,
      restrictDefaultSecurityGroup: false,
      subnetConfiguration: [
        {
          name: 'Private',
          subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
          cidrMask: 24,
        },
        {
          name: 'CloudWanAttachment',
          subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
          cidrMask: 24,
        },
      ],
    });
    this.vpc = vpc;

    const privateSubnet = vpc.selectSubnets({ subnetGroupName: 'Private' }).subnets[0];
    const cloudWanSubnet = vpc.selectSubnets({ subnetGroupName: 'CloudWanAttachment' }).subnets[0];

    // EC2 用 Security Group (RFC1918 から全ポート許可)
    const ec2Sg = new ec2.SecurityGroup(this, 'Ec2Sg', {
      vpc,
      description: 'for EC2 instance',
    });
    for (const cidr of RFC1918_CIDRS) {
      ec2Sg.addIngressRule(ec2.Peer.ipv4(cidr), ec2.Port.allTraffic());
    }

    new ec2.Instance(this, 'Instance', {
      vpc,
      vpcSubnets: { subnets: [privateSubnet] },
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.T3, ec2.InstanceSize.MICRO),
      machineImage: ec2.MachineImage.fromSsmParameter(
        '/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-6.1-x86_64',
      ),
      securityGroup: ec2Sg,
      ssmSessionPermissions: true,
    });

    // EC2 Instance Connect Endpoint
    const eicSg = new ec2.SecurityGroup(this, 'EicSg', {
      vpc,
      description: 'for EIC Endpoint',
      allowAllOutbound: false,
    });
    eicSg.addEgressRule(ec2.Peer.ipv4(props.vpcCidr), ec2.Port.tcp(22));

    new ec2.CfnInstanceConnectEndpoint(this, 'EicEndpoint', {
      subnetId: privateSubnet.subnetId,
      securityGroupIds: [eicSg.securityGroupId],
    });

    // Cloud WAN VPC Attachment (タグで segment を決定)
    const attachment = new networkmanager.CfnVpcAttachment(this, 'CloudWanAttachment', {
      coreNetworkId: props.coreNetworkId,
      vpcArn: vpc.vpcArn,
      subnetArns: [
        cdk.Arn.format(
          { service: 'ec2', resource: 'subnet', resourceName: cloudWanSubnet.subnetId },
          cdk.Stack.of(this),
        ),
      ],
      tags: [
        { key: cloudWanTagKey.Segment, value: props.cloudWanSegmentTag },
      ],
    });

    // Private Subnet: 0.0.0.0/0 を Core Network へ
    const coreNetworkRoute = new ec2.CfnRoute(this, 'PrivateSubnetDefaultRoute', {
      routeTableId: privateSubnet.routeTable.routeTableId,
      destinationCidrBlock: '0.0.0.0/0',
      coreNetworkArn: props.coreNetworkArn,
    });
    coreNetworkRoute.addDependency(attachment);
  }
}
