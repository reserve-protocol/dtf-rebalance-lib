import { Decimal } from "./utils";

import { bn, D9d, D18d } from "./numbers";
import { AuctionMetrics, FolioVersion, OpenAuctionArgs, Rebalance, TokenRebalanceParams, WeightRange } from "./types";

import { Rebalance as Rebalance_4_0_0 } from "./4.0.0/types";

import { getOpenAuction as getOpenAuction_4_0_0 } from "./4.0.0/open-auction";
import { getOpenAuction as getOpenAuction_5_0_0 } from "./5.0.0/open-auction";

/**
 * Generator for the `_targetBasket` parameter
 *
 * Depending on the usecase, pass either:
 * - TRACKING: CURRENT prices
 * - NATIVE: HISTORICAL prices
 *
 * @param _initialWeights D27{tok/BU} The initial historical weights emitted in the RebalanceStarted event
 * @param _prices {USD/wholeTok} either CURRENT or HISTORICAL prices
 * @returns D18{1} The target basket
 */
export const getTargetBasket = (
  _initialWeights: WeightRange[],
  _prices: number[],
  _decimals: bigint[],
  debug?: boolean,
): bigint[] => {
  if (debug === undefined) {
    debug = true;
  }

  if (debug) {
    console.log("getTargetBasket", _initialWeights, _prices, _decimals);
  }

  if (_initialWeights.length != _prices.length) {
    throw new Error("length mismatch");
  }

  const vals = _initialWeights.map((initialWeight: WeightRange, i: number) => {
    if (_prices[i] <= 0) {
      throw new Error(`missing price for token index ${i}`);
    }

    const price = new Decimal(_prices[i]);
    const decimalScale = new Decimal(`1e${_decimals[i]}`);

    // {USD/wholeBU} = D27{tok/BU} * {BU/wholeBU} / {tok/wholeTok} / D27 * {USD/wholeTok}
    return new Decimal(initialWeight.spot.toString()).div(decimalScale).mul(price).div(D9d);
  });

  const totalValue = vals.reduce((a, b) => a.add(b));

  // D18{1} = {USD/wholeBU} / {USD/wholeBU} * D18
  return vals.map((val) => bn(val.div(totalValue).mul(D18d)));
};

/**
 * Get the values needed to call `folio.openAuction()` as the AUCTION_LAUNCHER
 *
 * Non-AUCTION_LAUNCHERs should use `folio.openAuctionUnrestricted()`
 *
 * @param _rebalance The result of calling folio.getRebalance(), today
 * @param _supply {share} The totalSupply() of the basket, today
 * @param _initialSupply {share} The totalSupply() at time rebalance was first proposed
 * @param _initialAssets {tok} Initial asset balances in the Folio, e.g result of folio.totalAssets() at time rebalance was first proposed
 * @param _targetBasket D18{1} Result of calling `getTargetBasket()`
 * @param _assets {tok} Current asset balances in the Folio, e.g result of folio.totalAssets(), today
 * @param _decimals Decimals of each token
 * @param _prices {USD/wholeTok} USD prices for each *whole* token, today
 * @param _priceError {1} Price error to use for each token during auction pricing; should be smaller than price error during startRebalance
 * @param _finalStageAt {1} The % rebalanced from the initial Folio to determine when is the final stage of the rebalance
 *
 * @return OpenAuctionArgs
 * @return AuctionMetrics
 */
export const getOpenAuction = (
  version: FolioVersion,
  _rebalance: Rebalance,
  _supply: bigint,
  _initialSupply: bigint,
  _initialAssets: bigint[] = [],
  _targetBasket: bigint[] = [],
  _assets: bigint[],
  _decimals: bigint[],
  _prices: number[],
  _priceError: number[],
  _finalStageAt: number,
  debug?: boolean,
): [OpenAuctionArgs, AuctionMetrics] => {
  if (debug) {
    console.log("getOpenAuction version", version);
  }

  if (version === FolioVersion.V4) {
    // Folio 4.0.0

    const rebalance_4_0_0: Rebalance_4_0_0 = {
      nonce: _rebalance.nonce,
      tokens: _rebalance.tokens.map((token: TokenRebalanceParams) => token.token),
      weights: _rebalance.tokens.map((token: TokenRebalanceParams) => token.weight),
      initialPrices: _rebalance.tokens.map((token: TokenRebalanceParams) => token.price),
      inRebalance: _rebalance.tokens.map((token: TokenRebalanceParams) => token.inRebalance),
      limits: _rebalance.limits,
      startedAt: _rebalance.timestamps.startedAt,
      restrictedUntil: _rebalance.timestamps.restrictedUntil,
      availableUntil: _rebalance.timestamps.availableUntil,
      priceControl: _rebalance.priceControl,
    };

    return getOpenAuction_4_0_0(
      rebalance_4_0_0,
      _supply,
      _initialSupply,
      _initialAssets,
      _targetBasket,
      _assets,
      _decimals,
      _prices,
      _priceError,
      _finalStageAt,
      debug,
    );
  } else if (version === FolioVersion.V5) {
    // Folio 5.0.0

    return getOpenAuction_5_0_0(
      _rebalance,
      _supply,
      _initialSupply,
      _initialAssets,
      _targetBasket,
      _assets,
      _decimals,
      _prices,
      _priceError,
      _finalStageAt,
      debug,
    );
  } else {
    throw new Error(`unsupported version: ${version}`);
  }
};
