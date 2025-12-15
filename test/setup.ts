import "@nomicfoundation/hardhat-ethers";
import { reset } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { HardhatRuntimeEnvironment } from "hardhat/types";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { FolioConfig } from "./types";
import { whileImpersonating } from "./utils";

import FolioArtifact from "../out/Folio.sol/Folio.json";
import FolioLensArtifact from "../out/FolioLens.sol/FolioLens.json";
import MathLibArtifact from "../out/MathLib.sol/MathLib.json";
import RebalancingLibArtifact from "../out/RebalancingLib.sol/RebalancingLib.json";
import ProxyAdminArtifact from "../out/ProxyAdmin.sol/ProxyAdmin.json";
import * as dotenv from "dotenv";

dotenv.config();

const CHAIN_RPC_URLS: Record<number, string | undefined> = {
  1: process.env.MAINNET_RPC_URL,
  8453: process.env.BASE_RPC_URL,
  56: process.env.BSC_RPC_URL,
};

export async function initializeChainState(
  hre: HardhatRuntimeEnvironment,
  folioConfig: FolioConfig,
  blockNumber?: number,
) {
  const rpcUrl = CHAIN_RPC_URLS[folioConfig.chainId];

  if (!rpcUrl) {
    throw new Error(`RPC URL not found for chainId: ${folioConfig.chainId}`);
  }

  // Fork from specific block or latest
  await reset(rpcUrl, blockNumber);
  await hre.ethers.provider.send("evm_mine", []); // Mine a new block to ensure RPC works
}

export async function setupContractsAndSigners(hre: HardhatRuntimeEnvironment, folioConfig: FolioConfig) {
  let bidder: HardhatEthersSigner;
  let admin: HardhatEthersSigner;
  let rebalanceManager: HardhatEthersSigner;
  let auctionLauncher: HardhatEthersSigner;

  [bidder] = await hre.ethers.getSigners();

  const folio = await hre.ethers.getContractAt(FolioArtifact.abi, folioConfig.folio);

  admin = await hre.ethers.getSigner(
    await folio.getRoleMember("0x0000000000000000000000000000000000000000000000000000000000000000", 0),
  );

  rebalanceManager = await hre.ethers.getSigner(
    await folio.getRoleMember("0x4ff6ae4d6a29e79ca45c6441bdc89b93878ac6118485b33c8baa3749fc3cb130", 0), // REBALANCE_MANAGER
  );
  auctionLauncher = await hre.ethers.getSigner(
    await folio.getRoleMember("0x13ff1b2625181b311f257c723b5e6d366eb318b212d9dd694c48fcf227659df5", 0), // AUCTION_LAUNCHER
  );

  const FolioLensFactory = await hre.ethers.getContractFactory(
    FolioLensArtifact.abi,
    FolioLensArtifact.bytecode.object,
  );
  const folioLens = await FolioLensFactory.deploy();
  await folioLens.waitForDeployment();
  const folioLensTyped = await hre.ethers.getContractAt(FolioLensArtifact.abi, await folioLens.getAddress());

  return { folio, folioLensTyped, bidder, admin, rebalanceManager, auctionLauncher };
}

export async function deployCommonContracts(hre: HardhatRuntimeEnvironment, folioConfig: FolioConfig) {
  let bidder: HardhatEthersSigner;
  let admin: HardhatEthersSigner;
  let rebalanceManager: HardhatEthersSigner;
  let auctionLauncher: HardhatEthersSigner;

  const signers = await hre.ethers.getSigners();
  [bidder, admin, rebalanceManager, auctionLauncher] = signers;

  const folio = await hre.ethers.getContractAt(FolioArtifact.abi, folioConfig.folio);

  const MathLibFactory = await hre.ethers.getContractFactory(MathLibArtifact.abi, MathLibArtifact.bytecode.object);
  const mathLib = await MathLibFactory.deploy();
  await mathLib.waitForDeployment();

  const RebalancingLibFactory = await hre.ethers.getContractFactory(
    RebalancingLibArtifact.abi,
    RebalancingLibArtifact.bytecode.object,
  );
  const rebalancingLib = await RebalancingLibFactory.deploy();
  await rebalancingLib.waitForDeployment();

  const FolioLensFactory = await hre.ethers.getContractFactory(
    FolioLensArtifact.abi,
    FolioLensArtifact.bytecode.object.replace(
      /__\$[a-fA-F0-9]+\$__/g,
      (await mathLib.getAddress()).slice(2).padEnd(40, "0"),
    ),
  );
  const folioLens = await FolioLensFactory.deploy();
  await folioLens.waitForDeployment();
  const folioLensTyped = await hre.ethers.getContractAt(FolioLensArtifact.abi, await folioLens.getAddress());

  const proxyAdmin = await hre.ethers.getContractAt(ProxyAdminArtifact.abi, folioConfig.proxyAdmin);

  const proxyAdminOwner = await proxyAdmin.owner();

  const FolioFactory = await hre.ethers.getContractFactory(
    FolioArtifact.abi,
    FolioArtifact.bytecode.object.replace(/__\$[a-fA-F0-9]+\$__/g, (await rebalancingLib.getAddress()).slice(2)),
  );
  const newFolioImp = await FolioFactory.deploy();
  await newFolioImp.waitForDeployment();

  const implementationUpgradeCalldata = proxyAdmin.interface.encodeFunctionData("upgradeAndCall", [
    folioConfig.folio,
    await newFolioImp.getAddress(),
    "0x",
  ]);

  await whileImpersonating(hre, proxyAdminOwner, async (ownerSigner: HardhatEthersSigner) => {
    const tx = await ownerSigner.sendTransaction({
      to: await proxyAdmin.getAddress(),
      data: implementationUpgradeCalldata,
    });
    await tx.wait();
  });

  return { admin, bidder, folio, folioLensTyped, rebalanceManager, auctionLauncher, proxyAdmin };
}
