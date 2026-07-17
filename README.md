# Infinite Virtual Context

**100K+ virtual context** for local LLM agents — without stuffing everything into GPU `num_ctx`.

The model sees a **smart GPU slice**; the rest lives in an append-only vault with cryptographic integrity. Facts do not mutate. Tool results stay recoverable.

## Install

```bash
npm install
npm test
```

Node 18+. No GPU required for the vault itself (pairs with Ollama / OmniCore / any OpenAI-compatible backend).

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
| **Ollama** | Build `messages` via `packForGpu`, POST `/api/chat` with that array |
| **OmniCore** | Same messages; or send vault chunks over `SYNC_CTX` JSON stdin |
| **OpenAI / llama.cpp server** | `chat.completions` with `messages` from `packForGpu` |
| **VS Code Local AI plugin** | Built-in (`ContextVault` + `virtualCtxTarget: 100000`) |

```js
// Ollama example
const res = await fetch('http://127.0.0.1:11434/api/chat', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ model: 'qwen2.5-coder:14b', messages, stream: false }),
});
```

Keep **generation `num_ctx` = full GPU window** (e.g. 3072–8192). Do not re-anchor/trim the system prompt on every tool turn — that is what dumbs the model down.

## How it works

1. **Vault** stores every chunk with `body` + `bodyHash` (SHA-256). Mutation is detectable.  
2. **Packer** selects pinned + high-relevance chunks into a GPU budget (~2–8K tok).  
3. **Virtual total** = sum of chunk sizes (target 100K) — recoverable via `recall` / re-read from disk.  
4. **Fold** may compress *prompt copies* for the next turn; **vault bodies are never rewritten**.

```
┌──────────── virtual 100K ────────────┐
│  vault (append-only, bodyHash)       │
│    ├─ project index / files          │
│    ├─ tool results (full kept)       │
│    └─ history / IO tape              │
└───────────────┬──────────────────────┘
                │ packForGpu(budget)
                ▼
         GPU sliding window (2–8K)
                │
                ▼
            LLM decode
```

## Metrics & proof

From Local AI / OmniCore offline suite (RTX 2060S · 32GB class):

| Check | Result |
|-------|--------|
| FACT / UNIQUE markers survive fold | PASS |
| `bodyHash` detects in-place mutation | PASS |
| Gen `num_ctx` uses full effective window (not warm-only) | PASS |
| Minimal system (no rules dump) on explore | PASS |
| Virtual target | **100_000** tok default |
| Typical GPU slice | **2–8K** tok |

Re-run proofs:

```bash
npm test
# or in the Local AI plugin tree:
node test/context-integrity.cjs
node test/context-quality-audit.cjs
node test/phase0-parity.cjs
```

**Vs dumping 100K into `num_ctx`:** keeps interactive speed and model IQ.  
**Vs silent truncate:** vault retains exact text; GPU sees ranked slice + tools to re-fetch.

## API (minimal)

- `new ContextVault({ virtualTarget, gpuBudget })`
- `vault.add(chunk)` / `addFromTool(name, args, text)`
- `vault.verifyIntegrity()` → `{ ok, bad[] }`
- `packForGpu(vault, { system, user, history, task })` → `{ messages, stats }`
- `bodyHash(text)` / `assertMarkersPreserved(before, after)`

## License

MIT
