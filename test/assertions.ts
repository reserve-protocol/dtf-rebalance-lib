import { strict as assert } from "node:assert";

import { bn } from "../src/numbers";
import { OpenAuctionArgs, PriceRange, RebalanceLimits, WeightRange } from "../src/types";

export const PRECISION = bn("1e3"); // 1-part-in-1000

export const assertApproxEq = (a: bigint, b: bigint, precision: bigint = PRECISION) => {
  const delta = a > b ? a - b : b - a;
  assert(a >= b / precision, `Expected ${a} to be >= ${b / precision}`); // Ensure a is not far below b
  assert(delta <= b / precision, `Expected delta ${delta} to be <= ${b / precision}`); // Ensure difference is small relative to b
  // A more robust check might be delta <= max(abs(a), abs(b)) / precision, or handle b=0
  if (b !== 0n) {
    assert(delta <= (a > b ? a : b) / precision, `Expected delta ${delta} to be <= ${(a > b ? a : b) / precision}`); // Compare delta to the larger of a or b
  } else {
    assert(delta <= precision, `Expected delta ${delta} to be <= ${precision}`); // If b is 0, delta must be small
  }
};

export const assertRangesEqual = (a: WeightRange, b: WeightRange) => {
  assertApproxEq(a.low, b.low);
  assertApproxEq(a.spot, b.spot);
  assertApproxEq(a.high, b.high);
};

export const assertPricesEqual = (a: PriceRange, b: PriceRange) => {
  assertApproxEq(a.low, b.low);
  assertApproxEq(a.high, b.high);
};

export const assertRebalanceLimitsEqual = (a: RebalanceLimits, b: RebalanceLimits, precision: bigint = PRECISION) => {
  assertApproxEq(a.low, b.low, precision);
  assertApproxEq(a.spot, b.spot, precision);
  assertApproxEq(a.high, b.high, precision);
};

export const assertOpenAuctionArgsEqual = (a: OpenAuctionArgs, b: OpenAuctionArgs, precision: bigint = PRECISION) => {
  assert.equal(a.rebalanceNonce, b.rebalanceNonce);
  assert.deepEqual(a.tokens, b.tokens);

  assert.equal(a.newWeights.length, b.newWeights.length);
  for (let i = 0; i < a.newWeights.length; i++) {
    assertRangesEqual(a.newWeights[i], b.newWeights[i]);
  }

  assert.equal(a.newPrices.length, b.newPrices.length);
  for (let i = 0; i < a.newPrices.length; i++) {
    // assertPricesEqual uses its own default precision, which is fine.
    assertPricesEqual(a.newPrices[i], b.newPrices[i]);
  }

  assertRebalanceLimitsEqual(a.newLimits, b.newLimits, precision);
};
