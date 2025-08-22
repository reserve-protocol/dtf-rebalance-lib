import { time } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import hre from "hardhat";
import { FOLIO_CONFIGS, CHAIN_BLOCK_NUMBERS } from "../../tasks/config";
import { getAssetPrices } from "../../tasks/utils";
import { initializeChainState, setupContractsAndSigners } from "../../tasks/setup";
import { runRebalance } from "../../tasks/rebalance-helpers";
import { Contract } from "ethers";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { bn } from "../../src/numbers";

// Only test BGCI for now
const TEST_FOLIO_CONFIGS = FOLIO_CONFIGS.filter((f) => f.name === "BGCI");

for (const folioConfig of TEST_FOLIO_CONFIGS) {
  describe("Fuzzing " + folioConfig.name, function () {
    // Declare variables to hold contract instances and signers across rounds
    let folio: Contract;
    let folioLensTyped: Contract;
    let admin: HardhatEthersSigner;
    let bidder: HardhatEthersSigner;
    let rebalanceManager: HardhatEthersSigner;
    let auctionLauncher: HardhatEthersSigner;

    before(async function () {
      this.timeout(60000);
      const blockNumber = CHAIN_BLOCK_NUMBERS[folioConfig.chainId];
      await initializeChainState(hre, folioConfig, blockNumber);

      const contractsAndSigners = await setupContractsAndSigners(hre, folioConfig);

      folio = contractsAndSigners.folio;
      folioLensTyped = contractsAndSigners.folioLensTyped;
      admin = contractsAndSigners.admin;
      bidder = contractsAndSigners.bidder;
      rebalanceManager = contractsAndSigners.rebalanceManager;
      auctionLauncher = contractsAndSigners.auctionLauncher;
    });

    const logPercentages = async (
      label: string,
      targetBasketWeights: Record<string, bigint>,
      orderedTokensForLog: string[],
    ) => {
      const percentageStrings = orderedTokensForLog.map((token) => {
        const weight = targetBasketWeights[token] || 0n; // Handle cases where a token might not be in the weights
        const percentage = (Number(weight) / Number(10n ** 18n)) * 100;
        return percentage === 0 ? "00.00%" : `${percentage.toFixed(2)}%`;
      });
      console.log(`${label} [${percentageStrings.join(", ")}]`);
    };

    // Initialize tokens once outside the loop to keep them constant
    let orderedTokens: string[];
    let decimalsRec: Record<string, bigint> = {};

    before(async function () {
      // Get initial tokens and their decimals once
      const [tokens] = await folio.totalAssets();
      orderedTokens = [...tokens];

      for (const token of orderedTokens) {
        decimalsRec[token] = await (await hre.ethers.getContractAt("IERC20Metadata", token)).decimals();
      }
    });

    const NUM_FUZZ_RUNS = 100;
    for (let i = 0; i < NUM_FUZZ_RUNS; i++) {
      it(`Basket randomization round ${i} for ${folioConfig.name} -- EJECT->FINAL`, async function () {
        this.timeout(60000);

        // --- Common setup for the round ---

        const pricesRec = await getAssetPrices(orderedTokens, folioConfig.chainId, await time.latest());

        const [initialTokens, initialAmounts] = await folio.totalAssets();

        const initialAmountsRec: Record<string, bigint> = {};
        orderedTokens.forEach((token: string) => {
          initialAmountsRec[token] = initialAmounts[initialTokens.indexOf(token)];
        });

        const initialValuesRec: Record<string, number> = {};
        let totalInitialValue = 0;
        orderedTokens.forEach((token: string) => {
          if (pricesRec[token].snapshotPrice == 0) {
            throw new Error(`price for token ${token} is 0`);
          }

          initialValuesRec[token] =
            (pricesRec[token].snapshotPrice * Number(initialAmountsRec[token])) / Number(10n ** decimalsRec[token]);
          totalInitialValue += initialValuesRec[token];
        });

        const initialBasket: Record<string, bigint> = {};
        orderedTokens.forEach((token: string) => {
          initialBasket[token] = bn(((initialValuesRec[token] / totalInitialValue) * 10 ** 18).toString());
        });

        // --- Generate target with one token ejected ---

        const randomShares = orderedTokens.map((_: string) => BigInt(Math.floor(Math.random() * 999) + 1));
        const indexToEject = Math.floor(Math.random() * orderedTokens.length);
        randomShares[indexToEject] = 0n; // eject random token
        const sumRandomShares = randomShares.reduce((a: bigint, b: bigint) => a + b, 0n);

        const targetBasketRec: Record<string, bigint> = {};
        orderedTokens.forEach((token: string, k: number) => {
          targetBasketRec[token] = (randomShares[k] * 10n ** 18n) / sumRandomShares;
        });

        await logPercentages(`\nNew Target  `, targetBasketRec, orderedTokens);

        // --- Single rebalance call that handles both EJECT and FINAL auctions ---

        await runRebalance(
          hre,
          folioConfig,
          { folio, folioLensTyped },
          { bidder, rebalanceManager, auctionLauncher, admin },
          [...orderedTokens],
          initialAmountsRec,
          targetBasketRec,
          pricesRec,
          0.9,
          false,
        );

        // --- Verify final state ---

        // only used for NATIVE (weightControl=true)
        const finalPricesRec = await getAssetPrices(orderedTokens, folioConfig.chainId, await time.latest());

        const [finalTokens, balancesAfterFinal] = await folio.totalAssets();

        const balancesAfterFinalRec: Record<string, bigint> = {};
        orderedTokens.forEach((token: string) => {
          const idx = finalTokens.indexOf(token);
          balancesAfterFinalRec[token] = idx >= 0 ? balancesAfterFinal[idx] : 0n;
        });

        const [weightControl] = await folio.rebalanceControl();

        // these value calculations have to use the initial prices, not current prices
        let totalValueAfterFinal = 0;
        const finalTokenValuesRec: Record<string, number> = {};
        orderedTokens.forEach((token: string) => {
          const price = weightControl ? finalPricesRec[token].snapshotPrice : pricesRec[token].snapshotPrice;
          const bal = balancesAfterFinalRec[token];
          const decimal = decimalsRec[token];

          finalTokenValuesRec[token] = (price * Number(bal)) / Number(10n ** decimal);
          totalValueAfterFinal += finalTokenValuesRec[token];
        });

        const finalTargetBasketRec: Record<string, bigint> = {};
        orderedTokens.forEach((token: string) => {
          finalTargetBasketRec[token] = bn(((finalTokenValuesRec[token] / totalValueAfterFinal) * 10 ** 18).toString());
        });

        // verify we hit the original intended target, within 1 bps
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

        await logPercentages(`\n🔍 Final    `, finalTargetBasketRec, orderedTokens);
        await logPercentages(`🎯 Target   `, targetBasketRec, orderedTokens);

        if (totalError > 10n ** 14n) {
          console.log(`⚠️ Error     ${(totalError * 100).toFixed(2)}%\n`);
          throw new Error("Total error is too high");
        } else {
          console.log(`✅ Error     ${(totalError * 100).toFixed(2)}%\n`);
        }
      });
    }
  });
}
