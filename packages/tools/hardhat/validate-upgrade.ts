import "@nomicfoundation/hardhat-ethers";
import { HardhatRuntimeEnvironment } from "hardhat/types";
import { Contract } from "ethers";

import { whileImpersonating } from "./utils";
import { deployFolioLens } from "./setup";
import { FolioConfig } from "./types";

// EIP-1967 implementation slot
const IMPLEMENTATION_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";

const DTF_ARTIFACTS = "../../../node_modules/@reserve-protocol/reserve-index-dtf/out";

const loadFolioArtifact = () => require(`${DTF_ARTIFACTS}/Folio.sol/Folio.json`);
const loadRebalancingLibArtifact = () => require(`${DTF_ARTIFACTS}/RebalancingLib.sol/RebalancingLib.json`);

/**
 * Post-check: verify the Folio proxy is still upgradeable.
 * Deploys a new Folio implementation, upgrades via ProxyAdmin, and verifies
 * the implementation changed and the folio still works.
 *
 * @returns new folioLensTyped (redeployed after upgrade)
 */
export async function validateUpgrade(
  hre: HardhatRuntimeEnvironment,
  folio: Contract,
  folioConfig: FolioConfig,
): Promise<Contract> {
  console.log(`\n🧪 Validation upgrade check...`);

  const folioAddress = await folio.getAddress();

  // Read implementation slot before upgrade
  const implBefore = await hre.ethers.provider.getStorage(folioAddress, IMPLEMENTATION_SLOT);

  // Deploy RebalancingLib
  const RebalancingLibArtifact = loadRebalancingLibArtifact();
  const RebalancingLibFactory = await hre.ethers.getContractFactory(
    RebalancingLibArtifact.abi,
    RebalancingLibArtifact.bytecode.object,
  );
  const rebalancingLib = await RebalancingLibFactory.deploy();
  await rebalancingLib.waitForDeployment();

  // Deploy new Folio implementation with linked library
  const FolioArtifact = loadFolioArtifact();
  const FolioFactory = await hre.ethers.getContractFactory(
    FolioArtifact.abi,
    FolioArtifact.bytecode.object.replace(/__\$[a-fA-F0-9]+\$__/g, (await rebalancingLib.getAddress()).slice(2)),
  );
  const newFolioImpl = await FolioFactory.deploy();
  await newFolioImpl.waitForDeployment();

  // Upgrade by impersonating the FolioProxyAdmin contract and calling
  // upgradeToAndCall directly on the proxy. The FolioProxy's _fallback
  // accepts upgradeToAndCall from msg.sender == admin (the ProxyAdmin address).
  const iface = new hre.ethers.Interface([
    "function upgradeToAndCall(address implementation, bytes data)",
  ]);
  const upgradeCalldata = iface.encodeFunctionData("upgradeToAndCall", [
    await newFolioImpl.getAddress(),
    "0x",
  ]);

  await whileImpersonating(hre, folioConfig.proxyAdmin, async (proxyAdminSigner) => {
    const tx = await proxyAdminSigner.sendTransaction({
      to: folioAddress,
      data: upgradeCalldata,
    });
    await tx.wait();
  });

  // Read implementation slot after upgrade — must have changed
  const implAfter = await hre.ethers.provider.getStorage(folioAddress, IMPLEMENTATION_SLOT);
  if (implBefore === implAfter) {
    throw new Error(
      `Upgrade failed: implementation slot did not change.\n` +
        `Before: ${implBefore}\n` +
        `After:  ${implAfter}`,
    );
  }
  console.log(`   ✅ Implementation slot changed`);

  // Verify folio still works after upgrade
  const version = await folio.version();
  if (version[0] !== "5") {
    throw new Error(`Folio version after upgrade is ${version}, expected 5.x.x`);
  }
  console.log(`   ✅ Version: ${version}`);

  const [tokens, assets] = await folio.totalAssets();
  if (tokens.length === 0) {
    throw new Error("totalAssets() returned empty after upgrade");
  }
  console.log(`   ✅ totalAssets: ${tokens.length} tokens`);

  // Redeploy FolioLens to match upgraded implementation
  const folioLensTyped = await deployFolioLens(hre);
  console.log(`   ✅ FolioLens redeployed`);

  console.log(`   ✅ Validation upgrade completed successfully`);
  return folioLensTyped;
}
