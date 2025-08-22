# Auction Algorithm

## Overview

The auction algorithm is a sophisticated mechanism for rebalancing portfolios (called "Folios") through a series of auction rounds. The algorithm determines what tokens to buy and sell, at what prices, and in what quantities to transition a portfolio from its current state to a target composition.

The algorithm is designed to handle any number of tokens and supports three types of rebalances, each with different approaches to manipulating weights and limits.

Initially `getStartRebalance()` is called to prepare the initial rebalance parameters. Any number of auctions (serially) are then launched via successive calls to `getOpenAuction()`.

## Key Concepts

### Core Components

1. **Weights** (`WeightRange`): Represent the amount of tokens per basket unit (BU). Expressed as D27 values with low/spot/high ranges.

   - Formula: `D27{tok/BU}`
   - Used to define the target composition of the basket

2. **Limits** (`RebalanceLimits`): Define the relationship between basket units and shares. Expressed as D18 values with low/spot/high ranges.

   - Formula: `D18{BU/share}`
   - Used to scale the basket composition to actual share holdings

3. **Prices** (`PriceRange`): Token prices in nanoUSD (D27 format) with low/high bounds for auction pricing.

   - Formula: `D27{nanoUSD/tok}`
   - Used to calculate values and determine trading ranges

4. **Target Basket**: A normalized representation (D18 format) of the portfolio's target composition by value percentage.
   - Different calculation methods for tracking vs native rebalances

### Fundamental Relationship

The core relationship between these components is:

```
expected balance = weight × limit
```

Where:

- `balance`: tokens per share `{tok/share}`
- `weight`: tokens per basket unit `{tok/BU}`
- `limit`: basket units per share `{BU/share}`

**Understanding High and Low Bounds:**

The high and low bounds define the trading boundaries for the auction:

- **Low Bounds**: Define **deficits** - what we **buy up to**

  - `buyUpTo = weight.low × limit.low`
  - If current balance < buyUpTo, the token has a deficit
  - The auction will purchase tokens to reach this threshold

- **High Bounds**: Define **surpluses** - what we **sell down to**
  - `sellDownTo = weight.high × limit.high`
  - If current balance > sellDownTo, the token has a surplus
  - The auction will sell tokens down to this threshold

This asymmetric design creates a trading range that gradually narrows in on a final spot target that is constantly updated throughout the auction in response to changing prices and variable slippage.

## Types of Rebalances

The algorithm supports three types of rebalances. First, let's understand the two simple, disjoint cases:

### 1. Tracking Rebalance (Simple Case)

- **What it does**: Adjusts portfolio scale while keeping token ratios constant
- **What changes**: Only limits vary
- **What stays fixed**: Weights remain constant (low = spot = high)
- **Weight Control**: `false` in `getStartRebalance()`
- **Target Basket**: Uses CURRENT market prices
- **Real-world analogy**: Like zooming in/out on a photograph - proportions stay the same, only scale changes
- **Example**: Portfolio maintains 60% ETH, 40% BTC ratio but adjusts total value

### 2. Native Rebalance (Simple Case)

- **What it does**: Changes portfolio composition while keeping scale constant
- **What changes**: Only weights vary
- **What stays fixed**: Limits remain at initial values
- **Weight Control**: `true` in `getStartRebalance()`
- **Target Basket**: Uses HISTORICAL prices from rebalance start
- **Real-world analogy**: Like rearranging furniture in a room - the room size stays the same, but contents change
- **Example**: Changing from 100% USDC to 50% DAI, 50% USDT

### 3. Hybrid Rebalance (Complex Case)

- **What it does**: Changes both composition AND scale simultaneously
- **What changes**: Both weights AND limits vary
- **Implementation**: Uses manually constructed `Rebalance` objects
- **Use Case**: Complex scenarios requiring simultaneous composition and scale changes
- **Real-world analogy**: Like both rearranging furniture AND changing room size
- **Example**: Reducing USDC from 100% to 33% while also doubling portfolio scale

## Auction Rounds

The algorithm progresses through three types of auction rounds:

### 1. Eject Round (`EJECT`)

- **Purpose**: Remove tokens with zero target weight from the portfolio
- **Trigger**: When `portionBeingEjected > 0` (tokens have `weight.spot == 0`)
- **Special Handling**:
  - Adds 10% buffer to high limits and weights
  - Prevents selling all surpluses upfront
  - Allows ejected tokens to fill deficits
- **Target**: Either approaches `finalStageAt` or completes ejection

### 2. Progress Round (`PROGRESS`)

- **Purpose**: Move the portfolio towards the `finalStageAt` threshold
- **Trigger**: When progression < 99% AND relative progression < (finalStageAt - 0.02)
- **Target**: `initialProgression + (1 - initialProgression) × finalStageAt`
- **Behavior**: Gradual rebalancing to avoid market impact

### 3. Final Round (`FINAL`)

- **Purpose**: Complete the rebalance to 100%
- **Trigger**: When approaching or exceeding `finalStageAt` threshold
- **Target**: 100% completion (rebalanceTarget = 1)
- **Delta**: 0 (no spread between low/high bounds)

## Algorithm Flow

### Input Parameters

1. **rebalance**: Current rebalance state from `folio.getRebalance()`
2. **\_supply**: Total supply of shares
3. **\_initialFolio**: Initial token balances when rebalance started
4. **\_targetBasket**: Target composition by value percentage
5. **\_folio**: Current token balances
6. **\_decimals**: Token decimal places
7. **\_prices**: Current USD prices per whole token
8. **\_priceError**: Price error margins for auction pricing
9. **\_finalStageAt**: Progression threshold (e.g., 0.9 = 95%)

### Initial Setup with getStartRebalance

Before any auction can begin, `getStartRebalance()` prepares the initial rebalance parameters:

**For Tracking Rebalances (`weightControl = false`):**

- Weights: All three values (low/spot/high) are set identically based on target basket
- Limits: Calculated using price error to create asymmetric bounds
  - `totalPortion = Σ(targetBasket[i] × priceError[i])`
  - `low = (1 - totalPortion) × 1e18`
  - `high = 1 / (1 - totalPortion) × 1e18`
  - The division in `high` creates asymmetry (e.g., 10% error → 90% low, 111% high)
- Prices: Standard low/high based on price error

**For Native Rebalances (`weightControl = true`):**

- Weights: Vary based on price error
  - `low = spotWeight × (1 - priceError)`
  - `high = spotWeight / (1 - priceError)`
- Limits: Fixed at 1e18 for all (low/spot/high)
- Prices: Same calculation as tracking

### Processing Steps

1. **Calculate Current State**

   - Convert all values to common decimal format
   - Calculate share value and basket unit value
   - Determine ideal spot limit: `shareValue / buValue`

2. **Calculate Progression**

   - **Absolute Progression**: Percentage of balances in correct position (0-100%)
   - **Relative Progression**: Progress from initial to target
   - Formula: `(current - initial) / (1 - initial)`

3. **Determine Auction Round**

   - Check for ejections first
   - Then check progression thresholds
   - Default to FINAL if near completion

4. **Calculate New Limits**

   - Base calculation: `spotLimit × (1 ± delta)`
   - Constrained by initial rebalance limits
   - Delta derived from target progression

5. **Calculate New Weights**

   - Ideal weight: `shareValue × targetBasket / actualLimits.spot / price`
   - Adjusted for delta while avoiding double-counting uncertainty
   - Formula: `idealWeight × (1 ± delta) / (limitRatio)`
   - The `limitRatio` division prevents propagating uncertainty twice
   - Constrained by initial weight ranges

6. **Calculate New Prices**

   - Based on current prices ± price error
   - Constrained by initial price ranges
   - Only adjusted if `priceControl != NONE`

7. **Filter Tradeable Tokens**
   - Include only tokens with surpluses or deficits
   - Exclude tokens not in rebalance
   - Minimum trade value: $1

### Output

The algorithm returns:

1. **OpenAuctionArgs**: Parameters for calling `folio.openAuction()`

   - rebalanceNonce
   - tokens (filtered list)
   - newWeights
   - newPrices
   - newLimits

2. **AuctionMetrics**: Useful metrics for monitoring
   - round type
   - progression values (initial, absolute, relative)
   - target values
   - auction size in USD
   - surplus/deficit token lists

## Example Walkthroughs

### Tracking Rebalance: 100% USDC → 50% DAI, 50% USDT

This example shows how limits change while weights stay constant throughout.

**Initial Setup:**

- Starting Folio: [1 USDC, 0 DAI, 0 USDT] per share
- Target: [0%, 50%, 50%] by value (using current prices)
- Weights (constant throughout): USDC=0, DAI=5e26, USDT=5e14 (in D27 format)
- Price Error: 10% for each token
- Initial Limits calculation:
  - totalPortion = (0×0.1) + (0.5×0.1) + (0.5×0.1) = 0.1
  - low = (1 - 0.1) × 1e18 = 9e17
  - high = 1/(1 - 0.1) × 1e18 = 1.111...e18
  - Note the asymmetry: high uses division, not simple addition

**Scenario 1 - Ejection Round:**

- Current Folio: [1 USDC, 0 DAI, 0 USDT] (still at start)
- Current Limits: {low: 9.5e17, spot: 1e18, high: 1.11e18}
- USDC marked for ejection (weight = 0)
- Progression: 0%
- Target: 95% (approaching finalStageAt)
- New Limits: {low: 9.5e17, spot: 1e18, high: 1.11e18} (adjusted for delta)
- Action: Sell USDC using limit-based pricing, buy DAI/USDT

**Scenario 2 - Final Round:**

- Current Folio: [0.05 USDC, 0.475 DAI, 0.475 USDT] by value
- Low limit of 0.9 constrained the first auction
- Progression: 95% (reached finalStageAt threshold)
- Round: FINAL (skipped PROGRESS since we hit finalStageAt)
- New Limits: {low: 1e18, spot: 1e18, high: 1e18} (delta = 0)
- Action: Sell remaining USDC, reach exact 50/50 DAI/USDT split
- Final Result: [0 USDC, 0.5 DAI, 0.5 USDT] by value

**Key Insight**: Throughout this rebalance, weights never changed. Only limits varied to achieve the target composition through the relationship `balance = weight × limit`.

### Native Rebalance: 100% USDC → 50% DAI, 50% USDT

This example shows how weights change while limits stay constant.

**Initial Setup:**

- Starting Folio: [1 USDC, 0 DAI, 0 USDT] per share
- Target Basket: [0%, 50%, 50%] by value (using historical prices)
- Limits (constant throughout): {low: 1e18, spot: 1e18, high: 1e18}
- Price Error: 10% for each token
- Initial Weights calculation:
  - USDC: {low: 0, spot: 0, high: 0} (marked for ejection)
  - DAI: {low: 4.5e26, spot: 5e26, high: 5.55e26} (D27 format)
  - USDT: {low: 4.5e14, spot: 5e14, high: 5.55e14} (D27 format)

**Scenario 1 - Ejection Round:**

- Current Folio: [1 USDC, 0 DAI, 0 USDT] (still at start)
- Current Weights: USDC=0, DAI and USDT have ranges as above
- Progression: 0%
- Target: 95% (approaching finalStageAt)
- New Weights (with 5% delta applied):
  - USDC: remains at 0
  - DAI/USDT: adjusted ranges to enable trading
- Action: Sell USDC using weight-based pricing, buy DAI/USDT

**Scenario 2 - Final Round:**

- Current Folio: [0.05 USDC, 0.475 DAI, 0.475 USDT] by value
- Progression: 95% (reached finalStageAt threshold)
- Round: FINAL (skipped PROGRESS since we hit finalStageAt)
- New Weights (delta = 0):
  - USDC: {low: 0, spot: 0, high: 0}
  - DAI: {low: 5e26, spot: 5e26, high: 5e26} (converged to spot)
  - USDT: {low: 5e14, spot: 5e14, high: 5e14} (converged to spot)
- Action: Sell remaining USDC, reach exact 50/50 DAI/USDT split
- Final Result: [0 USDC, 0.5 DAI, 0.5 USDT] by value

**Key Insight**: Throughout this rebalance, limits never changed from 1e18. Only weights varied to achieve the target composition.

## Price Control

The `PriceControl` enum affects price adjustments:

- **NONE**: No price manipulation allowed; prices remain at initial ranges
- **PARTIAL**: Prices can be adjusted within bounds based on current market prices and price error

## Key Formulas

### Target Basket Calculation

```javascript
targetBasket[i] = (initialWeight[i] × price[i]) / totalValue
```

### Progression Calculation

```javascript
absoluteProgression = Σ(min(actual[i], expected[i]) × price[i]) / shareValue
relativeProgression = (absolute - initial) / (1 - initial)
```

### Delta Application and Uncertainty Propagation

The delta represents the uncertainty or spread in the rebalancing process. It's crucial to avoid double-counting this uncertainty:

- **For Limits**: `limit × (1 ± delta)`

  - Uncertainty is directly applied to limits

- **For Weights**: `weight × (1 ± delta) / (limitRatio)`
  - Where `limitRatio = actualLimit / spotLimit`
  - The division by `limitRatio` accounts for uncertainty already propagated to limits
  - This prevents double-counting the delta uncertainty
  - Since `balance = weight × limit`, if limits already contain uncertainty, weights must be adjusted to avoid compounding it

## Error Handling

The algorithm includes several safety checks:

1. Spot prices must remain within initial price bounds
2. Progression should not go backwards (except for rounding)
3. BU value and share value should not differ by more than 10x
4. All array lengths must match
5. Minimum $1 trade value per token

## Usage Notes

1. **AUCTION_LAUNCHER** role uses `getOpenAuction()` results with `folio.openAuction()`
2. Non-launchers should use `folio.openAuctionUnrestricted()`
3. The algorithm is stateless - each call recalculates from current state
4. Prices should be passed differently for tracking vs native rebalances
5. The 10% buffer in ejection rounds prevents premature surplus depletion
