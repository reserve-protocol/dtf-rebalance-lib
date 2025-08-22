import { Folio } from "../src/types";

export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
export const ZERO_BYTES = "0x0000000000000000000000000000000000000000000000000000000000000000";

export const CHAIN_RPC_URLS: Record<number, string | undefined> = {
  1: process.env.MAINNET_RPC_URL,
  8453: process.env.BASE_RPC_URL,
};

export const CHAIN_BLOCK_NUMBERS: Record<number, number | undefined> = {
  1: 23078902,
  8453: 33430815,
};

export const FOLIO_CONFIGS: Folio[] = [
  {
    name: "OPEN",
    chainId: 1,
    folio: "0x323c03c48660fe31186fa82c289b0766d331ce21",
    proxyAdmin: "0x0b79E381eD8D6d676C772Dba61cbeEA0B2d28c7D",
    basketGovernor: "0xe7b6c199bbb1b4c08efdadd4bbe99d246ac9a7dd",
  },
  {
    name: "BED",
    chainId: 1,
    folio: "0x4E3B170DcBe704b248df5f56D488114acE01B1C5",
    proxyAdmin: "0xEAa356F6CD6b3fd15B47838d03cF34fa79F7c712",
    basketGovernor: "0xe7b6c199bbb1b4c08efdadd4bbe99d246ac9a7dd",
  },
  {
    name: "DGI",
    chainId: 1,
    folio: "0x9a1741E151233a82Cf69209A2F1bC7442B1fB29C",
    proxyAdmin: "0xe24e3DBBEd0db2a9aC2C1d2EA54c6132Dce181b7",
    basketGovernor: "0x665339c6e5168a0f23e5a1adab568027e8df2673",
  },
  {
    name: "DFX",
    chainId: 1,
    folio: "0x188D12Eb13a5Eadd0867074ce8354B1AD6f4790b",
    proxyAdmin: "0x0e3B2EF9701d5Ef230CB67Ee8851bA3071cf557C",
    basketGovernor: "0x1742b681cabe3111598e1be2a9313c787fe906c6",
  },
  {
    name: "mvDEFI",
    chainId: 1,
    folio: "0x20d81101D254729a6E689418526bE31e2c544290",
    proxyAdmin: "0x3927882f047944A9c561F29E204C370Dd84852Fd",
    basketGovernor: "0x5aaa18f0f1449a43f4de5e4c175885da4f70af04",
  },
  {
    name: "SMEL",
    chainId: 1,
    folio: "0xF91384484F4717314798E8975BCd904A35fc2BF1",
    proxyAdmin: "0xDd885B0F2f97703B94d2790320b30017a17768BF",
    basketGovernor: "0x41e2aa9b0f6c2600f21cfb88473e73745a28b50f",
  },
  {
    name: "mvRWA",
    chainId: 1,
    folio: "0xA5cdea03B11042fc10B52aF9eCa48bb17A2107d2",
    proxyAdmin: "0x019318674560C233893aA31Bc0A380dc71dc2dDf",
    basketGovernor: "0x87a7cd8ec8d6e3a87ac57ef1bec3b5f3c72080f7",
  },
  {
    name: "BGCI",
    chainId: 8453,
    folio: "0x23418de10d422ad71c9d5713a2b8991a9c586443",
    proxyAdmin: "0x2330a29DE3238b07b4a1Db70a244A25b8f21ab91",
    basketGovernor: "0xc94a762854d7d3a0252e6c00a23c9360978ccb57",
  },
  {
    name: "CLX",
    chainId: 8453,
    folio: "0x44551CA46Fa5592bb572E20043f7C3D54c85cAD7",
    proxyAdmin: "0x4472F1f3aD832Bed3FDeF75ace6540c2f3E5a187",
    basketGovernor: "0x106f0302d12a51691b278bd04b1b447cce4a9943",
  },
  {
    name: "ABX",
    chainId: 8453,
    folio: "0xeBcda5b80f62DD4DD2A96357b42BB6Facbf30267",
    proxyAdmin: "0xF3345fca866673BfB58b50F00691219a62Dd6Dc8",
    basketGovernor: "0x0e7049f86d7ef4f724104a1c62290f8b7fc9ac38",
  },
  {
    name: "MVTT10F",
    chainId: 8453,
    folio: "0xe8b46b116D3BdFA787CE9CF3f5aCC78dc7cA380E",
    proxyAdmin: "0xBe278Be45C265A589BD0bf8cDC6C9e5a04B3397D",
    basketGovernor: "0x65e90cbf1e03150273808506a4d16e32ac50ec7f",
  },
  {
    name: "MVDA25",
    chainId: 8453,
    folio: "0xD600e748C17Ca237Fcb5967Fa13d688AFf17Be78",
    proxyAdmin: "0xb467947f35697FadB46D10f36546E99A02088305",
    basketGovernor: "0xac0fb1e80e96a6bb30d8afc83c7e3e1e666e8177",
  },
  {
    name: "BDTF",
    chainId: 8453,
    folio: "0xb8753941196692E322846cfEE9C14C97AC81928A",
    proxyAdmin: "0xADC76fB0A5ae3495443E8df8D411FD37a836F763",
    basketGovernor: "0xa9e47a079de056854d3e0ffd48b87e6e8c096b84",
  },
  {
    name: "AI",
    chainId: 8453,
    folio: "0xfe45EDa533e97198d9f3dEEDA9aE6c147141f6F9",
    proxyAdmin: "0x456219b7897384217ca224f735DBbC30c395C87F",
    basketGovernor: "0xc3bb42e45e6bb5cd825e063e7bb31e8fec6fce7b",
  },
  {
    name: "VTF",
    chainId: 8453,
    folio: "0x47686106181b3cefe4eaf94c4c10b48ac750370b",
    proxyAdmin: "0x7C1fAFfc7F3a52aa9Dbd265E5709202eeA3A8A48",
    basketGovernor: "0xc570368439b4e26e30e6fb8a51122b1d33c3b3ba",
  },
  {
    name: "LCAP",
    chainId: 8453,
    folio: "0x4da9a0f397db1397902070f93a4d6ddbc0e0e6e8",
    proxyAdmin: "0xf6Db82f6b5F343d74A1D88af9e58fA1d2D89562e",
    basketGovernor: "0xf9edb4491fbd5e1185e05ecba2d69251dd869096",
  },
];
