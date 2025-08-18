import DecimalLight from "decimal.js-light";

import { WeightRange, RebalanceLimits } from "./types";
import { bn, D18d, D18n, D27n, ZERO } from "./numbers";

// Create a local Decimal constructor with custom precision
export const Decimal = DecimalLight.clone({ precision: 100 });

/**
 * This function can be used to get a basket distribution EITHER from a set of historical basket weights
 * or from a set of current balances. Make sure to use prices from the right time.
 *
 * @param _bals {tok} Current balances; or previous historical weights
 * @param _prices {USD/wholeTok} USD prices for each *whole* token; or previous historical prices
 * @param decimals Decimals of each token
 * @returns D18{1} Current basket, total will be around 1e18 but not exactly
 */
export const getBasketDistribution = (_bals: bigint[], _prices: number[], decimals: bigint[]): bigint[] => {
  const decimalScale = decimals.map((d) => new Decimal(`1e${d}`));

  // {wholeTok} = {tok} / {tok/wholeTok}
  const bals = _bals.map((bal, i) => new Decimal(bal.toString()).div(decimalScale[i]));

  // {USD/wholeTok} = {USD/wholeTok}
  const prices = _prices.map((a) => new Decimal(a.toString()));

  // {USD} = {wholeTok} * {USD/wholeTok}
  const totalValue = bals.map((bal, i) => bal.mul(prices[i])).reduce((a, b) => a.add(b));

  // D18{1} = {wholeTok} * {USD/wholeTok} / {USD}
  return bals.map((bal, i) => bn(bal.mul(prices[i]).div(totalValue).mul(D18d)));
};

/**
 * Calculate how accurately balances reflect weights
 *
 * @param supply {share} Current total supply
 * @param _bals {tok} Current balances
 * @param _prices {USD/wholeTok} Current USD prices for each *whole* token
 * @param decimals Decimals of each token
 * @param weights Current weights from getRebalance.weights
 * @param limits Current limits from getRebalance.limits
 * @returns {1} Basket accuracy
 */
export const getBasketAccuracy = (
  supply: bigint,
  _bals: bigint[],
  _prices: number[],
  decimals: bigint[],
  weights: WeightRange[],
  limits: RebalanceLimits,
): number => {
  const decimalScale = decimals.map((d) => new Decimal(`1e${d}`));

  // {USD/wholeTok} = {USD/wholeTok}
  const prices = _prices.map((a) => new Decimal(a.toString()));

  // {USD}
  let totalValue = ZERO;
  let surplusValue = ZERO;

  for (let i = 0; i < weights.length; i++) {
    // {tok} = D27{tok/BU} * D18{BU/share} * {share} / D27 / D18
    const expectedBal = (weights[i].spot * limits.spot * supply) / D27n / D18n;

    if (_bals[i] > expectedBal) {
      // {USD} = {tok} * {USD/wholeTok} / {tok/wholeTok}
      surplusValue = surplusValue.add(
        new Decimal((_bals[i] - expectedBal).toString()).mul(prices[i]).div(decimalScale[i]),
      );
    }

    // {USD} = {tok} * {USD/wholeTok} / {tok/wholeTok}
    totalValue = totalValue.add(new Decimal(_bals[i].toString()).mul(prices[i]).div(decimalScale[i]));
  }

  return totalValue.sub(surplusValue).div(totalValue).toNumber();
};
