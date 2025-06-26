import DecimalLight from "decimal.js-light";
import type { Decimal as DecimalType } from "decimal.js-light";

import { bn, D18d, D27d, ONE, ZERO } from "./numbers";

// Create a local Decimal constructor with custom precision
const Decimal = DecimalLight.clone({ precision: 100 });

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
 * @param _folio D18{tok/share} Folio of the basket
 * @param decimals Decimals of each token
 * @param _targetBasket D18{1} Ideal basket
 * @param _prices {USD/wholeTok} USD prices for each *whole* token
 * @param _priceError {1} Price error per token to use in the rebalanc; should be larger than price error during openAuction
 * @param _dtfPrice {USD/wholeShare} DTF price
 * @param weightControl TRACKING=false, NATIVE=true
 */
export const getStartRebalance = (
  _supply: bigint,
  tokens: string[],
  _folio: bigint[],
  decimals: bigint[],
  _targetBasket: bigint[],
  _prices: number[],
  _priceError: number[],
  weightControl: boolean,
  debug?: boolean,
): StartRebalanceArgsPartial => {
  if (debug) {
    console.log(
      "getStartRebalance",
      _supply,
      tokens,
      _folio,
      decimals,
      _targetBasket,
      _prices,
      _priceError,
      weightControl,
    );
  }

  // {wholeTok/wholeShare} = D18{tok/share} * {share/wholeShare} / {tok/wholeTok} / D18
  const folio = _folio.map((c: bigint, i: number) => new Decimal(c.toString()).div(new Decimal(`1e${decimals[i]}`)));

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
  const newLimits: RebalanceLimits = {
    low: bn("1e18"),
    spot: bn("1e18"),
    high: bn("1e18"),
  };

  // ================================================================

  for (let i = 0; i < tokens.length; i++) {
    if (priceError[i].gte(ONE)) {
      throw new Error("cannot defer prices");
    }

    // === newWeights ===

    // {USD/wholeShare} = {wholeTok/wholeShare} * {USD/wholeTok}
    const dtfPrice = folio
      .map((f: DecimalType, i: number) => f.mul(prices[i]))
      .reduce((a: DecimalType, b: DecimalType) => a.add(b));

    // {wholeTok/wholeShare} = {1} * {USD/wholeShare} / {USD/wholeTok}
    const spotWeight = targetBasket[i].mul(dtfPrice).div(prices[i]);

    // D27{tok/share}{wholeShare/wholeTok} = D27 * {tok/wholeTok} / {share/wholeShare}
    const limitMultiplier = D27d.mul(new Decimal(`1e${decimals[i]}`)).div(D18d);

    if (debug) {
      console.log("limitMultiplier", limitMultiplier.toString());
    }

    if (!weightControl) {
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
    }

    // === newPrices ===

    // D27{wholeTok/tok} = D27 / {tok/wholeTok}
    const priceMultiplier = D27d.div(new Decimal(`1e${decimals[i]}`));

    // {USD/wholeTok} = {USD/wholeTok} * {1}
    const lowPrice = prices[i].mul(ONE.sub(priceError[i]));
    const highPrice = prices[i].mul(ONE.add(priceError[i]));

    // D27{USD/tok} = {USD/wholeTok} * D27{wholeTok/tok}
    newPrices.push({
      low: bn(lowPrice.mul(priceMultiplier)),
      high: bn(highPrice.mul(priceMultiplier)),
    });
  }

  // update low/high for tracking DTFs
  if (!weightControl) {
    // sum of dot product of targetBasket and priceError
    const totalPortion = targetBasket
      .map((portion: DecimalType, i: number) => portion.mul(priceError[i]))
      .reduce((a: DecimalType, b: DecimalType) => a.add(b));

    if (totalPortion.gte(ONE)) {
      throw new Error("totalPortion > 1");
    }

    // D18{BU/share} = {1} * D18 * {BU/share}
    newLimits.low = bn(ONE.sub(totalPortion).mul(D18d));
    newLimits.high = bn(ONE.div(ONE.sub(totalPortion)).mul(D18d));
  }

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
