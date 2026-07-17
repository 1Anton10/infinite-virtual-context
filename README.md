# Infinite Virtual Context

**Independent add-on** for any AI that speaks OpenAI-style `messages[]`.

Not a model. Not OmniCore-only. Drop it in front of whatever you already run — local GGUF server, Ollama, LM Studio, vLLM, cloud API — and the model gets a **packed GPU working set** while a lossless vault holds **100K+ virtual tokens**.

```
your app  ──►  infinite-virtual-context  ──►  any chat API / any weights
                 (vault + pack)
```

## 30-second plug-in

```bash
npm install github:1Anton10/infinite-virtual-context
# or: clone this repo and require('./index')
```

```js
const { attach } = require('infinite-virtual-context');

// Point at ANY OpenAI-compatible server (llama.cpp, LM Studio, vLLM, …)
const ai = attach({
  baseUrl: 'http://127.0.0.1:8080', // or Ollama openai shim, etc.
  model: 'local',
  gpuBudget: 8192,
  virtualTarget: 100_000,
});

// Feed the vault (files, tool dumps, notes) — bodies stay intact
ai.remember(bigSourceFile, { id: 'file:app.js', pinned: true });
ai.addFromTool('read_file', { path: 'app.js' }, fileText);

// Same shape as OpenAI — packing happens inside
const res = await ai.chat.completions.create({
  messages: [
    { role: 'system', content: 'You are a coding agent.' },
    { role: 'user', content: 'Where is auth handled?' },
  ],
});
console.log(res.choices[0].message.content);
console.log(res._virtualContext); // { virtualTok, gpuTok, … }
```

**That is the product:** one `attach()` and any backend that accepts `/v1/chat/completions` works.

## Zero-code path (proxy)

Sit this in front of an existing server — no app changes:

```bash
node proxy.js --upstream http://127.0.0.1:8080 --port 8787
# Point Cursor / Continue / your client at http://127.0.0.1:8787/v1
```

Every `POST /v1/chat/completions` is rewritten with a vault pack before it hits the model.

## Wrap an existing fetch / SDK

```js
const { attach } = require('infinite-virtual-context');
const ai = attach({ baseUrl: 'http://127.0.0.1:8080' });
ai.remember(docs);

globalThis.fetch = ai.wrapFetch(globalThis.fetch);
// now any library that POSTs …/chat/completions gets virtual context
```

Or only rewrite messages you already built:

```js
const { attach } = require('infinite-virtual-context');
const ai = attach();
const { messages, stats } = ai.pack(existingMessages);
await sendToWhateverModel(messages);
```

## What “independent” means

| Claim | Reality |
|-------|---------|
| Works without OmniCore | **Yes** — pure JS vault + packer |
| Works with any GGUF / any NN | **Yes**, if something exposes OpenAI chat (or you call `pack` yourself) |
| Changes model weights | **No** — prompt-side only |
| Silent truncate of vault | **No** — `bodyHash` integrity; GPU sees a slice |

OmniCore / Local AI plugin are **optional accelerators** (SYNC_CTX, chunked prefill). This repo alone is enough to plug virtual context into any stack.

## Install / test

```bash
npm install
npm test
```

Node 18+ (`fetch`). No GPU required for the vault.

## API

| Export | Role |
|--------|------|
| `attach(opts)` | **Main drop-in** — vault + `chat.completions.create` + `wrapFetch` |
| `packMessages(messages, vault)` | Slim existing `messages[]` |
| `rewriteChatRequest(body, vault)` | Rewrite full chat.completions JSON |
| `packForGpu` / `packWorkingSet` | Build messages from vault + user turn |
| `ContextVault` | Low-level store (`add`, `remember`, `verifyIntegrity`) |
| `proxy.js` | HTTP sidecar for any upstream |

```js
const ai = attach({
  baseUrl: 'http://127.0.0.1:8080',
  apiKey: process.env.OPENAI_API_KEY, // optional
  model: 'local',
  gpuBudget: 8192,
  virtualTarget: 100000,
});
ai.remember(text, { id, pinned, path });
ai.stats(); // { virtualTok, chunks, integrity }
```

## Contract

1. Vault stores every chunk with `body` + `bodyHash` (SHA-256).  
2. Packer selects ranked chunks into `gpuBudget` (~2–8K tok).  
3. Virtual total can be ~100K — overflow stays in vault, not in KV.  
4. Vault bodies are never rewritten by pack.

```
┌──────── virtual 100K+ (lossless) ─────┐
│  vault                                │
└───────────────┬───────────────────────┘
                │ attach / pack / proxy
                ▼
         GPU working set (~8K)
                │
                ▼
         any model (any host)
```

## Optional companions

- OmniCore engine (full lean path): https://github.com/1Anton10/omnicore-engine  
- This add-on: https://github.com/1Anton10/infinite-virtual-context

## License

MIT
