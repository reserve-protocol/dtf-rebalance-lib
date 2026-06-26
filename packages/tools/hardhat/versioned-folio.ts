import { Contract } from "ethers";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { HardhatRuntimeEnvironment } from "hardhat/types";

import { FolioVersion, OpenAuctionArgs, PriceRange, WeightRange } from "../../../src/types";
import type {
  Rebalance as RebalanceV4,
  StartRebalanceArgsPartial as StartRebalanceArgsPartialV4,
} from "../../../src/4.0.0/types";
import type {
  Rebalance as RebalanceV5,
  StartRebalanceArgsPartial as StartRebalanceArgsPartialV5,
} from "../../../src/5.0.0/types";
import type {
  Rebalance as RebalanceV6,
  StartRebalanceArgsPartial as StartRebalanceArgsPartialV6,
} from "../../../src/6.0.0/types";

export type VersionedRebalance = RebalanceV4 | RebalanceV5 | RebalanceV6;
export type VersionedStartRebalanceArgs =
  | StartRebalanceArgsPartialV4
  | StartRebalanceArgsPartialV5
  | StartRebalanceArgsPartialV6;

export interface RebalanceTokenView {
  token: string;
  weight: WeightRange;
  price: PriceRange;
}

export interface RebalanceView {
  availableUntil: bigint;
  tokens: RebalanceTokenView[];
}

const V4_GET_REBALANCE_ABI = [
  "function getRebalance() view returns (uint256 nonce, address[] tokens, (uint256 low, uint256 spot, uint256 high)[] weights, (uint256 low, uint256 high)[] initialPrices, bool[] inRebalance, (uint256 low, uint256 spot, uint256 high) limits, uint256 startedAt, uint256 restrictedUntil, uint256 availableUntil, uint8 priceControl)",
];

const V4_START_REBALANCE_ABI = [
  "function startRebalance(address[] tokens, (uint256 low, uint256 spot, uint256 high)[] weights, (uint256 low, uint256 high)[] prices, (uint256 low, uint256 spot, uint256 high) limits, uint256 auctionLauncherWindow, uint256 ttl)",
];

export async function getRebalanceForVersion(
  version: FolioVersion,
  hre: HardhatRuntimeEnvironment,
  folio: Contract,
): Promise<VersionedRebalance> {
  if (version === FolioVersion.V4) {
    const v4Iface = new hre.ethers.Interface(V4_GET_REBALANCE_ABI);
    const v4Folio = new hre.ethers.Contract(await folio.getAddress(), v4Iface, hre.ethers.provider);
    return v4Folio.getRebalance() as Promise<RebalanceV4>;
  }

  return folio.getRebalance() as Promise<RebalanceV5 | RebalanceV6>;
}

export function toRebalanceView(version: FolioVersion, rebalance: VersionedRebalance): RebalanceView {
  switch (version) {
    case FolioVersion.V4: {
      const rebalanceV4 = rebalance as RebalanceV4;
      return {
        availableUntil: rebalanceV4.availableUntil,
        tokens: rebalanceV4.tokens.map((token, i) => ({
          token,
          weight: rebalanceV4.weights[i],
          price: rebalanceV4.initialPrices[i],
        })),
      };
    }
    case FolioVersion.V5:
    case FolioVersion.V6: {
      const rebalanceV5Plus = rebalance as RebalanceV5 | RebalanceV6;
      return {
        availableUntil: rebalanceV5Plus.timestamps.availableUntil,
        tokens: rebalanceV5Plus.tokens.map(({ token, weight, price }) => ({ token, weight, price })),
      };
    }
    default:
      throw new Error(`Unsupported version: ${version}`);
  }
}

export async function getAuctionLengthForVersion(version: FolioVersion, folio: Contract): Promise<bigint | undefined> {
  switch (version) {
    case FolioVersion.V6:
      return folio.maxAuctionLength();
    case FolioVersion.V4:
    case FolioVersion.V5:
      return undefined;
    default:
      throw new Error(`Unsupported version: ${version}`);
  }
}

export async function submitStartRebalanceForVersion(
  version: FolioVersion,
  hre: HardhatRuntimeEnvironment,
  folio: Contract,
  signer: HardhatEthersSigner,
  startRebalanceArgs: VersionedStartRebalanceArgs,
): Promise<void> {
  switch (version) {
    case FolioVersion.V4: {
      const v4Args = startRebalanceArgs as StartRebalanceArgsPartialV4;
      const v4Iface = new hre.ethers.Interface(V4_START_REBALANCE_ABI);
      const v4Folio = new hre.ethers.Contract(await folio.getAddress(), v4Iface, signer);
      await (
        await v4Folio.startRebalance(v4Args.tokens, v4Args.weights, v4Args.prices, v4Args.limits, 0n, 1000000n)
      ).wait();
      return;
    }
    case FolioVersion.V5: {
      const v5Args = startRebalanceArgs as StartRebalanceArgsPartialV5;
      await (await (folio.connect(signer) as any).startRebalance(v5Args.tokens, v5Args.limits, 0n, 1000000n)).wait();
      return;
    }
    case FolioVersion.V6: {
      const v6Args = startRebalanceArgs as StartRebalanceArgsPartialV6;
      const [nonce] = await folio.getRebalance();
      await (
        await (folio.connect(signer) as any).startRebalance(nonce + 1n, v6Args.tokens, v6Args.limits, 0n, 1000000n)
      ).wait();
      return;
    }
    default:
      throw new Error(`Unsupported version: ${version}`);
  }
}

export async function submitOpenAuctionForVersion(
  version: FolioVersion,
  folio: Contract,
  signer: HardhatEthersSigner,
  openAuctionArgs: OpenAuctionArgs,
): Promise<void> {
  const folioWithSigner = folio.connect(signer) as any;
  const args = [
    openAuctionArgs.rebalanceNonce,
    openAuctionArgs.tokens,
    openAuctionArgs.newWeights,
    openAuctionArgs.newPrices,
    openAuctionArgs.newLimits,
  ];

  switch (version) {
    case FolioVersion.V4:
    case FolioVersion.V5:
      await (await folioWithSigner.openAuction(...args)).wait();
      return;
    case FolioVersion.V6:
      if (openAuctionArgs.auctionLength === undefined) {
        throw new Error("Folio 6.0.0 openAuction requires auctionLength");
      }
      await (await folioWithSigner.openAuction(...args, openAuctionArgs.auctionLength)).wait();
      return;
    default:
      throw new Error(`Unsupported version: ${version}`);
  }
}
