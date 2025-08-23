import { task } from "hardhat/config";
import { HardhatRuntimeEnvironment } from "hardhat/types";
import { FOLIO_CONFIGS } from "./config";
import { initializeChainState, setupContractsAndSigners } from "./setup";
import { runRebalance } from "./rebalance-helpers";
import {
  getAssetPrices,
  calculateRebalanceMetrics,
  logPercentages,
  convertProposalPricesToUSD,
  simulateMarketPrices,
  createPriceLookup,
} from "./utils";
import { time } from "@nomicfoundation/hardhat-toolbox/network-helpers";

import FolioGovernorArtifact from "../out/FolioGovernor.sol/FolioGovernor.json";

task("simulate", "Run a live rebalance simulation for a governance proposal")
  .addParam("id", "The governance proposal ID")
  .addParam("symbol", "The Folio symbol (e.g., DFX, BED)")
  .addOptionalParam("deviation", "Price deviation setting (0-1, default 0.5 for MEDIUM)", "0.5")
  .addOptionalParam("block", "Block number to fork from (optional, defaults to latest)")
  .addOptionalParam("volatility", "Market volatility for price simulation (0-1, default 0.6 for 50%)", "0.5")
  .setAction(async (taskArgs, hre: HardhatRuntimeEnvironment) => {
    const { id, symbol, deviation, block, volatility } = taskArgs;
    const priceDeviationValue = parseFloat(deviation);
    const marketVolatility = parseFloat(volatility);

    // Validate proposal ID
    if (!id || id.toString().trim() === "") {
      throw new Error("Proposal ID is required");
    }

    if (priceDeviationValue < 0 || priceDeviationValue > 1) {
      throw new Error("Price deviation must be between 0 and 1");
    }

    if (marketVolatility < 0 || marketVolatility > 1) {
      throw new Error("Market volatility must be between 0 and 1");
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
    console.log(`📈 Market Volatility: ${(marketVolatility * 100).toFixed(0)}% annual`);
    console.log(`🔢 Fork Block: ${blockNumber ? blockNumber : "latest"}`);

    // Fork from specified block or latest
    await initializeChainState(hre, folioConfig, blockNumber);

    // Setup contracts and signers
    const { folio, folioLensTyped, bidder, admin, rebalanceManager, auctionLauncher } = await setupContractsAndSigners(
      hre,
      folioConfig,
    );
    // Check folio version compatibility
    let folioVersion: string;
    try {
      folioVersion = await folio.version();
    } catch (error) {
      throw new Error(`Failed to get folio version: ${error}. The folio contract may not be properly initialized.`);
    }

    if (folioVersion !== "4.0.0") {
      throw new Error(`Unsupported folio version: ${folioVersion}. This simulation requires version 4.0.0.`);
    }

    // Get governor contract
    const governor = await hre.ethers.getContractAt(FolioGovernorArtifact.abi, folioConfig.basketGovernor);

    // Get proposal state
    let proposalState;
    try {
      proposalState = Number(await governor.state(id)); // Convert to number for comparison
    } catch (error: any) {
      // Check if the error is due to a non-existent proposal
      if (error.message?.includes("reverted") || error.message?.includes("VM Exception")) {
        throw new Error(
          `Proposal ${id} does not exist at block ${blockNumber || "latest"}.\n` +
            `This could mean:\n` +
            `  - The proposal ID is incorrect\n` +
            `  - The proposal was created after block ${blockNumber || "latest"}\n` +
            `  - You're using the wrong governor address for this proposal`,
        );
      }
      throw new Error(`Failed to get proposal state: ${error}`);
    }
    const PROPOSAL_STATES = ["Pending", "Active", "Canceled", "Defeated", "Succeeded", "Queued", "Expired", "Executed"];
    console.log(`📊 Proposal State: ${PROPOSAL_STATES[proposalState]} (${proposalState})`);

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

    // Validate that the target contract is the folio
    if (event.args.targets[0].toLowerCase() !== folioConfig.folio.toLowerCase()) {
      throw new Error(
        `Proposal ${id} does not target the expected folio contract.\n` +
          `Expected: ${folioConfig.folio}\n` +
          `Found: ${event.args.targets[0]}\n` +
          `This proposal may be for a different folio or contract.`,
      );
    }

    // Decode the calldata to extract startRebalance parameters
    const iface = new hre.ethers.Interface([
      "function startRebalance(address[],(uint256,uint256,uint256)[],(uint256,uint256)[],(uint256,uint256,uint256),uint256,uint256)",
    ]);

    // Validate it's a startRebalance call
    let functionName: string;
    try {
      const parsed = iface.parseTransaction({ data: calldata });
      functionName = parsed?.name || "";
    } catch {
      functionName = "";
    }

    if (functionName !== "startRebalance") {
      throw new Error(
        `Proposal ${id} does not contain a startRebalance action.\n` +
          `Found function: ${functionName || "unknown"}\n` +
          `This simulation requires a proposal that calls startRebalance on the folio contract.`,
      );
    }

    let proposalTokens: string[];
    let proposalWeights: bigint[];
    let proposalPrices: { low: bigint; high: bigint }[];

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

      // Extract historical prices from proposal
      // PriceRange is a tuple of [low, high] in D27{nanoUSD/tok} format
      proposalPrices = decoded[2].map((p: any) => {
        if (Array.isArray(p)) {
          return { low: p[0], high: p[1] };
        } else {
          return { low: p.low, high: p.high };
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

    // Calculate current values and get decimals for all tokens
    const decimalsRec: Record<string, bigint> = {};
    const currentAmountsRec: Record<string, bigint> = {};

    // Get decimals for all tokens (current + proposal)
    for (const token of allTokens) {
      const tokenContract = await hre.ethers.getContractAt("IERC20Metadata", token);
      decimalsRec[token] = await tokenContract.decimals();
    }

    // Calculate real governance delay
    const currentTime = await time.latest();
    let governanceDelayDays: number;

    // Check if proposal needs queuing (has a timelock)
    const needsQueuing = await governor.proposalNeedsQueuing(id);

    // Get proposal timing information
    const proposalDeadline = await governor.proposalDeadline(id);

    // Get timelock delay if proposal needs queuing
    let timelockDelaySeconds = 0;
    if (needsQueuing) {
      // Get the timelock controller address from governor
      const timelockAddress = await governor.timelock();

      // Create timelock controller interface to query minimum delay
      const timelockAbi = [
        "function getMinDelay() view returns (uint256)",
        "function minDelay() view returns (uint256)",
      ];
      const timelock = new hre.ethers.Contract(timelockAddress, timelockAbi, hre.ethers.provider);

      // Try to fetch the minimum delay
      try {
        timelockDelaySeconds = Number(await timelock.getMinDelay());
      } catch {
        try {
          timelockDelaySeconds = Number(await timelock.minDelay());
        } catch (error) {
          throw new Error(`Could not fetch minimum delay from timelock at ${timelockAddress}: ${error}`);
        }
      }
    }

    if (proposalState === 0) {
      // Pending state
      // Proposal hasn't started voting yet
      // Get voting delay and voting period to calculate full timeline
      const votingDelay = await governor.votingDelay();
      const votingPeriod = await governor.votingPeriod();
      const totalSeconds = Number(votingDelay) + Number(votingPeriod) + timelockDelaySeconds;
      governanceDelayDays = totalSeconds / (24 * 60 * 60);
      console.log(
        `\n⏰ Governance Delay: ${governanceDelayDays.toFixed(2)} days (Proposal pending: ${(Number(votingDelay) / (24 * 60 * 60)).toFixed(2)} days delay + ${(Number(votingPeriod) / (24 * 60 * 60)).toFixed(2)} days voting + ${(timelockDelaySeconds / (24 * 60 * 60)).toFixed(2)} days timelock)`,
      );
    } else if (proposalState === 1) {
      // Active state
      // Calculate remaining voting time + timelock delay
      const remainingVotingSeconds = Math.max(0, Number(proposalDeadline) - currentTime);
      const totalRemainingSeconds = remainingVotingSeconds + timelockDelaySeconds;
      governanceDelayDays = totalRemainingSeconds / (24 * 60 * 60);
      console.log(
        `\n⏰ Governance Delay: ${governanceDelayDays.toFixed(2)} days (${(remainingVotingSeconds / (24 * 60 * 60)).toFixed(2)} days voting + ${(timelockDelaySeconds / (24 * 60 * 60)).toFixed(2)} days timelock)`,
      );
    } else if (proposalState === 4) {
      // Succeeded state
      // Voting has ended, only timelock delay remains
      governanceDelayDays = timelockDelaySeconds / (24 * 60 * 60);
      console.log(
        `\n⏰ Governance Delay: ${governanceDelayDays.toFixed(2)} days (Voting ended, ${(timelockDelaySeconds / (24 * 60 * 60)).toFixed(2)} days timelock pending)`,
      );
    } else if (proposalState === 5) {
      // Queued state
      // Proposal is queued, use ETA to calculate remaining time
      const proposalEta = await governor.proposalEta(id);
      const remainingSeconds = Math.max(0, Number(proposalEta) - currentTime);
      governanceDelayDays = remainingSeconds / (24 * 60 * 60);
      console.log(
        `\n⏰ Governance Delay: ${governanceDelayDays.toFixed(2)} days (Proposal is queued, ETA: ${new Date(Number(proposalEta) * 1000).toISOString()})`,
      );
    } else if (proposalState === 7) {
      // Executed state
      // Proposal has been executed, no delay
      governanceDelayDays = 0;
      console.log(`\n⏰ Governance Delay: 0 days (Proposal already executed)`);
    } else if (proposalState === 2 || proposalState === 3 || proposalState === 6) {
      // For Canceled (2), Defeated (3), or Expired (6) states - these proposals won't be executed
      throw new Error(
        `Cannot simulate rebalance for proposal in ${PROPOSAL_STATES[proposalState]} state.\n` +
          `Only proposals that are Pending, Active, Succeeded, Queued, or Executed can be simulated.`,
      );
    } else {
      // Unknown state
      throw new Error(
        `Unknown proposal state: ${proposalState}.\n` +
          `Expected one of: Pending (0), Active (1), Canceled (2), Defeated (3), Succeeded (4), Queued (5), Expired (6), Executed (7).`,
      );
    }

    // Get decimals array for proposal tokens (needed for price conversion)
    const proposalDecimals = proposalTokens.map((token) => decimalsRec[token]);

    // Get symbols for proposal tokens for better error messages
    const proposalSymbols: string[] = [];
    for (const token of proposalTokens) {
      const tokenContract = await hre.ethers.getContractAt("IERC20Metadata", token);
      const symbol = await tokenContract.symbol();
      proposalSymbols.push(symbol);
    }

    // Convert proposal prices from D27{nanoUSD/tok} to USD/wholeTok
    const historicalPrices = convertProposalPricesToUSD(proposalPrices, proposalDecimals, proposalSymbols);

    // Simulate market price movements during calculated governance delay
    const simulatedPriceData = simulateMarketPrices(historicalPrices, marketVolatility, governanceDelayDays);

    // Build price record for all tokens
    const prices: Record<string, { snapshotPrice: number }> = {};
    const priceChanges: { symbol: string; historical: number; simulated: number; change: string }[] = [];

    for (let i = 0; i < allTokens.length; i++) {
      const token = allTokens[i];
      const proposalIndex = proposalTokens.indexOf(token);

      if (proposalIndex >= 0) {
        // Use simulated price for tokens in the proposal
        prices[token] = simulatedPriceData[proposalIndex.toString()];
        const historicalPrice = historicalPrices[proposalIndex];
        const priceChange = ((prices[token].snapshotPrice / historicalPrice - 1) * 100).toFixed(2);
        const tokenContract = await hre.ethers.getContractAt("IERC20Metadata", token);
        const symbol = await tokenContract.symbol();
        // Store for later display
        priceChanges.push({
          symbol,
          historical: historicalPrice,
          simulated: prices[token].snapshotPrice,
          change: priceChange,
        });
      } else {
        // For tokens not in proposal, fetch current price (shouldn't happen normally)
        const currentPrices = await getAssetPrices([token], folioConfig.chainId, await time.latest());
        // Handle potential address casing mismatches from API
        const priceEntry = Object.entries(currentPrices).find(
          ([addr, _]) => addr.toLowerCase() === token.toLowerCase(),
        );
        prices[token] = priceEntry ? priceEntry[1] : { snapshotPrice: 0 };
        if (!priceEntry) {
          console.log(`   Warning: No price found for ${token}`);
        }
      }
    }

    // Store current amounts (set 0 for tokens not in current basket)
    for (const token of allTokens) {
      currentAmountsRec[token] = 0n;
    }
    for (let i = 0; i < currentTokens.length; i++) {
      currentAmountsRec[currentTokens[i]] = currentAmounts[i];
    }

    // Build target basket from proposal - we know we have valid data at this point
    // Weights from proposals are in D27{tok/BU} format where tok and BU are smallest units
    // These are NOT percentages - they represent absolute token amounts per basket unit
    // tok is smallest unit (e.g., satoshis for BTC, wei for ETH)
    const targetBasketRec: Record<string, bigint> = {};
    for (let i = 0; i < proposalTokens.length; i++) {
      targetBasketRec[proposalTokens[i]] = proposalWeights[i];
    }

    // Create price lookup helper
    const priceLookup = createPriceLookup(prices);

    // Calculate current basket values
    let totalCurrentValue = 0;
    const currentValues: Record<string, number> = {};

    for (const token of currentTokens) {
      const index = currentTokens.indexOf(token);
      const balance = currentAmounts[index];
      const decimals = decimalsRec[token];
      const tokenPrice = priceLookup.getPrice(token);
      const dollarValue = (tokenPrice * Number(balance)) / Number(10n ** decimals);
      currentValues[token] = dollarValue;
      totalCurrentValue += dollarValue;
    }

    // Calculate proposed basket value breakdown
    let totalProposedValue = 0;
    const proposedValues: Record<string, number> = {};

    // Initialize proposedValues for all tokens to 0
    for (const token of allTokens) {
      proposedValues[token] = 0;
    }

    for (const token of proposalTokens) {
      const weight = targetBasketRec[token] || 0n;
      const decimals = decimalsRec[token];
      const tokenPrice = priceLookup.getPrice(token);

      // Weight is in D27{tok/BU} format where tok and BU are smallest units
      // To get whole tokens per whole BU:
      // wholeTokensPerWholeBU = weight / (10^27 / 10^18 * 10^tokenDecimals)
      //                        = weight * 10^18 / (10^27 * 10^tokenDecimals)
      //                        = weight / (10^9 * 10^tokenDecimals)
      const wholeTokensPerWholeBU = Number(weight) / (Number(10n ** 9n) * Number(10n ** decimals));
      const dollarValuePerBU = wholeTokensPerWholeBU * tokenPrice;

      proposedValues[token] = dollarValuePerBU;
      totalProposedValue += dollarValuePerBU;
    }

    // Display combined basket breakdown comparison
    console.log(`\n📊 Proposal:`);
    console.log(`   Token     Current → Proposed`);
    console.log(`   --------- ------- → --------`);

    // Get all unique tokens from both baskets
    const allUniqueTokens = new Set([...currentTokens, ...proposalTokens]);

    for (const token of allUniqueTokens) {
      const tokenContract = await hre.ethers.getContractAt("IERC20Metadata", token);
      const symbol = await tokenContract.symbol();

      // Current percentage
      const currentPercentage = currentValues[token] ? (currentValues[token] / totalCurrentValue) * 100 : 0;
      const currentStr = currentPercentage > 0 ? `${currentPercentage.toFixed(2)}%` : "    -";

      // Proposed percentage
      const proposedPercentage = proposedValues[token] ? (proposedValues[token] / totalProposedValue) * 100 : 0;
      const proposedStr = proposedPercentage > 0 ? `${proposedPercentage.toFixed(2)}%` : "    -";

      // Status indicator
      let status = "";
      if (currentPercentage === 0 && proposedPercentage > 0) {
        status = " (NEW)";
      } else if (currentPercentage > 0 && proposedPercentage === 0) {
        status = " (REMOVE)";
      }

      // Only show if token exists in either basket
      if (currentPercentage > 0 || proposedPercentage > 0) {
        console.log(`   ${symbol.padEnd(9)} ${currentStr.padStart(7)} → ${proposedStr.padEnd(7)}${status}`);
      }
    }

    // Log basket weights (raw format for reference)
    console.log(`\n📐 Basket weights (D27{tok/BU} format):`);

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

    // Display price changes
    console.log(`\n📈 Simulated price changes (${(marketVolatility * 100).toFixed(0)}% vol)`);
    for (const priceChange of priceChanges) {
      console.log(
        `   ${priceChange.symbol}: $${priceChange.historical.toFixed(2)} → $${priceChange.simulated.toFixed(2)} (${priceChange.change}%)`,
      );
    }

    const totalRebalancedValue = await runRebalance(
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
      true, // useSimulatedPrices - we're using simulated prices from proposal
      governanceDelayDays, // pass the calculated governance delay
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
      normalizedTargetRec[token] =
        totalTargetWeight > 0n ? (targetBasketArray[i] * 10n ** 18n) / totalTargetWeight : 0n;
    });

    // Calculate metrics
    const metrics = await calculateRebalanceMetrics(
      hre,
      folio,
      allTokens,
      normalizedTargetRec,
      prices,
      weightControl,
      folioConfig.chainId,
    );

    // Log the results
    logPercentages(`🔍 Final    `, metrics.finalTargetBasketRec, allTokens);
    logPercentages(`🎯 Target   `, normalizedTargetRec, allTokens);

    if (metrics.totalError > 0.0001) {
      // 0.01% = 1 basis point
      console.log(`⚠️  Error     ${(metrics.totalError * 100).toFixed(4)}%`);
      if (metrics.totalError > 0.01) {
        // 1% error threshold
        console.log(`\n⚠️  Warning: Total error exceeds 1%`);
      }
    } else {
      console.log(`✅ Error     ${(metrics.totalError * 100).toFixed(4)}%`);
    }

    console.log(
      `\n💰 Total Rebalanced Value: $${totalRebalancedValue.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
    );
    console.log(
      `💼 Total Portfolio Value: $${metrics.totalValueAfterFinal.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
    );
  });
