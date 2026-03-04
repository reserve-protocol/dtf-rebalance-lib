import "@nomicfoundation/hardhat-ethers";
import { HardhatRuntimeEnvironment } from "hardhat/types";
import { time } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { Contract } from "ethers";

import { bn } from "../src/numbers";
import { FolioVersion } from "../src/types";

import { startRebalance } from "./start-rebalance";
import { doAuctions } from "./do-auctions";
import { getAssetPrices, getTokenNameAndSymbol, normalizePrices } from "./utils";

// Shared context for validation rebalances
interface RebalanceContext {
  bidder: any;
  admin: any;
  rebalanceManager: any;
  auctionLauncher: any;
  initialSupply: bigint;
  tokens: string[];
  rawBalances: bigint[];
  normalizedPrices: Record<string, { snapshotPrice: number }>;
  decimals: bigint[];
  basketValues: number[];
  totalBasketValue: number;
  targetBasketBigIntWeights: bigint[];
  initialAssetsRec: Record<string, bigint>;
}

async function getRebalanceContext(
  hre: HardhatRuntimeEnvironment,
  folio: Contract,
  pricesRec?: Record<string, { currentPrice: number; snapshotPrice: number }>,
  chainId?: number,
): Promise<RebalanceContext> {
  const [bidder] = await hre.ethers.getSigners();

  const admin = await hre.ethers.getSigner(
    await folio.getRoleMember("0x0000000000000000000000000000000000000000000000000000000000000000", 0),
  );
  const rebalanceManager = await hre.ethers.getSigner(
    await folio.getRoleMember("0x4ff6ae4d6a29e79ca45c6441bdc89b93878ac6118485b33c8baa3749fc3cb130", 0), // REBALANCE_MANAGER
  );
  const auctionLauncher = await hre.ethers.getSigner(
    await folio.getRoleMember("0x13ff1b2625181b311f257c723b5e6d366eb318b212d9dd694c48fcf227659df5", 0), // AUCTION_LAUNCHER
  );

  const initialSupply = await folio.totalSupply();
  const [basket, rawBalances] = await folio.totalAssets();
  const tokens = [...basket];

  // Get or fetch prices
  let normalizedPrices: Record<string, { snapshotPrice: number }>;
  if (pricesRec) {
    normalizedPrices = normalizePrices(pricesRec);
  } else if (chainId) {
    const raw = await getAssetPrices(tokens, chainId, await time.latest());
    normalizedPrices = normalizePrices(raw);
  } else {
    throw new Error("Validation rebalance requires either pricesRec or chainId");
  }

  const decimals = await Promise.all(
    tokens.map(async (asset: string) => (await hre.ethers.getContractAt("IERC20Metadata", asset)).decimals()),
  );

  const basketValues = rawBalances.map(
    (bal: bigint, i: number) =>
      (normalizedPrices[tokens[i].toLowerCase()].snapshotPrice * Number(bal)) / Number(10n ** decimals[i]),
  );
  const totalBasketValue = basketValues.reduce((a: number, b: number) => a + b, 0);
  const targetBasketRatios = basketValues.map((value: number) => value / totalBasketValue);
  const targetBasketBigIntWeights = targetBasketRatios.map((weight: number): bigint =>
    bn((weight * 10 ** 18).toString()),
  );

  const initialAssetsRec: Record<string, bigint> = {};
  rawBalances.forEach((bal: bigint, i: number) => {
    initialAssetsRec[tokens[i]] = bal;
  });

  return {
    bidder,
    admin,
    rebalanceManager,
    auctionLauncher,
    initialSupply,
    tokens,
    rawBalances,
    normalizedPrices,
    decimals,
    basketValues,
    totalBasketValue,
    targetBasketBigIntWeights,
    initialAssetsRec,
  };
}

/**
 * Post-check 1: Shift 10% weight from the largest token to the smallest.
 * Validates basic rebalancing without adding or removing tokens.
 * Tokens must already be mocked (via doAuctions or mockBasketTokens).
 */
export async function validateWeightShift(
  hre: HardhatRuntimeEnvironment,
  folio: Contract,
  folioLensTyped: Contract,
  pricesRec?: Record<string, { currentPrice: number; snapshotPrice: number }>,
  chainId?: number,
) {
  console.log(`\n🧪 Validation weight shift...`);

  const ctx = await getRebalanceContext(hre, folio, pricesRec, chainId);

  if (ctx.tokens.length < 2) {
    console.log(`   ⚠️ Basket has fewer than 2 tokens — skipping validation weight shift`);
    return;
  }

  // Find the two largest tokens by value
  let firstIdx = 0;
  let secondIdx = -1;
  for (let i = 1; i < ctx.basketValues.length; i++) {
    if (ctx.basketValues[i] > ctx.basketValues[firstIdx]) {
      secondIdx = firstIdx;
      firstIdx = i;
    } else if (secondIdx === -1 || ctx.basketValues[i] > ctx.basketValues[secondIdx]) {
      secondIdx = i;
    }
  }

  if (secondIdx === -1) {
    console.log(`   ⚠️ Basket has fewer than 2 tokens with value — skipping validation weight shift`);
    return;
  }

  const shiftAmount = bn((0.10 * 10 ** 18).toString()); // 10 percentage points

  // Guard: skip if largest token has less than 10%
  if (ctx.targetBasketBigIntWeights[firstIdx] < shiftAmount) {
    console.log(`   ⚠️ Largest token has less than 10% weight — skipping validation weight shift`);
    return;
  }

  const firstSymbol = await getTokenNameAndSymbol(hre, ctx.tokens[firstIdx]);
  const secondSymbol = await getTokenNameAndSymbol(hre, ctx.tokens[secondIdx]);
  console.log(`   ⚖️ Shifting 10% from ${firstSymbol} to ${secondSymbol}`);

  // Apply shift
  const weights = [...ctx.targetBasketBigIntWeights];
  weights[firstIdx] -= shiftAmount;
  weights[secondIdx] += shiftAmount;

  const targetBasketRec: Record<string, bigint> = {};
  weights.forEach((weight: bigint, i: number) => {
    targetBasketRec[ctx.tokens[i]] = weight;
  });

  await startRebalance(
    FolioVersion.V5,
    hre,
    { folio, folioLensTyped },
    { bidder: ctx.bidder, rebalanceManager: ctx.rebalanceManager, auctionLauncher: ctx.auctionLauncher, admin: ctx.admin },
    ctx.tokens,
    targetBasketRec,
    ctx.normalizedPrices,
    0.5,
    false,
  );

  const { totalError } = await doAuctions(
    FolioVersion.V5,
    hre,
    { folio, folioLensTyped },
    { bidder: ctx.bidder, rebalanceManager: ctx.rebalanceManager, auctionLauncher: ctx.auctionLauncher, admin: ctx.admin },
    ctx.tokens,
    ctx.initialSupply,
    ctx.initialAssetsRec,
    targetBasketRec,
    ctx.normalizedPrices,
    0.9,
    false,
    0.001, // minimal price deviation for validation
    [0, 0], // no slippage for validation
  );

  console.log(`   ✅ Validation weight shift completed (error: ${(totalError * 100).toFixed(4)}%)`);
}

/**
 * Post-check 2: Eject the largest token and add a new mock token.
 * Validates the full add/remove flow.
 * Tokens must already be mocked (via doAuctions or mockBasketTokens).
 */
export async function validateEjectAndAdd(
  hre: HardhatRuntimeEnvironment,
  folio: Contract,
  folioLensTyped: Contract,
  pricesRec?: Record<string, { currentPrice: number; snapshotPrice: number }>,
  chainId?: number,
) {
  console.log(`\n🧪 Validation eject & add...`);

  const ctx = await getRebalanceContext(hre, folio, pricesRec, chainId);

  if (ctx.tokens.length < 2) {
    console.log(`   ⚠️ Basket has fewer than 2 tokens — skipping validation eject & add`);
    return;
  }

  // Find largest token to eject
  let maxIdx = 0;
  for (let i = 1; i < ctx.basketValues.length; i++) {
    if (ctx.basketValues[i] > ctx.basketValues[maxIdx]) maxIdx = i;
  }

  // Deploy a new ERC20Mock token
  const ERC20MockFactory = await hre.ethers.getContractFactory("ERC20Mock");
  const newToken = await ERC20MockFactory.deploy();
  await newToken.waitForDeployment();
  await (await newToken.init("Mock Token", "MOCK", 18n)).wait();
  const newTokenAddress = await newToken.getAddress();

  const ejectedSymbol = await getTokenNameAndSymbol(hre, ctx.tokens[maxIdx]);
  const ejectedWeight = ctx.targetBasketBigIntWeights[maxIdx];
  const ejectedPct = (Number(ejectedWeight) / 10 ** 18 * 100).toFixed(2);
  console.log(`   💨 Ejecting ${ejectedSymbol} (${ejectedPct}%) / 🆕 Adding MOCK`);

  // Build new token list: existing + new mock
  const allTokens = [...ctx.tokens, newTokenAddress];

  // Build target weights
  const weights = [...ctx.targetBasketBigIntWeights];
  const halfEjected = ejectedWeight / 2n;
  const otherHalf = ejectedWeight - halfEjected;

  // Redistribute half proportionally to remaining tokens
  const complement = weights.reduce((a: bigint, b: bigint) => a + b, 0n) - ejectedWeight;
  if (complement > 0n) {
    for (let i = 0; i < weights.length; i++) {
      if (i !== maxIdx) {
        weights[i] += (otherHalf * weights[i]) / complement;
      }
    }
  }
  weights[maxIdx] = 0n;

  // New mock token gets half of ejected weight
  weights.push(halfEjected);

  const targetBasketRec: Record<string, bigint> = {};
  weights.forEach((weight: bigint, i: number) => {
    targetBasketRec[allTokens[i]] = weight;
  });

  // Add price and initial balance for mock token
  const normalizedPrices = { ...ctx.normalizedPrices };
  normalizedPrices[newTokenAddress.toLowerCase()] = { snapshotPrice: 1.0 };

  const initialAssetsRec = { ...ctx.initialAssetsRec };
  initialAssetsRec[newTokenAddress] = 0n;

  await startRebalance(
    FolioVersion.V5,
    hre,
    { folio, folioLensTyped },
    { bidder: ctx.bidder, rebalanceManager: ctx.rebalanceManager, auctionLauncher: ctx.auctionLauncher, admin: ctx.admin },
    allTokens,
    targetBasketRec,
    normalizedPrices,
    0.5,
    false,
  );

  await doAuctions(
    FolioVersion.V5,
    hre,
    { folio, folioLensTyped },
    { bidder: ctx.bidder, rebalanceManager: ctx.rebalanceManager, auctionLauncher: ctx.auctionLauncher, admin: ctx.admin },
    allTokens,
    ctx.initialSupply,
    initialAssetsRec,
    targetBasketRec,
    normalizedPrices,
    0.9,
    false,
    0.001, // minimal price deviation for validation
    [0, 0], // no slippage for validation
  );

  // Verify new mock token has non-zero balance in folio
  const mockBalance = await newToken.balanceOf(await folio.getAddress());
  if (mockBalance === 0n) {
    throw new Error("New mock token has zero balance after rebalance — token was not added");
  }
  console.log(`   ✅ MOCK token balance: ${mockBalance}`);

  console.log(`   ✅ Validation eject & add completed successfully`);
}
