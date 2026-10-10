# Vota 1.0.0 widget candidate

Based on ping-pub/widget c9de63a908ed2737bc69ca628a7386e3b4ee3ced. This source fork preserves uint64 account IDs through BigInt and uses CosmJS 0.39.0. Both transaction-dialog and token-conversion signing paths share the strict parser. Unsafe numeric IDs are rejected instead of rounded.

Address decoding supplies an explicit 1023-character bound: CosmJS 0.39.0 defaults to Infinity, which is rejected by the resolved @scure/base 2.4.0. Token amounts retain decimal strings. Dora's 18-decimal metadata, delegation balance checks and MAX behavior are maintained in source.

Build with Node 22 and `npm ci && npm run build`. The root package-lock.json is authoritative. Old committed dist files and the stale root yarn.lock were removed. Explorer deployment must verify the generated bundle against its reviewed manifest.

The isolated browser tests use disposable software signers and do not certify real wallet extensions or hardware devices. Direct and Amino adapters must be separately verified against deployed wallet versions. Ethermint, swaps and non-Vota integrations are outside this validation scope. Older transitive Cosmos libraries still exist in legacy multi-chain adapters; they are not represented as upgraded or audited by changing the direct CosmJS dependencies.

No production deployment or npm publication is implied by this candidate.
