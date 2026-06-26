import { describe, it } from "node:test";
import { strict as assert } from "node:assert";

import { bn } from "../../src/numbers";
import {
  FolioVersion,
  PriceControl,
  Rebalance as RebalanceV5Root,
  StartRebalanceArgsPartial as StartRebalanceArgsPartialV5Root,
} from "../../src/types";
import type { RebalanceV5, RebalanceV6 } from "../../src";
import { Rebalance, StartRebalanceArgsPartial } from "../../src/6.0.0/types";
import { getOpenAuction } from "../../src/open-auction";
import { getStartRebalance } from "../../src/start-rebalance";

describe("Folio 6.0.0 paths", () => {
  const supply = bn("1e18");
  const tokens = ["USDC", "DAI", "USDT"];
  const decimals = [bn("6"), bn("18"), bn("6")];
  const prices = [1, 1, 1];
  const initialFolio = [bn("1e6"), bn("0"), bn("0")];
  const targetBasket = [bn("0"), bn("0.5e18"), bn("0.5e18")];

  const getV6StartArgs = () =>
    getStartRebalance(
      FolioVersion.V6,
      supply,
      tokens,
      initialFolio,
      decimals,
      targetBasket,
      prices,
      [0.1, 0.1, 0.1],
      tokens.map(() => 1e12),
      true,
      false,
    ) as StartRebalanceArgsPartial;

  const getV6Rebalance = (): Rebalance => {
    const startArgs = getV6StartArgs();

    return {
      nonce: 1n,
      priceControl: PriceControl.PARTIAL,
      tokens: startArgs.tokens,
      limits: startArgs.limits,
      timestamps: {
        startedAt: 0n,
        restrictedUntil: 0n,
        availableUntil: 0n,
      },
      bidsEnabled: true,
    };
  };

  it("returns 6.0.0 startRebalance token params", () => {
    const args = getV6StartArgs();

    assert.equal(args.tokens.length, 3);
    assert.equal(args.tokens[0].token, "USDC");
    assert.equal(args.tokens[0].inRebalance, true);
    assert.equal(args.tokens[0].maxAuctionSize > 0n, true);
    assert.equal(args.limits.spot, bn("1e18"));
  });

  it("allows exact zero spot weights for deferred 6.0.0 removals", () => {
    const args = getStartRebalance(
      FolioVersion.V6,
      supply,
      tokens,
      initialFolio,
      decimals,
      targetBasket,
      prices,
      [0.1, 0.1, 0.1],
      tokens.map(() => 1e12),
      true,
      true,
    ) as StartRebalanceArgsPartial;

    assert.equal(args.tokens[0].weight.low, 0n);
    assert.equal(args.tokens[0].weight.spot, 0n);
    assert.equal(args.tokens[0].weight.high, bn("1e54"));
  });

  it("keeps root Rebalance type V5-compatible", () => {
    const rootStartArgs = getStartRebalance(
      FolioVersion.V5,
      supply,
      tokens,
      initialFolio,
      decimals,
      targetBasket,
      prices,
      [0.1, 0.1, 0.1],
      tokens.map(() => 1e12),
      true,
      false,
    ) as StartRebalanceArgsPartialV5Root;

    const rootRebalance: RebalanceV5Root = {
      nonce: 1n,
      priceControl: PriceControl.PARTIAL,
      tokens: rootStartArgs.tokens,
      limits: rootStartArgs.limits,
      timestamps: {
        startedAt: 0n,
        restrictedUntil: 0n,
        availableUntil: 0n,
      },
    };
    const aliasRebalance: RebalanceV5 = rootRebalance;
    const v6Rebalance: RebalanceV6 = { ...rootRebalance, bidsEnabled: true };

    assert.equal(aliasRebalance.tokens.length, 3);
    assert.equal(v6Rebalance.bidsEnabled, true);
  });

  it("returns 6.0.0 openAuction args with auctionLength", () => {
    const rebalance = getV6Rebalance();

    const auctionLength = 3600n;
    const [openAuctionArgs] = getOpenAuction(
      FolioVersion.V6,
      rebalance,
      supply,
      supply,
      initialFolio,
      targetBasket,
      initialFolio,
      decimals,
      prices,
      [0.01, 0.01, 0.01],
      0.9,
      false,
      auctionLength,
    );

    assert.equal(openAuctionArgs.rebalanceNonce, 1n);
    assert.deepEqual(openAuctionArgs.tokens, tokens);
    assert.equal(openAuctionArgs.auctionLength, auctionLength);
  });

  it("requires auctionLength for 6.0.0 openAuction args", () => {
    const rebalance = getV6Rebalance();

    assert.throws(
      () =>
        getOpenAuction(
          FolioVersion.V6,
          rebalance,
          supply,
          supply,
          initialFolio,
          targetBasket,
          initialFolio,
          decimals,
          prices,
          [0.01, 0.01, 0.01],
          0.9,
        ),
      { message: "Folio 6.0.0 openAuction requires auctionLength" },
    );
  });
});
