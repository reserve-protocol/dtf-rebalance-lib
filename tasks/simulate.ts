import { task } from "hardhat/config";
import { HardhatRuntimeEnvironment } from "hardhat/types";
import { FOLIO_CONFIGS } from "../src/test/config";
import { initializeChainState, setupContractsAndSigners } from "../src/test/setup";
import { doAuctions } from "../src/test/do-auctions";
import {
  calculateRebalanceMetrics,
  logPercentages,
  convertProposalPricesToUSD,
  simulateMarketPrices,
  createPriceLookup,
  whileImpersonating,
} from "../src/test/utils";
import { time } from "@nomicfoundation/hardhat-toolbox/network-helpers";

import FolioGovernorArtifact from "../out/FolioGovernor.sol/FolioGovernor.json";

task("simulate", "Run a live rebalance simulation for a governance proposal")
  .addParam("id", "The governance proposal ID")
  .addParam("symbol", "The Folio symbol (e.g., DFX, BED)")
  .addOptionalParam("block", "Block number to fork from (optional, defaults to latest)")
  .addOptionalParam("volatility", "Market volatility for price simulation (0-1, default 0.4 for 40%)", "0.4")
  .setAction(async (taskArgs, hre: HardhatRuntimeEnvironment) => {
    const { id, symbol, block, volatility } = taskArgs;
    const marketVolatility = parseFloat(volatility);

    // Validate proposal ID
    if (!id || id.toString().trim() === "") {
      throw new Error("Proposal ID is required");
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
    const governorAbi = [
      ...FolioGovernorArtifact.abi,
      "function queue(address[] targets, uint256[] values, bytes[] calldatas, bytes32 descriptionHash) returns (uint256)",
      "function execute(address[] targets, uint256[] values, bytes[] calldatas, bytes32 descriptionHash) payable returns (uint256)",
    ];
    const governor = await hre.ethers.getContractAt(governorAbi, folioConfig.basketGovernor);

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

    // Convert Result objects to plain arrays to avoid ethers v6 read-only issues
    // In ethers v6, event args are Result objects with array-like behavior
    const targets = event.args.targets as string[];
    const calldatas = event.args.calldatas as string[];
    // Handle values carefully - they should be numeric values for the proposal
    const rawValues = event.args.values;
    const values = Array.isArray(rawValues)
      ? rawValues.map((v: any) => {
          // Skip if it's not a valid value that can be converted to BigInt
          try {
            return BigInt(v.toString());
          } catch {
            return 0n; // Default to 0 for non-numeric values
          }
        })
      : [0n]; // Default to single zero value if not an array

    // Get the first action's calldata (should be the startRebalance call)
    const calldata = calldatas[0];
    console.log(`   Found ${calldatas.length} action(s) in proposal`);

    // Validate that the target contract is the folio
    if (targets[0] && targets[0].toLowerCase() !== folioConfig.folio.toLowerCase()) {
      throw new Error(
        `Proposal ${id} does not target the expected folio contract.\n` +
          `Expected: ${folioConfig.folio}\n` +
          `Found: ${targets[0]}\n` +
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
      const parsed = iface.parseTransaction({ data: calldata as string });
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
    let decoded: any; // Store decoded data for later use

    try {
      decoded = iface.decodeFunctionData("startRebalance", calldata as string);
      // Convert Result objects to plain arrays
      proposalTokens = decoded[0] as string[];
      // WeightRange is a tuple of [low, spot, high], get spot weight (index 1)
      // These weights are in D27{tok/BU} format - tokens per basket unit with 27 decimals
      // They represent absolute amounts, NOT percentages
      proposalWeights = (decoded[1] as any[]).map((w: any) => {
        // ethers v6 returns Result objects which need conversion
        return BigInt(w[1].toString()); // spot weight is at index 1
      });

      // Extract historical prices from proposal
      // PriceRange is a tuple of [low, high] in D27{nanoUSD/tok} format
      proposalPrices = (decoded[2] as any[]).map((p: any) => {
        return {
          low: BigInt(p[0].toString()),
          high: BigInt(p[1].toString()),
        };
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
    console.log(`   Current time: ${currentTime}`);
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
    // These are the baseline prices reverse-engineered from the proposal's high/low bounds
    const baselinePrices = convertProposalPricesToUSD(proposalPrices, proposalDecimals, proposalSymbols);

    // Apply random market movements to baseline prices for auction simulation
    // This simulates price changes that might occur during the governance delay
    const deviatedPriceData = simulateMarketPrices(baselinePrices, marketVolatility, governanceDelayDays);

    // Build two sets of price records:
    // 1. baselinePriceRec - for measurements and display (no deviation)
    // 2. auctionPriceRec - for auction execution (with random deviation)
    const baselinePriceRec: Record<string, { snapshotPrice: number }> = {};
    const auctionPriceRec: Record<string, { snapshotPrice: number }> = {};
    const priceChanges: { symbol: string; baseline: number; deviated: number; change: string }[] = [];

    // Build the complete price records - using lowercase keys for consistency
    for (let i = 0; i < allTokens.length; i++) {
      const token = allTokens[i];
      const tokenKey = token.toLowerCase(); // Use lowercase key for price lookups
      const proposalIndex = proposalTokens.indexOf(token);

      if (proposalIndex >= 0) {
        // Store baseline price (no deviation)
        const baseline = baselinePrices[proposalIndex];
        baselinePriceRec[tokenKey] = { snapshotPrice: baseline };
        
        // Store deviated price for auction simulation
        auctionPriceRec[tokenKey] = deviatedPriceData[proposalIndex.toString()];
        
        const priceChange = ((auctionPriceRec[tokenKey].snapshotPrice / baseline - 1) * 100).toFixed(2);
        const tokenContract = await hre.ethers.getContractAt("IERC20Metadata", token);
        const symbol = await tokenContract.symbol();
        
        // Store for later display
        priceChanges.push({
          symbol,
          baseline: baseline,
          deviated: auctionPriceRec[tokenKey].snapshotPrice,
          change: priceChange,
        });
      } else {
        // For tokens not in proposal (shouldn't happen in normal rebalancing),
        // we don't have price data. This will be caught by validation later.
        console.log(`   Warning: Token ${token} is in current basket but not in proposal - no price data available`);
        baselinePriceRec[tokenKey] = { snapshotPrice: 0 };
        auctionPriceRec[tokenKey] = { snapshotPrice: 0 };
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

    // Create price lookup helpers for both baseline and auction prices
    const baselinePriceLookup = createPriceLookup(baselinePriceRec);
    const auctionPriceLookup = createPriceLookup(auctionPriceRec);

    // Calculate current basket values
    let totalCurrentValue = 0;
    const currentValues: Record<string, number> = {};

    for (const token of currentTokens) {
      const index = currentTokens.indexOf(token);
      const balance = currentAmounts[index];
      const decimals = decimalsRec[token];
      const tokenPrice = baselinePriceLookup.getPrice(token);
      if (tokenPrice > 0) {
        const dollarValue = (tokenPrice * Number(balance)) / Number(10n ** decimals);
        currentValues[token] = dollarValue;
        totalCurrentValue += dollarValue;
      } else {
        // Skip tokens without prices in value calculation
        currentValues[token] = 0;
      }
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
      const tokenPrice = baselinePriceLookup.getPrice(token);

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

    // Display price changes from proposal baseline
    console.log(`\n📈 Price simulation (proposal baseline → ${governanceDelayDays.toFixed(1)} days later):`);
    for (const priceChange of priceChanges) {
      console.log(
        `   ${priceChange.symbol}: $${priceChange.baseline.toFixed(2)} → $${priceChange.deviated.toFixed(2)} (${priceChange.change}%)`,
      );
    }

    // Execute the proposal if not already executed
    if (proposalState !== 7) {
      console.log(`\n📝 Executing proposal ${id} in simulation...`);

      // Fast-forward to when proposal can be executed
      if (proposalState === 0 || proposalState === 1) {
        // Pending or Active - need to wait for voting to end
        const votingEnd = Number(await governor.proposalDeadline(id));
        await hre.network.provider.send("evm_setNextBlockTimestamp", [votingEnd + 1]);
        await hre.network.provider.send("evm_mine", []);
      }

      // Re-fetch the proposal state after fast-forwarding
      const currentProposalState = Number(await governor.state(id));

      // Queue the proposal if it needs queuing
      if (needsQueuing) {
        // Check if already queued
        const proposalEta = await governor.proposalEta(id);
        const isQueued = proposalEta > 0n;

        if (!isQueued && currentProposalState === 4) {
          try {
            // Use the already converted arrays from earlier
            const queueDescriptionHash = hre.ethers.id(event.args.description || "");

            await whileImpersonating(hre, await admin.getAddress(), async (signer) => {
              await (
                await (governor.connect(signer) as any).queue(
                  [...targets], // Create new arrays to avoid read-only issues
                  [...values],
                  [...calldatas],
                  queueDescriptionHash,
                )
              ).wait();
            });

            console.log(`✅ Proposal queued successfully`);
          } catch (error: any) {
            // If queue fails, it might already be queued or there's another issue
            // Try to proceed anyway
            console.log(`⚠️ Could not queue proposal (may already be queued). Attempting to proceed...`);
          }
        } else if (isQueued) {
          console.log(`✅ Proposal already queued`);
        }

        // Fast-forward past timelock delay
        const finalProposalEta = await governor.proposalEta(id);
        if (finalProposalEta > 0n) {
          await hre.network.provider.send("evm_setNextBlockTimestamp", [Number(finalProposalEta) + 1]);
          await hre.network.provider.send("evm_mine", []);
        }
      }

      // Execute the proposal
      // Use the already converted arrays from earlier
      const descriptionHash = hre.ethers.id(event.args.description || "");

      await whileImpersonating(hre, await admin.getAddress(), async (signer) => {
        await (
          await (governor.connect(signer) as any).execute(
            [...targets], // Create new arrays to avoid read-only issues
            [...values],
            [...calldatas],
            descriptionHash,
          )
        ).wait();
      });

      console.log(`✅ Proposal executed successfully`);
    } else {
      console.log(`\n✅ Proposal ${id} was already executed`);
    }

    // Capture initial state after proposal execution
    const [initialRebalanceTokens, initialAssets] = await folio.totalAssets();
    const initialSupply = await folio.totalSupply();

    // Create the initial state object needed for doAuctions
    // We need to reconstruct startRebalanceArgs from the proposal data
    // IMPORTANT: Build arrays in allTokens order to match what doAuctions expects
    const proposalWeightsArray = decoded[1] as any[];
    const proposalPricesArray = decoded[2] as any[];
    
    // Reorder weights and prices to match allTokens order
    const reorderedWeights = [];
    const reorderedPrices = [];
    
    for (const token of allTokens) {
      const proposalIndex = proposalTokens.indexOf(token);
      if (proposalIndex >= 0) {
        // Token is in the proposal - use its weights and prices
        const w = proposalWeightsArray[proposalIndex];
        reorderedWeights.push({
          low: BigInt(w[0].toString()),
          spot: BigInt(w[1].toString()),
          high: BigInt(w[2].toString()),
        });
        
        const p = proposalPricesArray[proposalIndex];
        reorderedPrices.push({
          low: BigInt(p[0].toString()),
          high: BigInt(p[1].toString()),
        });
      } else {
        // Token not in proposal (shouldn't happen for normal rebalancing)
        // Use zero weights and a wide price range
        reorderedWeights.push({
          low: 0n,
          spot: 0n,
          high: 0n,
        });
        reorderedPrices.push({
          low: 0n,
          high: BigInt("999999999999999999999999999999999999"), // Max reasonable price
        });
      }
    }
    
    const startRebalanceArgs = {
      weights: reorderedWeights,
      prices: reorderedPrices,
      limits: {
        low: BigInt(decoded[3][0].toString()),
        spot: BigInt(decoded[3][1].toString()),
        high: BigInt(decoded[3][2].toString()),
      },
    };

    const initialState = {
      initialTokens: initialRebalanceTokens,
      initialAssets,
      initialSupply,
      startRebalanceArgs,
    };

    // Validate that all tokens have valid prices before running auctions
    const tokensWithoutPrices: string[] = [];
    for (const token of allTokens) {
      const priceKey = token.toLowerCase();
      if (!auctionPriceRec[priceKey] || !auctionPriceRec[priceKey].snapshotPrice || auctionPriceRec[priceKey].snapshotPrice === 0) {
        tokensWithoutPrices.push(token);
      }
    }

    if (tokensWithoutPrices.length > 0) {
      throw new Error(
        `Cannot run auction simulation: Missing or zero price data for tokens:\n` +
          `${tokensWithoutPrices.join(", ")}\n` +
          `All tokens involved in the rebalance must have valid price data.`,
      );
    }

    // Calculate normalized target basket percentages for doAuctions
    // We need to normalize the raw weights to D18 percentages
    const allTokenDecimals: bigint[] = [];
    for (const token of allTokens) {
      const tokenContract = await hre.ethers.getContractAt("IERC20Metadata", token);
      allTokenDecimals.push(await tokenContract.decimals());
    }
    
    const allTokenPrices = allTokens.map((token) => baselinePriceLookup.getPrice(token));
    const { getTargetBasket } = await import("../src/open-auction");
    
    // Use the reordered weights from startRebalanceArgs
    const normalizedTargetArray = getTargetBasket(
      startRebalanceArgs.weights,
      allTokenPrices,
      allTokenDecimals,
      false, // debug
    );
    
    const normalizedTargetBasketRec: Record<string, bigint> = {};
    allTokens.forEach((token, i) => {
      normalizedTargetBasketRec[token] = normalizedTargetArray[i];
    });

    // Generate random slippage range for this simulation
    const minSlippage = 0.001 + Math.random() * 0.003; // 0.1% to 0.4%
    const maxSlippage = minSlippage + 0.002 + Math.random() * 0.004; // +0.2% to +0.6% more
    const swapSlippageRange: [number, number] = [minSlippage, maxSlippage];
    
    // Generate random auction price deviation
    const auctionPriceDeviation = 0.01 + Math.random() * 0.02; // 1% to 3%

    // Now simulate the auctions
    console.log(`\n⚡ Running auction simulation...`);
    console.log(`   📊 Auction price deviation: ${(auctionPriceDeviation * 100).toFixed(1)}%`);
    console.log(`   💱 Swap slippage range: ${(minSlippage * 100).toFixed(2)}% - ${(maxSlippage * 100).toFixed(2)}%`);

    const { totalRebalancedValue } = await doAuctions(
      hre,
      { folio, folioLensTyped },
      { bidder, rebalanceManager, auctionLauncher, admin },
      allTokens,
      currentAmountsRec,
      normalizedTargetBasketRec,  // Use normalized percentages instead of raw weights
      auctionPriceRec,  // Use deviated prices for realistic auction simulation
      initialState,
      0.9, // finalStageAt
      false, // debug
      auctionPriceDeviation,
      swapSlippageRange,
    );

    console.log(`\n✅ Rebalance simulation completed successfully!`);

    // Calculate and display final metrics
    console.log(`\n📊 Final Rebalance Metrics:`);

    // Calculate metrics
    const metrics = await calculateRebalanceMetrics(
      hre,
      folio,
      allTokens,
      normalizedTargetBasketRec,  // Use the already calculated normalized target
      baselinePriceRec, // Use baseline prices for consistent error calculation
    );

    // Log the results
    logPercentages(`🔍 Final    `, metrics.finalTargetBasketRec, allTokens);
    logPercentages(`🎯 Target   `, normalizedTargetBasketRec, allTokens);

    // totalError is now directly a percentage (0-100)
    const errorPercentage = metrics.totalError;

    if (errorPercentage > 0.01) {
      // 0.01% = 1 basis point
      console.log(`⚠️  Error     ${errorPercentage.toFixed(4)}%`);
      if (errorPercentage > 1) {
        // 1% error threshold
        console.log(`\n⚠️  Warning: Total error exceeds 1%`);
      }
    } else {
      console.log(`✅ Error     ${errorPercentage.toFixed(4)}%`);
    }

    console.log(
      `\n💰 Total Rebalanced Value: $${totalRebalancedValue.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
    );
    console.log(
      `💼 Total Portfolio Value: $${metrics.totalValueAfterFinal.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
    );
  });
