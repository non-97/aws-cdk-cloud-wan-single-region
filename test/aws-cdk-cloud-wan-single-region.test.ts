import * as cdk from 'aws-cdk-lib/core';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { AwsCdkCloudWanSingleRegionStack } from '../lib/aws-cdk-cloud-wan-single-region-stack';
import {
  cloudWanTagKey,
  cloudWanSegment,
  cloudWanNfg,
} from '../lib/network-config';

describe('AwsCdkCloudWanSingleRegionStack', () => {
  const app = new cdk.App();
  const stack = new AwsCdkCloudWanSingleRegionStack(app, 'TestStack', {
    env: { account: '123456789012', region: 'ap-northeast-1' },
  });
  const template = Template.fromStack(stack);

  test('Core Network が作成される', () => {
    template.resourceCountIs('AWS::NetworkManager::GlobalNetwork', 1);
    template.resourceCountIs('AWS::NetworkManager::CoreNetwork', 1);
  });

  test('Core Network Policy に prod / dev セグメントと security NFG が含まれる', () => {
    template.hasResourceProperties('AWS::NetworkManager::CoreNetwork', {
      PolicyDocument: Match.objectLike({
        segments: Match.arrayWith([
          Match.objectLike({ name: cloudWanSegment.Prod, 'isolate-attachments': true }),
          Match.objectLike({ name: cloudWanSegment.Dev, 'isolate-attachments': true }),
        ]),
        'network-function-groups': Match.arrayWith([
          Match.objectLike({ name: cloudWanNfg.Security }),
        ]),
      }),
    });
  });

  test('Core Network Policy に share セグメントが含まれない', () => {
    const cores = template.findResources('AWS::NetworkManager::CoreNetwork');
    const policy = Object.values(cores)[0].Properties.PolicyDocument;
    const segmentNames: string[] = policy.segments.map((s: { name: string }) => s.name);
    expect(segmentNames).not.toContain('share');
  });

  test('Segment Actions に send-to / send-via / create-route(blackhole) が揃っている', () => {
    const cores = template.findResources('AWS::NetworkManager::CoreNetwork');
    const policy = Object.values(cores)[0].Properties.PolicyDocument;
    const actions: Array<Record<string, unknown>> = policy['segment-actions'];
    expect(actions).toHaveLength(6);
    expect(actions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ action: 'send-to', segment: cloudWanSegment.Prod }),
        expect.objectContaining({ action: 'send-via', segment: cloudWanSegment.Prod, mode: 'single-hop' }),
        expect.objectContaining({ action: 'send-to', segment: cloudWanSegment.Dev }),
        expect.objectContaining({ action: 'send-via', segment: cloudWanSegment.Dev, mode: 'single-hop' }),
        expect.objectContaining({
          action: 'create-route',
          segment: cloudWanSegment.Prod,
          'destination-cidr-blocks': ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16'],
          destinations: ['blackhole'],
        }),
        expect.objectContaining({
          action: 'create-route',
          segment: cloudWanSegment.Dev,
          'destination-cidr-blocks': ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16'],
          destinations: ['blackhole'],
        }),
      ]),
    );
  });

  test('Attachment Policies に prod / dev / security の rule (200/300/400) があり 100 は無い', () => {
    const cores = template.findResources('AWS::NetworkManager::CoreNetwork');
    const policy = Object.values(cores)[0].Properties.PolicyDocument;
    const ruleNumbers: number[] = policy['attachment-policies'].map(
      (p: { 'rule-number': number }) => p['rule-number'],
    );
    expect(ruleNumbers).toEqual(expect.arrayContaining([200, 300, 400]));
    expect(ruleNumbers).not.toContain(100);
  });

  test('VPC が 5 個 (Inspection + Prod x2 + Dev x2) 作成される', () => {
    template.resourceCountIs('AWS::EC2::VPC', 5);
  });

  test('各 VPC の CIDR が想定どおり', () => {
    for (const cidr of ['10.201.0.0/24', '10.1.0.0/16', '10.2.0.0/16', '10.101.0.0/16', '10.102.0.0/16']) {
      template.hasResourceProperties('AWS::EC2::VPC', { CidrBlock: cidr });
    }
  });

  test('Inspection VPC のサブネットが /26 で 3 個作られる', () => {
    for (const cidr of ['10.201.0.0/26', '10.201.0.64/26', '10.201.0.128/26']) {
      template.hasResourceProperties('AWS::EC2::Subnet', { CidrBlock: cidr });
    }
  });

  test('Prod セグメントの VpcAttachment が 2 個', () => {
    const prodAttachments = template.findResources('AWS::NetworkManager::VpcAttachment', {
      Properties: {
        Tags: Match.arrayWith([
          Match.objectLike({ Key: cloudWanTagKey.Segment, Value: cloudWanSegment.Prod }),
        ]),
      },
    });
    expect(Object.keys(prodAttachments)).toHaveLength(2);
  });

  test('Dev セグメントの VpcAttachment が 2 個', () => {
    const devAttachments = template.findResources('AWS::NetworkManager::VpcAttachment', {
      Properties: {
        Tags: Match.arrayWith([
          Match.objectLike({ Key: cloudWanTagKey.Segment, Value: cloudWanSegment.Dev }),
        ]),
      },
    });
    expect(Object.keys(devAttachments)).toHaveLength(2);
  });

  test('Security NFG の VpcAttachment が 1 個で applianceModeSupport: true', () => {
    template.hasResourceProperties('AWS::NetworkManager::VpcAttachment', {
      Options: { ApplianceModeSupport: true },
      Tags: Match.arrayWith([
        Match.objectLike({ Key: cloudWanTagKey.Nfg, Value: cloudWanNfg.Security }),
      ]),
    });
  });

  test('Network Firewall 関連リソースが揃っている', () => {
    template.resourceCountIs('AWS::NetworkFirewall::RuleGroup', 1);
    template.resourceCountIs('AWS::NetworkFirewall::FirewallPolicy', 1);
    template.resourceCountIs('AWS::NetworkFirewall::Firewall', 1);
    template.resourceCountIs('AWS::NetworkFirewall::LoggingConfiguration', 1);
  });

  test('NFW Rule Group の IPSets に全 VPC のキーが含まれる', () => {
    template.hasResourceProperties('AWS::NetworkFirewall::RuleGroup', {
      RuleGroup: Match.objectLike({
        RuleVariables: {
          IPSets: Match.objectLike({
            InspectionVPC_NET: Match.anyValue(),
            ProdAVPC_NET: Match.anyValue(),
            ProdBVPC_NET: Match.anyValue(),
            DevAVPC_NET: Match.anyValue(),
            DevBVPC_NET: Match.anyValue(),
          }),
        },
      }),
    });
  });

  test('NAT Gateway が 1 個 (Inspection VPC のみ)', () => {
    template.resourceCountIs('AWS::EC2::NatGateway', 1);
  });

  test('EC2 Instance が 4 個 (各 Prod/Dev VPC)', () => {
    template.resourceCountIs('AWS::EC2::Instance', 4);
  });

  test('EC2 Instance Connect Endpoint が 4 個', () => {
    template.resourceCountIs('AWS::EC2::InstanceConnectEndpoint', 4);
  });

  test('Prod/Dev Private subnet に 0.0.0.0/0 -> CoreNetworkArn のルートがある', () => {
    const routes = template.findResources('AWS::EC2::Route', {
      Properties: {
        DestinationCidrBlock: '0.0.0.0/0',
        CoreNetworkArn: Match.anyValue(),
      },
    });
    expect(Object.keys(routes).length).toBeGreaterThanOrEqual(4);
  });

  test('Inspection CloudWan subnet に 0.0.0.0/0 -> NFW Endpoint のルートがある', () => {
    template.hasResourceProperties('AWS::EC2::Route', {
      DestinationCidrBlock: '0.0.0.0/0',
      VpcEndpointId: Match.anyValue(),
    });
  });

  test('Inspection Public subnet に 10.0.0.0/8 -> NFW Endpoint のルートがある', () => {
    template.hasResourceProperties('AWS::EC2::Route', {
      DestinationCidrBlock: '10.0.0.0/8',
      VpcEndpointId: Match.anyValue(),
    });
  });

  test('Inspection Firewall subnet に 10.0.0.0/8 -> CoreNetworkArn のルートがある', () => {
    template.hasResourceProperties('AWS::EC2::Route', {
      DestinationCidrBlock: '10.0.0.0/8',
      CoreNetworkArn: Match.anyValue(),
    });
  });

  test('NFW Alert 用 LogGroup が作成される', () => {
    template.resourceCountIs('AWS::Logs::LogGroup', 1);
  });
});
