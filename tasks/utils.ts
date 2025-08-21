import "@nomicfoundation/hardhat-ethers";
import type { HardhatRuntimeEnvironment } from "hardhat/types";
import type { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

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
