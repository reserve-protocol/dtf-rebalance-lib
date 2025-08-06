import { Decimal } from "./utils";
import type { Decimal as DecimalType } from "decimal.js-light";

import { bn, D9d, D18d, D27d, D27n, ONE, ZERO } from "./numbers";

import { PriceRange, RebalanceLimits, WeightRange } from "./types";

// Partial set of the args needed to call `startRebalance()`
export interface StartRebalanceArgsPartial {
  // tokens: string[]
  weights: WeightRange[];
  prices: PriceRange[];
  limits: RebalanceLimits;
  // auctionLauncherWindow: bigint
  // ttl: bigint
}

/**
 * Get the arguments needed to call startRebalance
 *
 * The `tokens` argument should be paired with the two return values and passed to `startRebalance()`
 *
 * @param _supply {share}
 * @param tokens Addresses of tokens in the basket
 * @param _assets {tok} Folio asset assets
 * @param decimals Decimals of each token
 * @param _targetBasket D18{1} Ideal basket
 * @param _prices {USD/wholeTok} USD prices for each *whole* token
 * @param _priceError {1} Price error per token to use in the rebalance; should be larger than price error during openAuction
 * @param _dtfPrice {USD/wholeShare} DTF price
 * @param weightControl TRACKING=false, NATIVE=true
 * @param deferWeights Whether to use the full range for weights, only possible for NATIVE DTFs
 */
export const getStartRebalance = (
  _supply: bigint,
  tokens: string[],
  _assets: bigint[],
  decimals: bigint[],
  _targetBasket: bigint[],
  _prices: number[],
  _priceError: number[],
  weightControl: boolean,
  deferWeights: boolean,
  debug?: boolean,
): StartRebalanceArgsPartial => {
  if (debug) {
    console.log(
      "getStartRebalance",
      _supply,
      tokens,
      _assets,
      decimals,
      _targetBasket,
      _prices,
      _priceError,
      weightControl,
      deferWeights,
    );
  }

  if (deferWeights && !weightControl) {
    throw new Error("deferWeights is not supported for tracking DTFs");
  }

  // {wholeShare} = {share} / {share/wholeShare}
  const supply = new Decimal(_supply.toString()).div(D18d);

  // {wholeTok} = {tok} * {share/wholeShare} / {tok/wholeTok} / D18
  const assets = _assets.map((c: bigint, i: number) => new Decimal(c.toString()).div(new Decimal(`1e${decimals[i]}`)));

  // convert price number inputs to bigints

  // {USD/wholeTok}
  const prices = _prices.map((a) => new Decimal(a.toString()));
  for (let i = 0; i < prices.length; i++) {
    if (prices[i].eq(ZERO)) {
      throw new Error(`missing price for token ${tokens[i]}`);
    }
  }

  // {1} = D18{1} / D18
  const targetBasket = _targetBasket.map((a) => new Decimal(a.toString()).div(D18d));

  // {1}
  const priceError = _priceError.map((a) => new Decimal(a.toString()));

  // ================================================================

  const newWeights: WeightRange[] = [];
  const newPrices: PriceRange[] = [];

  for (let i = 0; i < tokens.length; i++) {
    if (priceError[i].gte(ONE)) {
      throw new Error("price error >= 1");
    }

    // === newWeights ===

    // {USD} = {wholeTok} * {USD/wholeTok}
    const dtfValue = assets
      .map((f: DecimalType, i: number) => f.mul(prices[i]))
      .reduce((a: DecimalType, b: DecimalType) => a.add(b));

    // {wholeTok/wholeShare} = {1} * {USD} / {USD/wholeTok} / {wholeShare}
    const spotWeight = targetBasket[i].mul(dtfValue).div(prices[i]).div(supply);

    // D27{tok/share}{wholeShare/wholeTok} = D27 * {tok/wholeTok} / {share/wholeShare}
    const limitMultiplier = D27d.mul(new Decimal(`1e${decimals[i]}`)).div(D18d);

    if (debug) {
      console.log("limitMultiplier", limitMultiplier.toString());
    }

    if (!weightControl) {
      // TRACKING case

      // D27{tok/BU} = {wholeTok/wholeShare} * D27{tok/share}{wholeShare/wholeTok} / {BU/share}
      newWeights.push({
        low: bn(spotWeight.mul(limitMultiplier)),
        spot: bn(spotWeight.mul(limitMultiplier)),
        high: bn(spotWeight.mul(limitMultiplier)),
      });
    } else {
      // NATIVE case

      // {wholeTok/wholeShare} = {wholeTok/wholeShare} / {1}
      const lowWeight = spotWeight.mul(ONE.sub(priceError[i]));
      const highWeight = spotWeight.div(ONE.sub(priceError[i]));

      // D27{tok/share} = {wholeTok/wholeShare} * D27{tok/share}{wholeShare/wholeTok} / {BU/share}
      newWeights.push({
        low: bn(lowWeight.mul(limitMultiplier)),
        spot: bn(spotWeight.mul(limitMultiplier)),
        high: bn(highWeight.mul(limitMultiplier)),
      });

      // deferWeights case
      if (deferWeights && newWeights[i].low > 0n) {
        newWeights[i].low = 1n;
        newWeights[i].high = D27n * D27n; // 1e54 MAX_WEIGHT
      }
    }

    // === newPrices ===

    // D27{wholeTok/tok} = D27 / {tok/wholeTok}
    const priceMultiplier = D27d.div(new Decimal(`1e${decimals[i]}`));

    newPrices.push({
      // D27{nanoUSD/tok} = {USD/wholeTok} * {1} * D27{wholeTok/tok} * {nanoUSD/USD}
      low: bn(prices[i].mul(ONE.sub(priceError[i])).mul(priceMultiplier).mul(D9d)),
      // D27{nanoUSD/tok} = {USD/wholeTok} / {1} * D27{wholeTok/tok} * {nanoUSD/USD}
      high: bn(prices[i].div(ONE.sub(priceError[i])).mul(priceMultiplier).mul(D9d)),
    });
  }

  // ================================================================

  // newLimits

  // sum of dot product of targetBasket and priceError
  const basketError = targetBasket
    .map((portion: DecimalType, i: number) => portion.mul(priceError[i]))
    .reduce((a: DecimalType, b: DecimalType) => a.add(b));

  if (basketError.gte(ONE)) {
    throw new Error("basketError >= 1");
  }

  const newLimits: RebalanceLimits = {
    low: weightControl ? bn("1e18") : bn(ONE.sub(basketError).mul(D18d)),
    spot: bn("1e18"),
    high: weightControl ? bn("1e18") : bn(ONE.div(ONE.sub(basketError)).mul(D18d)),
  };

  // ================================================================

  if (debug) {
    console.log("newWeights", newWeights);
    console.log("newPrices", newPrices);
    console.log("newLimits", newLimits);
  }

  return {
    weights: newWeights,
    prices: newPrices,
    limits: newLimits,
  };
};
