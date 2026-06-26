import { PriceRange, RebalanceLimits, WeightRange, PriceControl } from "../types";

// === FOLIO DATA STRUCTURES ===

export interface TokenRebalanceParams {
  token: string;
  weight: WeightRange;
  price: PriceRange;
  maxAuctionSize: bigint;
  inRebalance: boolean;
}

export interface RebalanceTimestamps {
  startedAt: bigint;
  restrictedUntil: bigint;
  availableUntil: bigint;
}

export interface Rebalance {
  nonce: bigint;
  priceControl: PriceControl;
  tokens: TokenRebalanceParams[];
  limits: RebalanceLimits;
  timestamps: RebalanceTimestamps;
}

// === START REBALANCE ===

// Partial set of the args needed to call `startRebalance()`
export interface StartRebalanceArgsPartial {
  tokens: TokenRebalanceParams[];
  limits: RebalanceLimits;
  // auctionLauncherWindow: bigint
  // ttl: bigint
}

// ======================
