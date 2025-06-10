import { loadFixture, time } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import hre from "hardhat";
import { FOLIO_CONFIGS } from "./constants";
import { initializeChainState, deployCommonContracts } from "./lib/setup";
import { runRebalance } from "./lib/rebalance-helpers";
import { bn, getAssetPrices, getTokenNameAndSymbol } from "./utils";

for (const folioConfig of FOLIO_CONFIGS) {
  describe(folioConfig.name, function () {
    before(async function () {
      await initializeChainState(hre, folioConfig);
    });

    async function deployFixture() {
      return deployCommonContracts(hre, folioConfig);
    }

    it("Basic ejection", async function () {
      const { admin, folio, folioLensTyped, bidder, rebalanceManager, auctionLauncher } =
        await loadFixture(deployFixture);

      const supply = await folio.totalSupply();
      const [basket, rawAmounts] = await folio.toAssets(10n ** 18n, 0);
      const tokens = [...basket];

      const decimals = await Promise.all(
        tokens.map(async (asset: string) => (await hre.ethers.getContractAt("IERC20Metadata", asset)).decimals()),
      );

      const prices = await getAssetPrices(tokens, folioConfig.chainId, await time.latest());
      for (const [k, v] of Object.entries(prices)) {
        if (v.snapshotPrice === 0) {
          throw new Error(
            `missing price for token ${k} at block ${(await hre.ethers.provider.getBlock("latest"))?.number} and time ${await time.latest()}`,
          );
        }
      }

      const basketValues = rawAmounts.map(
        (amount: bigint, i: number) => (prices[tokens[i]].snapshotPrice * Number(amount)) / Number(10n ** decimals[i]),
      );
      const totalBasketValue = basketValues.reduce((a: number, b: number) => a + b, 0);
      const targetBasketRatios = basketValues.map((value: number) => value / totalBasketValue);
      let targetBasketBigIntWeights = targetBasketRatios.map((weight: number): bigint =>
        bn((weight * 10 ** 18).toString()),
      );

      const initialAmountsAsRecord: Record<string, bigint> = {};
      rawAmounts.forEach((amount: bigint, i: number) => {
        initialAmountsAsRecord[tokens[i]] = amount;
      });

      let targetWeightsAsRecord: Record<string, bigint> = {};
      targetBasketBigIntWeights.forEach((weight: bigint, i: number) => {
        targetWeightsAsRecord[tokens[i]] = weight;
      });

      if (tokens.length > 0 && targetBasketBigIntWeights.length > 0) {
        const { symbol: ejectedSymbol } = await getTokenNameAndSymbol(tokens[0]);
        console.log(
          `💨 ejecting ${ejectedSymbol} $${((totalBasketValue * Number(supply) * targetBasketRatios[0]) / 10 ** 18).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} (${(Number(targetBasketBigIntWeights[0]) / 10 ** 18).toLocaleString("en-US", { style: "percent", minimumFractionDigits: 2, maximumFractionDigits: 2 })})`,
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

        targetWeightsAsRecord = {};
        targetBasketBigIntWeights.forEach((weight: bigint, i: number) => {
          targetWeightsAsRecord[tokens[i]] = weight;
        });
      } else {
        console.warn(`Cannot perform ejection for ${folioConfig.name}: basket is empty or not properly initialized.`);
        return;
      }

      await runRebalance(
        hre,
        folioConfig,
        { folio, folioLensTyped },
        { bidder, rebalanceManager, auctionLauncher, admin },
        tokens,
        initialAmountsAsRecord,
        targetWeightsAsRecord,
        1,
        true,
      );
    });
  });
}
