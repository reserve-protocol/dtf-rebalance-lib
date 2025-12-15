import { FolioVersion } from "./types";

import { StartRebalanceArgsPartial as StartRebalanceArgsPartial_4_0_0 } from "./4.0.0/types";
import { StartRebalanceArgsPartial as StartRebalanceArgsPartial_5_0_0 } from "./types";

import { getStartRebalance as getStartRebalance_4_0_0 } from "./4.0.0/start-rebalance";
import { getStartRebalance as getStartRebalance_5_0_0 } from "./5.0.0/start-rebalance";

/**
 * Get the arguments needed to call startRebalance
 *
 * The `tokens` argument should be paired with the two return values and passed to `startRebalance()`
 *
 * @param _supply {share} Current total supply
 * @param tokens Addresses of tokens in the basket
 * @param _assets {tok} Current asset balances
 * @param decimals Decimals of each token
 * @param _targetBasket D18{1} Ideal basket
 * @param _prices {USD/wholeTok} USD prices for each *whole* token
 * @param _priceError {1} Price error per token to use in the rebalance; should be larger than price error during openAuction
 * @param _dtfPrice {USD/wholeShare} DTF price
 * @param _maxAuctionSize {USD} The maximum auction size for each token
 * @param weightControl TRACKING=false, NATIVE=true
 * @param deferWeights Whether to use the full range for weights, only possible for NATIVE DTFs
 *
 * @return StartRebalanceArgsPartial_5_0_0 | StartRebalanceArgsPartial_4_0_0, depending on `version` enum
 */
export const getStartRebalance = (
  version: FolioVersion,
  _supply: bigint,
  tokens: string[],
  _assets: bigint[],
  decimals: bigint[],
  _targetBasket: bigint[],
  _prices: number[],
  _priceError: number[],
  _maxAuctionSizes: number[],
  weightControl: boolean,
  deferWeights: boolean,
  debug?: boolean,
): StartRebalanceArgsPartial_5_0_0 | StartRebalanceArgsPartial_4_0_0 => {
  if (debug) {
    console.log("getOpenAuction version", version);
  }

  if (version === FolioVersion.V4) {
    // Folio 4.0.0

    return getStartRebalance_4_0_0(
      _supply,
      tokens,
      _assets,
      decimals,
      _targetBasket,
      _prices,
      _priceError,
      weightControl,
      deferWeights,
      debug,
    );
  } else if (version === FolioVersion.V5) {
    // Folio 5.0.0

    return getStartRebalance_5_0_0(
      _supply,
      tokens,
      _assets,
      decimals,
      _targetBasket,
      _prices,
      _priceError,
      _maxAuctionSizes,
      weightControl,
      deferWeights,
      debug,
    );
  } else {
    throw new Error(`unsupported version: ${version}`);
  }
};
