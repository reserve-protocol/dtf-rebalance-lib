import { loadSdk } from "./sdk";

export type TokenPriceWithSnapshot = Record<string, { currentPrice: number; snapshotPrice: number }>;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export const getAssetPrices = async (
  tokens: string[],
  chainId: number,
  timestamp: number,
): Promise<TokenPriceWithSnapshot> => {
  await sleep(100); // base rate limiting

  if (!tokens?.length) return {};

  let result = await fetchAssetPrices(tokens, chainId, timestamp);
  let foundAll = hasAllSnapshotPrices(tokens, result);

  if (!foundAll) {
    await sleep(2000);
    result = await fetchAssetPrices(tokens, chainId, timestamp);
    foundAll = hasAllSnapshotPrices(tokens, result);
  }

  if (!foundAll) {
    console.log("timestamp", timestamp);
    console.log("prices", result);
    throw new Error("Failed to fetch all prices");
  }

  validatePriceRatios(tokens, timestamp, result);

  return result;
};

async function fetchAssetPrices(tokens: string[], chainId: number, timestamp: number): Promise<TokenPriceWithSnapshot> {
  const { createDtfClient } = await loadSdk();
  const client = createDtfClient();

  return client.api.getBasketTokenPricesWithSnapshot({
    chainId: chainId as never,
    assets: tokens as never,
    timestamp,
  }) as Promise<TokenPriceWithSnapshot>;
}

function hasAllSnapshotPrices(tokens: string[], result: TokenPriceWithSnapshot): boolean {
  return tokens.every((token) => !!result[token.toLowerCase()]?.snapshotPrice);
}

function validatePriceRatios(tokens: string[], timestamp: number, result: TokenPriceWithSnapshot) {
  for (const token of tokens) {
    const priceData = result[token.toLowerCase()];
    if (!priceData) {
      console.log(`Warning: No price data found for token ${token}`);
      continue;
    }
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
}
