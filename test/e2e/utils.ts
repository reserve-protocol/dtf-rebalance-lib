import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { HardhatRuntimeEnvironment } from "hardhat/types";
import "@nomicfoundation/hardhat-ethers";

import hre from "hardhat";
import Decimal from "decimal.js-light";
import { Address } from "viem";

type TokenPrice = {
  address: Address;
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

  for (const token of tokens) {
    const priceRatio = Math.abs(result[token].currentPrice - result[token].snapshotPrice) / result[token].snapshotPrice;
    if (priceRatio > 10) {
      console.log("timestamp", timestamp);
      console.log("prices", result[token]);
      throw new Error(`price ratio for token ${token} is too extreme: ${priceRatio}`);
    }
  }

  return result;
};

type ImpersonationFunction<T> = (signer: HardhatEthersSigner) => Promise<T>;

export const whileImpersonating = async (
  hre: HardhatRuntimeEnvironment,
  address: string,
  f: ImpersonationFunction<void>,
) => {
  // Set maximum ether balance at address
  await hre.network.provider.request({
    method: "hardhat_setBalance",
    params: [address, "0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"],
  });
  await hre.network.provider.request({
    method: "hardhat_impersonateAccount",
    params: [address],
  });
  const signer = await hre.ethers.getSigner(address);

  await f(signer);

  await hre.network.provider.request({
    method: "hardhat_stopImpersonatingAccount",
    params: [address],
  });
  // If anyone ever needs it, we could make sure here that we set the balance at address back to
  // its original quantity...
};

export const bn = (str: string | Decimal): bigint => {
  return BigInt(new Decimal(str).toFixed(0));
};

/**
 * Recursively converts ethers.js Result objects to plain JavaScript objects/arrays
 */
export function toPlainObject(obj: any): any {
  // Handle null/undefined
  if (obj == null) return obj;

  // Handle primitive types
  if (typeof obj !== "object") return obj;

  // Handle bigint
  if (typeof obj === "bigint") return obj;

  // Handle Result objects (check if it has numeric indices like an array)
  if (obj.constructor?.name === "Result" || (typeof obj.length === "number" && obj.length >= 0)) {
    // Convert to array and recursively process each element
    return Array.from(obj).map((item) => toPlainObject(item));
  }

  // Handle regular arrays
  if (Array.isArray(obj)) {
    return obj.map((item) => toPlainObject(item));
  }

  // Handle plain objects
  const result: any = {};
  for (const [key, value] of Object.entries(obj)) {
    result[key] = toPlainObject(value);
  }

  return result;
}

export async function getTokenNameAndSymbol(addr: string) {
  const token = await hre.ethers.getContractAt("ERC20Mock", addr);

  // MKR exemption
  if ((await token.getAddress()) === "0x9f8F72aA9304c8B593d555F12eF6589cC3A579A2") {
    return { name: "Maker", symbol: "MKR", decimals: 18 };
  }

  const name = await token.name();
  const symbol = await token.symbol();
  const decimals = await token.decimals();
  return { name, symbol, decimals };
}
