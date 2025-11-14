export enum PriceControl {
  NONE = 0,
  PARTIAL = 1,
  ATOMIC_SWAP = 2,
}

export interface RebalanceLimits {
  low: bigint; // D18{BU/share}
  spot: bigint; // D18{BU/share}
  high: bigint; // D18{BU/share}
}

export interface WeightRange {
  low: bigint; // D27{tok/BU}
  spot: bigint; // D27{tok/BU}
  high: bigint; // D27{tok/BU}
}

export interface PriceRange {
  low: bigint; // D27{nanoUSD/tok}
  high: bigint; // D27{nanoUSD/tok}
}

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

export interface Folio {
  name: string;
  chainId: number;
  folio: string;
  proxyAdmin: string;
  basketGovernor?: string;
}
