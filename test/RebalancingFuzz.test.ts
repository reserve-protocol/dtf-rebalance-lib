import hre from "hardhat";
import { Contract } from "ethers";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { time } from "@nomicfoundation/hardhat-toolbox/network-helpers";

import { FolioVersion } from "../src/types";

import { getAssetPrices, logPercentages, normalizePrices } from "./utils";
import { initializeChainState, setupContractsAndSigners } from "./setup";
import { startRebalance } from "./start-rebalance";
import { doAuctions } from "./do-auctions";

import { FOLIO_CONFIGS, CHAIN_BLOCK_NUMBERS } from "./4.0.0/config";
// TODO test V5

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
    let initialTimestamp: number;

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

      // Capture initial timestamp for price fetching
      initialTimestamp = await time.latest();
    });

    // Initialize tokens once outside the loop to keep them constant
    let orderedTokens: string[];

    before(async function () {
      const [tokens] = await folio.totalAssets();
      orderedTokens = [...tokens];
    });

    const NUM_FUZZ_RUNS = 100;
    for (let i = 0; i < NUM_FUZZ_RUNS; i++) {
      it(`Basket randomization round ${i} for ${folioConfig.name} -- EJECT->FINAL`, async function () {
        this.timeout(60000);

        // --- Common setup for the round ---

        const pricesRecRaw = await getAssetPrices(orderedTokens, folioConfig.chainId, initialTimestamp);

        // Apply random price deviation for this round (between -10% and +10%)
        const maxPriceDeviation = 0.1; // 10% max deviation
        const priceDeviationFactors: Record<string, number> = {};
        orderedTokens.forEach((token: string) => {
          // Generate random deviation factor between 0.9 and 1.1
          priceDeviationFactors[token.toLowerCase()] = 1 - maxPriceDeviation + Math.random() * (2 * maxPriceDeviation);
        });

        // Normalize price records to lowercase keys and apply deviation
        const normalizedPrices = normalizePrices(pricesRecRaw);
        const pricesRec: Record<string, { snapshotPrice: number }> = {};
        for (const [token, price] of Object.entries(normalizedPrices)) {
          const factor = priceDeviationFactors[token] || 1;
          pricesRec[token] = {
            snapshotPrice: price.snapshotPrice * factor,
          };
        }
        const [tokens, assets] = await folio.totalAssets();
        const initialSupply = await folio.totalSupply();

        const assetsRec: Record<string, bigint> = {};
        orderedTokens.forEach((token: string) => {
          const idx = tokens.findIndex((t: string) => t.toLowerCase() === token.toLowerCase());
          // If token was ejected in previous round, it won't be in current assets
          assetsRec[token] = idx === -1 ? 0n : assets[idx];
        });

        // --- Generate target basket with one token ejected ---

        const randomShares = orderedTokens.map((_: string) => BigInt(Math.floor(Math.random() * 999) + 1));
        const indexToEject = Math.floor(Math.random() * orderedTokens.length);
        const tokenToEject = orderedTokens[indexToEject];
        randomShares[indexToEject] = 0n; // eject random token
        const sumRandomShares = randomShares.reduce((a: bigint, b: bigint) => a + b, 0n);

        const targetBasketRec: Record<string, bigint> = {};
        orderedTokens.forEach((token: string, k: number) => {
          targetBasketRec[token] = (randomShares[k] * 10n ** 18n) / sumRandomShares;
        });

        // Log initial portfolio value distribution
        let totalInitialValue = 0;
        const initialValues: Record<string, number> = {};
        for (const token of orderedTokens) {
          const price = pricesRec[token.toLowerCase()].snapshotPrice || 0;
          const decimals = await (await hre.ethers.getContractAt("IERC20Metadata", token)).decimals();
          const value = (price * Number(assetsRec[token])) / Number(10n ** decimals);
          initialValues[token] = value;
          totalInitialValue += value;
        }
        const initialPercentages = orderedTokens.map((token: string) => {
          const percentage = (initialValues[token] / totalInitialValue) * 100;
          return `${percentage.toFixed(2)}%`;
        });
        console.log(`Initial basket: [${initialPercentages.join(", ")}]`);

        const ejectSymbol = await (await hre.ethers.getContractAt("IERC20Metadata", tokenToEject)).symbol();
        const ejectValue = initialValues[tokenToEject];
        const ejectPercent = ((ejectValue / totalInitialValue) * 100).toFixed(2);
        console.log(
          `💨 ejecting ${ejectSymbol} at index ${indexToEject} (${ejectPercent}% of portfolio, $${ejectValue.toFixed(2)})`,
        );
        logPercentages(`\nNew Target  `, targetBasketRec, orderedTokens);

        // --- Setup the rebalance and execute auctions ---

        // Setup the rebalance
        await startRebalance(
          FolioVersion.V4,
          hre,
          { folio, folioLensTyped },
          { bidder, rebalanceManager, auctionLauncher, admin },
          orderedTokens,
          targetBasketRec,
          pricesRec,
          0.5, // priceDeviation default
          false, // debug
        );

        const auctionPriceDeviation = 0.1 + Math.random() * 0.1;

        // Generate random slippage range (between 0.1% and 1%)
        const minSlippage = 0.001 + Math.random() * 0.003; // 0.1% to 0.4%
        const maxSlippage = minSlippage + 0.002 + Math.random() * 0.004; // +0.2% to +0.6% more
        const swapSlippageRange: [number, number] = [minSlippage, maxSlippage];

        // Execute the auctions
        await doAuctions(
          FolioVersion.V4,
          hre,
          { folio, folioLensTyped },
          { bidder, rebalanceManager, auctionLauncher, admin },
          orderedTokens,
          initialSupply,
          assetsRec,
          targetBasketRec,
          pricesRec,
          0.9, // finalStageAt
          false, // debug
          auctionPriceDeviation, // Pass random auction deviation
          swapSlippageRange, // Pass random slippage range
        );
      });
    }
  });
}
