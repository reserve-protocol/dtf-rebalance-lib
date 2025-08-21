import { task } from "hardhat/config";
import { HardhatRuntimeEnvironment } from "hardhat/types";
import { FOLIO_CONFIGS } from "./config";
import { initializeChainState, setupContractsAndSigners } from "./setup";
import { runRebalance } from "./rebalance-helpers";
import { getAssetPrices } from "./utils";
import { time } from "@nomicfoundation/hardhat-toolbox/network-helpers";

import IGovernorArtifact from "../out/IGovernor.sol/IGovernor.json";

task("live-rebalance-simulation", "Run a live rebalance simulation for a governance proposal")
  .addParam("proposalid", "The governance proposal ID")
  .addParam("foliosymbol", "The Folio symbol (e.g., DFX, BED)")
  .setAction(async (taskArgs, hre: HardhatRuntimeEnvironment) => {
    const { proposalid, foliosymbol } = taskArgs;

    // Find folio configuration
    const folioConfig = FOLIO_CONFIGS.find((f) => f.name.toUpperCase() === foliosymbol.toUpperCase());
    if (!folioConfig) {
      throw new Error(`Folio configuration not found for symbol: ${foliosymbol}`);
    }

    if (!folioConfig.basketGovernor) {
      throw new Error(`basketGovernor address not configured for ${foliosymbol}`);
    }

    console.log(`\n🚀 Starting live rebalance simulation for ${folioConfig.name}...`);
    console.log(`📋 Proposal ID: ${proposalid}`);
    console.log(`🏛️  Governor: ${folioConfig.basketGovernor}`);

    // Fork from latest block
    await initializeChainState(hre, folioConfig);

    // Setup contracts and signers
    const { folio, folioLensTyped, bidder, admin, rebalanceManager, auctionLauncher } = await setupContractsAndSigners(
      hre,
      folioConfig,
    );

    // Get governor contract
    const governor = await hre.ethers.getContractAt(IGovernorArtifact.abi, folioConfig.basketGovernor);

    // Get proposal state
    const proposalState = await governor.state(proposalid);
    const PROPOSAL_STATES = ["Pending", "Active", "Canceled", "Defeated", "Succeeded", "Queued", "Expired", "Executed"];
    console.log(`📊 Proposal State: ${PROPOSAL_STATES[proposalState]}`);

    // Get proposal details - this will contain the calldata
    const proposalActions = await governor.getActions(proposalid);
    console.log(`\n🔍 Analyzing proposal with ${proposalActions[0].length} actions...`);

    // Extract tokens, weights, and prices from the proposal calldata
    let proposalTokens: string[] = [];
    let proposalWeights: bigint[] = [];

    // Decode the calldata to extract startRebalance parameters
    if (proposalActions[0].length > 0 && proposalActions[3].length > 0) {
      const calldata = proposalActions[3][0]; // First action's calldata

      // The startRebalance function signature and parameter decoding
      const iface = new hre.ethers.Interface([
        "function startRebalance(address[] tokens, (uint256,uint256)[] weights, (uint256,uint256,uint256)[] prices, (uint256,uint256,uint256) limits, uint256 restrictedUntil, uint256 availableUntil)",
      ]);

      try {
        const decoded = iface.decodeFunctionData("startRebalance", calldata);
        proposalTokens = decoded[0];
        proposalWeights = decoded[1].map((w: any) => w[1]); // Get target weight from WeightRange

        console.log(`📊 Proposal contains ${proposalTokens.length} tokens`);
      } catch (error) {
        console.log("⚠️  Could not decode proposal calldata, using example weights");
      }
    }

    // Get current basket
    const [currentTokens, currentAmounts] = await folio.totalAssets();
    console.log(`\n📦 Current basket has ${currentTokens.length} tokens`);

    // Get prices
    const prices = await getAssetPrices(currentTokens, folioConfig.chainId, await time.latest());

    // Calculate current values
    const decimalsRec: Record<string, bigint> = {};
    const currentAmountsRec: Record<string, bigint> = {};

    for (let i = 0; i < currentTokens.length; i++) {
      const token = currentTokens[i];
      const tokenContract = await hre.ethers.getContractAt("IERC20Metadata", token);
      decimalsRec[token] = await tokenContract.decimals();
      currentAmountsRec[token] = currentAmounts[i];
    }

    // Build target basket from proposal or use example
    const targetBasketRec: Record<string, bigint> = {};

    if (proposalTokens.length > 0 && proposalWeights.length === proposalTokens.length) {
      // Use weights from proposal
      for (let i = 0; i < proposalTokens.length; i++) {
        targetBasketRec[proposalTokens[i]] = proposalWeights[i];
      }
    } else {
      // Fallback: Example that ejects first token and redistributes weights
      const totalWeight = 10n ** 18n;
      for (let i = 0; i < currentTokens.length; i++) {
        if (i === 0) {
          targetBasketRec[currentTokens[i]] = 0n; // Eject first token
        } else {
          // Distribute weight evenly among remaining tokens
          targetBasketRec[currentTokens[i]] = totalWeight / BigInt(currentTokens.length - 1);
        }
      }
    }

    // Log target basket
    console.log(`\n🎯 Target basket weights:`);
    const totalWeight = 10n ** 18n;
    for (const token of currentTokens) {
      const weight = targetBasketRec[token] || 0n;
      const percentage = ((Number(weight) / Number(totalWeight)) * 100).toFixed(2);
      const tokenContract = await hre.ethers.getContractAt("IERC20Metadata", token);
      const symbol = await tokenContract.symbol();
      console.log(`   ${symbol}: ${percentage}%`);
    }

    // Run the rebalance simulation
    console.log(`\n⚡ Running rebalance simulation...`);

    await runRebalance(
      hre,
      folioConfig,
      { folio, folioLensTyped },
      { bidder, rebalanceManager, auctionLauncher, admin },
      currentTokens,
      currentAmountsRec,
      targetBasketRec,
      prices,
      0.95, // finalStageAt
      false, // debug
    );

    console.log(`\n✅ Rebalance simulation completed successfully!`);
  });
