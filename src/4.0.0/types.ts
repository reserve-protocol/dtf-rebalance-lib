import { WeightRange, PriceRange, RebalanceLimits, PriceControl } from "../types";

// === START REBALANCE ===

// Partial set of the args needed to call `startRebalance()`
export interface StartRebalanceArgsPartial {
  tokens: string[];
  weights: WeightRange[];
  prices: PriceRange[];
  limits: RebalanceLimits;
  // auctionLauncherWindow: bigint
  // ttl: bigint
}

/// === OPEN AUCTION ===

export interface Rebalance {
  nonce: bigint;
  tokens: string[];
  weights: WeightRange[];
  initialPrices: PriceRange[];
  inRebalance: boolean[];
  limits: RebalanceLimits;
  startedAt: bigint;
  restrictedUntil: bigint;
  availableUntil: bigint;
  priceControl: PriceControl;
}

// ======================
