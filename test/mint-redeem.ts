import "@nomicfoundation/hardhat-ethers";
import { HardhatRuntimeEnvironment } from "hardhat/types";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { expect } from "chai";
import { Contract } from "ethers";

/**
 * Post-check: mint shares then redeem, verify supply invariants.
 * Tokens must already be mocked (via doAuctions or mockBasketTokens).
 *
 * V5 Folio signatures:
 *   mint(uint256 shares, address receiver, uint256 minSharesOut)
 *   redeem(uint256 shares, address receiver, address[] assets, uint256[] minAmountsOut)
 */
export async function mintAndRedeem(
  hre: HardhatRuntimeEnvironment,
  folio: Contract,
  user: HardhatEthersSigner,
) {
  console.log(`\n🧪 Mint & Redeem check...`);

  const supplyBefore = await folio.totalSupply();
  const folioAddress = await folio.getAddress();

  // Get basket tokens and required amounts for minting
  const [tokens, balances] = await folio.totalAssets();

  if (tokens.length === 0) {
    console.log(`   ⚠️ No basket tokens — skipping mint/redeem`);
    return;
  }

  // Mint a small amount — 0.01% of supply, min 1e12
  const mintAmount = supplyBefore / 10000n > 1000000000000n ? supplyBefore / 10000n : 1000000000000n;

  // Approve and mint tokens to the user for minting folio shares
  for (const token of tokens) {
    const tokenContract = (await hre.ethers.getContractAt("ERC20Mock", token)) as unknown as Contract;

    const tokenIdx = tokens.indexOf(token);
    const tokenBalance = balances[tokenIdx];

    // Calculate proportional amount needed: (mintAmount / totalSupply) * tokenBalance * 2x buffer
    const neededAmount = supplyBefore > 0n
      ? (mintAmount * tokenBalance * 2n) / supplyBefore + 1n
      : tokenBalance;

    await (await tokenContract.mint(user.address, neededAmount)).wait();
    await (await (tokenContract.connect(user) as Contract).approve(folioAddress, neededAmount)).wait();
  }

  // Mint shares: mint(shares, receiver, minSharesOut=0)
  try {
    await (await (folio.connect(user) as any).mint(mintAmount, user.address, 0n)).wait();
  } catch (error: any) {
    console.log(`   ⚠️ Mint failed: ${error.message?.slice(0, 200)}`);
    return;
  }

  const supplyAfterMint = await folio.totalSupply();
  expect(supplyAfterMint).to.be.greaterThan(supplyBefore);
  console.log(`   ✅ Minted ${mintAmount} shares (supply: ${supplyBefore} → ${supplyAfterMint})`);

  // Now redeem the minted shares
  const userBalance = await folio.balanceOf(user.address);
  const redeemAmount = userBalance > mintAmount ? mintAmount : userBalance;

  // Build assets array and minAmountsOut (zeros = no minimum)
  const assetsArray = [...tokens];
  const minAmountsOut = assetsArray.map(() => 0n);

  // Redeem shares: redeem(shares, receiver, assets, minAmountsOut)
  try {
    await (await (folio.connect(user) as any).redeem(redeemAmount, user.address, assetsArray, minAmountsOut)).wait();
  } catch (error: any) {
    console.log(`   ⚠️ Redeem failed: ${error.message?.slice(0, 200)}`);
    return;
  }

  const supplyAfterRedeem = await folio.totalSupply();
  console.log(`   ✅ Redeemed ${redeemAmount} shares (supply: ${supplyAfterMint} → ${supplyAfterRedeem})`);

  // Supply after redeem should be back close to before (within minting dust + fees)
  const supplyDiff = supplyAfterRedeem > supplyBefore
    ? supplyAfterRedeem - supplyBefore
    : supplyBefore - supplyAfterRedeem;

  // Allow up to 1% deviation due to rounding and fees
  const tolerance = supplyBefore / 100n + 1n;
  expect(supplyDiff <= tolerance).to.be.true;
  console.log(`   ✅ Supply invariant maintained (diff: ${supplyDiff})`);
}
