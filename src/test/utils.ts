import "@nomicfoundation/hardhat-ethers";
import type { HardhatRuntimeEnvironment } from "hardhat/types";
import type { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { Contract } from "ethers";
import { bn } from "../numbers";

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

type TokenPrice = {
  address: string;
  price?: number;
};

type HistoricalPriceResponse = {
  address: string;
  timeseries: {
    price: number;
    timestamp: number;
  }[];
};

type TokenPriceWithSnapshot = Record<string, { currentPrice: number; snapshotPrice: number }>;

export const getAssetPrices = async (
  tokens: string[],
  chainId: number,
  timestamp: number,
): Promise<TokenPriceWithSnapshot> => {
  await new Promise((resolve) => setTimeout(resolve, 100)); // base rate limiting

  if (!tokens?.length) return {};

  const RESERVE_API = "https://api.reserve.org/"; // Assuming this is the base API URL

  const currentPricesUrl = `${RESERVE_API}current/prices?chainId=${chainId}&tokens=${tokens.join(",")}`;
  const currentPricesResponse = await fetch(currentPricesUrl);
  const currentPricesData = (await currentPricesResponse.json()) as TokenPrice[];

  const result: TokenPriceWithSnapshot = currentPricesData.reduce((acc, tokenData) => {
    const price = tokenData.price ?? 0;
    // Use original address casing from API response
    acc[tokenData.address] = {
      currentPrice: price,
      snapshotPrice: 0,
    };
    return acc;
  }, {} as TokenPriceWithSnapshot);

  // Ensure tokens array is not empty for historical fetch
  const from = Number(timestamp) - 3600;
  const to = Number(timestamp) + 3600;
  const baseUrl = `${RESERVE_API}historical/prices?chainId=${chainId}&from=${from}&to=${to}&interval=1h&address=`;

  // Create a map of original token casing to handle potential discrepancies from historical API if any
  // However, historical API also returns "address" field which should be used.
  // The tokens in the `tokens` array are used to make the calls.
  const calls = tokens.map(
    (tokenAddress) => fetch(`${baseUrl}${tokenAddress}`).then((res) => res.json()), // Use original tokenAddress for API call
  );

  const historicalResponses = await (<Promise<HistoricalPriceResponse[]>>Promise.all(calls));

  let foundAll = true;
  for (const historicalData of historicalResponses) {
    // Use address from historical data response directly as key
    const addressFromApi = historicalData.address;
    const price =
      historicalData.timeseries.length === 0
        ? 0
        : historicalData.timeseries[Math.floor(historicalData.timeseries.length / 2)].price;

    if (result[addressFromApi]) {
      result[addressFromApi].snapshotPrice = price;
    } else {
      // This case can happen if a token was in historical but not current, or casing mismatch
      // If current price wasn't fetched, we initialize it here.
      result[addressFromApi] = {
        currentPrice: 0, // Or some other default/error state
        snapshotPrice: price,
      };
    }

    if (!result[addressFromApi]?.snapshotPrice) {
      foundAll = false;
    }
  }

  // failure case
  if (!foundAll) {
    await new Promise((resolve) => setTimeout(resolve, 2000)); // sleep 2s to let the api cooldown

    // add dummy var to end to force cache clear
    const calls = tokens.map((tokenAddress) =>
      fetch(`${baseUrl}${tokenAddress}&t=${Date.now()}`).then((res) => res.json()),
    );

    const historicalResponses = await (<Promise<HistoricalPriceResponse[]>>Promise.all(calls));

    foundAll = true;
    for (const historicalData of historicalResponses) {
      // Use address from historical data response directly as key
      const addressFromApi = historicalData.address;
      const price =
        historicalData.timeseries.length === 0
          ? 0
          : historicalData.timeseries[Math.floor(historicalData.timeseries.length / 2)].price;

      if (result[addressFromApi]) {
        result[addressFromApi].snapshotPrice = price;
      } else {
        // This case can happen if a token was in historical but not current, or casing mismatch
        // If current price wasn't fetched, we initialize it here.
        result[addressFromApi] = {
          currentPrice: 0, // Or some other default/error state
          snapshotPrice: price,
        };
      }

      if (!result[addressFromApi]?.snapshotPrice) {
        foundAll = false;
      }
    }
  }

  if (!foundAll) {
    console.log("timestamp", timestamp);
    console.log("prices", result);
    throw new Error("Failed to fetch all prices");
  }

  // Create a mapping from lowercase addresses to result keys for case-insensitive lookup
  const resultKeys = Object.keys(result);
  const lowercaseToKey: Record<string, string> = {};
  for (const key of resultKeys) {
    lowercaseToKey[key.toLowerCase()] = key;
  }

  for (const token of tokens) {
    const resultKey = lowercaseToKey[token.toLowerCase()];
    if (!resultKey || !result[resultKey]) {
      console.log(`Warning: No price data found for token ${token}`);
      continue;
    }
    const priceData = result[resultKey];
    if (priceData.snapshotPrice === 0) {
      console.log(`Warning: Snapshot price is 0 for token ${token}, skipping ratio check`);
      continue;
    }
    const priceRatio = Math.abs(priceData.currentPrice - priceData.snapshotPrice) / priceData.snapshotPrice;
    if (priceRatio > 10) {
      console.log("timestamp", timestamp);
      console.log("prices", priceData);
      throw new Error(`price ratio for token ${token} is too extreme: ${priceRatio}`);
    }
  }

  return result;
};

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

export async function getTokenNameAndSymbol(hre: HardhatRuntimeEnvironment, token: string) {
  try {
    const tokenContract = await hre.ethers.getContractAt("IERC20Metadata", token);
    const [name, symbol] = await Promise.all([tokenContract.name(), tokenContract.symbol()]);
    return `${name} (${symbol})`;
  } catch (e) {
    return token;
  }
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

  // Get final prices if needed (for NATIVE mode)
  // Note: In simulations, we're in the future so we can't fetch historical prices
  // Just use the prices we already have
  const finalPricesRec = pricesRec;

  // Calculate total value and individual token values
  let totalValueAfterFinal = 0;
  const finalTokenValuesRec: Record<string, number> = {};

  // Create case-insensitive lookup for prices
  const priceKeys = Object.keys(finalPricesRec);
  const lowercaseToPriceKey: Record<string, string> = {};
  for (const key of priceKeys) {
    lowercaseToPriceKey[key.toLowerCase()] = key;
  }

  orderedTokens.forEach((token: string) => {
    const priceKey = lowercaseToPriceKey[token.toLowerCase()];
    const price = priceKey && finalPricesRec[priceKey] ? finalPricesRec[priceKey].snapshotPrice : 0;
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
