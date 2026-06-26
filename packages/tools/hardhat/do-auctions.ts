import "@nomicfoundation/hardhat-ethers";
import { HardhatRuntimeEnvironment } from "hardhat/types";
import { time } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { expect } from "chai";
import { Contract } from "ethers";

import { whileImpersonating, toPlainObject, createPriceLookup, logPercentages, mockBasketTokens } from "./utils";
import { bn } from "../../../src/numbers";
import {
  AuctionRound,
  FolioVersion,
  type AuctionMetrics,
  type OpenAuctionArgs,
  type WeightRange,
} from "../../../src/types";
import { getOpenAuction, getTargetBasket } from "../../../src/open-auction";
import type { RebalanceContracts, RebalanceSigners } from "./types";
import {
  getAuctionLengthForVersion,
  getRebalanceForVersion,
  submitOpenAuctionForVersion,
  toRebalanceView,
  type VersionedRebalance,
} from "./versioned-folio";

export async function doAuctions(
  version: FolioVersion,
  hre: HardhatRuntimeEnvironment,
  contracts: RebalanceContracts,
  signers: RebalanceSigners,
  orderedTokens: string[],
  initialSupply: bigint,
  initialAssetsRec: Record<string, bigint>,
  targetBasketRec: Record<string, bigint>,
  rebalancePricesRec: Record<string, { snapshotPrice: number }>,
  finalStageAt: number,
  debug?: boolean,
  auctionPriceDeviation: number = 0.02,
  swapSlippageRange: [number, number] = [0.001, 0.005], // 0.1% to 0.5% default slippage
  tolerance: number = 1e-5,
) {
  const { folio, folioLensTyped } = contracts;
  const { bidder, auctionLauncher } = signers;

  // Get decimals for all tokens
  const allDecimalsRec: Record<string, bigint> = {};
  for (const token of orderedTokens) {
    const tokenContract = await hre.ethers.getContractAt("IERC20Metadata", token);
    allDecimalsRec[token] = await tokenContract.decimals();
  }

  const currentSupply = await folio.totalSupply();

  // Validate all tokens have prices
  for (const token of orderedTokens) {
    const priceKey = token.toLowerCase();

    if (!rebalancePricesRec[priceKey] || !rebalancePricesRec[priceKey].snapshotPrice) {
      throw new Error(
        `Missing price data for token: ${token}\n` +
          `All tokens must have valid price data in rebalancePricesRec before running auctions.`,
      );
    }
  }

  for (const token of orderedTokens) {
    if (!(token in initialAssetsRec)) {
      throw new Error(`Token ${token} from tokens not found in initialAssetsRec`);
    }
    if (!(token in targetBasketRec)) {
      throw new Error(`Token ${token} from tokens not found in targetBasketRec`);
    }
  }
  if (Object.keys(initialAssetsRec).length !== orderedTokens.length) {
    throw new Error("Mismatch between tokens length and initialAssetsRec keys");
  }
  if (Object.keys(targetBasketRec).length !== orderedTokens.length) {
    throw new Error("Mismatch between tokens length and targetBasketRec keys");
  }

  const [weightControl] = await folio.rebalanceControl();

  const targetBasketArray = orderedTokens.map((token) => targetBasketRec[token]);

  if (debug) {
    console.log(
      "Target basket:",
      targetBasketArray.map((w) => w.toString()),
    );
  }

  // Replace tokens with mocks
  const mockedTokensRec = await mockBasketTokens(hre, await folio.getAddress(), orderedTokens);

  // function definitions

  const getBidValue = (bid: any[], pricesRec: Record<string, { snapshotPrice: number }>): number => {
    const sellTokenAddr = bid[0];
    const buyTokenAddr = bid[1];

    const priceLookup = createPriceLookup(pricesRec);
    const sellTokenPrice = priceLookup.getPrice(sellTokenAddr);
    const buyTokenPrice = priceLookup.getPrice(buyTokenAddr);

    const sellValue = (Number(bid[2]) / Number(10n ** (allDecimalsRec[sellTokenAddr] || 18n))) * sellTokenPrice;
    const buyValue = (Number(bid[3]) / Number(10n ** (allDecimalsRec[buyTokenAddr] || 18n))) * buyTokenPrice;
    return buyValue > sellValue ? sellValue : buyValue;
  };

  const doAuction = async (auctionNumber: number): Promise<[OpenAuctionArgs, AuctionMetrics]> => {
    // can have fewer tokens than orderedTokens, because some have been successfully ejected
    const rebalanceState: VersionedRebalance = await getRebalanceForVersion(version, hre, folio);
    const rebalanceView = toRebalanceView(version, rebalanceState);

    const [currentTokens, currentAssets] = await folio.totalAssets();
    const currentValues: Record<string, number> = {};
    let totalCurrentValue = 0;

    // calculate total value of current basket
    const currentBalanceMap: Record<string, bigint> = {};
    currentTokens.forEach((token: string, idx: number) => {
      currentBalanceMap[token] = currentAssets[idx];

      currentValues[token] =
        (rebalancePricesRec[token.toLowerCase()].snapshotPrice * Number(currentAssets[idx])) /
        Number(10n ** allDecimalsRec[token]);

      totalCurrentValue += currentValues[token];
    });

    const currentBasket = orderedTokens.map((token: string) => {
      const val = currentValues[token] || 0;
      const percentage = (val / totalCurrentValue) * 100;
      return percentage === 0 ? "00.00%" : `${percentage.toFixed(2)}%`;
    });

    // log current distribution
    console.log(`\n📊 Auction ${auctionNumber} [${currentBasket.join(", ")}]`);

    expect(rebalanceView.availableUntil).to.be.greaterThan(await time.latest());

    // ==============================

    // About the original start rebalance
    const initialWeights: WeightRange[] = [];
    const initialAssets: bigint[] = [];
    const initialPrices: number[] = [];

    // About the current auction
    const assets: bigint[] = [];
    const decimals: bigint[] = [];
    const deviatedAuctionPrices: number[] = [];

    // Populate auction calldata
    {
      // Build arrays in rebalanceState.tokens order, not tokens order
      for (let idx = 0; idx < rebalanceView.tokens.length; idx++) {
        const rebalanceToken = rebalanceView.tokens[idx];
        const token = rebalanceToken.token;

        if (orderedTokens.indexOf(token) < 0) {
          throw new Error(`Token ${token} in rebalance state but not in orderedTokens`);
        }

        // === initialWeights ===
        initialWeights.push(rebalanceToken.weight);

        // === initialAssets ===
        initialAssets.push(initialAssetsRec[token]);

        // === initialPrices ===
        const originalPrice = rebalanceToken.price;

        // {USD/wholeTok} = D27{nanoUSD/tok} / D27 / {nanoUSD/USD} * {tok/wholeTok}
        const lowPriceUSD = Number(originalPrice.low) / Number(10n ** 36n / 10n ** allDecimalsRec[token]);
        const highPriceUSD = Number(originalPrice.high) / Number(10n ** 36n / 10n ** allDecimalsRec[token]);
        // Use geometric mean for consistency with convertProposalPricesToUSD
        initialPrices.push(Math.sqrt(lowPriceUSD * highPriceUSD));

        // === assets ===
        assets.push(currentAssets[idx]);

        // === decimals ===
        decimals.push(allDecimalsRec[token]);

        // === deviatedAuctionPrices ===
        const auctionPrice = rebalancePricesRec[token.toLowerCase()].snapshotPrice;
        // Generate random factor between (1 - deviation) and (1 + deviation)
        const deviatedPrice = auctionPrice * (1 - auctionPriceDeviation + Math.random() * (2 * auctionPriceDeviation));
        deviatedAuctionPrices.push(deviatedPrice);
      }
    }

    // which target basket we pass to getOpenAuction() depends on TRACKING vs NATIVE weightControl
    // TRACKING (weightControl = false): use CURRENT auction prices (with deviation)
    // NATIVE (weightControl = true): use HISTORICAL prices from proposal
    const auctionTargetBasket = getTargetBasket(
      initialWeights,
      weightControl ? initialPrices : deviatedAuctionPrices,
      decimals,
      debug,
    );

    const auctionLength = await getAuctionLengthForVersion(version, folio);

    const [openAuctionArgsLocal, auctionMetrics] = getOpenAuction(
      version,
      rebalanceState,
      currentSupply,
      initialSupply,
      initialAssets,
      auctionTargetBasket,
      assets,
      decimals,
      deviatedAuctionPrices,
      deviatedAuctionPrices.map((_: number) => auctionPriceDeviation),
      finalStageAt,
      debug,
      auctionLength,
    );

    console.log(
      `      📏  [${(Number(openAuctionArgsLocal.newLimits.low) / 1e18).toFixed(4)}, ${(
        Number(openAuctionArgsLocal.newLimits.spot) / 1e18
      ).toFixed(4)}, ${(Number(openAuctionArgsLocal.newLimits.high) / 1e18).toFixed(4)}]`,
    );

    if (openAuctionArgsLocal.tokens.length == 0) {
      return [openAuctionArgsLocal, auctionMetrics];
    }

    // openAuction()
    await whileImpersonating(hre, await auctionLauncher.getAddress(), async (signer) => {
      await submitOpenAuctionForVersion(version, folio, signer, openAuctionArgsLocal);
    });

    // advance time to midpoint of auction
    const auctionId = (await folio.nextAuctionId()) - 1n;
    const [, start, end] = await folio.auctions(auctionId);
    const bidTime = start + BigInt(end - start) / 2n;
    await hre.network.provider.send("evm_setNextBlockTimestamp", [bidTime.toString()]);
    await hre.network.provider.send("evm_mine", []);

    const getAllBids = async () => folioLensTyped.getAllBids(await folio.getAddress(), auctionId);

    let allBids = toPlainObject(await getAllBids());
    allBids.sort((a: any, b: any) => getBidValue(b, rebalancePricesRec) - getBidValue(a, rebalancePricesRec));

    while (allBids.length > 0 && getBidValue(allBids[0], rebalancePricesRec) >= 1) {
      const bid = allBids[0];

      const buyTokenContract = mockedTokensRec[bid[1]] as unknown as Contract;
      if (!buyTokenContract) {
        throw new Error(`Mocked token for ${bid[1]} not found during bidding.`);
      }

      // Apply random slippage to simulate real-world execution
      // We simulate slippage by reducing the sell amount we get back
      const slippage = swapSlippageRange[0] + Math.random() * (swapSlippageRange[1] - swapSlippageRange[0]);
      const actualSellAmount = BigInt(Math.floor(Number(bid[2]) * (1 - slippage)));

      // Mint the full buy amount as expected
      await (await buyTokenContract.mint(await bidder.getAddress(), bid[3])).wait();

      await whileImpersonating(hre, await bidder.getAddress(), async (signer) => {
        await (await (buyTokenContract.connect(signer) as Contract).approve(await folio.getAddress(), bid[3])).wait();
        // Execute with original bid amounts - the slippage is simulated by the reduced sell amount we'll track
        await (await (folio.connect(signer) as any).bid(auctionId, bid[0], bid[1], bid[2], bid[3], false, "0x")).wait();

        const sellTokenContract = await hre.ethers.getContractAt("IERC20Metadata", bid[0]);
        const buyTokenContract2 = await hre.ethers.getContractAt("IERC20Metadata", bid[1]);
        const sellSymbol = await sellTokenContract.symbol();
        const buySymbol = await buyTokenContract2.symbol();

        const buyPriceData = rebalancePricesRec[bid[1].toLowerCase()];
        const buyPrice = buyPriceData ? buyPriceData.snapshotPrice : 0;

        // Use original prices for value calculation if provided, otherwise use auction prices
        const sellValuePriceData = rebalancePricesRec[bid[0].toLowerCase()];
        const sellValuePrice = sellValuePriceData ? sellValuePriceData.snapshotPrice : 0;

        // Calculate values with slippage simulation
        const actualSellValue = (Number(actualSellAmount) * sellValuePrice) / Number(10n ** allDecimalsRec[bid[0]]);
        const buyValue = (Number(bid[3]) * buyPrice) / Number(10n ** allDecimalsRec[bid[1]]);
        const slippagePercent = (slippage * 100).toFixed(2);

        // Use actual sell value for tracking (simulating that we got less than expected)
        totalRebalancedValue += actualSellValue; // Accumulate total traded value with slippage

        console.log(
          "      🔄 ",
          `${sellSymbol} ($${actualSellValue.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}) -> ${buySymbol} ($${buyValue.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}) [${slippagePercent}% slip]`,
        );
      });

      allBids = toPlainObject(await getAllBids());
      allBids.sort((a: any, b: any) => getBidValue(b, rebalancePricesRec) - getBidValue(a, rebalancePricesRec));
    }

    // skip to end of auction
    await hre.network.provider.send("evm_setNextBlockTimestamp", [(end + 1n).toString()]);
    await hre.network.provider.send("evm_mine", []);

    return [openAuctionArgsLocal, auctionMetrics];
  };

  // Track total value rebalanced across all auctions
  let totalRebalancedValue = 0;

  const maxAuctions = 6;
  const minBidValue = 1;

  let [openAuctionArgsLocal, auctionMetrics] = await doAuction(1);
  const needsAnotherAuction = () =>
    (auctionMetrics.round == AuctionRound.EJECT || auctionMetrics.target < 1 - tolerance) &&
    auctionMetrics.auctionSize >= minBidValue &&
    auctionMetrics.surplusTokens.length > 0;

  for (let auctionNumber = 2; auctionNumber <= maxAuctions; auctionNumber++) {
    if (!needsAnotherAuction()) break;
    [openAuctionArgsLocal, auctionMetrics] = await doAuction(auctionNumber);
  }

  if (needsAnotherAuction()) {
    if (auctionMetrics.target < finalStageAt) {
      console.log("openAuctionArgsLocal", openAuctionArgsLocal);
      console.log("auctionMetrics", auctionMetrics);
      throw new Error(`did not reach final stage after ${maxAuctions} auctions`);
    }

    console.log(`      🛑  Reached ${maxAuctions} auctions in final stage; checking final basket error`);
  }

  if (auctionMetrics.target >= 1 - tolerance) {
    expect(auctionMetrics.target).to.be.closeTo(1, tolerance);
  } else {
    console.log("      🛑  No executable auction remains; checking final basket error");
  }

  // Verify all tokens with weight 0 have been fully ejected
  for (const token of orderedTokens) {
    if (targetBasketRec[token] === 0n) {
      const remainingBalance = await mockedTokensRec[token].balanceOf(await folio.getAddress());
      const remainingValue =
        (rebalancePricesRec[token.toLowerCase()].snapshotPrice * Number(remainingBalance)) /
        Number(10n ** allDecimalsRec[token]);
      expect(remainingValue).to.be.lessThan(minBidValue);
    }
  }

  // --- Analyze final state ---

  const [finalTokens, finalAssets] = await folio.totalAssets();

  const balancesAfterFinalRec: Record<string, bigint> = {};
  orderedTokens.forEach((token: string) => {
    const idx = finalTokens.indexOf(token);
    balancesAfterFinalRec[token] = idx >= 0 ? finalAssets[idx] : 0n;
  });

  // these value calculations have to use the initial prices, not current prices
  let totalValueAfterFinal = 0;
  const finalTokenValuesRec: Record<string, number> = {};
  orderedTokens.forEach((token: string) => {
    const price = rebalancePricesRec[token.toLowerCase()].snapshotPrice;
    const bal = balancesAfterFinalRec[token];
    const decimal = allDecimalsRec[token];

    finalTokenValuesRec[token] = (price * Number(bal)) / Number(10n ** decimal);
    totalValueAfterFinal += finalTokenValuesRec[token];
  });

  const finalTargetBasketRec: Record<string, bigint> = {};
  orderedTokens.forEach((token: string) => {
    finalTargetBasketRec[token] = bn(((finalTokenValuesRec[token] / totalValueAfterFinal) * 10 ** 18).toString());
  });

  // calculate error from intended target
  const totalErrorSquared = orderedTokens
    .map((token: string) => {
      const diff =
        targetBasketRec[token] > finalTargetBasketRec[token]
          ? targetBasketRec[token] - finalTargetBasketRec[token]
          : finalTargetBasketRec[token] - targetBasketRec[token];

      return (diff * diff) / 10n ** 18n;
    })
    .reduce((a: bigint, b: bigint) => a + b, 0n);

  const totalError = Math.sqrt(Number(totalErrorSquared) / 10 ** 18);

  logPercentages(`\n🔍 Final    `, finalTargetBasketRec, orderedTokens);
  logPercentages(`🎯 Target   `, targetBasketRec, orderedTokens);

  if (totalError > 10n ** 14n) {
    console.log(`⚠️ Error     ${(totalError * 100).toFixed(2)}%\n`);
    throw new Error("Total error is too high");
  } else {
    console.log(`✅ Error     ${(totalError * 100).toFixed(2)}%\n`);
  }

  return {
    totalRebalancedValue,
    totalError,
    finalTargetBasketRec,
  };
}
