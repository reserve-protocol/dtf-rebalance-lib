import type { Rebalance as RebalanceV5, StartRebalanceArgsPartial as StartRebalanceArgsPartialV5 } from "../types";

// === FOLIO DATA STRUCTURES ===

export interface Rebalance extends RebalanceV5 {
  bidsEnabled: boolean;
}

// === START REBALANCE ===

// Partial set of the args needed to call `startRebalance()`.
// Folio 6.0.0 additionally requires `rebalanceNonce`, supplied by the caller.
export interface StartRebalanceArgsPartial extends StartRebalanceArgsPartialV5 {}

// ======================
