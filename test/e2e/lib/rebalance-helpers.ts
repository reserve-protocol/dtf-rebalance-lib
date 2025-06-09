import { HardhatRuntimeEnvironment } from "hardhat/types";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { time } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { expect } from "chai";
import { Contract } from "ethers"; // For typing Folio and FolioLens contracts

import { Folio as FolioConfig } from "../constants"; // Renaming to avoid conflict
import { getAssetPrices, whileImpersonating, toPlainObject, getTokenNameAndSymbol } from "../utils";
import { AuctionRound, AuctionMetrics, getOpenAuction } from "../../../src/open-auction";
import { getStartRebalance } from "../../../src/start-rebalance";

// Define an interface for the contract instances for better type safety
interface RebalanceContracts {
  folio: Contract; // Replace with specific Folio type if available
  folioLensTyped: Contract; // Replace with specific FolioLens type if available
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
  finalStageAt: number,
  logging?: boolean,
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

  const pricesRec = await getAssetPrices(orderedTokens, folioConfig.chainId, await time.latest());
  console.log("pricesRec", pricesRec);
  for (const token of orderedTokens) {
    if (pricesRec[token] === undefined || pricesRec[token].snapshotPrice === 0) {
      throw new Error(
        `missing price for token ${token} at block ${(await hre.ethers.provider.getBlock("latest"))?.number} and time ${await time.latest()}`,
      );
    }

    expect(
      (pricesRec[token].currentPrice - pricesRec[token].snapshotPrice) / pricesRec[token].snapshotPrice,
    ).to.be.lessThan(0.05);
  }

  const initialAmountsArray = orderedTokens.map((token) => initialAmounts[token]);

  const currentBasketValuesRec: Record<string, number> = {};
  orderedTokens.forEach((token) => {
    currentBasketValuesRec[token] =
      (pricesRec[token].snapshotPrice * Number(initialAmounts[token])) / Number(10n ** allDecimalsRec[token]);
  });

  const [weightControl] = await folio.rebalanceControl();

  const targetBasketBigIntArray = orderedTokens.map((token) => targetBasket[token]);
  const pricesArray = orderedTokens.map((token) => pricesRec[token].snapshotPrice);
  const decimalsArray = orderedTokens.map((token) => allDecimalsRec[token]);

  const startRebalanceArgs = getStartRebalance(
    supply,
    orderedTokens,
    initialAmountsArray,
    decimalsArray,
    targetBasketBigIntArray,
    pricesArray,
    pricesArray.map((_: number) => 0.2),
    weightControl,
    logging,
  );

  await whileImpersonating(hre, await rebalanceManager.getAddress(), async (signer) => {
    await (folio.connect(signer) as any).startRebalance(
      orderedTokens,
      startRebalanceArgs.weights,
      startRebalanceArgs.prices,
      startRebalanceArgs.limits,
      0n,
      100n,
    );
  });

  const rebalance = await folio.getRebalance();
  if (rebalance.tokens.length !== orderedTokens.length) {
    throw new Error(`Mismatch between orderedTokens length and rebalance tokens length`);
  }
  for (const token of orderedTokens) {
    if (rebalance.tokens.indexOf(token) === -1) {
      throw new Error(`Token ${token} not found in rebalance tokens`);
    }
  }

  const ERC20MockFactory = await hre.ethers.getContractFactory("ERC20Mock");
  const mockedTokensRec: Record<string, Contract> = {};

  // replace tokens with mocks
  for (const asset of orderedTokens) {
    if (allDecimalsRec[asset] === undefined) {
      allDecimalsRec[asset] = await (await hre.ethers.getContractAt("IERC20Metadata", asset)).decimals();
    }

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

  const getBidValue = (bid: any[]): number => {
    const sellTokenAddr = bid[0];
    const buyTokenAddr = bid[1];

    const sellTokenPrice = pricesRec[sellTokenAddr].snapshotPrice;
    const buyTokenPrice = pricesRec[buyTokenAddr].snapshotPrice;

    const sellValue = (Number(bid[2]) / Number(10n ** (allDecimalsRec[sellTokenAddr] || 18n))) * sellTokenPrice;
    const buyValue = (Number(bid[3]) / Number(10n ** (allDecimalsRec[buyTokenAddr] || 18n))) * buyTokenPrice;
    return buyValue > sellValue ? sellValue : buyValue;
  };

  const doAuction = async (currentFinalStageAt: number): Promise<AuctionMetrics> => {
    const rebalanceState = await folio.getRebalance();
    const wholeRebalance = {
      nonce: rebalanceState.nonce,
      tokens: orderedTokens,
      weights: rebalanceState.weights.map((weight: [bigint, bigint, bigint]) => ({
        low: weight[0],
        spot: weight[1],
        high: weight[2],
      })),
      initialPrices: rebalanceState.initialPrices.map((price: [bigint, bigint]) => ({
        low: price[0],
        high: price[1],
      })),
      inRebalance: toPlainObject(rebalanceState.inRebalance),
      limits: {
        low: rebalanceState.limits[0],
        spot: rebalanceState.limits[1],
        high: rebalanceState.limits[2],
      },
      startedAt: rebalanceState.startedAt,
      restrictedUntil: rebalanceState.restrictedUntil,
      availableUntil: rebalanceState.availableUntil,
      priceControl: rebalanceState.priceControl,
    };
    const [, amtsFromFolio] = await folio.toAssets(10n ** 18n, 0);

    const [openAuctionArgsLocal, auctionMetrics] = getOpenAuction(
      wholeRebalance,
      supply,
      initialAmountsArray,
      targetBasketBigIntArray,
      [...amtsFromFolio],
      decimalsArray,
      pricesArray,
      pricesArray.map((_: number) => 1e-4),
      currentFinalStageAt,
      logging,
    );

    // openAuction()
    await whileImpersonating(hre, await auctionLauncher.getAddress(), async (signer) => {
      await (folio.connect(signer) as any).openAuction(
        openAuctionArgsLocal.rebalanceNonce,
        openAuctionArgsLocal.tokens,
        openAuctionArgsLocal.newWeights,
        openAuctionArgsLocal.newPrices,
        openAuctionArgsLocal.newLimits,
      );
    });

    // advance time to 2/3 of the way through the auction
    const auctionId = (await folio.nextAuctionId()) - 1n;
    const [, start, end] = await folio.auctions(auctionId);
    const bidTime = start + (BigInt(end - start) * 2n) / 3n;
    await hre.network.provider.send("evm_setNextBlockTimestamp", [bidTime.toString()]);
    await hre.network.provider.send("evm_mine", []);

    let allBids = toPlainObject(await folioLensTyped.getAllBids(await folio.getAddress(), auctionId, 0n));
    allBids.sort((a: any, b: any) => getBidValue(b) - getBidValue(a));

    expect(allBids.length).to.be.greaterThan(0);
    expect(getBidValue(allBids[0])).to.be.greaterThan(1);

    while (allBids.length > 0 && getBidValue(allBids[0]) > 0.1) {
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
          "  🔄 ",
          `${sellAttributes.symbol} -> ${buyAttributes.symbol}`,
          `$${getBidValue(bid).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
        );
      });

      allBids = toPlainObject(
        await folioLensTyped.getAllBids(await folio.getAddress(), auctionId, (await time.latest()) + 1),
      );
      allBids.sort((a: any, b: any) => getBidValue(b) - getBidValue(a));
    }
    return auctionMetrics;
  };

  const firstAuctionMetrics = await doAuction(finalStageAt);

  const rebalanceAfterFirst = await folio.getRebalance();
  let finalAuctionMetrics = firstAuctionMetrics;

  if (rebalanceAfterFirst.rebalanceType !== AuctionRound.FINAL) {
    finalAuctionMetrics = await doAuction(finalStageAt);
  }

  // re-add ejected token to basket
  await whileImpersonating(hre, await admin.getAddress(), async (signer) => {
    const [basketWithoutEjectedToken] = await folio.toAssets(10n ** 18n, 0);
    for (const token of orderedTokens) {
      if (!basketWithoutEjectedToken.includes(token)) {
        await (await (folio.connect(signer) as any).addToBasket(token)).wait();
      }
    }
  });

  // verify we are close to the target basket
  const [actualBasket, actualBasketAmounts] = await folio.toAssets(supply, 0);
  expect(actualBasket.length).to.equal(orderedTokens.length);

  const actualBasketValues = orderedTokens.map((token: string) => {
    return (
      (pricesRec[token].snapshotPrice * Number(actualBasketAmounts[actualBasket.indexOf(token)])) /
      Number(10n ** allDecimalsRec[token])
    );
  });

  const sumActualBasketValues = actualBasketValues.reduce((a: number, b: number) => a + b, 0);
  const actualBasketPortions = actualBasketValues.map((value: number) => value / sumActualBasketValues);

  if (finalAuctionMetrics.target === 1) {
    // total error should be less than 1%
    const totalError = orderedTokens
      .map((token: string) => {
        return Math.abs(
          Number(targetBasket[token]) / 10 ** 18 - Number(actualBasketPortions[orderedTokens.indexOf(token)]),
        );
      })
      .reduce((a: number, b: number) => a + b, 0);
    expect(totalError).to.be.lessThan(1e-2);
  }
}
