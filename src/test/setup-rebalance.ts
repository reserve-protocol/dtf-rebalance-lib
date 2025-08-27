import "@nomicfoundation/hardhat-ethers";
import { HardhatRuntimeEnvironment } from "hardhat/types";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { time } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { Contract } from "ethers";

import { whileImpersonating } from "./utils";
import { getStartRebalance } from "../start-rebalance";

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
  initialAssets: bigint[];
  initialSupply: bigint;
  startRebalanceArgs: {
    weights: any[];
    prices: any[];
    limits: any;
  };
}

export async function setupRebalance(
  hre: HardhatRuntimeEnvironment,
  contracts: RebalanceContracts,
  signers: RebalanceSigners,
  tokens: string[],
  targetBasketRec: Record<string, bigint>,
  rebalancePricesRec: Record<string, { snapshotPrice: number }>,
  priceDeviation: number = 0.5,
  debug?: boolean,
  governanceDelayDays?: number,
): Promise<RebalanceInitialState> {
  const { folio } = contracts;
  const { rebalanceManager } = signers;

  const initialSupply = await folio.totalSupply();
  const [, initialAssets] = await folio.totalAssets();

  // Get decimals for all tokens
  const allDecimalsRec: Record<string, bigint> = {};
  for (const token of tokens) {
    const tokenContract = await hre.ethers.getContractAt("IERC20Metadata", token);
    allDecimalsRec[token] = await tokenContract.decimals();
  }

  if (Object.keys(targetBasketRec).length !== tokens.length) {
    throw new Error("Mismatch between tokens length and targetBasketRec keys");
  }

  // {USD}
  const currentBasketValuesRec: Record<string, number> = {};
  tokens.forEach((token: string) => {
    const price = rebalancePricesRec[token.toLowerCase()];
    if (!price) {
      throw new Error(`Token ${token} from tokens not found in rebalancePricesRec: ${token}`);
    }

    // {USD} = {USD/wholeTok} * {tok} / {tok/wholeTok}
    currentBasketValuesRec[token] =
      (price.snapshotPrice * Number(initialAssets[token])) / Number(10n ** allDecimalsRec[token]);
  });

  const [weightControl] = await folio.rebalanceControl();

  // TODO snapshotPrice
  const pricesArray = tokens.map((token: string) => rebalancePricesRec[token.toLowerCase()].snapshotPrice);
  const decimalsArray = tokens.map((token: string) => allDecimalsRec[token]);
  const targetBasketArray = tokens.map((token: string) => targetBasketRec[token]);

  const startRebalanceArgs = getStartRebalance(
    initialSupply,
    tokens,
    initialAssets,
    decimalsArray,
    targetBasketArray,
    pricesArray,
    pricesArray.map((_: number) => priceDeviation),
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
    await (
      await (folio.connect(signer) as any).startRebalance(
        tokens,
        startRebalanceArgs.weights,
        startRebalanceArgs.prices,
        startRebalanceArgs.limits,
        0n,
        1000000n,
      )
    ).wait();
  });

  return {
    initialAssets,
    initialSupply,
    startRebalanceArgs,
  };
}
