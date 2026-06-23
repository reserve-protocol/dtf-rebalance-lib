import "@nomicfoundation/hardhat-ethers";
import { Contract } from "ethers";
import type { HardhatRuntimeEnvironment } from "hardhat/types";
import type { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { expect } from "chai";

import { bn } from "../../../src/numbers";
export { getAssetPrices } from "../src/prices";

export function toPlainObject(obj: any): any {
  if (typeof obj !== "object" || obj === null) {
    return obj;
  }

  if (Array.isArray(obj)) {
    return obj.map((item) => toPlainObject(item));
  }

  const plainObject: any = {};
  for (const key in obj) {
    if (obj.hasOwnProperty(key) && typeof obj[key] !== "function") {
      const value = obj[key];
      if (typeof value === "bigint") {
        plainObject[key] = value.toString();
      } else if (typeof value === "object") {
        plainObject[key] = toPlainObject(value);
      } else {
        plainObject[key] = value;
      }
    }
  }
  return plainObject;
}

export async function whileImpersonating(
  hre: HardhatRuntimeEnvironment,
  address: string,
  fn: (signer: HardhatEthersSigner) => Promise<void>,
) {
  const FORK_FUNDING = hre.ethers.parseEther("5000");
  const impersonate = async (addr: string) => {
    await hre.network.provider.request({
      method: "hardhat_impersonateAccount",
      params: [addr],
    });
  };
  const stopImpersonating = async (addr: string) => {
    await hre.network.provider.request({
      method: "hardhat_stopImpersonatingAccount",
      params: [addr],
    });
  };

  await impersonate(address);
  const signer = await hre.ethers.getSigner(address);

  if ((await hre.ethers.provider.getBalance(address)) < FORK_FUNDING) {
    await hre.network.provider.send("hardhat_setBalance", [address, hre.ethers.toQuantity(FORK_FUNDING)]);
  }

  try {
    await fn(signer);
  } finally {
    await stopImpersonating(address);
  }
}

export async function ensureProposalPasses(
  hre: HardhatRuntimeEnvironment,
  governor: Contract,
  proposalId: string | bigint,
): Promise<void> {
  // Check proposal state — skip if already Succeeded/Queued/Executed
  const state = Number(await governor.state(proposalId));
  if (state === 4 || state === 5 || state === 7) return;

  // Get governance token
  const tokenAddress = await governor.token();
  const tokenAbi = [
    "function getVotes(address) view returns (uint256)",
    "event DelegateVotesChanged(address indexed delegate, uint256 previousVotes, uint256 newVotes)",
  ];
  const token = new hre.ethers.Contract(tokenAddress, tokenAbi, hre.ethers.provider);

  // Get quorum requirement
  const snapshot = await governor.proposalSnapshot(proposalId);
  const quorum = await governor.quorum(snapshot);

  // Check existing votes
  const [, forVotes] = await governor.proposalVotes(proposalId);
  if (forVotes >= quorum) return;

  let accumulated = forVotes;

  // Helper to cast a vote for a delegate
  const tryCastVote = async (delegate: string): Promise<bigint> => {
    const hasVoted = await governor.hasVoted(proposalId, delegate);
    if (hasVoted) return 0n;

    const votingPower = await governor.getVotes(delegate, snapshot);
    if (votingPower === 0n) return 0n;

    await whileImpersonating(hre, delegate, async (signer) => {
      await (await (governor.connect(signer) as any).castVote(proposalId, 1)).wait();
    });
    return votingPower;
  };

  // Strategy 1: Try the proposer first — they must have had enough tokens to propose
  try {
    const proposer = await governor.proposalProposer(proposalId);
    accumulated += await tryCastVote(proposer);
    if (accumulated >= quorum) return;
  } catch {
    // proposalProposer may not exist on older governors
  }

  // Strategy 2: Find delegates via DelegateVotesChanged events
  const filter = token.filters.DelegateVotesChanged();
  const currentBlock = await hre.ethers.provider.getBlockNumber();
  let events: any[] = [];
  for (let i = 0; i < 100; i++) {
    const toBlock = currentBlock - 9999 * i;
    const fromBlock = Math.max(0, currentBlock - 9999 * (i + 1));

    try {
      const batch = await token.queryFilter(filter, fromBlock, toBlock);
      events.push(...batch);
    } catch {
      // BSC fallback: smaller batches of 999 blocks
      for (let j = 0; j < 10; j++) {
        const bscFrom = fromBlock + 999 * j;
        const bscTo = Math.min(fromBlock + 999 * (j + 1), toBlock);
        if (bscFrom > toBlock) break;

        const batch = await token.queryFilter(filter, bscFrom, bscTo);
        events.push(...batch);
      }
    }
  }

  // Build map: delegate → latest newVotes
  const delegateVotes = new Map<string, bigint>();
  for (const e of events) {
    if ("args" in e && e.args) {
      const delegate = e.args.delegate as string;
      const newVotes = BigInt(e.args.newVotes.toString());
      delegateVotes.set(delegate, newVotes);
    }
  }

  // Sort descending by votes, filter > 0
  const sortedDelegates = [...delegateVotes.entries()]
    .filter(([, votes]) => votes > 0n)
    .sort(([, a], [, b]) => (b > a ? 1 : b < a ? -1 : 0));

  // Cast votes from top delegates
  for (const [delegate] of sortedDelegates) {
    if (accumulated >= quorum) break;
    accumulated += await tryCastVote(delegate);
  }

  if (accumulated < quorum) {
    throw new Error(`Could not accumulate enough votes to pass proposal. Got ${accumulated}, need ${quorum}`);
  }
}

export async function getTokenNameAndSymbol(hre: HardhatRuntimeEnvironment, token: string) {
  try {
    const tokenContract = await hre.ethers.getContractAt("IERC20Metadata", token);
    const [name, symbol] = await Promise.all([tokenContract.name(), tokenContract.symbol()]);
    return `${name} (${symbol})`;
  } catch (e) {
    return token;
  }
}

/**
 * Replace real ERC20 tokens with ERC20Mock at the same addresses.
 * Idempotent — if bytecodes already match, the token is skipped.
 * Preserves name, symbol, decimals, and folio balances.
 */
export async function mockBasketTokens(
  hre: HardhatRuntimeEnvironment,
  folioAddress: string,
  tokens: string[],
): Promise<Record<string, Contract>> {
  const ERC20MockFactory = await hre.ethers.getContractFactory("ERC20Mock");
  const mockedTokensRec: Record<string, Contract> = {};

  for (const asset of tokens) {
    const tokenContract = (await hre.ethers.getContractAt("ERC20Mock", asset)) as unknown as Contract;
    const balBefore = await tokenContract.balanceOf(folioAddress);

    const currentCode = await hre.ethers.provider.getCode(asset);
    const newMockDeployment = await ERC20MockFactory.deploy();
    await newMockDeployment.waitForDeployment();
    const newImplementationBytecode = await hre.ethers.provider.getCode(await newMockDeployment.getAddress());

    if (newImplementationBytecode !== currentCode) {
      const tokenContract2 = await hre.ethers.getContractAt("IERC20Metadata", asset);
      const [name, symbol, tokenDecimalsValue] = await Promise.all([
        tokenContract2.name(),
        tokenContract2.symbol(),
        tokenContract2.decimals(),
      ]);
      await hre.network.provider.send("hardhat_setCode", [asset, newImplementationBytecode]);
      await (await tokenContract.init(name, symbol, tokenDecimalsValue)).wait();
      await (await tokenContract.mint(folioAddress, balBefore)).wait();
    }

    expect(await tokenContract.balanceOf(folioAddress)).to.equal(balBefore);
    mockedTokensRec[asset] = tokenContract;
  }

  return mockedTokensRec;
}

export async function calculateRebalanceMetrics(
  hre: HardhatRuntimeEnvironment,
  folio: Contract,
  orderedTokens: string[],
  targetBasketRec: Record<string, bigint>,
  pricesRec: Record<string, { snapshotPrice: number }>,
) {
  // Get final balances
  const [finalTokens, balancesAfterFinal] = await folio.totalAssets();
  const balancesAfterFinalRec: Record<string, bigint> = {};
  const decimalsRec: Record<string, bigint> = {};

  // Get decimals for all tokens
  for (const token of orderedTokens) {
    const tokenContract = await hre.ethers.getContractAt("IERC20Metadata", token);
    decimalsRec[token] = await tokenContract.decimals();
  }

  // Map balances to record
  for (let i = 0; i < finalTokens.length; i++) {
    balancesAfterFinalRec[finalTokens[i]] = balancesAfterFinal[i];
  }
  for (const token of orderedTokens) {
    if (!(token in balancesAfterFinalRec)) {
      balancesAfterFinalRec[token] = 0n;
    }
  }

  // Calculate total value and individual token values
  let totalValueAfterFinal = 0;
  const finalTokenValuesRec: Record<string, number> = {};

  const { getPrice } = createPriceLookup(pricesRec);

  orderedTokens.forEach((token: string) => {
    const price = getPrice(token);
    const bal = balancesAfterFinalRec[token];
    const decimal = decimalsRec[token];

    finalTokenValuesRec[token] = (price * Number(bal)) / Number(10n ** decimal);
    totalValueAfterFinal += finalTokenValuesRec[token];
  });

  // Calculate final basket percentages
  const finalTargetBasketRec: Record<string, bigint> = {};
  orderedTokens.forEach((token: string) => {
    finalTargetBasketRec[token] = bn(((finalTokenValuesRec[token] / totalValueAfterFinal) * 10 ** 18).toString());
  });

  // Calculate what fraction of value is correctly allocated
  // For each token, the "correct" amount is the minimum of what we have vs what we want
  let correctlyAllocatedValue = 0;

  orderedTokens.forEach((token: string) => {
    const targetFraction = Number(targetBasketRec[token]) / 1e18;
    const actualFraction = Number(finalTargetBasketRec[token]) / 1e18;

    // The correctly allocated fraction for this token is the minimum of target and actual
    const correctFraction = Math.min(targetFraction, actualFraction);

    // Add this token's correctly allocated value to the total
    correctlyAllocatedValue += correctFraction * totalValueAfterFinal;
  });

  // The fraction of total value that is correctly allocated (0 to 1)
  const fractionCorrect = totalValueAfterFinal > 0 ? correctlyAllocatedValue / totalValueAfterFinal : 0;

  // Convert to error percentage (0% = perfect, 100% = completely wrong)
  const totalError = (1 - fractionCorrect) * 100;

  return {
    finalTargetBasketRec,
    totalError,
    totalValueAfterFinal,
  };
}

/**
 * Create a case-insensitive price lookup from a price record
 * @param pricesRec Price record with token addresses as keys
 * @returns Object with lowercase mapping and lookup function
 */
export function createPriceLookup(pricesRec: Record<string, { snapshotPrice: number }>) {
  const priceKeys = Object.keys(pricesRec);
  const lowercaseToPriceKey: Record<string, string> = {};
  for (const key of priceKeys) {
    lowercaseToPriceKey[key.toLowerCase()] = key;
  }

  const getPrice = (token: string): number => {
    const priceKey = lowercaseToPriceKey[token.toLowerCase()];
    return priceKey && pricesRec[priceKey] ? pricesRec[priceKey].snapshotPrice : 0;
  };

  const hasPrice = (token: string): boolean => {
    const priceKey = lowercaseToPriceKey[token.toLowerCase()];
    return !!(priceKey && pricesRec[priceKey]);
  };

  return { lowercaseToPriceKey, getPrice, hasPrice };
}

export function logPercentages(label: string, targetBasketWeights: Record<string, bigint>, orderedTokens: string[]) {
  const percentageStrings = orderedTokens.map((token) => {
    const weight = targetBasketWeights[token] || 0n;
    const percentage = (Number(weight) / Number(10n ** 18n)) * 100;
    return percentage === 0 ? "00.00%" : `${percentage.toFixed(2)}%`;
  });
  console.log(`${label} [${percentageStrings.join(", ")}]`);
}

/**
 * Convert proposal prices from D27{nanoUSD/tok} to USD/wholeTok format
 */
export function convertProposalPricesToUSD(
  proposalPrices: { low: bigint; high: bigint }[],
  decimals: bigint[],
  tokenSymbols?: string[],
): number[] {
  return proposalPrices.map((priceRange, i) => {
    // Convert both prices to USD/wholeTok first
    const tokPerWholeTok = 10n ** decimals[i];
    const nanoUSDPerUSD = 10n ** 9n;
    const D27 = 10n ** 27n;

    // Convert low and high prices
    // First multiply to preserve precision, then divide by combined divisor
    const divisor = (D27 * nanoUSDPerUSD) / tokPerWholeTok;
    const lowPriceUSD = Number(priceRange.low) / Number(divisor);
    const highPriceUSD = Number(priceRange.high) / Number(divisor);

    // Check for zero prices which indicate invalid proposal data
    if (lowPriceUSD === 0 || highPriceUSD === 0) {
      const tokenIdentifier = tokenSymbols?.[i] ? `${tokenSymbols[i]} (index ${i})` : `index ${i}`;
      throw new Error(
        `Invalid proposal data: Token at ${tokenIdentifier} has zero price. ` +
          `Low: ${priceRange.low.toString()}, High: ${priceRange.high.toString()}`,
      );
    }

    // Use geometric mean: sqrt(low * high)
    const geometricMean = Math.sqrt(lowPriceUSD * highPriceUSD);

    return geometricMean;
  });
}

/**
 * Simulate market price movements using geometric Brownian motion
 * @param historicalPrices Original prices from the proposal
 * @param volatility Annual volatility (e.g., 0.3 for 30%)
 * @param daysElapsed Number of days elapsed (e.g., 5 for governance delay)
 * @param drift Annual drift rate (default 0)
 * @returns Simulated prices with market movements
 */
export function simulateMarketPrices(
  historicalPrices: number[],
  volatility: number = 0.2, // 20% annual volatility default
  daysElapsed: number = 5,
  drift: number = 0,
): Record<string, { snapshotPrice: number }> {
  const result: Record<string, { snapshotPrice: number }> = {};

  // Convert annual parameters to daily
  const dailyVolatility = volatility / Math.sqrt(365);
  const dailyDrift = drift / 365;

  historicalPrices.forEach((price, i) => {
    // Generate random walk for each day
    let simulatedPrice = price;
    for (let day = 0; day < daysElapsed; day++) {
      // Generate random normal distribution (Box-Muller transform)
      const u1 = Math.random();
      const u2 = Math.random();
      const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);

      // Apply geometric Brownian motion
      const dailyReturn = dailyDrift + dailyVolatility * z;
      simulatedPrice = simulatedPrice * (1 + dailyReturn);
    }

    // Ensure price doesn't go negative or too extreme
    simulatedPrice = Math.max(simulatedPrice, price * 0.5); // Min 50% of original
    simulatedPrice = Math.min(simulatedPrice, price * 2.0); // Max 200% of original

    result[i.toString()] = { snapshotPrice: simulatedPrice };
  });

  return result;
}

// ============ Price Utilities ============

/**
 * Normalize price records to lowercase keys for case-insensitive lookups
 */
export function normalizePrices<T>(pricesRaw: Record<string, T>): Record<string, T> {
  const normalized: Record<string, T> = {};
  for (const [token, price] of Object.entries(pricesRaw)) {
    normalized[token.toLowerCase()] = price;
  }
  return normalized;
}
