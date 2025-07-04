import { bn } from "../../src/numbers";
import { PriceControl, PriceRange, RebalanceLimits, Rebalance, WeightRange } from "../../src/types";
import { getBasketDistribution } from "../../src/utils";
import { OpenAuctionArgs, getOpenAuction } from "../../src/open-auction";
import { getStartRebalance } from "../../src/start-rebalance";
import { describe, it, beforeEach } from "node:test";
import { strict as assert } from "node:assert";

const PRECISION = bn("1e3"); // 1-part-in-1000

const assertApproxEq = (a: bigint, b: bigint, precision: bigint = PRECISION) => {
  const delta = a > b ? a - b : b - a;
  // if (delta > b / precision) console.log('assertApproxEq FAIL', a.toString(), b.toString(), 'delta:', delta.toString()) // Keep for debugging if necessary
  assert(a >= b / precision, `Expected ${a} to be >= ${b / precision}`); // Ensure a is not far below b
  assert(delta <= b / precision, `Expected delta ${delta} to be <= ${b / precision}`); // Ensure difference is small relative to b
  // A more robust check might be delta <= max(abs(a), abs(b)) / precision, or handle b=0
  if (b !== 0n) {
    assert(delta <= (a > b ? a : b) / precision, `Expected delta ${delta} to be <= ${(a > b ? a : b) / precision}`); // Compare delta to the larger of a or b
  } else {
    assert(delta <= precision, `Expected delta ${delta} to be <= ${precision}`); // If b is 0, delta must be small
  }
};

const assertRangesEqual = (a: WeightRange, b: WeightRange) => {
  assertApproxEq(a.low, b.low);
  assertApproxEq(a.spot, b.spot);
  assertApproxEq(a.high, b.high);
};

const assertPricesEqual = (a: PriceRange, b: PriceRange) => {
  assertApproxEq(a.low, b.low);
  assertApproxEq(a.high, b.high);
};

const assertRebalanceLimitsEqual = (a: RebalanceLimits, b: RebalanceLimits, precision: bigint = PRECISION) => {
  assertApproxEq(a.low, b.low, precision);
  assertApproxEq(a.spot, b.spot, precision);
  assertApproxEq(a.high, b.high, precision);
};

const assertOpenAuctionArgsEqual = (a: OpenAuctionArgs, b: OpenAuctionArgs, precision: bigint = PRECISION) => {
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

describe("NATIVE DTFs", () => {
  const supply = bn("1e21"); // 1000 supply
  const auctionPriceError = [0.01, 0.01, 0.01]; // Smaller price error for getOpenAuction
  const finalStageAtForTest = 0.95; // Standard finalStageAt

  // Common expected prices for tokens [USDC (6dec), DAI (18dec), USDT (6dec)]
  // when market prices are [1,1,1], auctionPriceError is [0.01,0.01,0.01], and priceControl=true,
  // and initialPrices allow this range.
  const defaultExpectedPrices_USDC_DAI_USDT: PriceRange[] = [
    { low: bn("9.9e29"), high: bn("1.01e30") }, // USDC (D27 nanoUSD from $1, 6dec)
    { low: bn("9.9e17"), high: bn("1.01e18") }, // DAI (D27 nanoUSD from $1, 18dec)
    { low: bn("9.9e29"), high: bn("1.01e30") }, // USDT (D27 nanoUSD from $1, 6dec)
  ];

  describe("Rebalancing from 100% USDC to 0% USDC, 50% DAI, 50% USDT", () => {
    const tokens = ["USDC", "DAI", "USDT"];
    const decimalsS1 = [bn("6"), bn("18"), bn("6")];
    const initialMarketPricesS1 = [1, 1, 1];
    const priceErrorStartRebalanceS1 = [0.1, 0.1, 0.1];
    const initialFolioS1 = [bn("1e6"), bn("0"), bn("0")]; // Represents 1 USDC, 0 DAI, 0 USDT per share (approx value)
    const targetBasketS1 = [bn("0"), bn("0.5e18"), bn("0.5e18")];
    // Folio representing mid-progress for ejection tests: ~20% USDC, ~40% DAI, ~40% USDT by value
    const folioMidProgressS1 = [bn("0.2e6"), bn("0.4e18"), bn("0.4e6")];
    // Folio representing near completion for ejection tests: ~1% USDC, ~49.5% DAI, ~49.5% USDT by value
    const folioNearCompletionS1 = [bn("0.01e6"), bn("0.495e18"), bn("0.495e6")];
    // Folio for Step 6 (negligible ejection, high relative progression): USDC almost gone, DAI/USDT balanced
    const folioTrueMidS1_ActuallyHighProg = [bn("0.00001e6"), bn("0.2e18"), bn("0.2e6")];
    // Folio for Step 7: shareValue ~1.0. USDC negligible. DAI 0.8 val, USDT 0.2 val.
    // InitialProg=0. Progression for this folio = (min(0.8,0.5)+min(0.2,0.5))/1.0 = (0.5+0.2)/1.0 = 0.7.
    // relativeProgression = 0.7 < 0.93 -> delta=0.05.
    const folioStep7S1_varied_weights = [bn("0.00001e6"), bn("0.8e18"), bn("0.2e6")];

    let mockRebalanceBaseS1: Omit<Rebalance, "priceControl">;
    let initialWeightsS1: WeightRange[], initialPricesS1: PriceRange[], initialLimitsS1: RebalanceLimits;

    beforeEach(() => {
      const { weights, prices, limits } = getStartRebalance(
        supply,
        tokens,
        initialFolioS1,
        decimalsS1,
        targetBasketS1,
        initialMarketPricesS1,
        priceErrorStartRebalanceS1,
        true, // weightControl: true for NATIVE-style
      );
      initialWeightsS1 = weights;
      initialPricesS1 = prices;
      initialLimitsS1 = limits;
      mockRebalanceBaseS1 = {
        nonce: 1n,
        tokens: tokens,
        weights: initialWeightsS1, // These are the NATIVE rebalance.weights used for clamping
        initialPrices: initialPricesS1,
        inRebalance: tokens.map(() => true),
        limits: initialLimitsS1, // NATIVE limits are {1e18, 1e18, 1e18}, crucial for newLimits clamping
        startedAt: 0n,
        restrictedUntil: 0n,
        availableUntil: 0n,
      };
    });

    it("Step 0: Verifies initial setup from getStartRebalance", () => {
      assert.equal(initialWeightsS1.length, 3);
      assert.equal(initialPricesS1.length, 3);
      assertRangesEqual(initialWeightsS1[0], {
        low: bn("0"),
        spot: bn("0"),
        high: bn("0"),
      }); // USDC
      assertRangesEqual(initialWeightsS1[1], {
        low: bn("450000000000000000000000000"), // 0.5 * 0.9 * 1e27
        spot: bn("500000000000000000000000000"), // 0.5 * 1e27
        high: bn("555555555555555555550000000"), // 0.5 / 0.9 * 1e27
      }); // DAI
      assertRangesEqual(initialWeightsS1[2], {
        low: bn("450000000000000"), // 0.5 * 0.9 * 1e15
        spot: bn("500000000000000"), // 0.5 * 1e15
        high: bn("555555555555556"), // 0.5 / 0.9 * 1e15
      }); // USDT
      assertRebalanceLimitsEqual(initialLimitsS1, {
        low: bn("1e18"),
        spot: bn("1e18"),
        high: bn("1e18"),
      });
    });

    it("Step 1: Ejection Phase (initial folio, priceControl=true, prices=[1,1,1])", () => {
      const mockRebalance: Rebalance = {
        ...mockRebalanceBaseS1,
        priceControl: PriceControl.PARTIAL,
      };
      const [openAuctionArgs] = getOpenAuction(
        mockRebalance,
        supply,
        initialFolioS1,
        targetBasketS1,
        initialFolioS1,
        decimalsS1,
        initialMarketPricesS1,
        auctionPriceError,
        finalStageAtForTest,
      );
      // With ejection, USDC has surplus, DAI/USDT have deficits, so all tokens are returned
      assertOpenAuctionArgsEqual(openAuctionArgs, {
        rebalanceNonce: 1n,
        tokens: tokens, // All tokens are returned (USDC has surplus, DAI/USDT have deficits)
        newWeights: [
          initialWeightsS1[0], // USDC target 0
          { low: bn("475000000000000000000000000"), spot: bn("500000000000000000000000000"), high: bn("555555555555555555555555556") },
          { low: bn("475000000000000"), spot: bn("500000000000000"), high: bn("555555555555556") },
        ],
        newPrices: defaultExpectedPrices_USDC_DAI_USDT,
        newLimits: initialLimitsS1,
      });
    });

    it("Step 2: Ejection Phase (mid-progress folio with USDC to eject)", () => {
      const mockRebalance: Rebalance = {
        ...mockRebalanceBaseS1,
        priceControl: PriceControl.PARTIAL,
      };
      const [openAuctionArgs] = getOpenAuction(
        mockRebalance,
        supply,
        initialFolioS1,
        targetBasketS1,
        folioMidProgressS1,
        decimalsS1,
        initialMarketPricesS1,
        auctionPriceError,
        finalStageAtForTest,
      );
      // USDC still has surplus to eject, DAI/USDT have deficits
      assertOpenAuctionArgsEqual(openAuctionArgs, {
        rebalanceNonce: 1n,
        tokens: tokens, // All tokens included because all have surpluses or deficits
        newWeights: [
          initialWeightsS1[0],
          { low: bn("475000000000000000000000000"), spot: bn("500000000000000000000000000"), high: bn("555555555555555555555555556") },
          { low: bn("475000000000000"), spot: bn("500000000000000"), high: bn("555555555555556") },
        ],
        newPrices: defaultExpectedPrices_USDC_DAI_USDT,
        newLimits: initialLimitsS1,
      });
    });

    it("Step 3: Ejection Phase (near-completion folio with USDC to eject)", () => {
      const mockRebalance: Rebalance = {
        ...mockRebalanceBaseS1,
        priceControl: PriceControl.PARTIAL,
      };
      const [openAuctionArgs] = getOpenAuction(
        mockRebalance,
        supply,
        initialFolioS1,
        targetBasketS1,
        folioNearCompletionS1,
        decimalsS1,
        initialMarketPricesS1,
        auctionPriceError,
        finalStageAtForTest,
      );
      assertOpenAuctionArgsEqual(openAuctionArgs, {
        rebalanceNonce: 1n,
        tokens: tokens,
        newWeights: [
          initialWeightsS1[0],
          {
            low: bn("500000000000000000000000000"),
            spot: bn("500000000000000000000000000"),
            high: bn("550000000000000000000000000"), // 5e26 * 1.1 for ejection
          },
          {
            low: bn("500000000000000"),
            spot: bn("500000000000000"),
            high: bn("550000000000000"), // 5e14 * 1.1 for ejection
          },
        ],
        newPrices: defaultExpectedPrices_USDC_DAI_USDT,
        newLimits: initialLimitsS1,
      });
    });

    it("Step 4: Ejection Phase (initial folio, priceControl=false, prices=[1,1,1])", () => {
      const mockRebalance: Rebalance = {
        ...mockRebalanceBaseS1,
        priceControl: PriceControl.NONE,
      };
      const [openAuctionArgs] = getOpenAuction(
        mockRebalance,
        supply,
        initialFolioS1,
        targetBasketS1,
        initialFolioS1,
        decimalsS1,
        initialMarketPricesS1,
        auctionPriceError,
        finalStageAtForTest,
      );
      assertOpenAuctionArgsEqual(openAuctionArgs, {
        rebalanceNonce: 1n,
        tokens: tokens, // All tokens have surpluses/deficits
        newWeights: [
          initialWeightsS1[0],
          { low: bn("475000000000000000000000000"), spot: bn("500000000000000000000000000"), high: bn("555555555555555555555555556") },
          { low: bn("475000000000000"), spot: bn("500000000000000"), high: bn("555555555555556") },
        ],
        newPrices: initialPricesS1, // from mockRebalance due to priceControl=false
        newLimits: initialLimitsS1,
      });
    });

    it("Step 5: Ejection Phase (initial folio, USDC Price Loss 0.9, priceControl=true)", () => {
      const mockRebalance: Rebalance = {
        ...mockRebalanceBaseS1,
        priceControl: PriceControl.PARTIAL,
      };
      const pricesS1_loss = [0.9, 1, 1];
      const [openAuctionArgs] = getOpenAuction(
        mockRebalance,
        supply,
        initialFolioS1,
        targetBasketS1,
        initialFolioS1,
        decimalsS1,
        pricesS1_loss,
        auctionPriceError,
        finalStageAtForTest,
      );
      const expectedNewPricesLoss: PriceRange[] = [
        { low: bn("9e29"), high: bn("9.09e29") }, // USDC price (nanoUSD)
        { low: bn("9.9e17"), high: bn("1.01e18") }, // DAI (nanoUSD)
        { low: bn("9.9e29"), high: bn("1.01e30") }, // USDT (nanoUSD)
      ];
      // shareValue = 0.9 due to USDC price drop
      // idealWeight calculations affected by shareValue change
      // With delta=0.05 and ejection, weights get (1-delta)/(low/spot) factor
      assertOpenAuctionArgsEqual(openAuctionArgs, {
        rebalanceNonce: 1n,
        tokens: tokens, // All tokens
        newWeights: [
          initialWeightsS1[0], // USDC target 0
          {
            low: bn("450000000000000000000000000"),
            spot: bn("450000000000000000000000000"),
            high: bn("519750000000000000000000000"), // Calculated value with ejection
          },
          {
            low: bn("450000000000000"),
            spot: bn("450000000000000"),
            high: bn("519750000000000"), // Calculated value with ejection
          },
        ],
        newPrices: expectedNewPricesLoss,
        newLimits: initialLimitsS1,
      });
    });

    it("Step 6: Test Case: Negligible Ejection, High Relative Progression -> Delta=0", () => {
      const mockRebalance: Rebalance = {
        ...mockRebalanceBaseS1,
        priceControl: PriceControl.PARTIAL,
      };
      const [openAuctionArgs] = getOpenAuction(
        mockRebalance,
        supply,
        initialFolioS1,
        targetBasketS1,
        folioTrueMidS1_ActuallyHighProg,
        decimalsS1,
        initialMarketPricesS1,
        auctionPriceError,
        finalStageAtForTest,
      );
      // With high progression and negligible ejection, this reaches FINAL round with delta=0
      // Only DAI and USDT are returned as they have deficits
      assertOpenAuctionArgsEqual(openAuctionArgs, {
        rebalanceNonce: 1n,
        tokens: ["DAI", "USDT"], // Only tokens with deficits
        newWeights: [
          {
            low: bn("450000000000000000000000000"),
            spot: bn("450000000000000000000000000"),
            high: bn("450000000000000000000000000"), // Clamped to initial weight range
          },
          {
            low: bn("450000000000000"),
            spot: bn("450000000000000"),
            high: bn("450000000000000"), // Clamped to initial weight range
          },
        ],
        newPrices: [defaultExpectedPrices_USDC_DAI_USDT[1], defaultExpectedPrices_USDC_DAI_USDT[2]], // DAI and USDT prices
        newLimits: initialLimitsS1,
      });
    });

    it("Step 7: NATIVE Mid-Rebalance (Multi-Asset Target, Negligible Ejection, Low Relative Progression -> Varied Weights)", () => {
      const mockRebalance: Rebalance = {
        ...mockRebalanceBaseS1,
        priceControl: PriceControl.PARTIAL,
      };
      // Using folioStep7S1_varied_weights: shareValue ~1.0, relativeProgression ~0.7 -> delta=0.05.
      // ideal_DAI/USDT_whole_spot ~0.5 (since shareValue*0.5 = 0.5).
      // This ideal_spot is same as initialWeightsS1[i].spot_whole.
      const [openAuctionArgs] = getOpenAuction(
        mockRebalance,
        supply,
        initialFolioS1,
        targetBasketS1,
        folioStep7S1_varied_weights,
        decimalsS1,
        initialMarketPricesS1,
        auctionPriceError,
        finalStageAtForTest,
      );
      assertOpenAuctionArgsEqual(openAuctionArgs, {
        rebalanceNonce: 1n,
        tokens: ["DAI", "USDT"], // Only tokens with deficits
        newWeights: [
          // DAI: actual calculated values from debug output
          { low: bn("475004750000000000000000000"), spot: bn("500005000000000000000000000"), high: bn("555555555555555555555555556") },
          // USDT: actual calculated values from debug output
          { low: bn("475004750000000"), spot: bn("500005000000000"), high: bn("555555555555556") },
        ],
        newPrices: [defaultExpectedPrices_USDC_DAI_USDT[1], defaultExpectedPrices_USDC_DAI_USDT[2]], // DAI and USDT prices
        newLimits: initialLimitsS1, // newLimits will be clamped to initial flat NATIVE limits
      });
    });
  });

  describe("Rebalancing from 0% USDC, 50% DAI, 50% USDT to 100% USDC", () => {
    const tokens = ["USDC", "DAI", "USDT"];
    const decimalsS2 = [bn("6"), bn("18"), bn("6")];
    const initialMarketPricesS2 = [1, 1, 1];
    const priceErrorStartRebalanceS2 = [0.1, 0.1, 0.1];
    // initialFolioS2: approx 0 USDC, 0.5 DAI val, 0.5 USDT val (total val 1 USD for 1 share)
    const initialFolioS2 = [bn("0"), bn("0.5e18"), bn("0.5e6")];
    const targetBasketS2 = [bn("1e18"), bn("0"), bn("0")]; // Target 100% USDC
    // Folio for mid-progress ejection tests: ~40% USDC, ~30% DAI, ~30% USDT by value
    const folioMidProgressS2 = [bn("0.4e6"), bn("0.3e18"), bn("0.3e6")];
    // Folio for near completion ejection tests: ~98% USDC, ~1% DAI, ~1% USDT by value
    const folioTrulyNearCompletionS2 = [bn("0.98e6"), bn("0.01e18"), bn("0.01e6")];
    // Folio for Step 6 (negligible ejection, high relative progression): DAI/USDT almost gone
    const folioTrueMidS2_ActuallyHighProg = [bn("0.4e6"), bn("0.00001e18"), bn("0.00001e6")];

    let mockRebalanceBaseS2: Omit<Rebalance, "priceControl">;
    let initialWeightsS2: WeightRange[], initialPricesS2: PriceRange[], initialLimitsS2: RebalanceLimits;

    beforeEach(() => {
      const { weights, prices, limits } = getStartRebalance(
        supply,
        tokens,
        initialFolioS2,
        decimalsS2,
        targetBasketS2,
        initialMarketPricesS2,
        priceErrorStartRebalanceS2,
        true,
      );
      initialWeightsS2 = weights;
      initialPricesS2 = prices;
      initialLimitsS2 = limits;
      mockRebalanceBaseS2 = {
        nonce: 2n, // Different nonce for this scenario suite
        tokens: tokens,
        weights: initialWeightsS2,
        initialPrices: initialPricesS2,
        inRebalance: tokens.map(() => true),
        limits: initialLimitsS2,
        startedAt: 0n,
        restrictedUntil: 0n,
        availableUntil: 0n,
      };
    });

    it("Step 0: Verifies initial setup from getStartRebalance", () => {
      assert.equal(initialWeightsS2.length, 3);
      // USDC target 100%
      assertRangesEqual(initialWeightsS2[0], {
        low: bn("900000000000000"), // 1.0 * 0.9 * 1e15
        spot: bn("1000000000000000"), // 1.0 * 1e15
        high: bn("1111111111111111"), // 1.0 / 0.9 * 1e15
      });
      assertRangesEqual(initialWeightsS2[1], {
        low: bn("0"),
        spot: bn("0"),
        high: bn("0"),
      }); // DAI target 0%
      assertRangesEqual(initialWeightsS2[2], {
        low: bn("0"),
        spot: bn("0"),
        high: bn("0"),
      }); // USDT target 0%
      assertRebalanceLimitsEqual(initialLimitsS2, {
        low: bn("1e18"),
        spot: bn("1e18"),
        high: bn("1e18"),
      });
    });

    it("Step 1: Ejection Phase (initial folio, priceControl=true, prices=[1,1,1])", () => {
      const mockRebalance: Rebalance = {
        ...mockRebalanceBaseS2,
        priceControl: PriceControl.PARTIAL,
      };
      const [openAuctionArgs] = getOpenAuction(
        mockRebalance,
        supply,
        initialFolioS2,
        targetBasketS2,
        initialFolioS2,
        decimalsS2,
        initialMarketPricesS2,
        auctionPriceError,
        finalStageAtForTest,
      );
      assertOpenAuctionArgsEqual(openAuctionArgs, {
        rebalanceNonce: 2n,
        tokens: tokens,
        newWeights: [
          { low: bn("950000000000000"), spot: bn("1000000000000000"), high: bn("1111111111111111") },
          initialWeightsS2[1],
          initialWeightsS2[2],
        ],
        newPrices: defaultExpectedPrices_USDC_DAI_USDT,
        newLimits: initialLimitsS2,
      });
    });

    it("Step 2: Ejection Phase (mid-progress folio with DAI/USDT to eject)", () => {
      const mockRebalance: Rebalance = {
        ...mockRebalanceBaseS2,
        priceControl: PriceControl.PARTIAL,
      };
      const [openAuctionArgs] = getOpenAuction(
        mockRebalance,
        supply,
        initialFolioS2,
        targetBasketS2,
        folioMidProgressS2,
        decimalsS2,
        initialMarketPricesS2,
        auctionPriceError,
        finalStageAtForTest,
      );
      assertOpenAuctionArgsEqual(openAuctionArgs, {
        rebalanceNonce: 2n,
        tokens: tokens,
        newWeights: [
          { low: bn("950000000000000"), spot: bn("1000000000000000"), high: bn("1111111111111111") },
          initialWeightsS2[1],
          initialWeightsS2[2],
        ],
        newPrices: defaultExpectedPrices_USDC_DAI_USDT,
        newLimits: initialLimitsS2,
      });
    });

    it("Step 3: Ejection Phase (near-completion folio with DAI/USDT to eject)", () => {
      const mockRebalance: Rebalance = {
        ...mockRebalanceBaseS2,
        priceControl: PriceControl.PARTIAL,
      };
      const [openAuctionArgs] = getOpenAuction(
        mockRebalance,
        supply,
        initialFolioS2,
        targetBasketS2,
        folioTrulyNearCompletionS2,
        decimalsS2,
        initialMarketPricesS2,
        auctionPriceError,
        finalStageAtForTest,
      );
      assertOpenAuctionArgsEqual(openAuctionArgs, {
        rebalanceNonce: 2n,
        tokens: tokens,
        newWeights: [
          {
            low: bn("1000000000000000"),
            spot: bn("1000000000000000"),
            high: bn("1100000000000000"),
          },
          initialWeightsS2[1],
          initialWeightsS2[2],
        ],
        newPrices: defaultExpectedPrices_USDC_DAI_USDT,
        newLimits: initialLimitsS2,
      });
    });

    it("Step 4: Ejection Phase (initial folio, USDC Price Drop 0.9 - Gain for Buyer, priceControl=true)", () => {
      const mockRebalance: Rebalance = {
        ...mockRebalanceBaseS2,
        priceControl: PriceControl.PARTIAL,
      };
      const pricesS2_USDCdrop = [0.9, 1, 1]; // USDC price drops, good for us as we target USDC
      const [openAuctionArgs] = getOpenAuction(
        mockRebalance,
        supply,
        initialFolioS2,
        targetBasketS2,
        initialFolioS2,
        decimalsS2,
        pricesS2_USDCdrop,
        auctionPriceError,
        finalStageAtForTest,
      );
      // Expected: rebalanceTarget=1, delta=0. idealWeight for USDC changes due to its price drop.
      // shareValue (of initialFolioS2) = 0.5*1 (DAI) + 0.5*1 (USDT) = 1 (approx, using scaled folio values)
      // idealSpotWeight_USDC = shareValue * targetBasket_USDC[0] / actualLimits.spot / prices_USDC[0.9]
      // idealSpot_USDC_D27 was 1e15 at price 1. At price 0.9, idealSpot_D27 becomes 1e15 / 0.9 = 1.111...e15.
      const expectedNewPricesGainUSDC: PriceRange[] = [
        { low: bn("9e29"), high: bn("9.09e29") }, // USDC (nanoUSD)
        { low: bn("9.9e17"), high: bn("1.01e18") }, // DAI (nanoUSD)
        { low: bn("9.9e29"), high: bn("1.01e30") }, // USDT (nanoUSD)
      ];
      // This new ideal spot (1.111...e15) would get +10% for ejection = 1.222...e15
      // But this exceeds initialWeightsS2[0].high (1.11111e15), so it gets clamped.
      assertOpenAuctionArgsEqual(openAuctionArgs, {
        rebalanceNonce: 2n,
        tokens: tokens, // All tokens included (USDC has deficit, DAI/USDT have surpluses)
        newWeights: [
          {
            low: bn("1055555555555556"), // Updated: 1.111...e15 * 0.95 = 1.055...e15
            spot: bn("1111111111111111"),
            high: bn("1111111111111111"), // Clamped to weight range limit
          },
          initialWeightsS2[1],
          initialWeightsS2[2],
        ],
        newPrices: expectedNewPricesGainUSDC,
        newLimits: initialLimitsS2,
      });
    });

    it("Step 5: Ejection Phase (initial folio, USDC Price Rise 1.1 - Loss for Buyer, priceControl=true)", () => {
      const mockRebalance: Rebalance = {
        ...mockRebalanceBaseS2,
        priceControl: PriceControl.PARTIAL,
      };
      const pricesS2_USDCrise = [1.1, 1, 1];
      const [openAuctionArgs] = getOpenAuction(
        mockRebalance,
        supply,
        initialFolioS2,
        targetBasketS2,
        initialFolioS2,
        decimalsS2,
        pricesS2_USDCrise,
        auctionPriceError,
        finalStageAtForTest,
      );
      // Expected: rebalanceTarget=1, delta=0. idealWeight for USDC changes.
      // idealSpot_USDC_D27 was 1e15 at price 1. At price 1.1, idealSpot_D27 becomes 1e15 / 1.1 = 9.09091e14.
      const expectedNewPricesLossUSDC: PriceRange[] = [
        { low: bn("1.089e30"), high: bn("1111111111111111111111111111111") }, // 1.1 / 0.99 * 1e30 (nanoUSD)
        { low: bn("9.9e17"), high: bn("1.01e18") }, // DAI (nanoUSD)
        { low: bn("9.9e29"), high: bn("1.01e30") }, // USDT (nanoUSD)
      ];
      // This new ideal spot (9.09091e14) would get +10% for ejection = 9.99999e14
      // This is within the weight range limits, so no clamping needed.
      assertOpenAuctionArgsEqual(openAuctionArgs, {
        rebalanceNonce: 2n,
        tokens: tokens, // All tokens included
        newWeights: [
          {
            low: bn("900000000000000"), // Clamped to weight range low limit
            spot: bn("909090909090909"), // Updated: 9.09091e14
            high: bn("1050000000000000"), // Calculated value with ejection
          },
          initialWeightsS2[1],
          initialWeightsS2[2],
        ],
        newPrices: expectedNewPricesLossUSDC,
        newLimits: initialLimitsS2,
      });
    });

    it("Step 6: Test Case: Negligible Ejection, High Relative Progression (Single Target Asset) -> Delta=0", () => {
      const mockRebalance: Rebalance = {
        ...mockRebalanceBaseS2,
        priceControl: PriceControl.PARTIAL,
      };
      const [openAuctionArgs] = getOpenAuction(
        mockRebalance,
        supply,
        initialFolioS2,
        targetBasketS2,
        folioTrueMidS2_ActuallyHighProg,
        decimalsS2,
        initialMarketPricesS2,
        auctionPriceError,
        finalStageAtForTest,
      );
      assertOpenAuctionArgsEqual(openAuctionArgs, {
        rebalanceNonce: 2n,
        tokens: ["USDC"], // Only USDC has deficit in this scenario
        newWeights: [
          { low: bn("900000000000000"), spot: bn("900000000000000"), high: bn("900000000000000") },
        ],
        newPrices: [defaultExpectedPrices_USDC_DAI_USDT[0]], // Only USDC price
        newLimits: initialLimitsS2,
      });
    });
  });

  it("volatiles: [75%, 25%]", () => {
    const tokens = ["USDC", "ETH"];
    const decimals = [bn("6"), bn("18")];
    const prices = [1, 3000];
    const priceError = [0.1, 0.1];
    const targetBasket = [bn("0.75e18"), bn("0.25e18")];
    const initialFolio = [bn("1e6"), bn("0")]; // Represents 1 USDC, 0 ETH
    const {
      weights: newWeights,
      prices: newPricesResult, // renamed to avoid clash
      limits: newLimitsResult, // renamed
    } = getStartRebalance(
      supply,
      tokens,
      initialFolio,
      decimals,
      targetBasket,
      prices,
      priceError,
      true, // weightControl: true
    );
    assert.equal(newWeights.length, 2);
    assert.equal(newPricesResult.length, 2);

    assertRangesEqual(newWeights[0], {
      // USDC
      low: bn("675000000000000"), // 0.75 * (1-0.1) * 1e15
      spot: bn("750000000000000"), // 0.75 * 1e15
      high: bn("833333333333333"), // 0.75 / (1-0.1) * 1e15
    });
    assertRangesEqual(newWeights[1], {
      // ETH
      low: bn("74999999999999999999000"), // (0.25/3000) * (1-0.1) * 1e27
      spot: bn("83333333333333333333333"), // (0.25/3000) * 1e27
      high: bn("92592592592592592592000"), // (0.25/3000) / (1-0.1) * 1e27
    });

    assertPricesEqual(newPricesResult[0], {
      low: bn("9e29"), // 1 * 0.9 * 1e30 (nanoUSD)
      high: bn("1111111111111111111111111111111"), // 1 / 0.9 * 1e30 (nanoUSD)
    });
    assertPricesEqual(newPricesResult[1], {
      low: bn("2700000000000000000000"), // 3000 * 0.9 * 1e18 (nanoUSD)
      high: bn("3333333333333333333333"), // 3000 / 0.9 * 1e18 (nanoUSD)
    });
    assertRebalanceLimitsEqual(newLimitsResult, {
      low: bn("1e18"),
      spot: bn("1e18"),
      high: bn("1e18"),
    });
  });

  it("volatiles: fuzz", () => {
    for (let i = 0; i < 100; i++) {
      // Reduced iterations for faster tests
      const tokensList = [
        ["USDC", "DAI", "WETH", "WBTC"],
        ["SOL", "BONK"],
      ];
      const currentTokens = tokensList[i % tokensList.length];

      const decimalsMap: { [key: string]: bigint } = {
        USDC: bn("6"),
        DAI: bn("18"),
        WETH: bn("18"),
        WBTC: bn("8"),
        SOL: bn("9"),
        BONK: bn("5"),
      };
      const currentDecimals = currentTokens.map((t) => decimalsMap[t]);

      const folio = currentTokens.map((_, i) => (i === 0 ? bn(`1e${currentDecimals[0]}`) : 0n));

      const bals = currentTokens.map(
        (_) => bn(Math.round(Math.random() * 1e20).toString()), // Reduced scale
      );
      const prices = currentTokens.map((_) => Math.max(0.01, Math.random() * 1e4)); // Ensure positive prices
      const priceError = currentTokens.map((_) => Math.max(0.001, Math.min(0.5, Math.random() * 0.2))); // Realistic price error 0.001 to 0.2

      const targetBasket = getBasketDistribution(bals, prices, currentDecimals);

      const {
        weights: newWeights,
        prices: newPricesResult,
        limits: newLimitsResult,
      } = getStartRebalance(
        supply,
        currentTokens,
        folio,
        currentDecimals,
        targetBasket,
        prices,
        priceError,
        true, // weightControl: true
      );
      assert.equal(newWeights.length, currentTokens.length);
      assert.equal(newPricesResult.length, currentTokens.length);
      assert(newLimitsResult !== undefined, "newLimitsResult should be defined");
    }
  });
});

describe("TRACKING DTF Rebalance: USDC -> DAI/USDT Sequence", () => {
  const supply = bn("1e21"); // 1000 supply
  const tokens = ["USDC", "DAI", "USDT"];
  const decimals = [bn("6"), bn("18"), bn("6")];
  const initialMarketPrices = [1, 1, 1];
  const priceErrorStartRebalance = [0.1, 0.1, 0.1]; // For getStartRebalance limits
  const targetBasketUSDCtoDAIUST = [bn("0"), bn("5e17"), bn("5e17")]; // Target 0% USDC, 50% DAI, 50% USDT
  const auctionPriceErrorSmall = [0.01, 0.01, 0.01]; // For getOpenAuction price calcs
  const finalStageAtForTest = 0.95; // Standard finalStageAt

  // Step 0: getStartRebalance for TRACKING DTF
  const _folioUSDCStart = [bn("1e6"), bn("0"), bn("0")]; // 100% USDC, use as initialFolio for this sequence

  const {
    weights: initialWeightsTracking,
    prices: initialPricesTracking,
    limits: initialLimitsTracking,
  } = getStartRebalance(
    supply,
    tokens,
    _folioUSDCStart,
    decimals,
    targetBasketUSDCtoDAIUST,
    initialMarketPrices,
    priceErrorStartRebalance,
    false, // weightControl: false for TRACKING-style weights and limits
  );

  it("Step 0: Verifies initial setup from getStartRebalance (TRACKING)", () => {
    // totalPortion = (0*0.1) + (0.5*0.1) + (0.5*0.1) = 0.1
    // expectedLowLimit = (1 / (1 + 0.1)) * 1e18 = (1/1.1) * 1e18
    // expectedHighLimit = (1 + 0.1) * 1e18 = 1.1 * 1e18
    assertRebalanceLimitsEqual(initialLimitsTracking, {
      low: bn("900000000000000000"), // (1/1.1) * 1e18
      spot: bn("1000000000000000000"),
      high: bn("1111111111111111111"), // 1/(1-0.1) * 1e18
    });

    // For TRACKING, weights low/spot/high are identical
    assertRangesEqual(initialWeightsTracking[0], {
      low: bn("0"),
      spot: bn("0"),
      high: bn("0"),
    }); // USDC
    assertRangesEqual(initialWeightsTracking[1], {
      low: bn("5e26"),
      spot: bn("5e26"),
      high: bn("5e26"),
    }); // DAI
    assertRangesEqual(initialWeightsTracking[2], {
      low: bn("5e14"),
      spot: bn("5e14"),
      high: bn("5e14"),
    }); // USDT

    // Prices are same as NATIVE calculation initially
    assertPricesEqual(initialPricesTracking[0], {
      low: bn("9e29"), // 1 * 0.9 * 1e30 (nanoUSD)
      high: bn("1111111111111111111111111111111"), // 1 / 0.9 * 1e30 (nanoUSD)
    });
    assertPricesEqual(initialPricesTracking[1], {
      low: bn("900000000000000000"), // 1 * 0.9 * 1e18 (nanoUSD)
      high: bn("1111111111111111111"), // 1 / 0.9 * 1e18 (nanoUSD)
    });
    assertPricesEqual(initialPricesTracking[2], {
      low: bn("9e29"), // 1 * 0.9 * 1e30 (nanoUSD)
      high: bn("1111111111111111111111111111111"), // 1 / 0.9 * 1e30 (nanoUSD)
    });
  });

  const mockRebalanceBase: Omit<Rebalance, "priceControl"> = {
    nonce: 2n, // Different nonce for this suite
    tokens: tokens,
    weights: initialWeightsTracking,
    initialPrices: initialPricesTracking,
    inRebalance: tokens.map(() => true),
    limits: initialLimitsTracking,
    startedAt: 0n,
    restrictedUntil: 0n,
    availableUntil: 0n,
  };

  it("Step 1: Auction for Ejection Phase", () => {
    const _folio1 = _folioUSDCStart; // 100% USDC, needs ejection
    const currentMarketPrices1 = [1, 1, 1];
    const mockRebalance1: Rebalance = {
      ...mockRebalanceBase,
      priceControl: PriceControl.PARTIAL,
    };

    const [openAuctionArgs1] = getOpenAuction(
      mockRebalance1,
      supply,
      _folioUSDCStart, // _initialFolio
      targetBasketUSDCtoDAIUST,
      _folio1, // current _folio
      decimals,
      currentMarketPrices1,
      auctionPriceErrorSmall,
      finalStageAtForTest,
    );
    // Expected: buyTarget=1 (ejection). idealSpotLimit=1. limitDelta=0.
    // newLimits before clamp: {1e18,1e18,1e18}. After initialLimitsTracking clamp: {1e18,1e18,1e18}
    // Re-eval: portionBeingEjected = 1. initialProgression = 0. progression = 0. target = 0+(1-0)*0.95=0.95. delta = 0.05.
    // newLimits.low = 1*(1-0.05)=0.95e18. Clamped by initial (0.909e18): 0.95e18.
    // newLimits.high = 1*(1+0.05)=1.05e18. Clamped by initial (1.1e18): 1.05e18.
    assertRebalanceLimitsEqual(openAuctionArgs1.newLimits, {
      low: bn("950000000000000000"),
      spot: bn("1e18"),
      high: bn("1111111111111111111"),
    });
    // For TRACKING, all tokens are included (USDC has surplus, DAI/USDT have deficits)
    assert.deepEqual(openAuctionArgs1.tokens, tokens);
    assert.deepEqual(openAuctionArgs1.newWeights, [
      { low: bn("0"), spot: bn("0"), high: bn("0") },
      { low: bn("5e26"), spot: bn("5e26"), high: bn("5e26") },
      { low: bn("5e14"), spot: bn("5e14"), high: bn("5e14") },
    ]);

    const expectedNewPrices1: PriceRange[] = [
      { low: bn("9.9e29"), high: bn("1.01e30") }, // USDC (nanoUSD)
      { low: bn("9.9e17"), high: bn("1.01e18") }, // DAI (nanoUSD)
      { low: bn("9.9e29"), high: bn("1.01e30") }, // USDT (nanoUSD)
    ];
    assertPricesEqual(openAuctionArgs1.newPrices[0], expectedNewPrices1[0]);
    assertPricesEqual(openAuctionArgs1.newPrices[1], expectedNewPrices1[1]);
    assertPricesEqual(openAuctionArgs1.newPrices[2], expectedNewPrices1[2]);
  });

  it("Step 2: Auction for Mid-Rebalance (progression < finalStageAt)", () => {
    // Folio: 0 USDC, 0.3 DAI (whole), 0.7 USDT (whole). shareValue = 1.
    // targetBasketDec = [0, 0.5, 0.5]. prices = [1,1,1].
    // DAI: expectedInBU = 1*0.5/1 = 0.5. actual = 0.3. balanceInBU = 0.3. value = 0.3.
    // USDT: expectedInBU = 1*0.5/1 = 0.5. actual = 0.7. balanceInBU = 0.5. value = 0.5.
    // progression = (0.3+0.5)/1 = 0.8. initialProgression (from _folioUSDCStart) = 0.
    // relativeProgression = (0.8 - 0) / (1 - 0) = 0.8.
    // finalStageAt = 0.95. threshold = 0.95 - 0.02 = 0.93. 0.8 < 0.93 is TRUE.
    const _folio2 = [bn("0"), bn("3e17"), bn("7e5")]; // Corresponds to 0.3 DAI, 0.7 USDT, total value $1
    const currentMarketPrices2 = [1, 1, 1];
    const mockRebalance2: Rebalance = {
      ...mockRebalanceBase,
      priceControl: PriceControl.PARTIAL,
    };

    const [openAuctionArgs2] = getOpenAuction(
      mockRebalance2,
      supply,
      _folioUSDCStart, // _initialFolio
      targetBasketUSDCtoDAIUST,
      _folio2, // current _folio
      decimals,
      currentMarketPrices2,
      auctionPriceErrorSmall,
      finalStageAtForTest,
    );

    // Expected: buyTarget=0.95 (finalStageAt). idealSpotLimit=1. limitDelta=0.05.
    // newLimits pre-clamp: low=0.95e18, spot=1e18, high=1.05e18.
    // Clamped by initialLimitsTracking (9.09e17,1e18,1.1e18):
    // low=max(0.95e18,9.0909e17)=9.5e17. spot=1e18. high=min(1.05e18,1.1e18)=1.05e18.
    assertRebalanceLimitsEqual(openAuctionArgs2.newLimits, {
      low: bn("950000000000000000"),
      spot: bn("1e18"),
      high: bn("1050000000000000000"),
    });
    assert.deepEqual(openAuctionArgs2.tokens, ["DAI", "USDT"]);
    assert.deepEqual(openAuctionArgs2.newWeights, [
      { low: bn("5e26"), spot: bn("5e26"), high: bn("5e26") },
      { low: bn("5e14"), spot: bn("5e14"), high: bn("5e14") },
    ]);
    // Prices same as step 1 if market prices didn't change
    assertPricesEqual(openAuctionArgs2.newPrices[0], {
      low: bn("9.9e17"), // DAI (nanoUSD)
      high: bn("1.01e18"),
    });
    assertPricesEqual(openAuctionArgs2.newPrices[1], {
      low: bn("9.9e29"), // USDT (nanoUSD)
      high: bn("1.01e30"),
    });
  });

  it("Step 3: Auction for Trading to Completion (progression >= finalStageAt)", () => {
    // Folio: 0 USDC, 0.48 DAI (whole), 0.52 USDT (whole). shareValue = 1.
    // DAI: exp=0.5, actual=0.48, inBU=0.48. USDT: exp=0.5, actual=0.52, inBU=0.5.
    // progression = (0.48+0.5)/1 = 0.98. initialProgression = 0.
    // relativeProgression = (0.98 - 0) / (1-0) = 0.98.
    // finalStageAt = 0.95. threshold = 0.95 - 0.02 = 0.93. 0.98 < 0.93 is FALSE.
    const _folio3 = [bn("0"), bn("4.8e17"), bn("5.2e5")]; // Corresponds to 0.48 DAI, 0.52 USDT, total value $1
    const currentMarketPrices3 = [1, 1, 1];
    const mockRebalance3: Rebalance = {
      ...mockRebalanceBase,
      priceControl: PriceControl.PARTIAL,
    };

    const [openAuctionArgs3] = getOpenAuction(
      mockRebalance3,
      supply,
      _folioUSDCStart, // _initialFolio
      targetBasketUSDCtoDAIUST,
      _folio3, // current _folio
      decimals,
      currentMarketPrices3,
      auctionPriceErrorSmall,
      finalStageAtForTest,
    );

    // Expected: buyTarget=1. idealSpotLimit=1. limitDelta=0.
    // newLimits pre-clamp: low=1e18, spot=1e18, high=1e18.
    // Clamped by initialLimitsTracking (9.09e17,1e18,1.1e18) -> no change.
    // Progression (0.98) >= finalStageAt-0.02 (0.93). So rebalanceTarget=1, delta=0.
    assertRebalanceLimitsEqual(openAuctionArgs3.newLimits, {
      low: bn("1e18"),
      spot: bn("1e18"),
      high: bn("1e18"),
    });
    assert.deepEqual(openAuctionArgs3.tokens, ["DAI", "USDT"]);
    assert.deepEqual(openAuctionArgs3.newWeights, [
      { low: bn("5e26"), spot: bn("5e26"), high: bn("5e26") },
      { low: bn("5e14"), spot: bn("5e14"), high: bn("5e14") },
    ]);
    // Prices same as step 1 if market prices didn't change
    assertPricesEqual(openAuctionArgs3.newPrices[0], {
      low: bn("9.9e17"), // DAI (nanoUSD)
      high: bn("1.01e18"),
    });
    assertPricesEqual(openAuctionArgs3.newPrices[1], {
      low: bn("9.9e29"), // USDT (nanoUSD)
      high: bn("1.01e30"),
    });
  });
});

describe("Hybrid Rebalance Scenario (Manually Constructed Rebalance Object)", () => {
  const supply = bn("1e21");
  const tokens = ["USDC", "DAI", "USDT"];
  const decimals = [bn("6"), bn("18"), bn("6")];
  const auctionPriceErrorSmall = [0.01, 0.01, 0.01];
  const finalStageAtForTest = 0.95;
  const targetBasketHybrid = [bn("0"), bn("5e17"), bn("5e17")]; // Target: 0% USDC, 50% DAI, 50% USDT
  const _initialFolioHybridStart = [bn("1e6"), bn("0"), bn("0")];

  const hybridWeights: WeightRange[] = [
    { low: bn("0"), spot: bn("0"), high: bn("0") },
    { low: bn("4.5e26"), spot: bn("5e26"), high: bn("5.55556e26") },
    { low: bn("4.5e14"), spot: bn("5e14"), high: bn("5.55556e14") },
  ];
  const hybridInitialPrices: PriceRange[] = [
    { low: bn("9e29"), high: bn("1.11111e30") }, // nanoUSD
    { low: bn("9e17"), high: bn("1.11111e18") }, // nanoUSD
    { low: bn("9e29"), high: bn("1.11111e30") }, // nanoUSD
  ];
  const hybridLimits_veryWide: RebalanceLimits = {
    low: bn("1"),
    spot: bn("1e18"),
    high: bn("1e36"),
  };
  const mockRebalanceHybridBase: Omit<Rebalance, "priceControl"> = {
    nonce: 3n,
    tokens: tokens,
    weights: hybridWeights,
    initialPrices: hybridInitialPrices,
    limits: hybridLimits_veryWide,
    inRebalance: tokens.map(() => true),
    startedAt: 0n,
    restrictedUntil: 0n,
    availableUntil: 0n,
  };
  const currentMarketPrices_Hybrid = [1, 1, 1]; // Defined for this scope

  const defaultPricesHybridScope: PriceRange[] = [
    { low: bn("9.9e29"), high: bn("1.01e30") }, // USDC (nanoUSD)
    { low: bn("9.9e17"), high: bn("1.01e18") }, // DAI (nanoUSD)
    { low: bn("9.9e29"), high: bn("1.01e30") }, // USDT (nanoUSD)
  ];

  it("Hybrid Scenario 1: Mid-Rebalance (progression < finalStageAt)", () => {
    const _folio = [bn("0"), bn("3e17"), bn("7e5")]; // Current folio: 0 USDC, 0.3 DAI val, 0.7 USDT val
    const mockRebalanceHybrid: Rebalance = {
      ...mockRebalanceHybridBase,
      priceControl: PriceControl.PARTIAL,
    };
    const [openAuctionArgs] = getOpenAuction(
      mockRebalanceHybrid,
      supply,
      _initialFolioHybridStart,
      targetBasketHybrid,
      _folio,
      decimals,
      currentMarketPrices_Hybrid,
      auctionPriceErrorSmall,
      finalStageAtForTest,
    );
    // Expected: initialProgression=0, progression=0.8, relativeProgression=0.8
    // rebalanceTarget = 0 + (1-0)*0.95 = 0.95. delta = 0.05.
    // newLimits.low = 1 * (1-0.05) = 0.95e18. Clamped by hybridLimits_veryWide (1) -> 0.95e18.
    // newLimits.high = 1 * (1+0.05) = 1.05e18. Clamped by hybridLimits_veryWide (1e36) -> 1.05e18.
    assertRebalanceLimitsEqual(openAuctionArgs.newLimits, {
      low: bn("950000000000000000"),
      spot: bn("1e18"),
      high: bn("1050000000000000000"),
    });
    assert.deepEqual(openAuctionArgs.tokens, ["DAI", "USDT"]);
    assert.deepEqual(openAuctionArgs.newWeights, [
      { low: bn("5e26"), spot: bn("5e26"), high: bn("5e26") },
      { low: bn("5e14"), spot: bn("5e14"), high: bn("5e14") },
    ]);
    assertPricesEqual(openAuctionArgs.newPrices[0], defaultPricesHybridScope[1]);
    assertPricesEqual(openAuctionArgs.newPrices[1], defaultPricesHybridScope[2]);
  });

  it("Hybrid Scenario 2: Near Completion (progression >= finalStageAt)", () => {
    const _folio = [bn("0"), bn("4.8e17"), bn("5.2e5")]; // Current folio: 0 USDC, 0.48 DAI val, 0.52 USDT val
    const mockRebalanceHybrid: Rebalance = {
      ...mockRebalanceHybridBase,
      priceControl: PriceControl.PARTIAL,
    };
    const [openAuctionArgs] = getOpenAuction(
      mockRebalanceHybrid,
      supply,
      _initialFolioHybridStart,
      targetBasketHybrid,
      _folio,
      decimals,
      currentMarketPrices_Hybrid,
      auctionPriceErrorSmall,
      finalStageAtForTest,
    );
    // Expected: initialProgression=0, progression=0.98, relativeProgression=0.98
    // 0.98 is not < (0.95-0.02=0.93). So, FINAL round. rebalanceTarget=1. delta=0.
    assertRebalanceLimitsEqual(openAuctionArgs.newLimits, {
      low: bn("1e18"),
      spot: bn("1e18"),
      high: bn("1e18"),
    });
    assert.deepEqual(openAuctionArgs.tokens, ["DAI", "USDT"]);
    assert.deepEqual(openAuctionArgs.newWeights, [
      { low: bn("5e26"), spot: bn("5e26"), high: bn("5e26") },
      { low: bn("5e14"), spot: bn("5e14"), high: bn("5e14") },
    ]);
    assertPricesEqual(openAuctionArgs.newPrices[0], defaultPricesHybridScope[1]);
    assertPricesEqual(openAuctionArgs.newPrices[1], defaultPricesHybridScope[2]);
  });

  it("Hybrid Scenario 3: Custom finalStageAt (0.8) - Round 1 & Round 2", () => {
    const finalStageAtCustom = 0.8;
    const mockRebalanceHybridCustom: Rebalance = {
      ...mockRebalanceHybridBase,
      priceControl: PriceControl.PARTIAL,
    };
    // Round 1
    const _folioRound1 = [bn("0"), bn("2e17"), bn("8e5")]; // Current: 0 USDC, 0.2 DAI val, 0.8 USDT val
    const [openAuctionArgsCustomRound1] = getOpenAuction(
      mockRebalanceHybridCustom,
      supply,
      _initialFolioHybridStart, // Use true initial folio
      targetBasketHybrid,
      _folioRound1,
      decimals,
      currentMarketPrices_Hybrid,
      auctionPriceErrorSmall,
      finalStageAtCustom,
    );
    // Expected: initialProgression=0, progression=0.7 (USDC=0, DAI=0.2, USDT=0.5 for target), relativeProgression=0.7
    // 0.7 < (0.8-0.02=0.78). PROGRESS round.
    // rebalanceTarget = 0 + (1-0)*0.8 = 0.8. delta = 0.2.
    // newLimits.low = 1 * (1-0.2) = 0.8e18. Clamped by hybridLimits_veryWide (1) -> 0.8e18
    // newLimits.high = 1 * (1+0.2) = 1.2e18. Clamped by hybridLimits_veryWide (1e36) -> 1.2e18
    assertRebalanceLimitsEqual(openAuctionArgsCustomRound1.newLimits, {
      low: bn("0.8e18"),
      spot: bn("1e18"),
      high: bn("1.2e18"),
    });
    assert.deepEqual(openAuctionArgsCustomRound1.tokens, ["DAI", "USDT"]);
    assert.deepEqual(openAuctionArgsCustomRound1.newWeights, [
      { low: bn("5e26"), spot: bn("5e26"), high: bn("5e26") },
      { low: bn("5e14"), spot: bn("5e14"), high: bn("5e14") },
    ]);
    assertPricesEqual(openAuctionArgsCustomRound1.newPrices[0], defaultPricesHybridScope[1]);
    assertPricesEqual(openAuctionArgsCustomRound1.newPrices[1], defaultPricesHybridScope[2]);

    // Round 2
    const _folioRound2 = [bn("0"), bn("4e17"), bn("6e5")]; // Current: 0 USDC, 0.4 DAI val, 0.6 USDT val
    const [openAuctionArgsCustomRound2] = getOpenAuction(
      mockRebalanceHybridCustom,
      supply,
      _initialFolioHybridStart,
      targetBasketHybrid,
      _folioRound2,
      decimals,
      currentMarketPrices_Hybrid,
      auctionPriceErrorSmall,
      finalStageAtCustom,
    );
    // Expected: initialProgression=0, progression=0.9 (USDC=0, DAI=0.4, USDT=0.5 for target), relativeProgression=0.9
    // 0.9 is not < (0.8-0.02=0.78). FINAL round.
    // rebalanceTarget=1. delta=0.
    assertRebalanceLimitsEqual(openAuctionArgsCustomRound2.newLimits, {
      low: bn("1e18"),
      spot: bn("1e18"),
      high: bn("1e18"),
    });
    assert.deepEqual(openAuctionArgsCustomRound2.tokens, ["DAI", "USDT"]);
    assert.deepEqual(openAuctionArgsCustomRound2.newWeights, [
      { low: bn("5e26"), spot: bn("5e26"), high: bn("5e26") },
      { low: bn("5e14"), spot: bn("5e14"), high: bn("5e14") },
    ]);
    assertPricesEqual(openAuctionArgsCustomRound2.newPrices[0], defaultPricesHybridScope[1]);
    assertPricesEqual(openAuctionArgsCustomRound2.newPrices[1], defaultPricesHybridScope[2]);
  });

  it("Hybrid Scenario 4: Delta split between Limits and Weights", () => {
    const _folioForS4 = [bn("0"), bn("2e17"), bn("8e5")]; // 0 USDC, 0.2 DAI val, 0.8 USDT val; shareVal=1.0
    const scenario4Limits: RebalanceLimits = {
      low: bn("0.98e18"),
      spot: bn("1e18"),
      high: bn("1.02e18"),
    };
    const mockRebalanceHybrid4: Rebalance = {
      ...mockRebalanceHybridBase,
      nonce: 4n,
      limits: scenario4Limits,
      priceControl: PriceControl.PARTIAL,
    };
    const [openAuctionArgs] = getOpenAuction(
      mockRebalanceHybrid4,
      supply,
      _initialFolioHybridStart,
      targetBasketHybrid,
      _folioForS4,
      decimals,
      currentMarketPrices_Hybrid,
      auctionPriceErrorSmall,
      finalStageAtForTest, // 0.95
    );
    // Expected: initialProgression=0, progression=0.7, relativeProgression=0.7
    // 0.7 < (0.95-0.02=0.93). PROGRESS round.
    // rebalanceTarget = 0 + (1-0)*0.95 = 0.95. delta = 0.05.
    // newLimits.low before clamp = 1 * (1-0.05) = 0.95e18.
    // newLimits.high before clamp = 1 * (1+0.05) = 1.05e18.
    assertRebalanceLimitsEqual(openAuctionArgs.newLimits, {
      low: bn("980000000000000000"),
      spot: bn("1e18"),
      high: bn("1020000000000000000"),
    });
    assert.equal(openAuctionArgs.tokens.length, 2); // Only DAI and USDT
    assert.deepEqual(openAuctionArgs.tokens, ["DAI", "USDT"]);
    assertPricesEqual(openAuctionArgs.newPrices[0], defaultPricesHybridScope[1]); // DAI price
    assertPricesEqual(openAuctionArgs.newPrices[1], defaultPricesHybridScope[2]); // USDT price

    // Weights will also be affected by the actual newLimits (which are scenario4Limits)
    // and the delta (0.05)
    assert.equal(openAuctionArgs.newWeights.length, 2); // Only DAI and USDT have deficits
    // With delta=0.05 and limited newLimits affecting weight calculations
    // The weights need to account for the constrained limits
    assertRangesEqual(openAuctionArgs.newWeights[0], {
      low: bn("484693877551020408163265306"), // Actual calculated value accounting for limit constraints
      spot: bn("500000000000000000000000000"),
      high: bn("514705882352941176470588235"), // Actual calculated value
    });
    assertRangesEqual(openAuctionArgs.newWeights[1], {
      low: bn("484693877551020"), // Actual calculated value
      spot: bn("500000000000000"),
      high: bn("514705882352941"), // Actual calculated value
    });
  });

  it("Hybrid Scenario 5: Already Balanced Folio (rebalanceTarget=1, delta=0)", () => {
    const _folioAlreadyBalancedAndShareValue1 = [bn("0"), bn("5e17"), bn("5e5")];
    const mockRebalanceHybrid5: Rebalance = {
      ...mockRebalanceHybridBase,
      nonce: 5n,
      priceControl: PriceControl.PARTIAL,
    };
    const [openAuctionArgs] = getOpenAuction(
      mockRebalanceHybrid5,
      supply,
      _initialFolioHybridStart,
      targetBasketHybrid,
      _folioAlreadyBalancedAndShareValue1,
      decimals,
      currentMarketPrices_Hybrid,
      auctionPriceErrorSmall,
      finalStageAtForTest,
    );
    // Expected: initialProgression=0. progression=1 (as current folio is target). relativeProgression=1.
    // Falls to FINAL round. rebalanceTarget=1. delta=0.
    assertRebalanceLimitsEqual(openAuctionArgs.newLimits, {
      low: bn("1e18"),
      spot: bn("1e18"),
      high: bn("1e18"),
    });

    // Already balanced folio has no surpluses/deficits, so no tokens are returned
    assert.equal(openAuctionArgs.tokens.length, 0);
    assert.equal(openAuctionArgs.newWeights.length, 0);
    assert.equal(openAuctionArgs.newPrices.length, 0);
  });
});

describe("Price Edge Cases in getOpenAuction", () => {
  const supply = bn("1e21");
  const tokens = ["USDC", "DAI"];
  const decimals = [bn("6"), bn("18")];
  const auctionPriceErrorSmall = [0.01, 0.01];
  const targetBasketSimple = [bn("5e17"), bn("5e17")]; // 50% USDC, 50% DAI
  const folioSimple = [bn("5e5"), bn("5e17")]; // Example folio, value $1

  it('should throw "spot price out of bounds!" when market price is outside initial price bounds', () => {
    // Set up narrow initial price bounds that are below the market price
    const initialPricesNarrowUSDC: PriceRange[] = [
      { low: bn("8e29"), high: bn("8.5e29") }, // USDC: Range 0.8 - 0.85 USD in nanoUSD
      { low: bn("9e17"), high: bn("1.11111e18") }, // DAI: Normal range (nanoUSD)
    ];

    const mockRebalanceEdge: Rebalance = {
      nonce: 4n,
      tokens: tokens,
      weights: [
        { low: bn("4.5e14"), spot: bn("5e14"), high: bn("5.5e14") },
        { low: bn("4.5e26"), spot: bn("5e26"), high: bn("5.5e26") },
      ],
      initialPrices: initialPricesNarrowUSDC,
      inRebalance: tokens.map(() => true),
      limits: { low: bn("1"), spot: bn("1e18"), high: bn("1e36") }, // Wide limits
      startedAt: 0n,
      restrictedUntil: 0n,
      availableUntil: 0n,
      priceControl: PriceControl.PARTIAL,
    };

    // Market price is $1.0, but initial bounds are only 0.8-0.85
    // spotPrice = 1.0 * 1e9 * 1e27 / 1e6 = 1e30
    // initialPrice.high = 8.5e29
    // Since 1e30 > 8.5e29, this triggers "spot price out of bounds!"
    const currentMarketPrices = [1.0, 1.0]; // USDC at $1.0 is above the 0.8-0.85 range

    assert.throws(
      () => {
        getOpenAuction(
          mockRebalanceEdge,
          supply,
          folioSimple, // _initialFolio
          targetBasketSimple,
          folioSimple, // current _folio
          decimals,
          currentMarketPrices,
          auctionPriceErrorSmall,
          0.95,
        );
      },
      {
        message: /spot price .* out of bounds .* auction launcher MUST closeRebalance to prevent loss!/,
      },
    );
  });

  it('should throw "no price range" when price clamping results in identical low and high prices', () => {
    // Set up initial price bounds where low == high (degenerate range)
    const initialPricesSameValue: PriceRange[] = [
      { low: bn("1e30"), high: bn("1e30") }, // USDC: Exactly $1.0 in nanoUSD (no range)
      { low: bn("9e17"), high: bn("1.11111e18") }, // DAI: Normal range (nanoUSD)
    ];

    const mockRebalanceEdge: Rebalance = {
      nonce: 5n,
      tokens: tokens,
      weights: [
        { low: bn("4.5e14"), spot: bn("5e14"), high: bn("5.5e14") },
        { low: bn("4.5e26"), spot: bn("5e26"), high: bn("5.5e26") },
      ],
      initialPrices: initialPricesSameValue,
      inRebalance: tokens.map(() => true),
      limits: { low: bn("1"), spot: bn("1e18"), high: bn("1e36") }, // Wide limits
      startedAt: 0n,
      restrictedUntil: 0n,
      availableUntil: 0n,
      priceControl: PriceControl.PARTIAL,
    };

    // Market price is $1.0, which matches the initial price bounds exactly
    // spotPrice = 1.0 * 1e9 * 1e27 / 1e6 = 1e30 == initialPrice.low == initialPrice.high ✓
    // But when we calculate pricesD27 with price error:
    // pricesD27.low = 1.0 * 0.99 * 1e9 * 1e27 / 1e6 = 9.9e29, gets clamped to 1e30
    // pricesD27.high = 1.0 / 0.99 * 1e9 * 1e27 / 1e6 ≈ 1.0101e30, gets clamped to 1e30
    // Result: pricesD27.low == pricesD27.high == 1e30, triggering "no price range"
    const currentMarketPrices = [1.0, 1.0];

    assert.throws(
      () => {
        getOpenAuction(
          mockRebalanceEdge,
          supply,
          folioSimple, // _initialFolio
          targetBasketSimple,
          folioSimple, // current _folio
          decimals,
          currentMarketPrices,
          auctionPriceErrorSmall,
          0.95,
        );
      },
      {
        message: "no price range",
      },
    );
  });
});
