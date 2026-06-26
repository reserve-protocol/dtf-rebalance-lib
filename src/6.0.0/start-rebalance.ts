import { getStartRebalance as getStartRebalance_5_0_0 } from "../5.0.0/start-rebalance";
import { StartRebalanceArgsPartial } from "./types";

/**
 * Get the arguments needed to call Folio 6.0.0 startRebalance.
 *
 * 6.0.0 uses the same token rebalance parameter math as 5.0.0; the on-chain ABI
 * additionally requires the expected rebalance nonce, which is supplied by the caller.
 */
export const getStartRebalance = (
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
): StartRebalanceArgsPartial => {
  const args = getStartRebalance_5_0_0(
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
  ) as StartRebalanceArgsPartial;

  if (!deferWeights || !weightControl) {
    return args;
  }

  return {
    ...args,
    tokens: args.tokens.map((tokenParams, i) => ({
      ...tokenParams,
      weight:
        _targetBasket[i] === 0n
          ? {
              ...tokenParams.weight,
              spot: 0n,
            }
          : tokenParams.weight,
    })),
  };
};
