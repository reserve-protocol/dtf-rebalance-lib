import { task } from "hardhat/config";
import { HardhatRuntimeEnvironment } from "hardhat/types";
import { FOLIO_CONFIGS } from "./config";
import { initializeChainState, setupContractsAndSigners } from "./setup";
import { runRebalance } from "./rebalance-helpers";
import { getAssetPrices, calculateRebalanceMetrics, logPercentages } from "./utils";
import { time } from "@nomicfoundation/hardhat-toolbox/network-helpers";

import IGovernorArtifact from "../out/IGovernor.sol/IGovernor.json";

task("simulate", "Run a live rebalance simulation for a governance proposal")
  .addParam("id", "The governance proposal ID")
  .addParam("symbol", "The Folio symbol (e.g., DFX, BED)")
  .addOptionalParam("deviation", "Price deviation setting (0-1, default 0.5 for MEDIUM)", "0.5")
  .addOptionalParam("block", "Block number to fork from (optional, defaults to latest)")
  .setAction(async (taskArgs, hre: HardhatRuntimeEnvironment) => {
    const { id, symbol, deviation, block } = taskArgs;
    const priceDeviationValue = parseFloat(deviation);

    if (priceDeviationValue < 0 || priceDeviationValue > 1) {
      throw new Error("Price deviation must be between 0 and 1");
    }

    // Parse and validate block number if provided
    let blockNumber: number | undefined;
    if (block) {
      blockNumber = parseInt(block);
      if (isNaN(blockNumber) || blockNumber < 0) {
        throw new Error("Block number must be a valid positive integer");
      }
    }

    // Find folio configuration
    const folioConfig = FOLIO_CONFIGS.find((f) => f.name.toUpperCase() === symbol.toUpperCase());
    if (!folioConfig) {
      throw new Error(`Folio configuration not found for symbol: ${symbol}`);
    }

    if (!folioConfig.basketGovernor) {
      throw new Error(`basketGovernor address not configured for ${symbol}`);
    }

    console.log(`\n🚀 Starting live rebalance simulation for ${folioConfig.name}...`);
    console.log(`📋 Proposal ID: ${id}`);
    console.log(`🏛️  Governor: ${folioConfig.basketGovernor}`);
    console.log(
      `📊 Price Deviation: ${priceDeviationValue} (${priceDeviationValue <= 0.3 ? "NARROW" : priceDeviationValue <= 0.7 ? "MEDIUM" : "WIDE"})`,
    );
    console.log(`🔢 Fork Block: ${blockNumber ? blockNumber : "latest"}`);

    // Fork from specified block or latest
    await initializeChainState(hre, folioConfig, blockNumber);

    // Setup contracts and signers
    const { folio, folioLensTyped, bidder, admin, rebalanceManager, auctionLauncher } = await setupContractsAndSigners(
      hre,
      folioConfig,
    );
    if ((await folio.version()) != "4.0.0") {
      throw new Error("Folio version is not 4.0.0");
    }

    // Get governor contract
    const governor = await hre.ethers.getContractAt(IGovernorArtifact.abi, folioConfig.basketGovernor);

    // Get proposal state
    let proposalState;
    try {
      proposalState = await governor.state(id);
    } catch (error) {
      throw new Error(`Failed to get proposal state: ${error}`);
    }
    const PROPOSAL_STATES = ["Pending", "Active", "Canceled", "Defeated", "Succeeded", "Queued", "Expired", "Executed"];
    console.log(`📊 Proposal State: ${PROPOSAL_STATES[proposalState]}`);

    // Query ProposalCreated events to get the proposal data
    console.log(`\n🔍 Fetching proposal data from event logs...`);

    // Get all ProposalCreated events (proposalId is not indexed, so we can't filter by it)
    const filter = governor.filters.ProposalCreated();
    const events = await governor.queryFilter(filter);

    // Find the event for our specific proposal ID
    const event = events.find((e) => {
      if ("args" in e && e.args) {
        return e.args.proposalId?.toString() === id.toString();
      }
      return false;
    });

    if (!event) {
      throw new Error(
        `No ProposalCreated event found for proposal ID ${id}.\n` +
          `This might mean:\n` +
          `  - The proposal doesn't exist\n` +
          `  - The proposal ID is incorrect\n` +
          `  - The block range doesn't include the proposal creation`,
      );
    }

    console.log(`✅ Found ProposalCreated event for proposal ${id}`);

    // Extract the calldata from the event
    if (!("args" in event) || !event.args?.calldatas || event.args.calldatas.length === 0) {
      throw new Error(
        `Proposal ${id} does not contain any actions.\n` + `Expected a startRebalance action in the proposal.`,
      );
    }

    // Get the first action's calldata (should be the startRebalance call)
    const calldata = event.args.calldatas[0];
    console.log(`   Found ${event.args.calldatas.length} action(s) in proposal`);

    // Decode the calldata to extract startRebalance parameters
    const iface = new hre.ethers.Interface([
      "function startRebalance(address[],(uint256,uint256,uint256)[],(uint256,uint256)[],(uint256,uint256,uint256),uint256,uint256)",
    ]);

    let proposalTokens: string[];
    let proposalWeights: bigint[];

    try {
      const decoded = iface.decodeFunctionData("startRebalance", calldata);
      proposalTokens = decoded[0];
      // WeightRange is a tuple of [low, spot, high], get spot weight (index 1)
      // These weights are in D27{tok/BU} format - tokens per basket unit with 27 decimals
      // They represent absolute amounts, NOT percentages
      proposalWeights = decoded[1].map((w: any) => {
        // Handle both array and object access patterns
        if (Array.isArray(w)) {
          return w[1]; // spot weight is at index 1
        } else if (w.spot !== undefined) {
          return w.spot;
        } else {
          return w[1]; // fallback to array access
        }
      });

      console.log(`📊 Proposal contains ${proposalTokens.length} tokens`);
    } catch (error) {
      throw new Error(
        `Could not decode proposal calldata.\n` +
          `The proposal may not contain a valid startRebalance action.\n` +
          `Error: ${error}`,
      );
    }

    // Get current basket
    const [currentTokens, currentAmounts] = await folio.totalAssets();
    console.log(`\n📦 Current basket has ${currentTokens.length} tokens`);

    // Get unique set of all tokens (current + proposal)
    const allTokensSet = new Set([...currentTokens, ...proposalTokens]);
    const allTokens = Array.from(allTokensSet);
    console.log(`📊 Total unique tokens across current and proposal: ${allTokens.length}`);

    // Get prices for all tokens
    const prices = await getAssetPrices(allTokens, folioConfig.chainId, await time.latest());

    // Calculate current values and get decimals for all tokens
    const decimalsRec: Record<string, bigint> = {};
    const currentAmountsRec: Record<string, bigint> = {};

    // Get decimals for all tokens (current + proposal)
    for (const token of allTokens) {
      const tokenContract = await hre.ethers.getContractAt("IERC20Metadata", token);
      decimalsRec[token] = await tokenContract.decimals();
    }

    // Store current amounts (set 0 for tokens not in current basket)
    for (const token of allTokens) {
      currentAmountsRec[token] = 0n;
    }
    for (let i = 0; i < currentTokens.length; i++) {
      currentAmountsRec[currentTokens[i]] = currentAmounts[i];
    }

    // Build target basket from proposal - we know we have valid data at this point
    // Weights from proposals are in D27{tok/BU} format (tokens per basket unit with 27 decimals)
    // These are NOT percentages - they represent absolute token amounts per basket unit
    const targetBasketRec: Record<string, bigint> = {};
    for (let i = 0; i < proposalTokens.length; i++) {
      targetBasketRec[proposalTokens[i]] = proposalWeights[i];
    }

    // Log target basket weights
    console.log(`\n🎯 Target basket weights (D27{tok/BU} format):`);
    
    for (const token of allTokens) {
      const weight = targetBasketRec[token] || 0n;
      if (weight > 0n) {
        const tokenContract = await hre.ethers.getContractAt("IERC20Metadata", token);
        const symbol = await tokenContract.symbol();
        const isNew = !currentTokens.includes(token) ? " (NEW)" : "";
        console.log(`   ${symbol}: ${weight.toString()}${isNew}`);
      }
    }

    // Run the rebalance simulation
    console.log(`\n⚡ Running rebalance simulation...`);

    await runRebalance(
      hre,
      folioConfig,
      { folio, folioLensTyped },
      { bidder, rebalanceManager, auctionLauncher, admin },
      allTokens,
      currentAmountsRec,
      targetBasketRec,
      prices,
      0.9, // finalStageAt
      false, // debug
      priceDeviationValue, // pass the configurable price deviation
    );

    console.log(`\n✅ Rebalance simulation completed successfully!`);
    
    // Calculate and display final metrics
    console.log(`\n📊 Final Rebalance Metrics:`);
    
    // Get weight control setting
    const [weightControl] = await folio.rebalanceControl();
    
    // Need to normalize targetBasketRec from D27{tok/BU} to D18{1} percentages for comparison
    const targetBasketArray = allTokens.map((token) => targetBasketRec[token] || 0n);
    const totalTargetWeight = targetBasketArray.reduce((a, b) => a + b, 0n);
    const normalizedTargetRec: Record<string, bigint> = {};
    allTokens.forEach((token, i) => {
      normalizedTargetRec[token] = totalTargetWeight > 0n 
        ? (targetBasketArray[i] * 10n ** 18n) / totalTargetWeight 
        : 0n;
    });
    
    // Calculate metrics
    const metrics = await calculateRebalanceMetrics(
      hre,
      folio,
      allTokens,
      normalizedTargetRec,
      prices,
      weightControl
    );
    
    // Log the results
    logPercentages(`🔍 Final    `, metrics.finalTargetBasketRec, allTokens);
    logPercentages(`🎯 Target   `, normalizedTargetRec, allTokens);
    
    if (metrics.totalError > 0.0001) {  // 0.01% = 1 basis point
      console.log(`⚠️  Error     ${(metrics.totalError * 100).toFixed(4)}%`);
      if (metrics.totalError > 0.01) {  // 1% error threshold
        console.log(`\n⚠️  Warning: Total error exceeds 1%`);
      }
    } else {
      console.log(`✅ Error     ${(metrics.totalError * 100).toFixed(4)}%`);
    }
    
    console.log(`\n💰 Total Value: $${metrics.totalValueAfterFinal.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
  });
