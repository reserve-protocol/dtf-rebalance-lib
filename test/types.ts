import { Contract } from "ethers";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import { FolioVersion } from "../src/types";

export interface FolioConfig {
  version: FolioVersion;
  name: string;
  chainId: number;
  folio: string;
  proxyAdmin: string;
  basketGovernor?: string;
}

export interface RebalanceContracts {
  folio: Contract;
  folioLensTyped: Contract;
}

export interface RebalanceSigners {
  admin: HardhatEthersSigner;
  bidder: HardhatEthersSigner;
  rebalanceManager: HardhatEthersSigner;
  auctionLauncher: HardhatEthersSigner;
}

export interface RebalanceInitialState {
  initialTokens: string[];
  initialAssets: bigint[];
  initialSupply: bigint;
  startRebalanceArgs: {
    tokens: any[];
    limits: any;
  };
}
