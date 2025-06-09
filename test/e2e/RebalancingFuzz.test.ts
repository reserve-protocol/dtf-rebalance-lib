import { time } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import hre from "hardhat";
import { FOLIO_CONFIGS } from "./constants";
import { getAssetPrices, getTokenNameAndSymbol, bn } from "./utils";
import { initializeChainState, deployCommonContracts } from "./lib/setup";
import { runRebalance } from "./lib/rebalance-helpers";
import { Contract } from "ethers";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { AuctionRound } from "../../src/open-auction";

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
        return `${percentage.toFixed(2)}%`;
      });
      console.log(`${label} [${percentageStrings.join(", ")}]`);
    };

    const NUM_FUZZ_RUNS = 100;
    for (let i = 0; i < NUM_FUZZ_RUNS; i++) {
      it(`Basket randomization round ${i} for ${folioConfig.name} -- EJECT->FINAL`, async function () {
        this.timeout(60000);

        // --- Common setup for the round ---
        const [initialTokens, initialAmounts] = await folio.toAssets(10n ** 18n, 0);

        if (initialTokens.length === 0) {
          throw new Error(`Basket for ${folioConfig.name} is empty`);
        }

        const decimalsRec: Record<string, bigint> = {};
        for (const token of initialTokens) {
          decimalsRec[token] = await (await hre.ethers.getContractAt("IERC20Metadata", token)).decimals();
        }

        const pricesRec = await getAssetPrices(initialTokens, folioConfig.chainId, await time.latest());

        for (const token of initialTokens) {
          if (!pricesRec[token] || pricesRec[token].snapshotPrice === 0) {
            throw new Error(
              `missing price for token ${token} (${await getTokenNameAndSymbol(token).then((t) => t.symbol)}) for ${folioConfig.name}`,
            );
          }
        }

        const initialAmountsRec: Record<string, bigint> = {};
        initialTokens.forEach((token: string, idx: number) => {
          initialAmountsRec[token] = initialAmounts[idx];
        });

        const initialValuesRec: Record<string, number> = {};
        let totalInitialValue = 0;
        initialTokens.forEach((token: string) => {
          initialValuesRec[token] =
            (pricesRec[token].snapshotPrice * Number(initialAmountsRec[token])) / Number(10n ** decimalsRec[token]);
          totalInitialValue += initialValuesRec[token];
        });

        const initialBasket: Record<string, bigint> = {};
        initialTokens.forEach((token: string) => {
          initialBasket[token] = bn(((initialValuesRec[token] / totalInitialValue) * 10 ** 18).toString());
        });

        // --- First Rebalance: EJECT, up to 0.95 cap ---

        const randomShares = initialTokens.map((_: string) => BigInt(Math.floor(Math.random() * 999) + 1));
        const indexToEject = Math.floor(Math.random() * initialTokens.length);
        randomShares[indexToEject] = 0n; // eject random token
        const sumRandomShares = randomShares.reduce((a: bigint, b: bigint) => a + b, 0n);

        const targetBasketRec: Record<string, bigint> = {};
        initialTokens.forEach((token: string, k: number) => {
          targetBasketRec[token] = (randomShares[k] * 10n ** 18n) / sumRandomShares;
        });

        await logPercentages(`🎯 Target basket`, targetBasketRec, initialTokens);

        await logPercentages(`▶️  Initial state`, initialBasket, initialTokens);

        await runRebalance(
          hre,
          folioConfig,
          { folio, folioLensTyped },
          { bidder, rebalanceManager, auctionLauncher, admin },
          [...initialTokens],
          initialAmountsRec,
          targetBasketRec,
          0.95,
          true,
        );

        // --- Second Rebalance: FINAL ---

        const rebalance = await folio.getRebalance();
        if (rebalance.rebalanceType === AuctionRound.FINAL) {
          console.log("✅ went all the way to FINAL");
          return;
        }

        const [tokensAfterEject, amountsAfterEject] = await folio.toAssets(10n ** 18n, 0);

        const amountsAfterEjectRec: Record<string, bigint> = {};
        tokensAfterEject.forEach((token: string, idx: number) => {
          amountsAfterEjectRec[token] = amountsAfterEject[idx];
        });

        let totalIntermediateValue = 0;
        const intermediateTokenValuesRec: Record<string, number> = {};
        tokensAfterEject.forEach((token: string) => {
          const price = pricesRec[token].snapshotPrice;
          const amount = amountsAfterEjectRec[token] || 0n;
          const decimal = decimalsRec[token];

          intermediateTokenValuesRec[token] = (price * Number(amount)) / Number(10n ** decimal);
          totalIntermediateValue += intermediateTokenValuesRec[token];
        });

        const intermediateTargetWeightsRec: Record<string, bigint> = {};
        initialTokens.forEach((token: string) => {
          const tokenValue = intermediateTokenValuesRec[token] || 0;
          intermediateTargetWeightsRec[token] = bn(((tokenValue / totalIntermediateValue) * 10 ** 18).toString());
        });
        await logPercentages(`📊 Intermediate state`, intermediateTargetWeightsRec, initialTokens);

        const targetBasketForFinalRec: Record<string, bigint> = {};
        tokensAfterEject.forEach((token: string) => {
          targetBasketForFinalRec[token] = targetBasketRec[token];
        });

        await runRebalance(
          hre,
          folioConfig,
          { folio, folioLensTyped },
          { bidder, rebalanceManager, auctionLauncher, admin },
          [...tokensAfterEject],
          amountsAfterEjectRec,
          targetBasketForFinalRec,
          0.95,
          true,
        );

        const [finalTokens, amountsAfterFinal] = await folio.toAssets(10n ** 18n, 0);

        const amountsAfterFinalRec: Record<string, bigint> = {};
        finalTokens.forEach((token: string, idx: number) => {
          amountsAfterFinalRec[token] = amountsAfterFinal[idx];
        });

        let totalAfterFinalValue = 0;
        const finalTokenValuesRec: Record<string, number> = {};
        finalTokens.forEach((token: string) => {
          const price = pricesRec[token].snapshotPrice;
          const amount = amountsAfterFinalRec[token];
          const decimal = decimalsRec[token];

          finalTokenValuesRec[token] = (price * Number(amount)) / Number(10n ** decimal);
          totalAfterFinalValue += finalTokenValuesRec[token];
        });

        const finalTargetWeightsRec: Record<string, bigint> = {};
        finalTokens.forEach((token: string) => {
          finalTargetWeightsRec[token] = bn(
            ((finalTokenValuesRec[token] / totalAfterFinalValue) * 10 ** 18).toString(),
          );
        });
        await logPercentages(`✅ Final`, finalTargetWeightsRec, initialTokens);
        await logPercentages(`🎯 Target basket`, targetBasketRec, initialTokens);
      });
    }
  });
}
