import "@nomicfoundation/hardhat-ethers";
import { HardhatRuntimeEnvironment } from "hardhat/types";
import { time } from "@nomicfoundation/hardhat-toolbox/network-helpers";

import { whileImpersonating } from "./utils";
import { getStartRebalance } from "../src/start-rebalance";
import { FolioVersion } from "../src/types";
import { RebalanceContracts, RebalanceSigners } from "./types";

import { StartRebalanceArgsPartial as StartRebalanceArgsPartial_4_0_0 } from "../src/4.0.0/types";
import { StartRebalanceArgsPartial as StartRebalanceArgsPartial_5_0_0 } from "../src/types";

export async function startRebalance(
  version: FolioVersion,
  hre: HardhatRuntimeEnvironment,
  contracts: RebalanceContracts,
  signers: RebalanceSigners,
  tokens: string[],
  targetBasketRec: Record<string, bigint>,
  rebalancePricesRec: Record<string, { snapshotPrice: number }>,
  priceDeviation: number = 0.5,
  debug?: boolean,
  governanceDelayDays?: number,
): Promise<void> {
  const { folio } = contracts;
  const { rebalanceManager } = signers;

  const initialSupply = await folio.totalSupply();
  const [currentTokens, currentAssets] = await folio.totalAssets();

  // Get decimals for all tokens
  const allDecimalsRec: Record<string, bigint> = {};
  for (const token of tokens) {
    const tokenContract = await hre.ethers.getContractAt("IERC20Metadata", token);
    allDecimalsRec[token] = await tokenContract.decimals();
  }

  if (Object.keys(targetBasketRec).length !== tokens.length) {
    throw new Error("Mismatch between tokens length and targetBasketRec keys");
  }

  // Build initialAssets array matching the tokens parameter order
  const initialAssets: bigint[] = tokens.map((token: string) => {
    const idx = currentTokens.findIndex((t: string) => t.toLowerCase() === token.toLowerCase());
    return idx === -1 ? 0n : currentAssets[idx];
  });

  // {USD}
  const currentBasketValuesRec: Record<string, number> = {};
  tokens.forEach((token: string, i: number) => {
    const price = rebalancePricesRec[token.toLowerCase()];
    if (!price) {
      throw new Error(`Token ${token} from tokens not found in rebalancePricesRec: ${token}`);
    }

    // {USD} = {USD/wholeTok} * {tok} / {tok/wholeTok}
    currentBasketValuesRec[token] =
      (price.snapshotPrice * Number(initialAssets[i])) / Number(10n ** allDecimalsRec[token]);
  });

  const [weightControl] = await folio.rebalanceControl();

  const pricesArray = tokens.map((token: string) => rebalancePricesRec[token.toLowerCase()].snapshotPrice);
  const decimalsArray = tokens.map((token: string) => allDecimalsRec[token]);
  const targetBasketArray = tokens.map((token: string) => targetBasketRec[token]);

  const startRebalanceArgs: StartRebalanceArgsPartial_4_0_0 | StartRebalanceArgsPartial_5_0_0 = getStartRebalance(
    version,
    initialSupply,
    tokens,
    initialAssets,
    decimalsArray,
    targetBasketArray,
    pricesArray,
    pricesArray.map((_: number) => priceDeviation),
    pricesArray.map((_: number) => 1e12), // maxAuctionSizes in USD (1 trillion = effectively unlimited)
    weightControl,
    false,
    debug,
  );

  // advance time as-if startRebalance() call was stuck in governance
  const delayDays = governanceDelayDays ?? 5;
  const delaySeconds = Math.floor(delayDays * 24 * 60 * 60);
  await hre.network.provider.send("evm_setNextBlockTimestamp", [(await time.latest()) + delaySeconds]);
  await hre.network.provider.send("evm_mine", []);

  if (debug) {
    console.log("Initial state captured BEFORE startRebalance:");
    console.log(`  Supply: ${initialSupply}`);
    for (let i = 0; i < Math.min(3, tokens.length); i++) {
      const symbol = await (await hre.ethers.getContractAt("IERC20Metadata", tokens[i])).symbol();
      console.log(`  ${symbol}: ${initialAssets[i]}`);
    }
  }

  // start rebalance
  await whileImpersonating(hre, await rebalanceManager.getAddress(), async (signer) => {
    if (version === FolioVersion.V4) {
      await (
        await (folio.connect(signer) as any).startRebalance(
          (startRebalanceArgs as StartRebalanceArgsPartial_4_0_0).tokens,
          (startRebalanceArgs as StartRebalanceArgsPartial_4_0_0).weights,
          (startRebalanceArgs as StartRebalanceArgsPartial_4_0_0).prices,
          (startRebalanceArgs as StartRebalanceArgsPartial_4_0_0).limits,
          0n,
          1000000n,
        )
      ).wait();
    } else if (version === FolioVersion.V5) {
      await (
        await (folio.connect(signer) as any).startRebalance(
          (startRebalanceArgs as StartRebalanceArgsPartial_5_0_0).tokens,
          (startRebalanceArgs as StartRebalanceArgsPartial_5_0_0).limits,
          0n,
          1000000n,
        )
      ).wait();
    } else {
      throw new Error(`Unsupported version: ${version}`);
    }
  });
}
