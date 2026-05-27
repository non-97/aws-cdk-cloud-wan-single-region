import * as networkmanager from 'aws-cdk-lib/aws-networkmanager';
import { Construct } from 'constructs';
import {
  CORE_NETWORK_CONFIG,
  cloudWanSegment,
  cloudWanNfg,
  cloudWanTagKey,
} from '../network-config';

export interface CoreNetworkProps {
  /** Cloud WAN Edge Location のリージョン */
  readonly region: string;
}

export class CoreNetwork extends Construct {
  public readonly coreNetworkId: string;
  public readonly coreNetworkArn: string;
  public readonly globalNetworkId: string;

  constructor(scope: Construct, id: string, props: CoreNetworkProps) {
    super(scope, id);

    const globalNetwork = new networkmanager.CfnGlobalNetwork(this, 'GlobalNetwork', {
      description: 'Cloud WAN Global Network',
    });

    const coreNetwork = new networkmanager.CfnCoreNetwork(this, 'CoreNetwork', {
      description: 'Cloud WAN Core Network',
      globalNetworkId: globalNetwork.attrId,
      policyDocument: {
        version: '2025.11',
        'core-network-configuration': {
          'asn-ranges': CORE_NETWORK_CONFIG.asnRanges,
          'edge-locations': [
            { location: props.region, asn: CORE_NETWORK_CONFIG.region1Asn },
          ],
        },
        segments: [
          {
            name: cloudWanSegment.Prod,
            'require-attachment-acceptance': false,
            'isolate-attachments': true,
            'edge-locations': [props.region],
          },
          {
            name: cloudWanSegment.Dev,
            'require-attachment-acceptance': false,
            'isolate-attachments': true,
            'edge-locations': [props.region],
          },
        ],
        'network-function-groups': [
          {
            name: cloudWanNfg.Security,
            'require-attachment-acceptance': false,
          },
        ],
        'segment-actions': [
          // Prod のインターネット行きを Security NFG (NFW) 経由に
          {
            action: 'send-to',
            segment: cloudWanSegment.Prod,
            via: { 'network-function-groups': [cloudWanNfg.Security] },
          },
          // Prod セグメント内通信 (Prod A <-> Prod B) を NFW 経由に
          {
            action: 'send-via',
            segment: cloudWanSegment.Prod,
            mode: 'single-hop',
            'when-sent-to': { segments: [cloudWanSegment.Prod] },
            via: { 'network-function-groups': [cloudWanNfg.Security] },
          },
          // Dev のインターネット行きを Security NFG (NFW) 経由に
          {
            action: 'send-to',
            segment: cloudWanSegment.Dev,
            via: { 'network-function-groups': [cloudWanNfg.Security] },
          },
          // Dev セグメント内通信 (Dev A <-> Dev B) を NFW 経由に
          {
            action: 'send-via',
            segment: cloudWanSegment.Dev,
            mode: 'single-hop',
            'when-sent-to': { segments: [cloudWanSegment.Dev] },
            via: { 'network-function-groups': [cloudWanNfg.Security] },
          },
          // Prod セグメントの RFC1918 を blackhole (Dev VPC への NFG 経由到達を遮断)。
          // LPM により Prod ローカル attachment route (10.1.0.0/16 等) と
          // 0.0.0.0/0 の send-to は影響を受けない
          {
            action: 'create-route',
            segment: cloudWanSegment.Prod,
            'destination-cidr-blocks': ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16'],
            destinations: ['blackhole'],
            description: 'Block cross-segment RFC1918 leakage from prod',
          },
          // Dev セグメント側にも同様に blackhole
          {
            action: 'create-route',
            segment: cloudWanSegment.Dev,
            'destination-cidr-blocks': ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16'],
            destinations: ['blackhole'],
            description: 'Block cross-segment RFC1918 leakage from dev',
          },
        ],
        'attachment-policies': [
          ...[
            { ruleNumber: 200, segment: cloudWanSegment.Prod },
            { ruleNumber: 300, segment: cloudWanSegment.Dev },
          ].map(({ ruleNumber, segment }) => ({
            'rule-number': ruleNumber,
            description: `attachment segment ${segment}`,
            'condition-logic': 'or',
            conditions: [
              {
                type: 'tag-value',
                operator: 'equals',
                key: cloudWanTagKey.Segment,
                value: segment,
              },
            ],
            action: { 'association-method': 'constant', segment },
          })),
          {
            'rule-number': 400,
            description: 'attachment nfg security',
            'condition-logic': 'or',
            conditions: [
              {
                type: 'tag-value',
                operator: 'equals',
                key: cloudWanTagKey.Nfg,
                value: cloudWanNfg.Security,
              },
            ],
            action: { 'add-to-network-function-group': cloudWanNfg.Security },
          },
        ],
      },
    });

    this.globalNetworkId = globalNetwork.attrId;
    this.coreNetworkId = coreNetwork.attrCoreNetworkId;
    this.coreNetworkArn = coreNetwork.attrCoreNetworkArn;
  }
}
