# Changelog

## 1.1.0 — 2026-07-17

### Better with OmniCore (lean working set)

- Documented end-to-end contract with OmniCore Engine + Local AI plugin:
  - GPU sees **packed working set** (~8K), not a full message dump
  - Vault bodies stay **append-only** (`bodyHash`); SYNC_CTX is ranking-only
  - Engine **chunked prefill** + **no silent prompt truncation**
  - Overflow via `recall_context` / `read_file`, not KV inflation
- README: before/after table, updated architecture diagram, lean-path proofs (`virtual-ctx-lean`)
- Points at OmniCore warm TCP `:8742` attach path

## 1.0.0 — 2026-07-17

Initial release: infinite virtual context vault for local LLM agents.
