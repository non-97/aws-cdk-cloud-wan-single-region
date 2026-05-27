import * as cdk from 'aws-cdk-lib/core';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as networkfirewall from 'aws-cdk-lib/aws-networkfirewall';
import * as networkmanager from 'aws-cdk-lib/aws-networkmanager';
import { Construct } from 'constructs';
import { ALL_VPC_CIDRS, cloudWanTagKey } from '../network-config';

export interface InspectionVpcProps {
  /** VPC CIDR ブロック */
  readonly vpcCidr: string;
  /** Cloud WAN Core Network ID */
  readonly coreNetworkId: string;
  /** Cloud WAN Core Network ARN */
  readonly coreNetworkArn: string;
  /** Cloud WAN Network Function Group タグ値 */
  readonly cloudWanNfgTag: string;
}

/**
 * Inspection VPC - AWS Network Firewall によるトラフィック検査 + NAT GW でインターネット出口を兼ねる。
 * Cloud WAN 経由で Prod / Dev からのトラフィックを受け取り、NFW で検査した上で
 * インターネットへは NAT GW、内部宛は Core Network にリターン。
 */
export class InspectionVpc extends Construct {
  public readonly vpc: ec2.IVpc;

  constructor(scope: Construct, id: string, props: InspectionVpcProps) {
    super(scope, id);

    const vpc = new ec2.Vpc(this, 'Vpc', {
      ipAddresses: ec2.IpAddresses.cidr(props.vpcCidr),
      maxAzs: 1,
      natGateways: 1,
      restrictDefaultSecurityGroup: false,
      subnetConfiguration: [
        { name: 'Firewall', subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS, cidrMask: 26 },
        { name: 'CloudWanAttachment', subnetType: ec2.SubnetType.PRIVATE_ISOLATED, cidrMask: 26 },
        { name: 'Public', subnetType: ec2.SubnetType.PUBLIC, cidrMask: 26 },
      ],
    });
    this.vpc = vpc;

    const publicSubnet = vpc.selectSubnets({ subnetGroupName: 'Public' }).subnets[0];
    const fwSubnet = vpc.selectSubnets({ subnetGroupName: 'Firewall' }).subnets[0];
    const cloudWanSubnet = vpc.selectSubnets({ subnetGroupName: 'CloudWanAttachment' }).subnets[0];

    // Network Firewall Rule Group (STRICT_ORDER)
    const nfwRuleGroup = new networkfirewall.CfnRuleGroup(this, 'NfwRuleGroup', {
      ruleGroupName: cdk.Names.uniqueResourceName(this, { maxLength: 16 }) + '-RuleGroup',
      capacity: 1000,
      type: 'STATEFUL',
      ruleGroup: {
        statefulRuleOptions: { ruleOrder: 'STRICT_ORDER' },
        ruleVariables: {
          ipSets: Object.fromEntries(
            Object.entries(ALL_VPC_CIDRS).map(([key, cidrs]) => [
              key,
              { definition: [...cidrs] },
            ]),
          ),
        },
        rulesSource: {
          rulesString: [
            // checkip.amazonaws.com への TLS を alert + pass (SNI 検査)
            'pass tls any any -> any any (ssl_state:client_hello; tls.sni; content:"checkip.amazonaws.com"; flow:to_server,established; alert; sid:2000001; rev:1; msg:"Access to checkip.amazonaws.com detected";)',
            // ICMP を alert + pass
            'pass icmp any any -> any any (alert; sid:2000002; rev:1; msg:"ICMP ping detected";)',
            // TCP ハンドシェイクを許可
            'pass tcp any any -> any any (flow:not_established; sid:3000001; rev:1;)',
            // TLS の確立済みフローを許可
            'pass tls any any -> any any (ssl_state:client_hello; flow:to_server,established; sid:3000002; rev:1;)',
            // 確立済み TCP を許可
            'pass tcp any any -> any any (flow:established; sid:3000003; rev:1;)',
            // UDP を許可
            'pass udp any any -> any any (sid:3000004; rev:1;)',
          ].join('\n') + '\n',
        },
      },
    });

    const nfwPolicy = new networkfirewall.CfnFirewallPolicy(this, 'NfwPolicy', {
      firewallPolicyName: cdk.Names.uniqueResourceName(this, { maxLength: 16 }) + '-Policy',
      firewallPolicy: {
        statelessDefaultActions: ['aws:forward_to_sfe'],
        statelessFragmentDefaultActions: ['aws:forward_to_sfe'],
        statefulDefaultActions: ['aws:drop_established'],
        statefulEngineOptions: { ruleOrder: 'STRICT_ORDER' },
        statefulRuleGroupReferences: [
          { priority: 1, resourceArn: nfwRuleGroup.attrRuleGroupArn },
        ],
      },
    });

    const nfw = new networkfirewall.CfnFirewall(this, 'Nfw', {
      firewallName: cdk.Names.uniqueResourceName(this, { maxLength: 16 }) + '-Nfw',
      firewallPolicyArn: nfwPolicy.attrFirewallPolicyArn,
      subnetMappings: [{ subnetId: fwSubnet.subnetId }],
      vpcId: vpc.vpcId,
    });

    // NFW Alert ログを CloudWatch Logs に出力
    const nfwAlertLogGroup = new logs.LogGroup(this, 'NfwAlertLogGroup', {
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    new networkfirewall.CfnLoggingConfiguration(this, 'NfwLogging', {
      firewallArn: nfw.ref,
      loggingConfiguration: {
        logDestinationConfigs: [
          {
            logDestination: { logGroup: nfwAlertLogGroup.logGroupName },
            logDestinationType: 'CloudWatchLogs',
            logType: 'ALERT',
          },
        ],
      },
    });

    // NFW VPC Endpoint ID 抽出 ("AZ:vpce-..." 形式から vpce-... を取得)
    const fwEndpointId = cdk.Fn.select(
      1,
      cdk.Fn.split(':', cdk.Fn.join(',', nfw.attrEndpointIds)),
    );

    // Cloud WAN Attachment Subnet: 0.0.0.0/0 -> NFW Endpoint
    new ec2.CfnRoute(this, 'CloudWanSubnetDefaultRoute', {
      routeTableId: cloudWanSubnet.routeTable.routeTableId,
      destinationCidrBlock: '0.0.0.0/0',
      vpcEndpointId: fwEndpointId,
    });

    // Public Subnet: RFC1918 リターン -> NFW Endpoint
    new ec2.CfnRoute(this, 'PublicSubnetInternalRoute', {
      routeTableId: publicSubnet.routeTable.routeTableId,
      destinationCidrBlock: '10.0.0.0/8',
      vpcEndpointId: fwEndpointId,
    });

    // Cloud WAN VPC Attachment (Inspection は applianceModeSupport: true)
    const attachment = new networkmanager.CfnVpcAttachment(this, 'CloudWanAttachment', {
      coreNetworkId: props.coreNetworkId,
      vpcArn: vpc.vpcArn,
      subnetArns: [
        cdk.Arn.format(
          { service: 'ec2', resource: 'subnet', resourceName: cloudWanSubnet.subnetId },
          cdk.Stack.of(this),
        ),
      ],
      options: { applianceModeSupport: true },
      tags: [{ key: cloudWanTagKey.Nfg, value: props.cloudWanNfgTag }],
    });

    // Firewall Subnet: 検査後のリターン (RFC1918) を Core Network へ
    // (0.0.0.0/0 -> NAT GW は L2 が PRIVATE_WITH_EGRESS から自動設定)
    const fwInternalRoute = new ec2.CfnRoute(this, 'FwSubnetInternalRoute', {
      routeTableId: fwSubnet.routeTable.routeTableId,
      destinationCidrBlock: '10.0.0.0/8',
      coreNetworkArn: props.coreNetworkArn,
    });
    fwInternalRoute.addDependency(attachment);
  }
}
