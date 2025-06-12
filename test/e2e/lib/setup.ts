import { reset } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { HardhatRuntimeEnvironment } from "hardhat/types";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { ZERO_BYTES, ZERO_ADDRESS, Folio } from "../constants"; // Assuming Folio type is from constants
import { whileImpersonating } from "../utils";

import FolioArtifact from "../../../out/Folio.sol/Folio.json";
import FolioDeployerArtifact from "../../../out/FolioDeployer.sol/FolioDeployer.json";
import FolioGovernorArtifact from "../../../out/FolioGovernor.sol/FolioGovernor.json";
import FolioLensArtifact from "../../../out/FolioLens.sol/FolioLens.json";
import GovernanceDeployerArtifact from "../../../out/GovernanceDeployer.sol/GovernanceDeployer.json";
import MathLibArtifact from "../../../out/MathLib.sol/MathLib.json";
import RebalancingLibArtifact from "../../../out/RebalancingLib.sol/RebalancingLib.json";
import ProxyAdminArtifact from "../../../out/ProxyAdmin.sol/ProxyAdmin.json";
import TimelockControllerUpgradeableArtifact from "../../../out/TimelockControllerUpgradeable.sol/TimelockControllerUpgradeable.json";
import UpgradeSpellArtifact from "../../../out/UpgradeSpell_4_0_0.sol/UpgradeSpell_4_0_0.json";
import VersionRegistryArtifact from "../../../out/FolioVersionRegistry.sol/FolioVersionRegistry.json";
import * as dotenv from "dotenv";

dotenv.config();

export const CHAIN_RPC_URLS: Record<number, string> = {
  1: process.env.MAINNET_RPC_URL!,
  8453: process.env.BASE_RPC_URL!,
};

export const CHAIN_BLOCK_NUMBERS: Record<number, number | undefined> = {
  1: 22482445,
  8453: 31052892,
};

export async function initializeChainState(hre: HardhatRuntimeEnvironment, folioConfig: Folio) {
  const rpcUrl = CHAIN_RPC_URLS[folioConfig.chainId];
  const blockNumber = CHAIN_BLOCK_NUMBERS[folioConfig.chainId];

  if (!rpcUrl) {
    throw new Error(`RPC URL not found for chainId: ${folioConfig.chainId}`);
  }
  // blockNumber can be undefined for latest, but reset expects number | undefined
  await reset(rpcUrl, blockNumber);
  await hre.ethers.provider.send("evm_mine", []); // Mine a new block to ensure base RPC works
}

export async function deployCommonContracts(hre: HardhatRuntimeEnvironment, folioConfig: Folio) {
  let bidder: HardhatEthersSigner;
  let admin: HardhatEthersSigner;
  let rebalanceManager: HardhatEthersSigner;
  let auctionLauncher: HardhatEthersSigner;

  [bidder] = await hre.ethers.getSigners();

  const folio = await hre.ethers.getContractAt(FolioArtifact.abi, folioConfig.address);

  admin = await hre.ethers.getSigner(await folio.getRoleMember(ZERO_BYTES, 0));

  // ensure on 4.0.0
  if ((await folio.version()) !== "4.0.0") {
    // Deploy implementations
    const GovernorFactory = await hre.ethers.getContractFactory(
      FolioGovernorArtifact.abi,
      FolioGovernorArtifact.bytecode.object,
    );
    const governor = await GovernorFactory.deploy();
    await governor.waitForDeployment();

    const TimelockFactory = await hre.ethers.getContractFactory(
      TimelockControllerUpgradeableArtifact.abi,
      TimelockControllerUpgradeableArtifact.bytecode.object,
    );
    const timelock = await TimelockFactory.deploy();
    await timelock.waitForDeployment();

    // Deploy GovernanceDeployer
    const GovernanceDeployerFactory = await hre.ethers.getContractFactory(
      GovernanceDeployerArtifact.abi,
      GovernanceDeployerArtifact.bytecode.object,
    );
    const governanceDeployer = await GovernanceDeployerFactory.deploy(
      await governor.getAddress(),
      await timelock.getAddress(),
    );
    await governanceDeployer.waitForDeployment();

    // Deploy required libraries first
    const MathLibFactory = await hre.ethers.getContractFactory(MathLibArtifact.abi, MathLibArtifact.bytecode.object);
    const mathLib = await MathLibFactory.deploy();
    await mathLib.waitForDeployment();

    const RebalancingLibFactory = await hre.ethers.getContractFactory(
      RebalancingLibArtifact.abi,
      RebalancingLibArtifact.bytecode.object,
    );
    const rebalancingLib = await RebalancingLibFactory.deploy();
    await rebalancingLib.waitForDeployment();

    let linkedBytecode = FolioDeployerArtifact.bytecode.object;
    const mathLibAddress = (await mathLib.getAddress()).slice(2);
    const rebalancingLibAddress = (await rebalancingLib.getAddress()).slice(2);

    linkedBytecode = linkedBytecode.replace(/__\$a9c6bd623be2c24c311ac53297b812b24c\$__/g, mathLibAddress);
    linkedBytecode = linkedBytecode.replace(/__\$3768f1fd6ff46374cf9f2c966db6d71973\$__/g, rebalancingLibAddress);

    await whileImpersonating(hre, "0xe8259842e71f4E44F2F68D6bfbC15EDA56E63064", async (signer: HardhatEthersSigner) => {
      const versionRegistry = await hre.ethers.getContractAt(
        VersionRegistryArtifact.abi,
        "0xa665b273997f70b647b66fa7ed021287544849db",
      );

      const FolioDeployerFactory = await hre.ethers.getContractFactory(FolioDeployerArtifact.abi, linkedBytecode);
      const folioDeployer = await FolioDeployerFactory.deploy(
        "0x0262E3e15cCFD2221b35D05909222f1f5FCdcd80", // daoFeeRegistry
        "0xa665b273997f70b647b66fa7ed021287544849db", // versionRegistry
        ZERO_ADDRESS, // trustedFillerRegistry
        await governanceDeployer.getAddress(), // governanceDeployer
      );
      await folioDeployer.waitForDeployment();

      await (versionRegistry.connect(signer) as any).registerVersion(await folioDeployer.getAddress());
    });

    const UpgradeFactory = await hre.ethers.getContractFactory(
      UpgradeSpellArtifact.abi,
      UpgradeSpellArtifact.bytecode.object,
    );
    const upgradeSpell = await UpgradeFactory.deploy();
    await upgradeSpell.waitForDeployment();

    await whileImpersonating(hre, await admin.getAddress(), async (signer: HardhatEthersSigner) => {
      const proxyAdmin = await hre.ethers.getContractAt(ProxyAdminArtifact.abi, folioConfig.proxyAdmin);
      await (proxyAdmin.connect(signer) as any).transferOwnership(await upgradeSpell.getAddress());
      await (folio.connect(signer) as any).grantRole(ZERO_BYTES, await upgradeSpell.getAddress());
      await (upgradeSpell.connect(signer) as any).cast(await folio.getAddress(), folioConfig.proxyAdmin);
    });
  }

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
