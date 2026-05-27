import * as cdk from 'aws-cdk-lib/core';
import { Construct } from 'constructs';
import { CoreNetwork, InspectionVpc, PrivateVpc } from './constructs';
import { TOKYO_NETWORK, cloudWanSegment, cloudWanNfg } from './network-config';

export class AwsCdkCloudWanSingleRegionStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const coreNetwork = new CoreNetwork(this, 'CoreNetwork', {
      region: this.region,
    });

    new InspectionVpc(this, 'InspectionVpc', {
      vpcCidr: TOKYO_NETWORK.inspection.vpcCidr,
      coreNetworkId: coreNetwork.coreNetworkId,
      coreNetworkArn: coreNetwork.coreNetworkArn,
      cloudWanNfgTag: cloudWanNfg.Security,
    });

    new PrivateVpc(this, 'ProdVpcA', {
      vpcCidr: TOKYO_NETWORK.prodA.vpcCidr,
      coreNetworkId: coreNetwork.coreNetworkId,
      coreNetworkArn: coreNetwork.coreNetworkArn,
      cloudWanSegmentTag: cloudWanSegment.Prod,
    });

    new PrivateVpc(this, 'ProdVpcB', {
      vpcCidr: TOKYO_NETWORK.prodB.vpcCidr,
      coreNetworkId: coreNetwork.coreNetworkId,
      coreNetworkArn: coreNetwork.coreNetworkArn,
      cloudWanSegmentTag: cloudWanSegment.Prod,
    });

    new PrivateVpc(this, 'DevVpcA', {
      vpcCidr: TOKYO_NETWORK.devA.vpcCidr,
      coreNetworkId: coreNetwork.coreNetworkId,
      coreNetworkArn: coreNetwork.coreNetworkArn,
      cloudWanSegmentTag: cloudWanSegment.Dev,
    });

    new PrivateVpc(this, 'DevVpcB', {
      vpcCidr: TOKYO_NETWORK.devB.vpcCidr,
      coreNetworkId: coreNetwork.coreNetworkId,
      coreNetworkArn: coreNetwork.coreNetworkArn,
      cloudWanSegmentTag: cloudWanSegment.Dev,
    });
  }
}
