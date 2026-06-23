# dtf-rebalance-tools

Private, repo-internal SDK-aware operational helpers for DTF rebalance simulations.

The core package, `@reserve-protocol/dtf-rebalance-lib`, stays deterministic and SDK-independent. This workspace is allowed to depend on `@reserve-protocol/sdk` for Reserve API access and higher-level DTF context.

This workspace is marked `private: true` and must not be published. It exists only for repo-local scripts, fork tests, and Hardhat task adapters.

The `src/` directory contains internal SDK-backed helpers. The `hardhat/` directory contains fork simulation adapters used by the root Hardhat config and is intentionally kept outside the workspace build.
