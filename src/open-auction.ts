import { Decimal } from "./utils";
import type { Decimal as DecimalType } from "decimal.js-light";

import { bn, D9d, D18d, D27d, ONE, ZERO } from "./numbers";

import { PriceControl, PriceRange, Rebalance, RebalanceLimits, WeightRange } from "./types";

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
 * @param surplusTokens The list of tokens in surplus
 * @param deficitTokens The list of tokens in deficit
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
  deficitTokens: string[];
}

// All the args needed to call `folio.openAuction()`
export interface OpenAuctionArgs {
  rebalanceNonce: bigint;
  tokens: string[];
  newWeights: WeightRange[];
  newPrices: PriceRange[];
  newLimits: RebalanceLimits;
}

/**
 * Generator for the `targetBasket` parameter
 *
 * Depending on the usecase, pass either:
 * - TRACKING: CURRENT prices
 * - NATIVE: HISTORICAL prices
 *
 * @param _initialWeights D27{tok/BU} The initial historical weights emitted in the RebalanceStarted event
 * @param _prices {USD/wholeTok} either CURRENT or HISTORICAL prices
 * @returns D18{1} The target basket
 */
export const getTargetBasket = (_initialWeights: WeightRange[], _prices: number[], _decimals: bigint[]): bigint[] => {
  console.log("getTargetBasket", _initialWeights, _prices, _decimals);

  if (_initialWeights.length != _prices.length) {
    throw new Error("length mismatch");
  }

  const vals = _initialWeights.map((initialWeight: WeightRange, i: number) => {
    if (_prices[i] <= 0) {
      throw new Error(`missing price for token index ${i}`);
    }

    const price = new Decimal(_prices[i]);
    const decimalScale = new Decimal(`1e${_decimals[i]}`);

    // {USD/wholeBU} = D27{tok/BU} * {BU/wholeBU} / {tok/wholeTok} / D27 * {USD/wholeTok}
    return new Decimal(initialWeight.spot.toString()).div(decimalScale).mul(price).div(D9d);
  });

  const totalValue = vals.reduce((a, b) => a.add(b));

  // D18{1} = {USD/wholeBU} / {USD/wholeBU} * D18
  return vals.map((val) => bn(val.div(totalValue).mul(D18d)));
};

/**
 * Get the values needed to call `folio.openAuction()` as the AUCTION_LAUNCHER
 *
 * Non-AUCTION_LAUNCHERs should use `folio.openAuctionUnrestricted()`
 *
 * @param rebalance The result of calling folio.getRebalance(), today
 * @param _supply {share} The totalSupply() of the basket, today
 * @param _initialFolio D18{tok/share} Initial balances per share, e.g result of folio.toAssets(1e18, 0) at time rebalance was first proposed
 * @param _targetBasket D18{1} Result of calling `getTargetBasket()`
 * @param _folio D18{tok/share} Current ratio of token per share, e.g result of folio.toAssets(1e18, 0), today
 * @param _decimals Decimals of each token
 * @param _prices {USD/wholeTok} USD prices for each *whole* token, today
 * @param _priceError {1} Price error to use for each token during auction pricing; should be smaller than price error during startRebalance
 * @param _finalStageAt {1} The % rebalanced from the initial Folio to determine when is the final stage of the rebalance
 */
export const getOpenAuction = (
  rebalance: Rebalance,
  _supply: bigint,
  _initialFolio: bigint[] = [],
  _targetBasket: bigint[] = [],
  _folio: bigint[],
  _decimals: bigint[],
  _prices: number[],
  _priceError: number[],
  _finalStageAt: number,
  debug?: boolean,
): [OpenAuctionArgs, AuctionMetrics] => {
  if (debug === undefined) {
    debug = true;
  }

  if (debug) {
    console.log(
      "getOpenAuction",
      rebalance,
      _supply,
      _initialFolio,
      _targetBasket,
      _folio,
      _decimals,
      _prices,
      _priceError,
      _finalStageAt,
    );
  }

  if (
    rebalance.tokens.length != _targetBasket.length ||
    _targetBasket.length != _folio.length ||
    _folio.length != _decimals.length ||
    _decimals.length != _prices.length ||
    _prices.length != _priceError.length
  ) {
    throw new Error("length mismatch");
  }

  if (_finalStageAt > 1) {
    throw new Error("finalStageAt must be less than 1");
  }

  // ================================================================

  // {wholeShare} = {share} / {share/wholeShare}
  const supply = new Decimal(_supply.toString()).div(D18d);

  // {1} = D18{1} / D18
  const targetBasket = _targetBasket.map((a) => new Decimal(a.toString()).div(D18d));

  // {USD/wholeTok}
  const prices = _prices.map((a) => new Decimal(a));
  for (let i = 0; i < prices.length; i++) {
    if (prices[i].lte(ZERO)) {
      throw new Error(`missing price for token ${rebalance.tokens[i]}`);
    }
  }

  // {1}
  const priceError = _priceError.map((a) => new Decimal(a.toString()));

  // {tok/wholeTok}
  const decimalScale = _decimals.map((a) => new Decimal(`1e${a}`));

  // {wholeTok/wholeShare} = D18{tok/share} * {share/wholeShare} / {tok/wholeTok} / D18
  const initialFolio = _initialFolio.map((c: bigint, i: number) => new Decimal(c.toString()).div(decimalScale[i]));

  // {wholeTok/wholeShare} = D18{tok/share} * {share/wholeShare} / {tok/wholeTok} / D18
  const folio = _folio.map((c: bigint, i: number) => new Decimal(c.toString()).div(decimalScale[i]));

  // {wholeTok/wholeBU} = D27{tok/BU} * {BU/wholeBU} / {tok/wholeTok} / D27
  let weightRanges = rebalance.weights.map((range: WeightRange, i: number) => {
    return {
      low: new Decimal(range.low.toString()).div(decimalScale[i]).div(D9d),
      spot: new Decimal(range.spot.toString()).div(decimalScale[i]).div(D9d),
      high: new Decimal(range.high.toString()).div(decimalScale[i]).div(D9d),
    };
  });

  const finalStageAt = new Decimal(_finalStageAt.toString());

  // ================================================================

  // calculate ideal spot limit, the actual BU<->share ratio

  // {USD/wholeShare} = {wholeTok/wholeShare} * {USD/wholeTok}
  const shareValue = folio
    .map((f: DecimalType, i: number) => {
      if (!rebalance.inRebalance[i]) {
        return ZERO;
      }

      return f.mul(prices[i]);
    })
    .reduce((a, b) => a.add(b));

  // {USD/wholeBU} = {wholeTok/wholeBU} * {USD/wholeTok}
  const buValue = weightRanges
    .map((weightRange, i) => {
      if (!rebalance.inRebalance[i]) {
        return ZERO;
      }

      return weightRange.spot.mul(prices[i]);
    })
    .reduce((a, b) => a.add(b));

  const buPriceChange = buValue.sub(shareValue).div(shareValue);
  console.log(`      🧺  ${buPriceChange.mul(100).toFixed(2)}% basket price difference`);

  if (debug) {
    console.log("shareValue", shareValue.toString());
    console.log("buValue", buValue.toString());
  }

  if (buValue.div(shareValue).gt(10) || shareValue.div(buValue).gt(10)) {
    throw new Error("buValue and shareValue are too different, something probably went wrong");
  }

  // ================================================================

  // calculate portionBeingEjected

  const ejectionIndices: number[] = [];
  for (let i = 0; i < rebalance.weights.length; i++) {
    if (rebalance.inRebalance[i] && rebalance.weights[i].spot == 0n) {
      ejectionIndices.push(i);
    }
  }

  // {1} = {wholeTok/wholeShare} * {USD/wholeTok} / {USD/wholeShare}
  const portionBeingEjected = ejectionIndices
    .map((i) => {
      return folio[i].mul(prices[i]);
    })
    .reduce((a, b) => a.add(b), ZERO)
    .div(shareValue);

  // ================================================================

  // calculate progressions

  // {wholeBU/wholeShare} = D18{BU/share} / D18
  const prevSpotLimit = new Decimal(rebalance.limits.spot.toString()).div(D18d);

  // {wholeTok/wholeShare} = {wholeTok/wholeBU} * {wholeBU/wholeShare}
  const expectedBalances = weightRanges.map((weightRange) => weightRange.spot.mul(prevSpotLimit));

  // {1} = {USD/wholeShare} / {USD/wholeShare}
  let progression = folio
    .map((actualBalance, i) => {
      if (!rebalance.inRebalance[i]) {
        return ZERO;
      }

      // {wholeTok/wholeShare}
      const balanceInBasket = expectedBalances[i].gt(actualBalance) ? actualBalance : expectedBalances[i];

      // {USD/wholeShare} = {wholeTok/wholeShare} * {USD/wholeTok}
      return balanceInBasket.mul(prices[i]);
    })
    .reduce((a, b) => a.add(b))
    .div(shareValue);

  // {1} = {USD/wholeShare} / {USD/wholeShare}
  const initialProgression = initialFolio
    .map((initialBalance, i) => {
      if (!rebalance.inRebalance[i]) {
        return ZERO;
      }

      // {wholeTok/wholeShare}
      const balanceInBasket = expectedBalances[i].gt(initialBalance) ? initialBalance : expectedBalances[i];

      // {USD/wholeShare} = {wholeTok/wholeShare} * {USD/wholeTok}
      return balanceInBasket.mul(prices[i]);
    })
    .reduce((a, b) => a.add(b))
    .div(shareValue);

  if (progression < initialProgression) {
    if (debug) {
      console.log("progression < initialProgression", progression.toString(), initialProgression.toString());
    }
    progression = initialProgression; // don't go backwards, should only happen due to negligible rounding errors
  }

  // {1} = {1} / {1}
  let relativeProgression = initialProgression.eq(ONE)
    ? ONE
    : progression.sub(initialProgression).div(ONE.sub(initialProgression));

  let rebalanceTarget = ONE;
  let round: AuctionRound = AuctionRound.FINAL;

  if (debug) {
    console.log("initialProgression", initialProgression.toString());
    console.log("progression", progression.toString());
    console.log("relativeProgression", relativeProgression.toString());
    console.log("portionBeingEjected", portionBeingEjected.toString());
    console.log("finalStageAt", finalStageAt.toString());
  }

  // approach finalStageAt first
  if (progression.lt(0.99) && relativeProgression.lt(finalStageAt.sub(0.02))) {
    round = AuctionRound.PROGRESS;

    rebalanceTarget = initialProgression.add(ONE.sub(initialProgression).mul(finalStageAt));

    if (rebalanceTarget.gte(0.997)) {
      rebalanceTarget = ONE;
    }

    if (rebalanceTarget.eq(ONE)) {
      round = AuctionRound.FINAL;
    }
  }

  // EJECT
  if (portionBeingEjected.gt(0)) {
    round = AuctionRound.EJECT;

    // if the ejections are everything that's left, keep the finalStageAt targeting from above
    if (progression.add(portionBeingEjected).lt(ONE)) {
      // else: get rid of all the dust
      let ejectionTarget = progression.add(portionBeingEjected.mul(1.05)); // buy 5% extra
      if (ejectionTarget.gt(ONE)) {
        ejectionTarget = ONE;
      }

      if (ejectionTarget.gt(rebalanceTarget)) {
        rebalanceTarget = ejectionTarget;
      }
    }
  }

  if (rebalanceTarget.lte(ZERO) || rebalanceTarget.lt(initialProgression) || rebalanceTarget.gt(ONE)) {
    throw new Error("something has gone very wrong");
  }

  const relativeTarget = rebalanceTarget.sub(initialProgression).div(ONE.sub(initialProgression));

  if (debug) {
    console.log("round", round);
    console.log("rebalanceTarget", rebalanceTarget.toString());
    console.log("relativeTarget", relativeTarget.toString());
  }

  // {1}
  const delta = ONE.sub(rebalanceTarget);

  // ================================================================

  // get new limits, constrained by extremes

  // {wholeBU/wholeShare} = {USD/wholeShare} / {USD/wholeBU}
  const spotLimit = shareValue.div(buValue);

  // D18{BU/share} = {wholeBU/wholeShare} * D18 * {1}
  const newLimits = {
    low: bn(spotLimit.sub(spotLimit.mul(delta)).mul(D18d)),
    spot: bn(spotLimit.mul(D18d)),
    high: bn(spotLimit.add(spotLimit.mul(delta)).mul(D18d)),
  };

  // hold some surpluses aside if ejecting
  if (round == AuctionRound.EJECT) {
    newLimits.high += newLimits.high / 10n;
  }

  // low
  if (newLimits.low < rebalance.limits.low) {
    newLimits.low = rebalance.limits.low;
  }
  if (newLimits.low > rebalance.limits.high) {
    newLimits.low = rebalance.limits.high;
  }

  // spot
  if (newLimits.spot < rebalance.limits.low) {
    newLimits.spot = rebalance.limits.low;
  }
  if (newLimits.spot > rebalance.limits.high) {
    newLimits.spot = rebalance.limits.high;
  }

  // high
  if (newLimits.high < rebalance.limits.low) {
    newLimits.high = rebalance.limits.low;
  }
  if (newLimits.high > rebalance.limits.high) {
    newLimits.high = rebalance.limits.high;
  }

  if (debug) {
    console.log("newLimits", newLimits);
  }

  // ================================================================

  // get new weights, constrained by extremes

  // {wholeBU/wholeShare} = D18{BU/share} / D18
  const actualLimits = {
    low: new Decimal(newLimits.low.toString()).div(D18d),
    spot: new Decimal(newLimits.spot.toString()).div(D18d),
    high: new Decimal(newLimits.high.toString()).div(D18d),
  };

  // D27{tok/BU}
  const newWeights = rebalance.weights.map((weightRange, i) => {
    // {wholeTok/wholeBU} = {USD/wholeShare} * {1} / {wholeBU/wholeShare} / {USD/wholeTok}
    const idealWeight = shareValue.mul(targetBasket[i]).div(actualLimits.spot).div(prices[i]);

    // D27{tok/BU} = {wholeTok/wholeBU} * D27 * {tok/wholeTok} / {BU/wholeBU}
    const newWeightsD27 = {
      low: bn(
        idealWeight
          .mul(rebalanceTarget.div(actualLimits.low.div(actualLimits.spot))) // add remaining delta into weight
          .mul(D9d)
          .mul(decimalScale[i]),
      ),
      spot: bn(idealWeight.mul(D9d).mul(decimalScale[i])),
      high: bn(
        idealWeight
          .mul(ONE.add(delta).div(actualLimits.high.div(actualLimits.spot))) // add remaining delta into weight
          .mul(D9d)
          .mul(decimalScale[i]),
      ),
    };

    // hold some surpluses aside if ejecting
    if (round == AuctionRound.EJECT) {
      newWeightsD27.high += newWeightsD27.high / 10n;
    }

    if (newWeightsD27.low < weightRange.low) {
      newWeightsD27.low = weightRange.low;
    } else if (newWeightsD27.low > weightRange.high) {
      newWeightsD27.low = weightRange.high;
    }

    if (newWeightsD27.spot < weightRange.low) {
      newWeightsD27.spot = weightRange.low;
    } else if (newWeightsD27.spot > weightRange.high) {
      newWeightsD27.spot = weightRange.high;
    }

    if (newWeightsD27.high < weightRange.low) {
      newWeightsD27.high = weightRange.low;
    } else if (newWeightsD27.high > weightRange.high) {
      newWeightsD27.high = weightRange.high;
    }

    return newWeightsD27;
  });

  if (debug) {
    console.log("newWeights", newWeights);
  }

  // ================================================================

  // get new prices, constrained by extremes

  // D27{USD/tok}
  const newPrices = rebalance.initialPrices.map((initialPrice, i) => {
    // revert if price out of bounds
    const spotPrice = bn(prices[i].div(decimalScale[i]).mul(D27d));
    if (spotPrice < initialPrice.low || spotPrice > initialPrice.high) {
      throw new Error(
        `spot price ${spotPrice.toString()} out of bounds relative to initial range [${initialPrice.low.toString()}, ${initialPrice.high.toString()}]! auction launcher MUST closeRebalance to prevent loss!`,
      );
    }

    if (rebalance.priceControl == PriceControl.NONE) {
      return initialPrice;
    }

    // D27{USD/tok} = {USD/wholeTok} * D27 / {tok/wholeTok}
    const pricesD27 = {
      low: bn(prices[i].mul(ONE.sub(priceError[i])).div(decimalScale[i]).mul(D27d)),
      high: bn(prices[i].div(ONE.sub(priceError[i])).div(decimalScale[i]).mul(D27d)),
    };

    // low
    if (pricesD27.low < initialPrice.low) {
      pricesD27.low = initialPrice.low;
    }
    if (pricesD27.low > initialPrice.high) {
      pricesD27.low = initialPrice.high;
    }

    // high
    if (pricesD27.high < initialPrice.low) {
      pricesD27.high = initialPrice.low;
    }
    if (pricesD27.high > initialPrice.high) {
      pricesD27.high = initialPrice.high;
    }

    if (pricesD27.low == pricesD27.high && priceError[i].gt(ZERO)) {
      throw new Error("no price range");
    }

    return pricesD27;
  });

  if (debug) {
    console.log("newPrices", newPrices);
  }

  // ================================================================

  // calculate metrics

  const surplusTokens: string[] = [];
  const deficitTokens: string[] = [];

  // update Decimal weightRanges
  // {wholeTok/wholeBU} = D27{tok/BU} * {BU/wholeBU} / {tok/wholeTok} / D27
  weightRanges = newWeights.map((range, i) => {
    return {
      low: new Decimal(range.low.toString()).div(decimalScale[i]).div(D9d),
      spot: new Decimal(range.spot.toString()).div(decimalScale[i]).div(D9d),
      high: new Decimal(range.high.toString()).div(decimalScale[i]).div(D9d),
    };
  });

  // {USD}
  let surplusValue = ZERO;
  let deficitValue = ZERO;

  rebalance.tokens.forEach((token, i) => {
    if (!rebalance.inRebalance[i]) {
      return;
    }

    // {wholeTok/wholeShare} = {wholeTok/wholeBU} * {wholeBU/wholeShare}
    const buyUpTo = weightRanges[i].low.mul(actualLimits.low);
    const sellDownTo = weightRanges[i].high.mul(actualLimits.high);

    if (folio[i].lt(buyUpTo)) {
      // {USD} = {wholeTok/wholeShare} * {USD/wholeTok} * {wholeShare}
      const tokenDeficitValue = buyUpTo.sub(folio[i]).mul(prices[i]).mul(supply);

      // $1 minimum
      if (tokenDeficitValue.gte(ONE)) {
        deficitValue = deficitValue.add(tokenDeficitValue);
        deficitTokens.push(token);
      }
    } else if (folio[i].gt(sellDownTo)) {
      // {USD} = {wholeTok/wholeShare} * {USD/wholeTok} * {wholeShare}
      const tokenSurplusValue = folio[i].sub(sellDownTo).mul(prices[i]).mul(supply);

      // $1 minimum
      if (tokenSurplusValue.gte(ONE)) {
        surplusValue = surplusValue.add(tokenSurplusValue);
        surplusTokens.push(token);
      }
    }
  });

  // {USD}
  const valueBeingTraded = surplusValue.gt(deficitValue) ? deficitValue : surplusValue;

  // // completed if nothing to trade
  // if (valueBeingTraded.eq(ZERO)) {
  //   round = AuctionRound.FINAL;
  //   rebalanceTarget = ONE;
  //   relativeProgression = ONE;
  //   progression = ONE;
  // }
  // // TODO maybe add back

  // ================================================================

  // filter tokens that are not in the rebalance
  const returnTokens = [];
  const returnWeights = [];
  const returnPrices = [];
  for (let i = 0; i < rebalance.tokens.length; i++) {
    if (rebalance.inRebalance[i]) {
      returnTokens.push(rebalance.tokens[i]);
      returnWeights.push(newWeights[i]);
      returnPrices.push(newPrices[i]);
    }
  }

  return [
    {
      rebalanceNonce: rebalance.nonce,
      tokens: returnTokens,
      newWeights: returnWeights,
      newPrices: returnPrices,
      newLimits: newLimits,
    },
    {
      round: round,
      initialProgression: initialProgression.toNumber(),
      absoluteProgression: progression.toNumber(),
      relativeProgression: relativeProgression.toNumber(),
      target: rebalanceTarget.toNumber(),
      relativeTarget: relativeTarget.toNumber(),
      auctionSize: valueBeingTraded.toNumber(),
      surplusTokens: surplusTokens,
      deficitTokens: deficitTokens,
    },
  ];
};
