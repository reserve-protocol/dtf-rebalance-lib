# dtf-rebalance-lib

Rebalancing library for DTFs in typescript. Computes the parameters needed to rebalance a DTF portfolio through a series of on-chain auctions, converging from its current composition toward a target basket.

For detailed formulas and worked examples, see [docs/auction-algorithm.md](docs/auction-algorithm.md).

## How rebalancing works

Rebalancing is a two-phase process:

1. **Start** -- Call `getStartRebalance()` once to open a new rebalance. It computes initial weight ranges, price ranges, limits, and per-token auction size caps based on the current portfolio, target basket, and market prices.

2. **Auction rounds** -- Call `getOpenAuction()` repeatedly (once per round) to produce tightening parameters that progressively move the portfolio toward its target. Each round narrows the weight/price bounds and advances a _progression_ metric from 0 toward 1.

## Key concepts

**Weights and limits.** Each token's expected balance per share is `weight * limit`. Weights describe _how much_ of each token a basket unit contains; limits describe _how many_ basket units a share is worth.

**Low/high bounds.** Every weight and limit has a low, spot, and high value. The low bound defines what you buy _up to_ and the high bound defines what you sell _down to_, creating a corridor within which the auction clears.

**Progression.** A 0-to-1 metric measuring how close the portfolio is to its target composition. Each auction round advances progression by a controlled step, and the final round pushes it to 1.

**maxAuctionSize.** Caps the USD value each token can trade in a single auction round, limiting market impact. Set per-token in `getStartRebalance()`.

## Auction rounds

Each call to `getOpenAuction()` produces one of three round types:

- **EJECT** -- Removes tokens that are being dropped from the basket entirely (weight target is zero). Runs first if applicable.
- **PROGRESS** -- The main phase. Moves the portfolio toward the target in controlled steps, with each step bounded by `maxAuctionSize` and a progression target.
- **FINAL** -- Once progression crosses the `finalStageAt` threshold, tightens bounds to zero spread and finishes the rebalance.

## Tracking vs Native

**Tracking rebalances** (`weightControl = false`) keep weights fixed and move only the limits. This changes the _scale_ of the portfolio -- how many basket units each share represents -- without changing composition. The target basket is computed from current market prices.

**Native rebalances** (`weightControl = true`) keep limits fixed and move only the weights. This changes the _composition_ of the portfolio -- which tokens and in what proportions -- without changing scale. The target basket is computed from the prices at rebalance start.

## Parameters

### `getStartRebalance()`

| Parameter | Type | Description |
| --- | --- | --- |
| `version` | `FolioVersion` | Protocol version (`V4` or `V5`) |
| `_supply` | `bigint` | Current total share supply |
| `tokens` | `string[]` | Token addresses in the basket |
| `_assets` | `bigint[]` | Current token balances |
| `decimals` | `bigint[]` | Decimals for each token |
| `_targetBasket` | `bigint[]` | D18 ideal basket proportions |
| `_prices` | `number[]` | USD price per whole token |
| `_priceError` | `number[]` | Price error fraction per token |
| `_maxAuctionSizes` | `number[]` | Max USD auction size per token |
| `weightControl` | `boolean` | `false` = tracking, `true` = native |
| `deferWeights` | `boolean` | Use full weight range (native only) |
| `debug` | `boolean?` | Log debug output |

**Returns** `StartRebalanceArgsPartial` -- contains `tokens` (with weight ranges, price ranges, and max auction sizes per token) and `limits` (low/spot/high).

### `getOpenAuction()`

| Parameter | Type | Description |
| --- | --- | --- |
| `version` | `FolioVersion` | Protocol version |
| `_rebalance` | `Rebalance` | On-chain rebalance state |
| `_supply` | `bigint` | Current total share supply |
| `_initialSupply` | `bigint` | Supply at rebalance start |
| `_initialAssets` | `bigint[]` | Token balances at rebalance start |
| `_targetBasket` | `bigint[]` | D18 ideal basket proportions |
| `_assets` | `bigint[]` | Current token balances |
| `_decimals` | `bigint[]` | Token decimals |
| `_prices` | `number[]` | Current USD prices per whole token |
| `_priceError` | `number[]` | Price error fraction per token |
| `_finalStageAt` | `number` | Progression threshold to enter FINAL (e.g. 0.9) |
| `debug` | `boolean?` | Log debug output |

**Returns** `[OpenAuctionArgs, AuctionMetrics]` -- the on-chain call arguments and a metrics object describing the round type, progression, and per-token surplus/deficit sizes.

## Utility functions

- **`getTargetBasket(weights, prices, decimals)`** -- Computes the D18 target basket proportions from initial weights and prices.
- **`getBasketDistribution(balances, prices, decimals)`** -- Returns the D18 value distribution across tokens given current balances and prices.
- **`getBasketAccuracy(balances, prices, decimals, weights)`** -- Returns a 0-to-1 score measuring how closely current balances match the target weights.
