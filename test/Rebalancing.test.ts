import { loadFixture, time } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import hre from "hardhat";

import { bn } from "../src/numbers";
import { FolioVersion } from "../src/types";

import { initializeChainState, setupContractsAndSigners } from "./setup";
import { startRebalance } from "./start-rebalance";
import { doAuctions } from "./do-auctions";
import { getAssetPrices, getTokenNameAndSymbol } from "./utils";

import { FOLIO_CONFIGS, CHAIN_BLOCK_NUMBERS } from "./4.0.0/config";
// TODO test V5

// Only test BGCI for now
const TEST_FOLIO_CONFIGS = FOLIO_CONFIGS.filter((f) => f.name === "BGCI");

for (const folioConfig of TEST_FOLIO_CONFIGS) {
  describe(folioConfig.name, function () {
    before(async function () {
      this.timeout(60000);
      const blockNumber = CHAIN_BLOCK_NUMBERS[folioConfig.chainId];
      await initializeChainState(hre, folioConfig, blockNumber);
    });

    async function deployFixture() {
      return setupContractsAndSigners(hre, folioConfig);
    }

    it("Basic ejection", async function () {
      const { admin, folio, folioLensTyped, bidder, rebalanceManager, auctionLauncher } =
        await loadFixture(deployFixture);

      const initialSupply = await folio.totalSupply();

      const [basket, rawBalances] = await folio.totalAssets();
      const tokens = [...basket];

      const decimals = await Promise.all(
        tokens.map(async (asset: string) => (await hre.ethers.getContractAt("IERC20Metadata", asset)).decimals()),
      );

      const pricesRecRaw = await getAssetPrices(tokens, folioConfig.chainId, await time.latest());

      // Normalize price records to lowercase keys
      const pricesRec: Record<string, { snapshotPrice: number }> = {};
      for (const [token, price] of Object.entries(pricesRecRaw)) {
        pricesRec[token.toLowerCase()] = price;
      }

      const basketValues = rawBalances.map(
        (bal: bigint, i: number) =>
          (pricesRec[tokens[i].toLowerCase()].snapshotPrice * Number(bal)) / Number(10n ** decimals[i]),
      );
      const totalBasketValue = basketValues.reduce((a: number, b: number) => a + b, 0);
      const targetBasketRatios = basketValues.map((value: number) => value / totalBasketValue);
      let targetBasketBigIntWeights = targetBasketRatios.map((weight: number): bigint =>
        bn((weight * 10 ** 18).toString()),
      );

      const initialAssetsRec: Record<string, bigint> = {};
      rawBalances.forEach((bal: bigint, i: number) => {
        initialAssetsRec[tokens[i]] = bal;
      });

      let targetBasketRec: Record<string, bigint> = {};
      targetBasketBigIntWeights.forEach((weight: bigint, i: number) => {
        targetBasketRec[tokens[i]] = weight;
      });

      if (tokens.length > 0 && targetBasketBigIntWeights.length > 0) {
        const ejectedSymbol = await getTokenNameAndSymbol(hre, tokens[0]);
        console.log(
          `💨 ejecting ${ejectedSymbol} $${(totalBasketValue * targetBasketRatios[0]).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} (${(Number(targetBasketBigIntWeights[0]) / 10 ** 18).toLocaleString("en-US", { style: "percent", minimumFractionDigits: 2, maximumFractionDigits: 2 })})`,
        );
        const complement =
          targetBasketBigIntWeights.reduce((a: bigint, b: bigint) => a + b, 0n) - targetBasketBigIntWeights[0];

        if (bn(complement.toString()) !== 0n) {
          for (let i = 1; i < targetBasketBigIntWeights.length; i++) {
            targetBasketBigIntWeights[i] += (targetBasketBigIntWeights[0] * targetBasketBigIntWeights[i]) / complement;
          }
        } else if (targetBasketBigIntWeights.length > 1) {
          if (targetBasketBigIntWeights[0] > 0n) {
            const weightToDistribute = targetBasketBigIntWeights[0] / BigInt(targetBasketBigIntWeights.length - 1);
            for (let i = 1; i < targetBasketBigIntWeights.length; i++) {
              targetBasketBigIntWeights[i] += weightToDistribute;
            }
          }
        }
        targetBasketBigIntWeights[0] = 0n;

        targetBasketRec = {};
        targetBasketBigIntWeights.forEach((weight: bigint, i: number) => {
          targetBasketRec[tokens[i]] = weight;
        });
      } else {
        console.warn(`Cannot perform ejection for ${folioConfig.name}: basket is empty or not properly initialized.`);
        return;
      }

      // Setup the rebalance
      await startRebalance(
        FolioVersion.V4,
        hre,
        { folio, folioLensTyped },
        { bidder, rebalanceManager, auctionLauncher, admin },
        tokens,
        targetBasketRec,
        pricesRec,
        0.5, // priceDeviation default
        false, // debug
      );

      // Execute the auctions
      await doAuctions(
        FolioVersion.V4,
        hre,
        { folio, folioLensTyped },
        { bidder, rebalanceManager, auctionLauncher, admin },
        tokens,
        initialSupply,
        initialAssetsRec,
        targetBasketRec,
        pricesRec,
        0.9, // finalStageAt
        false, // debug
      );
    });
  });
}
