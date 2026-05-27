/** RFC1918 プライベートアドレス帯 */
export const RFC1918_CIDRS = [
  '10.0.0.0/8',
  '172.16.0.0/12',
  '192.168.0.0/16',
] as const;

/** Cloud WAN Attachment タグキー */
export const cloudWanTagKey = {
  Segment: 'cloudwan-seg',
  Nfg: 'cloudwan-nfg',
} as const;

/** Cloud WAN セグメント名 */
export const cloudWanSegment = {
  Prod: 'prod',
  Dev: 'dev',
} as const;

/** Cloud WAN Network Function Group 名 */
export const cloudWanNfg = {
  Security: 'security',
} as const;

/** Cloud WAN Core Network 設定 */
export const CORE_NETWORK_CONFIG = {
  asnRanges: ['65000-65099'],
  region1Asn: 65001,
} as const;

/** VPC ごとのネットワーク設定 */
export interface VpcNetworkConfig {
  readonly vpcCidr: string;
}

/** 東京リージョンのネットワーク設定 */
export interface NetworkConfig {
  readonly inspection: VpcNetworkConfig;
  readonly prodA: VpcNetworkConfig;
  readonly prodB: VpcNetworkConfig;
  readonly devA: VpcNetworkConfig;
  readonly devB: VpcNetworkConfig;
}

export const TOKYO_NETWORK: NetworkConfig = {
  inspection: { vpcCidr: '10.201.0.0/24' },
  prodA: { vpcCidr: '10.1.0.0/16' },
  prodB: { vpcCidr: '10.2.0.0/16' },
  devA: { vpcCidr: '10.101.0.0/16' },
  devB: { vpcCidr: '10.102.0.0/16' },
};

/** Network Firewall ルール変数の IP Set マップ */
export const ALL_VPC_CIDRS = {
  InspectionVPC_NET: [TOKYO_NETWORK.inspection.vpcCidr],
  ProdAVPC_NET: [TOKYO_NETWORK.prodA.vpcCidr],
  ProdBVPC_NET: [TOKYO_NETWORK.prodB.vpcCidr],
  DevAVPC_NET: [TOKYO_NETWORK.devA.vpcCidr],
  DevBVPC_NET: [TOKYO_NETWORK.devB.vpcCidr],
} as const;
