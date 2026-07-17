# Changelog

## 1.3.0 — 2026-07-17

### Independent drop-in add-on

- **`attach()`** — one call plugs virtual context into any OpenAI-compatible chat API (`chat.completions.create`, `wrapFetch`, `pack`, `remember`)
- **`packMessages` / `rewriteChatRequest`** — wrap existing `messages[]` / request bodies without rebuilding your agent
- **`proxy.js`** — zero-code HTTP sidecar: point any client at the proxy, packing is automatic
- README rewritten: product = **independent supplement**, OmniCore optional — not a compatibility matrix of “maybe DIY”

## 1.2.0 — 2026-07-17

### Any-backend virtual context (honest matrix)

- Documented what works where; added `packWorkingSet` alias

## 1.1.0 — 2026-07-17

### OmniCore lean path docs

- Documented end-to-end contract with OmniCore Engine + Local AI plugin

## 1.0.0 — 2026-07-17

Initial release: infinite virtual context vault for local LLM agents.
