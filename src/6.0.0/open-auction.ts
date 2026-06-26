import { AuctionMetrics, OpenAuctionArgs } from "../types";
import { Rebalance } from "./types";
import { getOpenAuction as getOpenAuction_5_0_0 } from "../5.0.0/open-auction";

/**
 * Get the values needed to call Folio 6.0.0 `openAuction()`.
 *
 * 6.0.0 uses the same auction parameter math as 5.0.0; the on-chain ABI additionally
 * requires an auction length. If omitted, callers should provide one before submitting.
 */
export const getOpenAuction = (
  rebalance: Rebalance,
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
  _auctionLength?: bigint,
): [OpenAuctionArgs, AuctionMetrics] => {
  if (_auctionLength === undefined) {
    throw new Error("Folio 6.0.0 openAuction requires auctionLength");
  }

  const [openAuctionArgs, auctionMetrics] = getOpenAuction_5_0_0(
    rebalance,
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

  return [
    {
      ...openAuctionArgs,
      auctionLength: _auctionLength,
    },
    auctionMetrics,
  ];
};
