import DecimalLight from "decimal.js-light";
import { bn, D18d, D27d } from "./numbers";
import { WeightRange } from "./types";

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
 * @param _bals {tok} Current balances
 * @param _prices {USD/wholeTok} Current USD prices for each *whole* token
 * @param _decimals Decimals of each token
 * @param _weights D27{tok/BU} Current weights from getRebalance.weights
 * @returns {1} Basket accuracy
 */
export const getBasketAccuracy = (
  _bals: bigint[],
  _prices: number[],
  _decimals: bigint[],
  _weights: WeightRange[],
): number => {
  const decimalScale = _decimals.map((d) => new Decimal(`1e${d}`));

  // {USD/wholeTok} = {USD/wholeTok}
  const prices = _prices.map((a) => new Decimal(a.toString()));

  // {wholeTok} = {tok} / {tok/wholeTok}
  const bals = _bals.map((bal, i) => new Decimal(bal.toString()).div(decimalScale[i]));

  // {wholeTok/BU} = D27{tok/BU} / D27 / {tok/wholeTok}
  const spotWeights = _weights.map((_weight, i) => new Decimal(_weight.spot.toString()).div(D27d).div(decimalScale[i]));

  // compute $ value of balances
  // {USD} = {wholeTok} * {USD/wholeTok}
  const allValue = bals.map((bal, i) => bal.mul(prices[i])).reduce((a, b) => a.add(b));

  // compute $ value of one basket unit
  // {USD/BU} = {wholeTok/BU} * {USD/wholeTok}
  const basketValue = spotWeights.map((weight, i) => weight.mul(prices[i])).reduce((a, b) => a.add(b));

  // compute number of basket units
  // {BU} = {USD} / {USD/BU}
  const baskets = allValue.div(basketValue);

  // compute expected balances
  // {wholeTok} = {wholeTok/BU} * {BU}
  const expectedBalances = spotWeights.map((weight) => weight.mul(baskets));

  // compute value NOT in correct balances
  // {USD} = {wholeTok} * {USD/wholeTok}
  const errorValue = bals.map((bal, i) => bal.sub(expectedBalances[i]).abs().mul(prices[i])).reduce((a, b) => a.add(b));

  return allValue.sub(errorValue).div(allValue).toNumber();
};
