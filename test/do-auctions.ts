import "@nomicfoundation/hardhat-ethers";
import { HardhatRuntimeEnvironment } from "hardhat/types";
import { time } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { expect } from "chai";
import { Contract } from "ethers";

import { bn } from "../src/numbers";
import { whileImpersonating, toPlainObject, createPriceLookup, logPercentages } from "./utils";
import { AuctionMetrics, AuctionRound, FolioVersion, OpenAuctionArgs, WeightRange } from "../src/types";
import { getOpenAuction, getTargetBasket } from "../src/open-auction";
import { RebalanceContracts, RebalanceSigners, RebalanceInitialState } from "./types";

export async function doAuctions(
  version: FolioVersion,
  hre: HardhatRuntimeEnvironment,
  contracts: RebalanceContracts,
  signers: RebalanceSigners,
  rebalanceTokens: string[],
  initialAssetsRec: Record<string, bigint>,
  targetBasketRec: Record<string, bigint>,
  rebalancePricesRec: Record<string, { snapshotPrice: number }>,
  initialState: RebalanceInitialState,
  finalStageAt: number,
  debug?: boolean,
  auctionPriceDeviation: number = 0.02,
  swapSlippageRange: [number, number] = [0.001, 0.005], // 0.1% to 0.5% default slippage
) {
  const { folio, folioLensTyped } = contracts;
  const { bidder, auctionLauncher } = signers;
  const { initialTokens, initialSupply, initialAssets, startRebalanceArgs } = initialState;

  // Get decimals for all tokens
  const allDecimalsRec: Record<string, bigint> = {};
  for (const token of rebalanceTokens) {
    const tokenContract = await hre.ethers.getContractAt("IERC20Metadata", token);
    allDecimalsRec[token] = await tokenContract.decimals();
  }

  const currentSupply = await folio.totalSupply();

  // Validate all tokens have prices
  const missingPrices: string[] = [];
  for (const token of rebalanceTokens) {
    const priceKey = token.toLowerCase();
    if (!rebalancePricesRec[priceKey] || !rebalancePricesRec[priceKey].snapshotPrice) {
      missingPrices.push(token);
    }
  }

  if (missingPrices.length > 0) {
    throw new Error(
      `Missing price data for the following tokens: ${missingPrices.join(", ")}\n` +
        `All tokens must have valid price data in rebalancePricesRec before running auctions.`,
    );
  }

  for (const token of rebalanceTokens) {
    if (!(token in initialAssetsRec)) {
      throw new Error(`Token ${token} from tokens not found in initialAssetsRec`);
    }
    if (!(token in targetBasketRec)) {
      throw new Error(`Token ${token} from tokens not found in targetBasketRec`);
    }
  }
  if (Object.keys(initialAssetsRec).length !== rebalanceTokens.length) {
    throw new Error("Mismatch between tokens length and initialAssetsRec keys");
  }
  if (Object.keys(targetBasketRec).length !== rebalanceTokens.length) {
    throw new Error("Mismatch between tokens length and targetBasketRec keys");
  }

  const [weightControl] = await folio.rebalanceControl();

  const targetBasketArray = rebalanceTokens.map((token) => targetBasketRec[token]);

  if (debug) {
    console.log(
      "Target basket:",
      targetBasketArray.map((w) => w.toString()),
    );
  }

  // Replace tokens with mocks
  const ERC20MockFactory = await hre.ethers.getContractFactory("ERC20Mock");
  const mockedTokensRec: Record<string, Contract> = {};

  for (const asset of rebalanceTokens) {
    const tokenContract = (await hre.ethers.getContractAt("ERC20Mock", asset)) as unknown as Contract;
    const balBefore = await tokenContract.balanceOf(await folio.getAddress());

    const currentCode = await hre.ethers.provider.getCode(asset);
    const newMockDeployment = await ERC20MockFactory.deploy();
    await newMockDeployment.waitForDeployment();
    const newImplementationBytecode = await hre.ethers.provider.getCode(await newMockDeployment.getAddress());

    if (newImplementationBytecode !== currentCode) {
      const tokenContract2 = await hre.ethers.getContractAt("IERC20Metadata", asset);
      const [name, symbol, tokenDecimalsValue] = await Promise.all([
        tokenContract2.name(),
        tokenContract2.symbol(),
        tokenContract2.decimals(),
      ]);
      await hre.network.provider.send("hardhat_setCode", [asset, newImplementationBytecode]);
      await (await tokenContract.init(name, symbol, tokenDecimalsValue)).wait();
      await (await tokenContract.mint(await folio.getAddress(), balBefore)).wait();
    }

    expect(await tokenContract.balanceOf(await folio.getAddress())).to.equal(balBefore);
    mockedTokensRec[asset] = tokenContract;
  }

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
    const rebalanceState = await folio.getRebalance();
    // can have fewer tokens than rebalanceTokens, because some have been successfully ejected

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

    const currentBasket = rebalanceTokens.map((token: string) => {
      const val = currentValues[token] || 0;
      const percentage = (val / totalCurrentValue) * 100;
      return percentage === 0 ? "00.00%" : `${percentage.toFixed(2)}%`;
    });

    // log current distribution
    console.log(`\n📊 Auction ${auctionNumber} [${currentBasket.join(", ")}]`);

    // rebalanceState was already fetched above
    expect(rebalanceState.availableUntil).to.be.greaterThan(await time.latest());

    // ==============================

    const assets: bigint[] = [];
    const auctionPrices: number[] = [];

    const originalWeights: WeightRange[] = [];
    const rebalancePrices: number[] = [];

    // Populate auction calldata
    {
      // Build arrays in rebalanceState.tokens order, not tokens order
      // Note: Contract returns old format with tokens as string[], not TokenRebalanceParams[]
      for (let idx = 0; idx < rebalanceState.tokens.length; idx++) {
        const token = rebalanceState.tokens[idx]; // This is a string (token address)
        if (rebalanceTokens.indexOf(token) < 0) {
          throw new Error(`Token ${token} in rebalance state but not in rebalanceTokens`);
        }

        // Find the token's position in the original startRebalanceArgs.tokens array
        // startRebalanceArgs was created with tokens, so we need to find the token there
        const startRebalanceIdx = rebalanceTokens.indexOf(token);
        if (startRebalanceIdx === -1) {
          throw new Error(`Token ${token} not found in original tokens`);
        }

        assets.push(currentAssets[idx]);
        auctionPrices.push(rebalancePricesRec[token.toLowerCase()].snapshotPrice);
        originalWeights.push(startRebalanceArgs.tokens[startRebalanceIdx].weight); // Use the original index from startRebalanceArgs

        // recover original avgs used to construct startRebalanceArgs.tokens[].price
        const historicalPrice = startRebalanceArgs.tokens[startRebalanceIdx].price;
        const divisor = 10n ** 36n / 10n ** allDecimalsRec[token]; // 10^(27+9) / 10^decimals
        const lowPriceUSD = Number(historicalPrice.low) / Number(divisor);
        const highPriceUSD = Number(historicalPrice.high) / Number(divisor);
        // Use geometric mean for consistency with convertProposalPricesToUSD
        rebalancePrices.push(Math.sqrt(lowPriceUSD * highPriceUSD));
      }
    }

    // Apply random price deviation to auction prices
    // Each price gets a random deviation within ±auctionPriceDeviation
    const deviatedAuctionPrices = auctionPrices.map((price: number) => {
      // Generate random factor between (1 - deviation) and (1 + deviation)
      const factor = 1 - auctionPriceDeviation + Math.random() * (2 * auctionPriceDeviation);
      return price * factor;
    });

    // Build decimalsArray in rebalanceState.tokens order
    const decimalsArrayRebalanceOrder = rebalanceState.tokens.map((token: string) => allDecimalsRec[token]);

    // Build initialAmountsArray in rebalanceState.tokens order
    // Use the amounts captured BEFORE any auctions started
    const initialAssetsArrayRebalanceOrder = rebalanceState.tokens.map((token: string) => {
      const idx = initialTokens.findIndex((t: string) => t.toLowerCase() === token.toLowerCase());
      if (idx === -1) {
        throw new Error(`Token ${token} from rebalanceState not found in initialTokens`);
      }
      return initialAssets[idx];
    });

    // which target basket we pass to getOpenAuction() depends on TRACKING vs NATIVE weightControl
    // TRACKING (weightControl = false): use CURRENT auction prices (with deviation)
    // NATIVE (weightControl = true): use HISTORICAL prices from proposal
    const auctionTargetBasket = getTargetBasket(
      originalWeights,
      weightControl ? rebalancePrices : deviatedAuctionPrices,
      decimalsArrayRebalanceOrder,
      debug,
    );

    // Convert contract's old format to new TokenRebalanceParams[] format
    const tokensParams = rebalanceState.tokens.map((token: string, idx: number) => ({
      token: token,
      weight: rebalanceState.weights[idx],
      price: rebalanceState.initialPrices[idx],
      maxAuctionSize: rebalanceState.maxAuctionSizes[idx],
      inRebalance: rebalanceState.inRebalance[idx],
    }));

    const [openAuctionArgsLocal, auctionMetrics] = getOpenAuction(
      version,
      {
        nonce: rebalanceState.nonce,
        tokens: tokensParams,
        limits: rebalanceState.limits,
        timestamps: {
          startedAt: rebalanceState.startedAt,
          restrictedUntil: rebalanceState.restrictedUntil,
          availableUntil: rebalanceState.availableUntil,
        },
        priceControl: rebalanceState.priceControl,
      },
      currentSupply,
      initialSupply,
      initialAssetsArrayRebalanceOrder,
      auctionTargetBasket,
      assets,
      decimalsArrayRebalanceOrder,
      deviatedAuctionPrices,
      deviatedAuctionPrices.map((_: number) => auctionPriceDeviation),
      finalStageAt,
      debug,
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
      await (
        await (folio.connect(signer) as any).openAuction(
          openAuctionArgsLocal.rebalanceNonce,
          openAuctionArgsLocal.tokens,
          openAuctionArgsLocal.newWeights,
          openAuctionArgsLocal.newPrices,
          openAuctionArgsLocal.newLimits,
        )
      ).wait();
    });

    // advance time to midpoint of auction
    const auctionId = (await folio.nextAuctionId()) - 1n;
    const [, start, end] = await folio.auctions(auctionId);
    const bidTime = start + BigInt(end - start) / 2n;
    await hre.network.provider.send("evm_setNextBlockTimestamp", [bidTime.toString()]);
    await hre.network.provider.send("evm_mine", []);

    let allBids = toPlainObject(await folioLensTyped.getAllBids(await folio.getAddress(), auctionId));
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

      allBids = toPlainObject(await folioLensTyped.getAllBids(await folio.getAddress(), auctionId));
      allBids.sort((a: any, b: any) => getBidValue(b, rebalancePricesRec) - getBidValue(a, rebalancePricesRec));
    }

    // skip to end of auction
    await hre.network.provider.send("evm_setNextBlockTimestamp", [(end + 1n).toString()]);
    await hre.network.provider.send("evm_mine", []);

    return [openAuctionArgsLocal, auctionMetrics];
  };

  // Track total value rebalanced across all auctions
  let totalRebalancedValue = 0;

  // ROUND 1
  let [openAuctionArgsLocal, auctionMetrics] = await doAuction(1);

  const TOLERANCE = 1e-5;

  // ROUND 2
  if (auctionMetrics.round == AuctionRound.EJECT || auctionMetrics.target < 1 - TOLERANCE) {
    [openAuctionArgsLocal, auctionMetrics] = await doAuction(2);
  }

  // ROUND 3
  if (auctionMetrics.round == AuctionRound.EJECT || auctionMetrics.target < 1 - TOLERANCE) {
    [openAuctionArgsLocal, auctionMetrics] = await doAuction(3);
  }

  if (auctionMetrics.round == AuctionRound.EJECT || auctionMetrics.target < 1 - TOLERANCE) {
    console.log("openAuctionArgsLocal", openAuctionArgsLocal);
    console.log("auctionMetrics", auctionMetrics);
    throw new Error("did not finish rebalancing after 3 auctions");
  }
  expect(auctionMetrics.target).to.be.closeTo(1, TOLERANCE);

  // Verify all tokens with weight 0 have been fully ejected
  for (const token of rebalanceTokens) {
    if (targetBasketRec[token] === 0n) {
      expect(await mockedTokensRec[token].balanceOf(await folio.getAddress())).to.equal(0);
    }
  }

  // --- Analyze final state ---

  const [finalTokens, finalAssets] = await folio.totalAssets();

  const balancesAfterFinalRec: Record<string, bigint> = {};
  rebalanceTokens.forEach((token: string) => {
    const idx = finalTokens.indexOf(token);
    balancesAfterFinalRec[token] = idx >= 0 ? finalAssets[idx] : 0n;
  });

  // these value calculations have to use the initial prices, not current prices
  let totalValueAfterFinal = 0;
  const finalTokenValuesRec: Record<string, number> = {};
  rebalanceTokens.forEach((token: string) => {
    const price = rebalancePricesRec[token.toLowerCase()].snapshotPrice;
    const bal = balancesAfterFinalRec[token];
    const decimal = allDecimalsRec[token];

    finalTokenValuesRec[token] = (price * Number(bal)) / Number(10n ** decimal);
    totalValueAfterFinal += finalTokenValuesRec[token];
  });

  const finalTargetBasketRec: Record<string, bigint> = {};
  rebalanceTokens.forEach((token: string) => {
    finalTargetBasketRec[token] = bn(((finalTokenValuesRec[token] / totalValueAfterFinal) * 10 ** 18).toString());
  });

  // calculate error from intended target
  const totalErrorSquared = rebalanceTokens
    .map((token: string) => {
      const diff =
        targetBasketRec[token] > finalTargetBasketRec[token]
          ? targetBasketRec[token] - finalTargetBasketRec[token]
          : finalTargetBasketRec[token] - targetBasketRec[token];

      return (diff * diff) / 10n ** 18n;
    })
    .reduce((a: bigint, b: bigint) => a + b, 0n);

  const totalError = Math.sqrt(Number(totalErrorSquared) / 10 ** 18);

  logPercentages(`\n🔍 Final    `, finalTargetBasketRec, rebalanceTokens);
  logPercentages(`🎯 Target   `, targetBasketRec, rebalanceTokens);

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
