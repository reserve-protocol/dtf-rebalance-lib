import { task } from "hardhat/config";
import { HardhatRuntimeEnvironment } from "hardhat/types";
import { time } from "@nomicfoundation/hardhat-toolbox/network-helpers";

import { FolioVersion } from "../../../src/types";
import { getTargetBasket } from "../../../src/open-auction";

import { initializeChainState, setupContractsAndSigners } from "./setup";
import { doAuctions } from "./do-auctions";
import { mintAndRedeem } from "./mint-redeem";
import { validateWeightShift, validateEjectAndAdd } from "./validate-rebalance";
import { validateUpgrade } from "./validate-upgrade";
import { loadSdk } from "../src/sdk";
import {
  calculateRebalanceMetrics,
  logPercentages,
  convertProposalPricesToUSD,
  simulateMarketPrices,
  createPriceLookup,
  whileImpersonating,
  ensureProposalPasses,
  mockBasketTokens,
} from "./utils";

import { FOLIO_CONFIGS } from "./config";

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

    console.log(`\n🚀 Starting live simulation for ${folioConfig.name}...`);
    console.log(`📋 Proposal ID: ${id}`);
    console.log(`📈 Market Volatility: ${(marketVolatility * 100).toFixed(0)}% annual`);
    console.log(`🔢 Fork Block: ${blockNumber ? blockNumber : "latest"}`);

    // Fork from specified block or latest
    await initializeChainState(hre, folioConfig, blockNumber);

    // Setup contracts and signers
    const { folio, folioLensTyped, bidder, admin, rebalanceManager, auctionLauncher } = await setupContractsAndSigners(
      hre,
      folioConfig,
    );

    // Check folio version
    let folioVersion: string;
    try {
      folioVersion = await folio.version();
    } catch (error) {
      throw new Error(`Failed to get folio version: ${error}. The folio contract may not be properly initialized.`);
    }

    console.log(`📦 Folio version: ${folioVersion}`);

    // Auto-detect governor: try basketGovernor first, fall back to nonBasketGovernor
    const { dtfIndexAbi, dtfIndexGovernanceAbi } = await loadSdk();
    const governorAbi = dtfIndexGovernanceAbi as any;

    let governor;
    let governorAddress: string | undefined;

    // Try basketGovernor first
    if (folioConfig.basketGovernor) {
      try {
        const candidateGovernor = await hre.ethers.getContractAt(governorAbi, folioConfig.basketGovernor);
        await candidateGovernor.state(id);
        governor = candidateGovernor;
        governorAddress = folioConfig.basketGovernor;
        console.log(`🏛️  Governor: ${governorAddress} (basket)`);
      } catch {
        // Proposal not found on basketGovernor, try nonBasketGovernor
      }
    }

    // Fall back to nonBasketGovernor
    if (!governor && folioConfig.nonBasketGovernor) {
      try {
        const candidateGovernor = await hre.ethers.getContractAt(governorAbi, folioConfig.nonBasketGovernor);
        await candidateGovernor.state(id);
        governor = candidateGovernor;
        governorAddress = folioConfig.nonBasketGovernor;
        console.log(`🏛️  Governor: ${governorAddress} (non-basket)`);
      } catch {
        // Proposal not found on nonBasketGovernor either
      }
    }

    if (!governor || !governorAddress) {
      throw new Error(
        `Proposal ${id} not found on any governor.\n` +
          `Tried basketGovernor: ${folioConfig.basketGovernor || "not configured"}\n` +
          `Tried nonBasketGovernor: ${folioConfig.nonBasketGovernor || "not configured"}`,
      );
    }

    // Get proposal state
    const proposalState = Number(await governor.state(id));
    const PROPOSAL_STATES = ["Pending", "Active", "Canceled", "Defeated", "Succeeded", "Queued", "Expired", "Executed"];
    console.log(`📊 Proposal State: ${PROPOSAL_STATES[proposalState]} (${proposalState})`);

    // Query ProposalCreated events to get the proposal data
    console.log(`\n🔍 Fetching proposal data from event logs...`);

    // Get all ProposalCreated events (proposalId is not indexed, so we can't filter by it)
    const filter = governor.filters.ProposalCreated();

    let event;
    try {
      // only mainnet and base can query for all blocks
      const events = await governor.queryFilter(filter);

      // Find the event for our specific proposal ID
      event = events.find((e) => {
        if ("args" in e && e.args) {
          return e.args.proposalId?.toString() === id.toString();
        }
        return false;
      });
    } catch {
      // on bsc we have to look in batches of 999 each

      // look back 10 batches of 999 blocks each
      for (let i = 0; i < 100 && !event; i++) {
        const events = await governor.queryFilter(filter, blockNumber! - 999 * (i + 1), blockNumber! - 999 * i);

        // Find the event for our specific proposal ID
        event = events.find((e) => {
          if ("args" in e && e.args) {
            return e.args.proposalId?.toString() === id.toString();
          }
          return false;
        });
      }
    }

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

    // Convert Result objects to plain arrays to avoid ethers v6 read-only issues
    // In ethers v6, event args are Result objects with array-like behavior
    const eventArgs = (event as any).args;
    if (!eventArgs?.calldatas || eventArgs.calldatas.length === 0) {
      throw new Error(`Proposal ${id} does not contain any actions.`);
    }

    const targets = eventArgs.targets as string[];
    const calldatas = eventArgs.calldatas as string[];
    // Access values by index — eventArgs.values collides with Array.prototype.values in ethers v6
    const rawValues = eventArgs[3];
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

    const calldata = calldatas[0];
    console.log(`   Found ${calldatas.length} action(s) in proposal`);

    // Detect if this is a V5 startRebalance proposal.
    const ifaceV5 = new hre.ethers.Interface(dtfIndexAbi as any);

    let isRebalanceProposal = false;
    const parsedV5 = ifaceV5.parseTransaction({ data: calldata as string });
    if (parsedV5 !== null && parsedV5.name === "startRebalance") {
      isRebalanceProposal = true;
    }

    console.log(`   ${isRebalanceProposal ? "🔄 Rebalance proposal detected" : "📋 Non-rebalance proposal"}`);

    // === Variables shared between pre-execution and post-execution rebalance blocks ===
    let decoded: any;
    let allTokens: string[] = [];
    let baselinePriceRec: Record<string, { snapshotPrice: number }> = {};
    let auctionPriceRec: Record<string, { snapshotPrice: number }> = {};
    let targetBasketRec: Record<string, bigint> = {};
    let normalizedTargetBasketRec: Record<string, bigint> = {};
    let governanceDelayDays: number = 0;

    // === Pre-execution: decode and display rebalance data ===
    if (isRebalanceProposal) {
      // Validate that the target contract is the folio
      if (targets[0] && targets[0].toLowerCase() !== folioConfig.folio.toLowerCase()) {
        throw new Error(
          `Proposal ${id} does not target the expected folio contract.\n` +
            `Expected: ${folioConfig.folio}\n` +
            `Found: ${targets[0]}`,
        );
      }

      try {
        decoded = ifaceV5.decodeFunctionData("startRebalance", calldata as string);

        // V5 decoded[0] is TokenRebalanceParams[]
        const tokenParams = decoded[0] as any[];
        const proposalTokens = tokenParams.map((p: any) => p.token as string);
        const proposalWeights = tokenParams.map((p: any) => BigInt(p.weight[1].toString())); // spot weight
        const proposalPrices = tokenParams.map((p: any) => ({
          low: BigInt(p.price[0].toString()),
          high: BigInt(p.price[1].toString()),
        }));

        console.log(`📊 Proposal contains ${proposalTokens.length} tokens`);

        // Get current basket
        const [currentTokens, currentAmounts] = await folio.totalAssets();
        console.log(`📦 Current basket has ${currentTokens.length} tokens`);

        // Get unique set of all tokens
        const allTokensSet = new Set([...currentTokens, ...proposalTokens]);
        allTokens = Array.from(allTokensSet);
        console.log(`📊 Total unique tokens across current and proposal: ${allTokens.length}`);

        // Get decimals for all tokens
        const decimalsRec: Record<string, bigint> = {};
        const currentAmountsRec: Record<string, bigint> = {};

        for (const token of allTokens) {
          const tokenContract = await hre.ethers.getContractAt("IERC20Metadata", token);
          decimalsRec[token] = await tokenContract.decimals();
        }

        // Calculate governance delay
        const currentTime = await time.latest();
        const needsQueuing = await governor.proposalNeedsQueuing(id);
        const proposalDeadline = await governor.proposalDeadline(id);

        let timelockDelaySeconds = 0;
        if (needsQueuing) {
          const timelockAddress = await governor.timelock();
          const timelockAbi = [
            "function getMinDelay() view returns (uint256)",
            "function minDelay() view returns (uint256)",
          ];
          const timelock = new hre.ethers.Contract(timelockAddress, timelockAbi, hre.ethers.provider);
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
          const votingDelay = await governor.votingDelay();
          const votingPeriod = await governor.votingPeriod();
          const totalSeconds = Number(votingDelay) + Number(votingPeriod) + timelockDelaySeconds;
          governanceDelayDays = totalSeconds / (24 * 60 * 60);
          console.log(
            `\n⏰ Governance Delay: ${governanceDelayDays.toFixed(2)} days (${(Number(votingDelay) / 86400).toFixed(2)}d delay + ${(Number(votingPeriod) / 86400).toFixed(2)}d voting + ${(timelockDelaySeconds / 86400).toFixed(2)}d timelock)`,
          );
        } else if (proposalState === 1) {
          const remainingVotingSeconds = Math.max(0, Number(proposalDeadline) - currentTime);
          const totalRemainingSeconds = remainingVotingSeconds + timelockDelaySeconds;
          governanceDelayDays = totalRemainingSeconds / (24 * 60 * 60);
          console.log(
            `\n⏰ Governance Delay: ${governanceDelayDays.toFixed(2)} days (${(remainingVotingSeconds / 86400).toFixed(2)}d voting + ${(timelockDelaySeconds / 86400).toFixed(2)}d timelock)`,
          );
        } else if (proposalState === 4) {
          governanceDelayDays = timelockDelaySeconds / (24 * 60 * 60);
          console.log(`\n⏰ Governance Delay: ${governanceDelayDays.toFixed(2)} days (timelock only)`);
        } else if (proposalState === 5) {
          const proposalEta = await governor.proposalEta(id);
          const remainingSeconds = Math.max(0, Number(proposalEta) - currentTime);
          governanceDelayDays = remainingSeconds / (24 * 60 * 60);
          console.log(`\n⏰ Governance Delay: ${governanceDelayDays.toFixed(2)} days (queued)`);
        } else if (proposalState === 7) {
          governanceDelayDays = 0;
          console.log(`\n⏰ Governance Delay: 0 days (already executed)`);
        } else if (proposalState === 2 || proposalState === 3 || proposalState === 6) {
          throw new Error(
            `Cannot simulate proposal in ${PROPOSAL_STATES[proposalState]} state.`,
          );
        }

        // Get decimals array for proposal tokens (needed for price conversion)
        const proposalDecimals = proposalTokens.map((token) => decimalsRec[token]);

        // Get symbols for proposal tokens
        const proposalSymbols: string[] = [];
        for (const token of proposalTokens) {
          const tokenContract = await hre.ethers.getContractAt("IERC20Metadata", token);
          proposalSymbols.push(await tokenContract.symbol());
        }

        // Convert proposal prices to USD
        const baselinePrices = convertProposalPricesToUSD(proposalPrices, proposalDecimals, proposalSymbols);

        // Simulate market price movements
        const deviatedPriceData = simulateMarketPrices(baselinePrices, marketVolatility, governanceDelayDays);

        // Build price records
        const priceChanges: { symbol: string; baseline: number; deviated: number; change: string }[] = [];

        for (let i = 0; i < allTokens.length; i++) {
          const token = allTokens[i];
          const tokenKey = token.toLowerCase();
          const proposalIndex = proposalTokens.indexOf(token);

          if (proposalIndex >= 0) {
            const baseline = baselinePrices[proposalIndex];
            baselinePriceRec[tokenKey] = { snapshotPrice: baseline };
            auctionPriceRec[tokenKey] = deviatedPriceData[proposalIndex.toString()];

            const priceChange = ((auctionPriceRec[tokenKey].snapshotPrice / baseline - 1) * 100).toFixed(2);
            priceChanges.push({
              symbol: proposalSymbols[proposalIndex] || token,
              baseline,
              deviated: auctionPriceRec[tokenKey].snapshotPrice,
              change: priceChange,
            });
          } else {
            console.log(`   Warning: Token ${token} is in current basket but not in proposal`);
            baselinePriceRec[tokenKey] = { snapshotPrice: 0 };
            auctionPriceRec[tokenKey] = { snapshotPrice: 0 };
          }
        }

        // Store current amounts
        for (const token of allTokens) {
          currentAmountsRec[token] = 0n;
        }
        for (let i = 0; i < currentTokens.length; i++) {
          currentAmountsRec[currentTokens[i]] = currentAmounts[i];
        }

        // Build target basket from proposal weights
        for (let i = 0; i < proposalTokens.length; i++) {
          targetBasketRec[proposalTokens[i]] = proposalWeights[i];
        }

        // Create price lookup helper
        const baselinePriceLookup = createPriceLookup(baselinePriceRec);

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
            currentValues[token] = 0;
          }
        }

        // Calculate proposed basket value breakdown
        let totalProposedValue = 0;
        const proposedValues: Record<string, number> = {};
        for (const token of allTokens) {
          proposedValues[token] = 0;
        }
        for (const token of proposalTokens) {
          const weight = targetBasketRec[token] || 0n;
          const decimals = decimalsRec[token];
          const tokenPrice = baselinePriceLookup.getPrice(token);
          const wholeTokensPerWholeBU = Number(weight) / (Number(10n ** 9n) * Number(10n ** decimals));
          const dollarValuePerBU = wholeTokensPerWholeBU * tokenPrice;
          proposedValues[token] = dollarValuePerBU;
          totalProposedValue += dollarValuePerBU;
        }

        // Display basket comparison
        console.log(`\n📊 Proposal:`);
        console.log(`   Token     Current → Proposed`);
        console.log(`   --------- ------- → --------`);

        const allUniqueTokens = new Set([...currentTokens, ...proposalTokens]);
        for (const token of allUniqueTokens) {
          const tokenContract = await hre.ethers.getContractAt("IERC20Metadata", token);
          const sym = await tokenContract.symbol();
          const currentPercentage = currentValues[token] ? (currentValues[token] / totalCurrentValue) * 100 : 0;
          const currentStr = currentPercentage > 0 ? `${currentPercentage.toFixed(2)}%` : "    -";
          const proposedPercentage = proposedValues[token] ? (proposedValues[token] / totalProposedValue) * 100 : 0;
          const proposedStr = proposedPercentage > 0 ? `${proposedPercentage.toFixed(2)}%` : "    -";
          let status = "";
          if (currentPercentage === 0 && proposedPercentage > 0) status = " (NEW)";
          else if (currentPercentage > 0 && proposedPercentage === 0) status = " (REMOVE)";
          if (currentPercentage > 0 || proposedPercentage > 0) {
            console.log(`   ${sym.padEnd(9)} ${currentStr.padStart(7)} → ${proposedStr.padEnd(7)}${status}`);
          }
        }

        // Log raw weights
        console.log(`\n📐 Basket weights (D27{tok/BU} format):`);
        for (const token of allTokens) {
          const weight = targetBasketRec[token] || 0n;
          if (weight > 0n) {
            const tokenContract = await hre.ethers.getContractAt("IERC20Metadata", token);
            const sym = await tokenContract.symbol();
            const isNew = !currentTokens.includes(token) ? " (NEW)" : "";
            console.log(`   ${sym}: ${weight.toString()}${isNew}`);
          }
        }

        // Display price changes
        console.log(`\n📈 Price simulation (proposal baseline → ${governanceDelayDays.toFixed(1)} days later):`);
        for (const priceChange of priceChanges) {
          console.log(
            `   ${priceChange.symbol}: $${priceChange.baseline.toFixed(2)} → $${priceChange.deviated.toFixed(2)} (${priceChange.change}%)`,
          );
        }

        // Calculate normalized target basket for metrics
        const allTokenDecimals: bigint[] = allTokens.map((token) => decimalsRec[token]);
        const targetCalculationPrices = allTokens.map((token) => baselinePriceLookup.getPrice(token));

        // Build reordered weights for getTargetBasket
        const reorderedWeights = allTokens.map((token) => {
          const proposalIndex = proposalTokens.indexOf(token);
          if (proposalIndex >= 0) {
            const p = tokenParams[proposalIndex];
            return {
              low: BigInt(p.weight[0].toString()),
              spot: BigInt(p.weight[1].toString()),
              high: BigInt(p.weight[2].toString()),
            };
          }
          return { low: 0n, spot: 0n, high: 0n };
        });

        const normalizedTargetArray = getTargetBasket(reorderedWeights, targetCalculationPrices, allTokenDecimals, false);
        allTokens.forEach((token, i) => {
          normalizedTargetBasketRec[token] = normalizedTargetArray[i];
        });
      } catch (error) {
        throw new Error(`Could not decode proposal calldata.\n Error: ${error}`);
      }
    }

    // === Execute the proposal ===
    if (proposalState !== 7) {
      console.log(`\n📝 Executing proposal ${id} in simulation...`);

      // For Pending proposals, fast-forward past voting start (snapshot) first
      // so that quorum() can be queried and votes can be cast
      if (proposalState === 0) {
        const snapshot = Number(await governor.proposalSnapshot(id));
        const currentTime = await time.latest();
        if (snapshot > currentTime) {
          await hre.network.provider.send("evm_setNextBlockTimestamp", [snapshot + 1]);
          await hre.network.provider.send("evm_mine", []);
        }
      }

      // Ensure proposal passes (cast FOR votes if needed)
      await ensureProposalPasses(hre, governor, id);

      // Fast-forward past voting deadline
      const votingEnd = Number(await governor.proposalDeadline(id));
      const timeNow = await time.latest();
      if (votingEnd > timeNow) {
        await hre.network.provider.send("evm_setNextBlockTimestamp", [votingEnd + 1]);
        await hre.network.provider.send("evm_mine", []);
      }

      const currentProposalState = Number(await governor.state(id));

      // Queue if needed
      const needsQueuing = await governor.proposalNeedsQueuing(id);
      if (needsQueuing) {
        const proposalEta = await governor.proposalEta(id);
        const isQueued = proposalEta > 0n;

        if (!isQueued && currentProposalState === 4) {
          try {
            const queueDescriptionHash = hre.ethers.id(eventArgs.description || "");
            await whileImpersonating(hre, await admin.getAddress(), async (signer) => {
              await (
                await (governor.connect(signer) as any).queue(
                  [...targets],
                  [...values],
                  [...calldatas],
                  queueDescriptionHash,
                )
              ).wait();
            });
            console.log(`✅ Proposal queued successfully`);
          } catch (queueError: any) {
            console.log(`⚠️ Queue failed: ${queueError.message?.slice(0, 300)}`);
          }
        }

        // Fast-forward past timelock delay (only if ETA is in the future)
        const finalProposalEta = await governor.proposalEta(id);
        const currentTimeForEta = await time.latest();
        if (finalProposalEta > 0n && Number(finalProposalEta) > currentTimeForEta) {
          await hre.network.provider.send("evm_setNextBlockTimestamp", [Number(finalProposalEta) + 1]);
          await hre.network.provider.send("evm_mine", []);
        }
      }

      // Execute the proposal
      const descriptionHash = hre.ethers.id(eventArgs.description || "");
      await whileImpersonating(hre, await admin.getAddress(), async (signer) => {
        await (
          await (governor.connect(signer) as any).execute(
            [...targets],
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

    // === Post-execution: verify version is V5 ===
    folioVersion = await folio.version();
    console.log(`📦 Folio version after execution: ${folioVersion}`);

    if (folioVersion[0] !== "5") {
      throw new Error(`Folio version after proposal execution is ${folioVersion}, expected 5.x.x`);
    }

    // === Post-execution: run rebalance or post-checks ===
    if (isRebalanceProposal) {
      // Capture initial state after proposal execution
      const initialSupply = await folio.totalSupply();
      const [initialRebalanceTokens, initialAssets] = await folio.totalAssets();
      const initialAssetsRec: Record<string, bigint> = {};
      initialRebalanceTokens.forEach((token: string, i: number) => {
        initialAssetsRec[token] = initialAssets[i];
      });

      // Validate all tokens have valid prices
      const tokensWithoutPrices: string[] = [];
      for (const token of allTokens) {
        const priceKey = token.toLowerCase();
        if (
          !auctionPriceRec[priceKey] ||
          !auctionPriceRec[priceKey].snapshotPrice ||
          auctionPriceRec[priceKey].snapshotPrice === 0
        ) {
          tokensWithoutPrices.push(token);
        }
      }

      if (tokensWithoutPrices.length > 0) {
        throw new Error(
          `Cannot run auction simulation: Missing or zero price data for tokens:\n` +
            `${tokensWithoutPrices.join(", ")}`,
        );
      }

      // Generate random slippage range
      const minSlippage = 0.001 + Math.random() * 0.003;
      const maxSlippage = minSlippage + 0.002 + Math.random() * 0.004;
      const swapSlippageRange: [number, number] = [minSlippage, maxSlippage];

      // Generate random auction price deviation
      const auctionPriceDeviation = 0.01 + Math.random() * 0.02;

      console.log(`\n⚡ Running auction simulation...`);
      console.log(`   📊 Auction price deviation: ${(auctionPriceDeviation * 100).toFixed(1)}%`);
      console.log(`   💱 Swap slippage range: ${(minSlippage * 100).toFixed(2)}% - ${(maxSlippage * 100).toFixed(2)}%`);

      const { totalRebalancedValue } = await doAuctions(
        FolioVersion.V5,
        hre,
        { folio, folioLensTyped },
        { bidder, rebalanceManager, auctionLauncher, admin },
        allTokens,
        initialSupply,
        initialAssetsRec,
        targetBasketRec,
        baselinePriceRec,
        0.9, // finalStageAt
        false, // debug
        auctionPriceDeviation,
        swapSlippageRange,
      );

      console.log(`\n✅ Rebalance simulation completed successfully!`);

      // Calculate and display final metrics
      console.log(`\n📊 Final Rebalance Metrics:`);

      const metrics = await calculateRebalanceMetrics(
        hre,
        folio,
        allTokens,
        normalizedTargetBasketRec,
        baselinePriceRec,
      );

      logPercentages(`🔍 Final    `, metrics.finalTargetBasketRec, allTokens);
      logPercentages(`🎯 Target   `, normalizedTargetBasketRec, allTokens);

      const errorPercentage = metrics.totalError;

      if (errorPercentage > 0.01) {
        console.log(`⚠️  Error     ${errorPercentage.toFixed(4)}%`);
        if (errorPercentage > 1) {
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
    } else {
      // Non-rebalance proposal: mock tokens to prepare for post-checks
      console.log(`\n🔧 Preparing for post-checks (non-rebalance proposal)...`);
      const [currentTokens] = await folio.totalAssets();
      await mockBasketTokens(hre, await folio.getAddress(), [...currentTokens]);
    }

    // === Post-validations: mint/redeem + validate rebalance + upgrade ===
    const [bidder2] = await hre.ethers.getSigners();
    const postChecks: [string, () => Promise<unknown>][] = [
      ["mint/redeem", () => mintAndRedeem(hre, folio, bidder2)],
      ["weight shift", () => validateWeightShift(hre, folio, folioLensTyped, undefined, folioConfig.chainId)],
      ["eject & add", () => validateEjectAndAdd(hre, folio, folioLensTyped, undefined, folioConfig.chainId)],
      ["upgrade", () => validateUpgrade(hre, folio, folioConfig)],
    ];
    const failures: string[] = [];
    for (const [name, fn] of postChecks) {
      try {
        await fn();
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.log(`\n❌ Post-check "${name}" failed: ${msg}`);
        failures.push(name);
      }
    }

    if (failures.length > 0) {
      console.log(`\n🎉 Simulation complete (with ${failures.length} post-check failure(s): ${failures.join(", ")})`);
    } else {
      console.log(`\n🎉 Simulation complete!`);
    }
  });
