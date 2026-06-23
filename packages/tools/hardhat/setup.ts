import "@nomicfoundation/hardhat-ethers";
import { reset } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { HardhatRuntimeEnvironment } from "hardhat/types";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { FolioConfig } from "./types";
import { whileImpersonating } from "./utils";
import { loadSdk } from "../src/sdk";

import * as dotenv from "dotenv";

dotenv.config();

const CHAIN_RPC_URLS: Record<number, string | undefined> = {
  1: process.env.MAINNET_RPC_URL,
  8453: process.env.BASE_RPC_URL,
  56: process.env.BSC_RPC_URL,
};

const DTF_ARTIFACTS = "../../../node_modules/@reserve-protocol/reserve-index-dtf/out";

const loadFolioArtifact = () => require(`${DTF_ARTIFACTS}/Folio.sol/Folio.json`);
const loadFolioLensArtifact = () => require(`${DTF_ARTIFACTS}/FolioLens.sol/FolioLens.json`);
const loadRebalancingLibArtifact = () => require(`${DTF_ARTIFACTS}/RebalancingLib.sol/RebalancingLib.json`);
const loadProxyAdminArtifact = () => require(`${DTF_ARTIFACTS}/FolioProxy.sol/FolioProxyAdmin.json`);

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

export async function deployFolioLens(hre: HardhatRuntimeEnvironment) {
  const FolioLensArtifact = loadFolioLensArtifact();
  const factory = await hre.ethers.getContractFactory(FolioLensArtifact.abi, FolioLensArtifact.bytecode.object);
  const lens = await factory.deploy();
  await lens.waitForDeployment();
  return await hre.ethers.getContractAt(FolioLensArtifact.abi, await lens.getAddress());
}

export async function setupContractsAndSigners(hre: HardhatRuntimeEnvironment, folioConfig: FolioConfig) {
  let bidder: HardhatEthersSigner;
  let admin: HardhatEthersSigner;
  let rebalanceManager: HardhatEthersSigner;
  let auctionLauncher: HardhatEthersSigner;

  [bidder] = await hre.ethers.getSigners();

  const { dtfIndexAbi } = await loadSdk();
  const folio = await hre.ethers.getContractAt(dtfIndexAbi as any, folioConfig.folio);

  admin = await hre.ethers.getSigner(
    await folio.getRoleMember("0x0000000000000000000000000000000000000000000000000000000000000000", 0),
  );

  rebalanceManager = await hre.ethers.getSigner(
    await folio.getRoleMember("0x4ff6ae4d6a29e79ca45c6441bdc89b93878ac6118485b33c8baa3749fc3cb130", 0), // REBALANCE_MANAGER
  );
  auctionLauncher = await hre.ethers.getSigner(
    await folio.getRoleMember("0x13ff1b2625181b311f257c723b5e6d366eb318b212d9dd694c48fcf227659df5", 0), // AUCTION_LAUNCHER
  );

  const folioLensTyped = await deployFolioLens(hre);

  return { folio, folioLensTyped, bidder, admin, rebalanceManager, auctionLauncher };
}

export async function deployCommonContracts(hre: HardhatRuntimeEnvironment, folioConfig: FolioConfig) {
  let bidder: HardhatEthersSigner;
  let admin: HardhatEthersSigner;
  let rebalanceManager: HardhatEthersSigner;
  let auctionLauncher: HardhatEthersSigner;

  const signers = await hre.ethers.getSigners();
  [bidder, admin, rebalanceManager, auctionLauncher] = signers;

  const FolioArtifact = loadFolioArtifact();
  const RebalancingLibArtifact = loadRebalancingLibArtifact();
  const ProxyAdminArtifact = loadProxyAdminArtifact();

  const folio = await hre.ethers.getContractAt(FolioArtifact.abi, folioConfig.folio);

  const RebalancingLibFactory = await hre.ethers.getContractFactory(
    RebalancingLibArtifact.abi,
    RebalancingLibArtifact.bytecode.object,
  );
  const rebalancingLib = await RebalancingLibFactory.deploy();
  await rebalancingLib.waitForDeployment();

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

  const folioLensTyped = await deployFolioLens(hre);

  return { admin, bidder, folio, folioLensTyped, rebalanceManager, auctionLauncher, proxyAdmin };
}
