# Infinite Virtual Context

**100K+ virtual context** for local LLM agents — without stuffing everything into GPU `num_ctx`.

The model sees a **smart GPU working set**; the rest lives in an append-only vault with cryptographic integrity. Facts do not mutate. Tool results stay recoverable. Overflow is recalled on demand (`recall_context` / `read_file`) — never by silently dropping the head of a giant dump.

## What’s new (v1.1 · OmniCore lean path)

Wired end-to-end with **OmniCore Engine** + Local AI plugin:

| Before | Now |
|--------|-----|
| Full `messages[]` often dumped into one OmniCore prompt → assert / hang / IQ loss | **Lean GPU prompt**: vault `pack` + recent turns only |
| Engine could **truncate** oversized prompts (lost early facts) | Engine **refuses** dumps `> n_ctx` — no silent head-drop |
| Prefill one giant `llama_batch` → crash if `> n_batch` | Prefill **chunked** by `n_batch` (stable long agent turns) |
| Warm daemon attach races / stale sockets → “no reply”, 0 engine activity | TCP **warm attach** on `:8742` with reconnect + ready-race fix |
| Vault sync could look like mutation | Wire payload is ranking-only; **bodyHash** vault bodies untouched |

**Contract unchanged:** virtual tokens = address space; GPU ≈ **8K** working set; vault = lossless store.

Proofs in the plugin tree: `test/virtual-ctx-lean.cjs`, `test/context-integrity.cjs` — PASS.

## Install

```bash
npm install
npm test
```

Node 18+. No GPU required for the vault itself (pairs with [OmniCore](https://github.com/1Anton10/omnicore-engine) or any OpenAI-compatible chat API).

```js
const { ContextVault, packForGpu, bodyHash } = require('infinite-virtual-context');

const vault = new ContextVault({ virtualTarget: 100_000, gpuBudget: 8192 });
vault.add({ id: 'file:src/app.js', kind: 'file', body: sourceCode, pinned: true });
vault.addFromTool('read_file', { path: 'src/app.js' }, fileText);

const { messages, stats } = packForGpu(vault, {
  system: 'You are a coding agent.',
  user: 'Where is auth handled?',
  history: [],
});
// messages → send to your model
// vault originals unchanged; stats.virtualTok can be ~100K while gpuTok ~8K
```

## Connect your models

| Backend | How |
|---------|-----|
| **OmniCore** (recommended) | Plugin builds lean prompt via vault pack; chunks also `SYNC_CTX` for daemon ranking. Warm TCP `:8742`. |
| **OpenAI-compatible / llama.cpp server** | `chat.completions` with `messages` from `packForGpu` |
| **VS Code Local AI plugin** | Built-in (`ContextVault` + `virtualCtxTarget: 100000`, `inferenceBackend: omnicore`) |
| Any local OpenAI-style API | POST chat with `messages` from `packForGpu` |

```js
// Example: OpenAI-compatible local endpoint
const res = await fetch('http://127.0.0.1:8080/v1/chat/completions', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ model: 'local', messages, stream: false }),
});
```

Keep **generation `num_ctx` = full GPU window** (e.g. 8192 with OmniCore). Do not re-anchor/trim the system prompt on every tool turn — that is what dumbs the model down.

## How it works

1. **Vault** stores every chunk with `body` + `bodyHash` (SHA-256). Mutation is detectable.  
2. **Packer** selects pinned + high-relevance chunks into a GPU budget (~2–8K tok).  
3. **Virtual total** = sum of chunk sizes (target 100K) — recoverable via `recall` / re-read from disk.  
4. **Fold** may compress *prompt copies* for the next turn; **vault bodies are never rewritten**.  
5. **OmniCore**: lean pack → chunked prefill → decode; overflow stays in vault, not in KV.

```
┌──────────── virtual 100K+ ───────────┐
│  vault (append-only, bodyHash)       │
│    ├─ project index / files          │
│    ├─ tool results (full kept)       │
│    └─ history / IO tape              │
└───────────────┬──────────────────────┘
                │ packForGpu / lean OmniCore prompt
                ▼
         GPU working set (~8K)
                │ chunked prefill (n_batch)
                ▼
            LLM decode
                │
                └── recall_context / read_file ──► vault (no mutation)
```

## Metrics & proof

From Local AI / OmniCore suite (RTX 2060S · 32GB class):

| Check | Result |
|-------|--------|
| FACT / UNIQUE markers survive fold | PASS |
| `bodyHash` detects in-place mutation | PASS |
| Lean OmniCore prompt ≪ raw vault; bodies intact after pack/SYNC | PASS (`virtual-ctx-lean`) |
| Gen `num_ctx` uses full effective window (not warm-only) | PASS |
| Virtual target | **100_000** tok default |
| Typical GPU slice | **~8K** tok (OmniCore `n_ctx`) |
| OmniCore 1B CUDA (warm) | **224.82 tok/s** (engine proof) |

Re-run proofs:

```bash
npm test
# or in the Local AI plugin tree:
node test/context-integrity.cjs
node test/virtual-ctx-lean.cjs
node test/context-quality-audit.cjs
```

**Vs dumping 100K into `num_ctx`:** keeps interactive speed and model IQ.  
**Vs silent truncate:** vault retains exact text; GPU sees ranked slice + tools to re-fetch.  
**Vs refuse-without-vault:** plugin never sends mega-dumps; engine never deletes facts to “make it fit.”

## API (minimal)

- `new ContextVault({ virtualTarget, gpuBudget })`
- `vault.add(chunk)` / `addFromTool(name, args, text)`
- `vault.verifyIntegrity()` → `{ ok, bad[] }`
- `packForGpu(vault, { system, user, history, task })` → `{ messages, stats }`
- `bodyHash(text)` / `assertMarkersPreserved(before, after)`

## Companion

- Engine: https://github.com/1Anton10/omnicore-engine  
- This vault: https://github.com/1Anton10/infinite-virtual-context

## License

MIT
