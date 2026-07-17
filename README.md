# Infinite Virtual Context

**100K+ virtual context** for local LLM agents — without stuffing everything into GPU `num_ctx`.

The model sees a **smart GPU working set**; the rest lives in an append-only vault with cryptographic integrity. Facts do not mutate. Tool results stay recoverable. Overflow is recalled on demand (`recall_context` / `read_file`) — never by silently dropping the head of a giant dump.

## Will it work on any neural network?

**Short answer:** the *vault + packer* works with **any model that accepts OpenAI-style `messages[]`**. Automatic wiring depends on how you connect:

| How you run the model | Virtual context? | What you get |
|------------------------|------------------|--------------|
| **Local AI plugin → OmniCore** (`inferenceBackend: omnicore`) | **Full** | vault pack → lean GPU prompt + `SYNC_CTX` + chunked prefill + refuse oversized (no silent truncate) |
| **Local AI plugin → Ollama** (`inferenceBackend: ollama`, `adaptiveCtx: true`) | **Yes (pack)** | same vault → slim `messages[]` before `/api/chat` |
| **Local AI plugin → Remote OpenAI API** (`inferenceBackend: remote`) | **Yes (pack)** | same vault → slim `messages[]` to your URL |
| **Any GGUF via OmniCore daemon** | **Yes** | model file does not matter — vault is prompt-side; point `--model-path` at any GGUF |
| **llama.cpp server / LM Studio / vLLM / OpenAI-compatible** | **Yes (DIY)** | call `packWorkingSet` / `packForGpu`, POST `messages` |
| **Raw GGUF with no chat API / no plugin** | **No auto** | load weights only ≠ virtual context; wrap with a server + packer |

**Not automatic:** dropping a random `.gguf` into a random app without this packer or the Local AI plugin. Virtual context is a *prompt contract*, not a property of the weights.

## What’s new (v1.2 · any-backend pack)

| Before | Now |
|--------|-----|
| Docs implied OmniCore-only lean path | Clear matrix: pack for **all** plugin backends; OmniCore extras documented |
| Standalone API only `packForGpu` | Alias **`packWorkingSet`** (same API) for multi-backend connectors |
| Ollama/remote could send oversized turn history | Local AI plugin slim-packs `messages[]` for Ollama/remote before stream |

**Contract unchanged:** virtual tokens = address space; GPU ≈ **8K** working set; vault = lossless store.

## What’s new (v1.1 · OmniCore lean path)

Wired end-to-end with **OmniCore Engine** + Local AI plugin:

| Before | Now |
|--------|-----|
| Full `messages[]` dumped into one OmniCore prompt | **Lean GPU prompt**: vault pack + recent turns |
| Engine could **truncate** oversized prompts | Engine **refuses** dumps `> n_ctx` |
| Prefill one giant `llama_batch` | Prefill **chunked** by `n_batch` |
| Warm attach races | TCP **warm attach** `:8742` |
| Vault sync looked like mutation | Wire = ranking-only; **bodyHash** untouched |

Proofs: `test/virtual-ctx-lean.cjs`, `test/context-integrity.cjs` (Local AI plugin tree).

## Install

```bash
npm install
npm test
```

Node 18+. No GPU required for the vault itself.

```js
const { ContextVault, packWorkingSet, bodyHash } = require('infinite-virtual-context');

const vault = new ContextVault({ virtualTarget: 100_000, gpuBudget: 8192 });
vault.add({ id: 'file:src/app.js', kind: 'file', body: sourceCode, pinned: true });
vault.addFromTool('read_file', { path: 'src/app.js' }, fileText);

const { messages, stats } = packWorkingSet(vault, {
  system: 'You are a coding agent.',
  user: 'Where is auth handled?',
  history: [],
});
// messages → send to YOUR model (any OpenAI-compatible chat)
```

## Connect your models

### 1) Local AI plugin (recommended)

Settings (`localAi.*`):

| Setting | OmniCore | Ollama | Remote API |
|---------|----------|--------|------------|
| `inferenceBackend` | `omnicore` | `ollama` | `remote` |
| `adaptiveCtx` | `true` | `true` | `true` |
| `virtualCtxTarget` | `100000` | `100000` | `100000` |
| `gpuCtxBudget` / `numCtx` | `8192` | match Ollama `num_ctx` | match server ctx |
| Extra | `start-omnicore.ps1` → `:8742` | Ollama running | `remoteApiUrl` + model |

OmniCore-only extras: lean string prompt, `SYNC_CTX`, refuse `> n_ctx`, chunked prefill.

### 2) OpenAI-compatible endpoint (any NN behind HTTP)

```js
const { messages } = packWorkingSet(vault, { system, user, history });
const res = await fetch('http://127.0.0.1:8080/v1/chat/completions', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ model: 'local', messages, stream: false }),
});
```

Works with: llama.cpp server, LM Studio, vLLM, text-generation-webui OpenAI mode, cloud OpenAI-compatible proxies — **whatever model** that endpoint serves.

### 3) OmniCore GGUF (any weights)

```powershell
omnicore_daemon.exe --auto --model-path models\YOUR.gguf
# plugin: inferenceBackend = omnicore
```

Virtual context does not care if the GGUF is 1B or 70B — only the GPU window (~8K) and vault pack do.

Keep **generation `num_ctx` = full GPU window**. Do not re-anchor/trim the system prompt on every tool turn.

## How it works

1. **Vault** stores every chunk with `body` + `bodyHash` (SHA-256). Mutation is detectable.  
2. **Packer** selects pinned + high-relevance chunks into a GPU budget (~2–8K tok).  
3. **Virtual total** = sum of chunk sizes (target 100K) — recoverable via `recall` / re-read from disk.  
4. **Fold** may compress *prompt copies* for the next turn; **vault bodies are never rewritten**.  
5. **OmniCore**: lean pack → chunked prefill → decode; overflow stays in vault, not in KV.

```
┌──────────── virtual 100K+ ───────────┐
│  vault (append-only, bodyHash)       │
└───────────────┬──────────────────────┘
                │ packWorkingSet / plugin pack
                ▼
         GPU working set (~8K)
                │  OmniCore: + SYNC_CTX + chunked prefill
                │  Ollama/remote: messages[] only
                ▼
            LLM decode (any model)
                │
                └── recall_context / read_file ──► vault
```

## Metrics & proof

| Check | Result |
|-------|--------|
| FACT / UNIQUE markers survive fold | PASS |
| `bodyHash` detects in-place mutation | PASS |
| Lean / working-set ≪ raw vault; bodies intact | PASS |
| Virtual target | **100_000** tok default |
| Typical GPU slice | **~8K** tok |
| OmniCore 1B CUDA (warm) | **224.82 tok/s** (engine proof) |

```bash
npm test
# Local AI plugin:
node test/context-integrity.cjs
node test/virtual-ctx-lean.cjs
```

## API (minimal)

- `new ContextVault({ virtualTarget, gpuBudget })`
- `vault.add(chunk)` / `addFromTool(name, args, text)`
- `vault.verifyIntegrity()` → `{ ok, bad[] }`
- `packForGpu` / `packWorkingSet(vault, { system, user, history, task })` → `{ messages, stats }`
- `bodyHash(text)` / `assertMarkersPreserved(before, after)`

## Companion

- Engine: https://github.com/1Anton10/omnicore-engine  
- This vault: https://github.com/1Anton10/infinite-virtual-context

## License

MIT
