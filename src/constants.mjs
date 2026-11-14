export const ENGINE_VERSION = "recurring-payment-agent/2.0.0";
export const NETWORK = {
  name: "Pharos Pacific Mainnet",
  chainId: 1672,
  mcpUrl: "https://mcp.pharos.xyz/mcp",
  nativeSymbol: "PHRS"
};
export const USDC = {
  address: "0xc879c018db60520f4355c26ed1a6d572cdac1815",
  symbol: "USDC",
  decimals: 6
};
export const REVIEW_TEXT =
  "I reviewed the immutable occurrence terms and understand this export is unsigned and not paid.";
export const LIMITS = {
  catchUp: 12,
  validationTtlMs: 10 * 60 * 1000,
  confirmations: 1,
  requestsPerMinute: 90
};
export const ERC20_ABI = [
  {
    type: "function",
    name: "decimals",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint8" }]
  },
  {
    type: "function",
    name: "symbol",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "string" }]
  },
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ type: "uint256" }]
  },
  {
    type: "function",
    name: "transfer",
    stateMutability: "nonpayable",
    inputs: [
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" }
    ],
    outputs: [{ type: "bool" }]
  },
  {
    type: "event",
    name: "Transfer",
    inputs: [
      { name: "from", type: "address", indexed: true },
      { name: "to", type: "address", indexed: true },
      { name: "value", type: "uint256", indexed: false }
    ]
  }
];
