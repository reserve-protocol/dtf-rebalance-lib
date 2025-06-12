import { HardhatRuntimeEnvironment } from "hardhat/types";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { time } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { expect } from "chai";
import { Contract } from "ethers";

import { Folio as FolioConfig } from "../constants"; // Renaming to avoid conflict
import { getAssetPrices, whileImpersonating, toPlainObject, getTokenNameAndSymbol } from "../utils";
import { AuctionMetrics, AuctionRound, getOpenAuction, getTargetBasket } from "../../../src/open-auction";
import { getStartRebalance } from "../../../src/start-rebalance";
import { PriceRange, WeightRange } from "../../../src/types";

interface RebalanceContracts {
  folio: Contract;
  folioLensTyped: Contract;
}

interface RebalanceSigners {
  admin: HardhatEthersSigner;
  bidder: HardhatEthersSigner;
  rebalanceManager: HardhatEthersSigner;
  auctionLauncher: HardhatEthersSigner;
}

export async function runRebalance(
  hre: HardhatRuntimeEnvironment,
  folioConfig: FolioConfig,
  contracts: RebalanceContracts,
  signers: RebalanceSigners,
  orderedTokens: string[],
  initialAmounts: Record<string, bigint>,
  targetBasket: Record<string, bigint>,
  rebalancePricesRec: Record<string, { snapshotPrice: number }>,
  finalStageAt: number,
  debug?: boolean,
) {
  const { folio, folioLensTyped } = contracts;
  const { bidder, rebalanceManager, auctionLauncher, admin } = signers;

  const supply = await folio.totalSupply();

  for (const token of orderedTokens) {
    if (!(token in initialAmounts)) {
      throw new Error(`Token ${token} from orderedTokens not found in initialAmounts`);
    }
    if (!(token in targetBasket)) {
      throw new Error(`Token ${token} from orderedTokens not found in targetBasket`);
    }
  }
  if (Object.keys(initialAmounts).length !== orderedTokens.length) {
    throw new Error("Mismatch between orderedTokens length and initialAmounts keys");
  }
  if (Object.keys(targetBasket).length !== orderedTokens.length) {
    throw new Error("Mismatch between orderedTokens length and targetBasket keys");
  }

  const allDecimalsRec: Record<string, bigint> = {};
  for (const asset of orderedTokens) {
    allDecimalsRec[asset] = await (await hre.ethers.getContractAt("IERC20Metadata", asset)).decimals();
  }

  const initialAmountsArray = orderedTokens.map((token) => initialAmounts[token]);

  const currentBasketValuesRec: Record<string, number> = {};
  orderedTokens.forEach((token) => {
    currentBasketValuesRec[token] =
      (rebalancePricesRec[token].snapshotPrice * Number(initialAmounts[token])) / Number(10n ** allDecimalsRec[token]);
  });

  const [weightControl] = await folio.rebalanceControl();

  const pricesArray = orderedTokens.map((token) => rebalancePricesRec[token].snapshotPrice);
  const decimalsArray = orderedTokens.map((token) => allDecimalsRec[token]);

  const startRebalanceArgs = getStartRebalance(
    supply,
    orderedTokens,
    initialAmountsArray,
    decimalsArray,
    orderedTokens.map((token) => targetBasket[token]),
    pricesArray,
    pricesArray.map((_: number) => 0.5), // MEDIUM setting
    weightControl,
    debug,
  );

  // advance time as-if startRebalance() call was stuck in governance for 7 days
  await hre.network.provider.send("evm_setNextBlockTimestamp", [(await time.latest()) + 7 * 24 * 60 * 60]);
  await hre.network.provider.send("evm_mine", []);

  // start rebalance
  await whileImpersonating(hre, await rebalanceManager.getAddress(), async (signer) => {
    await (
      await (folio.connect(signer) as any).startRebalance(
        orderedTokens,
        startRebalanceArgs.weights,
        startRebalanceArgs.prices,
        startRebalanceArgs.limits,
        0n,
        1000000n,
      )
    ).wait();
  });

  const ERC20MockFactory = await hre.ethers.getContractFactory("ERC20Mock");
  const mockedTokensRec: Record<string, Contract> = {};

  // replace tokens with mocks
  for (const asset of orderedTokens) {
    const tokenContract = (await hre.ethers.getContractAt("ERC20Mock", asset)) as unknown as Contract;
    const balBefore = await tokenContract.balanceOf(await folio.getAddress());

    const currentCode = await hre.ethers.provider.getCode(asset);
    const newMockDeployment = await ERC20MockFactory.deploy();
    await newMockDeployment.waitForDeployment();
    const newImplementationBytecode = await hre.ethers.provider.getCode(await newMockDeployment.getAddress());

    if (newImplementationBytecode !== currentCode) {
      const { name, symbol, decimals: tokenDecimalsValue } = await getTokenNameAndSymbol(asset);
      await hre.network.provider.send("hardhat_setCode", [asset, newImplementationBytecode]);
      await (await tokenContract.init(name, symbol, tokenDecimalsValue)).wait();
      await (await tokenContract.mint(await folio.getAddress(), balBefore)).wait();
    }

    expect(await tokenContract.balanceOf(await folio.getAddress())).to.equal(balBefore);
    mockedTokensRec[asset] = tokenContract;
  }

  const getBidValue = (bid: any[], pricesRec: Record<string, { snapshotPrice: number }>): number => {
    const sellTokenAddr = bid[0];
    const buyTokenAddr = bid[1];

    const sellTokenPrice = pricesRec[sellTokenAddr].snapshotPrice;
    const buyTokenPrice = pricesRec[buyTokenAddr].snapshotPrice;

    const sellValue = (Number(bid[2]) / Number(10n ** (allDecimalsRec[sellTokenAddr] || 18n))) * sellTokenPrice;
    const buyValue = (Number(bid[3]) / Number(10n ** (allDecimalsRec[buyTokenAddr] || 18n))) * buyTokenPrice;
    return buyValue > sellValue ? sellValue : buyValue;
  };

  const doAuction = async (auctionNumber: number): Promise<AuctionMetrics> => {
    // make sure all tokens are in the basket
    await whileImpersonating(hre, await admin.getAddress(), async (signer) => {
      const [basketWithoutEjectedToken] = await folio.toAssets(10n ** 18n, 0);

      for (const token of orderedTokens) {
        if (!basketWithoutEjectedToken.includes(token)) {
          await (await (folio.connect(signer) as any).addToBasket(token)).wait();
        }
      }
    });

    // fetch prices to use for auction
    const auctionPricesRec = await getAssetPrices(orderedTokens, folioConfig.chainId, await time.latest());

    const [currentTokens, currentAmounts] = await folio.toAssets(10n ** 18n, 0);
    const currentValues: Record<string, number> = {};
    let totalCurrentValue = 0;

    // calculate total value of current basket
    orderedTokens.forEach((token: string) => {
      currentValues[token] =
        (auctionPricesRec[token].snapshotPrice * Number(currentAmounts[currentTokens.indexOf(token)])) /
        Number(10n ** allDecimalsRec[token]);
      totalCurrentValue += currentValues[token];
    });
    const currentBasket = orderedTokens.map((token: string) => {
      const percentage = (currentValues[token] / totalCurrentValue) * 100;
      return percentage === 0 ? "00.00%" : `${percentage.toFixed(2)}%`;
    });

    // log current distribution
    console.log(`\n📊 Auction ${auctionNumber} [${currentBasket.join(", ")}]`);

    const rebalanceState = await folio.getRebalance();
    expect(orderedTokens.length).to.equal(rebalanceState.tokens.length);
    expect(rebalanceState.availableUntil).to.be.greaterThan(await time.latest());

    const [, amtsFromFolio] = await folio.toAssets(10n ** 18n, 0);
    expect(amtsFromFolio.length).to.equal(rebalanceState.tokens.length);

    const weights: WeightRange[] = [];
    const initialPrices: PriceRange[] = [];
    const amts: bigint[] = [];
    const inRebalance: boolean[] = [];
    const auctionPrices: number[] = [];

    const originalWeights: WeightRange[] = [];
    const originalPrices: number[] = [];

    orderedTokens.forEach((token: string, idx: number) => {
      const currentIndex = rebalanceState.tokens.indexOf(token);

      weights.push(rebalanceState.weights[currentIndex]);
      initialPrices.push(startRebalanceArgs.prices[idx]);
      amts.push(amtsFromFolio[currentIndex]);
      inRebalance.push(rebalanceState.inRebalance[currentIndex]);
      auctionPrices.push(auctionPricesRec[token].snapshotPrice);

      originalWeights.push(startRebalanceArgs.weights[idx]);
      originalPrices.push(weightControl ? pricesArray[idx] : auctionPricesRec[token].snapshotPrice);
    });

    // which target basket we pass to getOpenAuction() depends on TRACKING vs NATIVE weightControl
    const auctionTargetBasket = getTargetBasket(originalWeights, originalPrices, decimalsArray);

    const [openAuctionArgsLocal, auctionMetrics] = getOpenAuction(
      {
        nonce: rebalanceState.nonce,
        tokens: orderedTokens,
        weights: weights,
        initialPrices: initialPrices,
        inRebalance: inRebalance,
        limits: rebalanceState.limits,
        startedAt: rebalanceState.startedAt,
        restrictedUntil: rebalanceState.restrictedUntil,
        availableUntil: rebalanceState.availableUntil,
        priceControl: rebalanceState.priceControl,
      },
      supply,
      initialAmountsArray,
      auctionTargetBasket,
      amts,
      decimalsArray,
      auctionPrices,
      auctionPrices.map((_: number) => 0.02),
      finalStageAt,
      debug,
    );

    console.log(
      `      📏  [${(Number(openAuctionArgsLocal.newLimits.low) / 1e18).toFixed(4)}, ${(
        Number(openAuctionArgsLocal.newLimits.spot) / 1e18
      ).toFixed(4)}, ${(Number(openAuctionArgsLocal.newLimits.high) / 1e18).toFixed(4)}]`,
    );

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

    // advance time to 2/3 of the way through the auction
    const auctionId = (await folio.nextAuctionId()) - 1n;
    const [, start, end] = await folio.auctions(auctionId);
    const bidTime = start + (BigInt(end - start) * 2n) / 3n;
    await hre.network.provider.send("evm_setNextBlockTimestamp", [bidTime.toString()]);
    await hre.network.provider.send("evm_mine", []);

    let allBids = toPlainObject(
      await folioLensTyped.getAllBids(await folio.getAddress(), auctionId, (await time.latest()) + 1),
    );
    allBids.sort((a: any, b: any) => getBidValue(b, auctionPricesRec) - getBidValue(a, auctionPricesRec));

    while (allBids.length > 0 && getBidValue(allBids[0], auctionPricesRec) >= 1) {
      const bid = allBids[0];

      const buyTokenContract = mockedTokensRec[bid[1]] as unknown as Contract;
      if (!buyTokenContract) {
        throw new Error(`Mocked token for ${bid[1]} not found during bidding.`);
      }
      await (await buyTokenContract.mint(await bidder.getAddress(), bid[3])).wait();

      await whileImpersonating(hre, await bidder.getAddress(), async (signer) => {
        await (await (buyTokenContract.connect(signer) as Contract).approve(await folio.getAddress(), bid[3])).wait();
        await (await (folio.connect(signer) as any).bid(auctionId, bid[0], bid[1], bid[2], bid[3], false, "0x")).wait();

        const sellAttributes = await getTokenNameAndSymbol(bid[0]);
        const buyAttributes = await getTokenNameAndSymbol(bid[1]);

        console.log(
          "      🔄 ",
          `${sellAttributes.symbol} ($${((Number(bid[2]) * auctionPricesRec[bid[0]].snapshotPrice) / Number(10n ** allDecimalsRec[bid[0]])).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}) -> ${buyAttributes.symbol} ($${((Number(bid[3]) * auctionPricesRec[bid[1]].snapshotPrice) / Number(10n ** allDecimalsRec[bid[1]])).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })})`,
        );
      });

      allBids = toPlainObject(
        await folioLensTyped.getAllBids(await folio.getAddress(), auctionId, (await time.latest()) + 1),
      );
      allBids.sort((a: any, b: any) => getBidValue(b, auctionPricesRec) - getBidValue(a, auctionPricesRec));
    }

    // skip to end of auction
    await hre.network.provider.send("evm_setNextBlockTimestamp", [(end + 1n).toString()]);
    await hre.network.provider.send("evm_mine", []);

    return auctionMetrics;
  };

  // ROUND 1
  const firstAuctionMetrics = await doAuction(1);

  // ROUND 2
  let finalAuctionMetrics = firstAuctionMetrics;
  if (firstAuctionMetrics.round == AuctionRound.EJECT || firstAuctionMetrics.target !== 1) {
    finalAuctionMetrics = await doAuction(2);
  }

  // ROUND 3
  if (finalAuctionMetrics.round == AuctionRound.EJECT || finalAuctionMetrics.target !== 1) {
    finalAuctionMetrics = await doAuction(3);
  }
  expect(finalAuctionMetrics.target).to.equal(1);

  // verify all tokens with weight 0 have been fully ejected
  for (const token of orderedTokens) {
    if (targetBasket[token] === 0n) {
      expect(await mockedTokensRec[token].balanceOf(await folio.getAddress())).to.equal(0);
    }
  }
}
