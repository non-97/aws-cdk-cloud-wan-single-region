# aws-cdk-cloud-wan-single-region

AWS Cloud WAN を東京単一リージョン (ap-northeast-1) で構築する CDK (TypeScript) プロジェクト。

`send-to` / `send-via single-hop` で Prod / Dev 各セグメントのトラフィックを Inspection VPC (AWS Network Firewall + NAT Gateway) に集約し、`create-route` の blackhole でセグメント間の通信を遮断する。

## アーキテクチャ概要

```
                ┌──────────────────────────────────────┐
                │  Inspection VPC  10.201.0.0/24       │
                │  ┌─────────────────────────────────┐ │
                │  │ Public subnet (Zonal NAT GW)    │ │
                │  ├─────────────────────────────────┤ │
                │  │ Firewall subnet (NFW Endpoint)  │ │
                │  ├─────────────────────────────────┤ │
                │  │ CloudWan subnet (Attachment)    │ │
                │  └─────────────────────────────────┘ │
                └────────────────┬─────────────────────┘
                                 │ NFG: security
                                 │ (applianceModeSupport)
   ┌─────────────────────────────┴─────────────────────────────┐
   │                 Cloud WAN Core Network                    │
   │                                                           │
   │  Prod Segment (isolate-attachments: true)                 │
   │  ├─ send-to       → security NFG  (インターネット行き)   │
   │  ├─ send-via      → security NFG  (Prod 内通信)           │
   │  └─ create-route  → blackhole     (RFC1918)               │
   │                                                           │
   │  Dev Segment (isolate-attachments: true)                  │
   │  ├─ send-to       → security NFG  (インターネット行き)    │
   │  ├─ send-via      → security NFG  (Dev 内通信)            │
   │  └─ create-route  → blackhole     (RFC1918)               │
   └────┬────────┬─────────────────────────┬──────────┬────────┘
        │        │                         │          │
   ┌────▼───┐ ┌──▼─────┐              ┌────▼───┐ ┌────▼───┐
   │Prod VPC│ │Prod VPC│              │Dev VPC │ │Dev VPC │
   │   A    │ │   B    │              │   A    │ │   B    │
   │10.1/16 │ │10.2/16 │              │10.101/ │ │10.102/ │
   │        │ │        │              │   16   │ │   16   │
   └────────┘ └────────┘              └────────┘ └────────┘
```

### トラフィック制御の設計

| 通信パターン | 結果 | 制御方法 |
|---|---|---|
| Prod A ↔ Prod B | NFW 経由で疎通 | send-via single-hop (NFG) |
| Dev A ↔ Dev B | NFW 経由で疎通 | send-via single-hop (NFG) |
| Prod ↔ Dev クロス | drop | create-route blackhole (10.0.0.0/8 等) |
| Prod / Dev → インターネット | NFW + NAT GW 経由で疎通 | send-to (NFG) + LPM で 0/0 が blackhole より優先される |

Prod / Dev セグメントのルートテーブルには RFC1918 を blackhole で書いているが、Longest Prefix Match により以下が優先される。

- 自セグメント内 attachment route (`/16`) → blackhole (`/8`) より specific
- インターネット行き `0.0.0.0/0` (send-to) → blackhole の RFC1918 と重ならない

## ディレクトリ構造

```
.
├── bin/
│   └── aws-cdk-cloud-wan-single-region.ts   App エントリポイント
├── lib/
│   ├── aws-cdk-cloud-wan-single-region-stack.ts   メインスタック
│   ├── network-config.ts                    CIDR / セグメント名の一元定義
│   └── constructs/
│       ├── index.ts
│       ├── core-network.ts                  Cloud WAN GlobalNetwork + CoreNetwork
│       ├── inspection-vpc.ts                Inspection VPC + NFW + NAT GW
│       └── private-vpc.ts                   Prod / Dev 共通の VPC + EC2 + EIC
└── test/
    └── aws-cdk-cloud-wan-single-region.test.ts   Fine-grained assertions
```

## CIDR 一覧

| VPC | CIDR | サブネット |
|---|---|---|
| Inspection VPC | `10.201.0.0/24` | Firewall `/26`, CloudWan `/26`, Public `/26` |
| Prod VPC A | `10.1.0.0/16` | Private `/24`, CloudWan `/24` |
| Prod VPC B | `10.2.0.0/16` | Private `/24`, CloudWan `/24` |
| Dev VPC A | `10.101.0.0/16` | Private `/24`, CloudWan `/24` |
| Dev VPC B | `10.102.0.0/16` | Private `/24`, CloudWan `/24` |

すべて maxAzs: 1 (Zonal 構成、Inspection 以外は NAT Gateway なし)。

## 前提

- Node.js 22.x
- pnpm 9 以降
- AWS CLI (awsume で認証)
- CDK 2.1122 以降

## セットアップ

```bash
pnpm install
```

## デプロイ

```bash
# AWS 認証 (東京リージョン)
awsume <profile>
aws sts get-caller-identity

# 初回のみ
pnpm exec cdk bootstrap

# デプロイ
pnpm exec cdk deploy
```

NFW のプロビジョニングと VPC Attachment 5 件 (Inspection + Prod x2 + Dev x2) の作成で 15 ~ 25 分程度かかる。

## テスト

```bash
pnpm test
```

Fine-grained assertions で次を検証している。

- Cloud WAN policyDocument に prod / dev segment と security NFG が存在
- send-to / send-via / create-route(blackhole) のアクションが揃っている
- VPC Attachment のタグと applianceModeSupport: true
- NFW 関連リソースと RuleVariables の IPSets
- Inspection VPC のサブネットが /26 で 3 つ
- 各 VPC のルートテーブルに正しい next-hop が設定されている

## 疎通確認

デプロイ完了後、AWS Network Manager コンソールで以下を確認。

1. Core Network の Policy version が active
2. Attachments 5 件すべて Available
3. Prod / Dev セグメントの Route table にローカル attachment route と `0.0.0.0/0` (NFG への擬似ルート) と RFC1918 blackhole が表示される

EIC で Prod A の EC2 にログインして疎通テスト。

```bash
aws ec2-instance-connect ssh --instance-id <prod-a-instance-id> --region ap-northeast-1
```

| テスト | 期待結果 | 確認方法 |
|---|---|---|
| Prod A → Prod B (10.2.0.0/16 内 EC2) | ping 応答 | NFW Alert Log Group に `ICMP ping detected` |
| Prod A → Dev A (10.101.0.0/16 内 EC2) | タイムアウト | Cloud WAN blackhole で drop |
| Prod A → `checkip.amazonaws.com` | 応答あり | NFW Alert Log Group に `Access to checkip.amazonaws.com detected` |

## クリーンアップ

```bash
pnpm exec cdk destroy
```

Cloud WAN Core Network の削除に時間がかかる (10 ~ 20 分)。

## 主要な設計判断

### なぜ Cloud WAN の blackhole で Prod ↔ Dev を遮断するか

共通 NFG (Inspection VPC) を Prod / Dev 両方から `send-to` で参照すると、NFG の RIB は AWS が自動的に両セグメントの attachment routes を持つ。これによりトラフィックは Prod → NFG → Dev という経路で疎通してしまう。

- NFG の RIB は AWS 管理でユーザー編集不可
- `deny-filter-in/out` は `share` action 専用
- `send-to`/`send-via` には CIDR 制限のオプションなし

そのため Cloud WAN policy 機能だけで遮断する正規の手段は `segment-actions` の `create-route` + `destinations: ["blackhole"]` 一択。Longest Prefix Match で自セグメントのローカル CIDR とインターネット行き 0/0 への影響なく、他セグメントの RFC1918 だけを落とせる。

### なぜ Inspection VPC のサブネットを /26 にしているか

Inspection VPC の CIDR が `10.201.0.0/24` (256 アドレス) で、Public / Firewall / CloudWan の 3 サブネットが必要。CDK の L2 `ec2.Vpc` は cidrMask を明示しないと自動計算するが、`/24` に 3 サブネットを切る計算は通らないため、`cidrMask: 26` (64 アドレス x 3) を明示している。

### なぜ Inspection VPC の VPC Attachment だけ applianceModeSupport: true か

NFW を経由した戻りトラフィックを同じ AZ / 同じ ENI から戻すためのフロー対称性確保に必要。Prod / Dev の通常 Attachment には不要。

## 参考

- [AWS Cloud WAN Policies JSON](https://docs.aws.amazon.com/network-manager/latest/cloudwan/cloudwan-policies-json.html)
- [Simplify global security inspection with AWS Cloud WAN service insertion](https://aws.amazon.com/blogs/networking-and-content-delivery/simplify-global-security-inspection-with-aws-cloud-wan-service-insertion/)
- [Service Insertion in AWS Cloud WAN](https://docs.aws.amazon.com/network-manager/latest/cloudwan/cloudwan-policy-service-insertion.html)
