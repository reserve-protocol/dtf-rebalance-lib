import { time } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import hre from "hardhat";
import { FOLIO_CONFIGS } from "./constants";
import { getAssetPrices, getTokenNameAndSymbol, bn } from "./utils";
import { initializeChainState, deployCommonContracts } from "./lib/setup";
import { runRebalance } from "./lib/rebalance-helpers";
import { Contract } from "ethers";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

for (const folioConfig of FOLIO_CONFIGS) {
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
      await initializeChainState(hre, folioConfig);

      const contractsAndSigners = await deployCommonContracts(hre, folioConfig);

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
      const [tokens] = await folio.toAssets(10n ** 18n, 0);
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

        for (const token of orderedTokens) {
          if (!pricesRec[token] || pricesRec[token].snapshotPrice === 0) {
            throw new Error(
              `missing price for token ${token} (${await getTokenNameAndSymbol(token).then((t) => t.symbol)}) for ${folioConfig.name}`,
            );
          }
        }

        const [initialTokens, initialAmounts] = await folio.toAssets(10n ** 18n, 0);

        const initialAmountsRec: Record<string, bigint> = {};
        orderedTokens.forEach((token: string) => {
          initialAmountsRec[token] = initialAmounts[initialTokens.indexOf(token)];
        });

        const initialValuesRec: Record<string, number> = {};
        let totalInitialValue = 0;
        orderedTokens.forEach((token: string) => {
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
          0.95,
          false,
        );

        // --- Verify final state ---

        const [finalTokens, amountsAfterFinal] = await folio.toAssets(10n ** 18n, 0);

        const amountsAfterFinalRec: Record<string, bigint> = {};
        orderedTokens.forEach((token: string) => {
          amountsAfterFinalRec[token] = amountsAfterFinal[finalTokens.indexOf(token)];
        });

        let totalAfterFinalValue = 0;
        const finalTokenValuesRec: Record<string, number> = {};
        orderedTokens.forEach((token: string) => {
          const price = pricesRec[token].snapshotPrice;
          const amount = amountsAfterFinalRec[token];
          const decimal = decimalsRec[token];

          finalTokenValuesRec[token] = (price * Number(amount)) / Number(10n ** decimal);
          totalAfterFinalValue += finalTokenValuesRec[token];
        });

        const finalTargetBasketRec: Record<string, bigint> = {};
        orderedTokens.forEach((token: string) => {
          finalTargetBasketRec[token] = bn(((finalTokenValuesRec[token] / totalAfterFinalValue) * 10 ** 18).toString());
        });
        await logPercentages(`\n✅ Final    `, finalTargetBasketRec, orderedTokens);
        await logPercentages(`🎯 Target   `, targetBasketRec, orderedTokens);
        console.log("");
      });
    }
  });
}
