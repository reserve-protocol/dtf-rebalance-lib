// === METADATA ===

export enum FolioVersion {
  V4 = 4,
  V5 = 5,
}

// === FOLIO DATA STRUCTURES ===

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

// === START REBALANCE ===

// Partial set of the args needed to call `startRebalance()`
export interface StartRebalanceArgsPartial {
  tokens: TokenRebalanceParams[];
  limits: RebalanceLimits;
  // auctionLauncherWindow: bigint
  // ttl: bigint
}

// === OPEN AUCTION ===

// Call `getOpenAuction()` to get the current auction round
export enum AuctionRound {
  EJECT = 0,
  PROGRESS = 1,
  FINAL = 2,
}

/**
 * Useful metrics to use to visualize things
 *
 * @param initialProgression {1} The progression the Folio had when the auction was first proposed
 * @param absoluteProgression {1} The progression of the auction on an absolute scale
 * @param relativeProgression {1} The relative progression of the auction
 * @param target {1} The target of the auction on an absolute scale
 * @param relativeTarget {1} The relative target of the auction
 * @param auctionSize {USD} The total value on sale in the auction
 *
 * @param surplusTokens The list of tokens in surplus
 * @param surplusTokenSizes {USD} The USD size of the surplus token
 * @param deficitTokens The list of tokens in deficit
 * @param deficitTokenSizes {USD} The USD size of the deficit token
 */
export interface AuctionMetrics {
  round: AuctionRound;
  initialProgression: number;
  absoluteProgression: number;
  relativeProgression: number;
  target: number;
  relativeTarget: number;
  auctionSize: number;

  surplusTokens: string[];
  surplusTokenSizes: number[];
  deficitTokens: string[];
  deficitTokenSizes: number[];
}

// All the args needed to call `folio.openAuction()`
export interface OpenAuctionArgs {
  rebalanceNonce: bigint;
  tokens: string[];
  newWeights: WeightRange[];
  newPrices: PriceRange[];
  newLimits: RebalanceLimits;
}

// ======================
