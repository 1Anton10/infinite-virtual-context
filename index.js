'use strict';

/**
 * infinite-virtual-context — independent add-on for any OpenAI-style chat AI.
 * Vault holds 100K+ virtual tokens; GPU sees a packed working set (~8K).
 * No OmniCore / Ollama / plugin required — wrap any messages[] endpoint.
 */

const crypto = require('crypto');

function estTok(text) {
  return Math.max(1, Math.ceil(String(text || '').length / 4));
}

function bodyHash(body) {
  return crypto.createHash('sha256').update(String(body || ''), 'utf8').digest('hex');
}

function extractKeywords(text) {
  const words = String(text || '')
    .toLowerCase()
    .match(/[a-zа-яё0-9_]{3,}/gi) || [];
  const stop = new Set(['the', 'and', 'for', 'with', 'this', 'that', 'from', 'are', 'was']);
  const freq = new Map();
  for (const w of words) {
    if (stop.has(w)) continue;
    freq.set(w, (freq.get(w) || 0) + 1);
  }
  return [...freq.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 24)
    .map(([w]) => w);
}

class ContextVault {
  constructor(opts = {}) {
    this.virtualTarget = opts.virtualTarget || 100000;
    this.gpuBudget = opts.gpuBudget || 8192;
    this.chunks = new Map();
    this._seq = 0;
  }

  nextId() {
    this._seq += 1;
    return `c${this._seq}`;
  }

  add(chunk) {
    const id = chunk.id || this.nextId();
    const body = String(chunk.body || '');
    const summary = chunk.summary || body.replace(/\s+/g, ' ').slice(0, 200);
    const stored = {
      id,
      kind: chunk.kind || 'misc',
      title: chunk.title || id,
      summary,
      body,
      bodyHash: bodyHash(body),
      keywords: chunk.keywords || extractKeywords(`${chunk.title || ''} ${summary} ${body.slice(0, 800)}`),
      sourceRel: chunk.sourceRel || '',
      fullTok: chunk.fullTok != null ? chunk.fullTok : estTok(body),
      pinned: !!chunk.pinned,
      ts: Date.now(),
    };
    this.chunks.set(id, stored);
    return id;
  }

  addFromTool(name, args, text) {
    return this.add({
      kind: 'tool',
      title: `${name} ${JSON.stringify(args || {}).slice(0, 100)}`,
      body: String(text || ''),
      summary: `${name}: ${String(text || '').replace(/\s+/g, ' ').slice(0, 160)}`,
    });
  }

  /** Ingest a plain text / file / chat turn into the vault. */
  remember(input, meta = {}) {
    if (input == null) return null;
    if (typeof input === 'object' && input.body != null) return this.add({ ...meta, ...input });
    return this.add({
      kind: meta.kind || 'note',
      title: meta.title || meta.id || 'memory',
      body: String(input),
      pinned: !!meta.pinned,
      sourceRel: meta.sourceRel || meta.path || '',
      id: meta.id,
    });
  }

  virtualTokens() {
    let n = 0;
    for (const c of this.chunks.values()) n += c.fullTok || estTok(c.body);
    return n;
  }

  verifyIntegrity() {
    const bad = [];
    for (const c of this.chunks.values()) {
      if (bodyHash(c.body) !== c.bodyHash) {
        bad.push({ id: c.id, reason: 'body_mutated' });
      }
    }
    return { ok: bad.length === 0, checked: this.chunks.size, bad };
  }

  serialize() {
    return {
      virtualTarget: this.virtualTarget,
      gpuBudget: this.gpuBudget,
      seq: this._seq,
      chunks: [...this.chunks.values()],
    };
  }

  static deserialize(data) {
    const v = new ContextVault({
      virtualTarget: data.virtualTarget,
      gpuBudget: data.gpuBudget,
    });
    v._seq = data.seq || 0;
    for (const c of data.chunks || []) {
      v.chunks.set(c.id, c);
    }
    return v;
  }
}

function scoreChunk(chunk, task) {
  if (chunk.pinned) return 1e9;
  const t = String(task || '').toLowerCase();
  let s = 0;
  for (const k of chunk.keywords || []) {
    if (t.includes(k)) s += 10;
  }
  if (chunk.sourceRel && t.includes(String(chunk.sourceRel).toLowerCase())) s += 20;
  return s + Math.min(5, (chunk.fullTok || 0) / 500);
}

function packForGpu(vault, opts = {}) {
  const budget = opts.gpuBudget || vault.gpuBudget || 8192;
  const system = opts.system || 'You are a helpful assistant with a virtual context vault.';
  const user = opts.user || '';
  const task = opts.task || user;
  const history = opts.history || [];
  const keepRecent = Math.max(2, Number(opts.keepRecent) || 6);

  const ranked = [...vault.chunks.values()].sort(
    (a, b) => scoreChunk(b, task) - scoreChunk(a, task)
  );

  let used = estTok(system) + estTok(user);
  const selected = [];
  for (const c of ranked) {
    const cost = Math.min(c.fullTok || estTok(c.body), 1200);
    if (used + cost > budget && selected.length > 0) continue;
    selected.push(c);
    used += cost;
  }

  const ctxBlock = selected
    .map((c) => `[ctx:${c.id}] ${c.title}\n${c.body.slice(0, 4000)}`)
    .join('\n\n');

  const banner = ctxBlock
    ? `\n\n--- VIRTUAL CONTEXT (GPU slice ~${used} tok / vault ${vault.virtualTokens()}) ---\n` +
      `Full vault is lossless; this is a ranked working set only.\n` +
      ctxBlock
    : '';

  const messages = [
    { role: 'system', content: system + banner },
    ...history.slice(-keepRecent),
    { role: 'user', content: user },
  ];

  return {
    messages,
    stats: {
      virtualTok: vault.virtualTokens(),
      gpuTok: used,
      chunks: vault.chunks.size,
      selected: selected.length,
      integrity: vault.verifyIntegrity().ok,
    },
  };
}

function packWorkingSet(vault, opts = {}) {
  return packForGpu(vault, opts);
}

/**
 * Drop-in: take an existing OpenAI-style messages[] + vault → slim GPU messages[].
 * Use this to wrap any agent that already built messages.
 */
function packMessages(messages, vault, opts = {}) {
  const list = Array.isArray(messages) ? messages.filter((m) => m && m.content != null) : [];
  const budget = opts.gpuBudget || (vault && vault.gpuBudget) || 8192;
  const keepRecent = Math.max(2, Number(opts.keepRecent) || 6);

  const sys = list.find((m) => m.role === 'system');
  const nonSys = list.filter((m) => m.role !== 'system');
  const lastUser = [...nonSys].reverse().find((m) => m.role === 'user');
  const task = opts.task || (lastUser && lastUser.content) || '';

  const systemBase = sys ? String(sys.content) : opts.system || 'You are a helpful assistant.';
  const history = nonSys.slice(0, -1);
  const user = lastUser ? String(lastUser.content) : opts.user || '';

  if (!vault || !vault.chunks || vault.chunks.size === 0) {
    return {
      messages: list.slice(-(keepRecent + 1)),
      stats: { virtualTok: 0, gpuTok: estTok(JSON.stringify(list)), skipped: true },
    };
  }

  // Avoid double-inject if caller already packed
  if (/--- VIRTUAL CONTEXT|--- VAULT SLICE ---/i.test(systemBase)) {
    return {
      messages: [
        { role: 'system', content: systemBase },
        ...nonSys.slice(-keepRecent),
      ],
      stats: {
        virtualTok: vault.virtualTokens(),
        gpuTok: estTok(systemBase) + nonSys.slice(-keepRecent).reduce((n, m) => n + estTok(m.content), 0),
        alreadyPacked: true,
        integrity: vault.verifyIntegrity().ok,
      },
    };
  }

  const packed = packForGpu(vault, {
    system: systemBase,
    user: user || '(continue)',
    history: history.slice(-(keepRecent - 1)),
    task,
    gpuBudget: budget,
    keepRecent,
  });
  return packed;
}

/** Rewrite an OpenAI chat.completions request body in-place-safe copy. */
function rewriteChatRequest(body, vault, opts = {}) {
  const src = body && typeof body === 'object' ? body : {};
  const packed = packMessages(src.messages || [], vault, opts);
  return {
    ...src,
    messages: packed.messages,
    _virtualContext: packed.stats,
  };
}

function markersIn(text) {
  const re = /UNIQUE_[A-Z0-9_]+|FACT_[A-Z0-9_]+/g;
  const s = new Set();
  let m;
  while ((m = re.exec(String(text || ''))) !== null) s.add(m[0]);
  return s;
}

function assertMarkersPreserved(beforeMessages, afterMessages) {
  const before = new Set();
  for (const m of beforeMessages || []) {
    for (const x of markersIn(m.content)) before.add(x);
  }
  const afterText = (afterMessages || []).map((m) => m.content).join('\n');
  const missing = [...before].filter((x) => !afterText.includes(x));
  return { ok: missing.length === 0, missing, beforeCount: before.size };
}

/**
 * Independent add-on handle. Plug into any AI:
 *   const vc = attach({ gpuBudget: 8192 })
 *   vc.remember(bigFile)
 *   const res = await vc.chat.completions.create({ model, messages })
 */
function attach(opts = {}) {
  const vault =
    opts.vault instanceof ContextVault
      ? opts.vault
      : new ContextVault({
          virtualTarget: opts.virtualTarget || 100000,
          gpuBudget: opts.gpuBudget || 8192,
        });

  const baseUrl = String(opts.baseUrl || opts.apiBase || 'http://127.0.0.1:8080')
    .replace(/\/+$/, '')
    .replace(/\/v1$/i, '');
  const apiKey = opts.apiKey || opts.token || process.env.OPENAI_API_KEY || '';
  const defaultModel = opts.model || 'local';
  const fetchImpl = opts.fetch || globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    throw new Error('attach() needs fetch (Node 18+ or opts.fetch)');
  }

  async function chatCompletionsCreate(req = {}) {
    const rewritten = rewriteChatRequest(
      {
        model: req.model || defaultModel,
        ...req,
      },
      vault,
      opts
    );
    const { _virtualContext, ...payload } = rewritten;
    const url = `${baseUrl}/v1/chat/completions`;
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
        ...(opts.headers || {}),
      },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(`chat.completions HTTP ${res.status}: ${errText.slice(0, 400)}`);
    }
    if (payload.stream) return res;
    const json = await res.json();
    json._virtualContext = _virtualContext;
    return json;
  }

  /** Wrap global/custom fetch so any POST …/chat/completions is auto-packed. */
  function wrapFetch(baseFetch = fetchImpl) {
    return async function virtualFetch(input, init = {}) {
      const url = typeof input === 'string' ? input : input && input.url;
      const method = String((init && init.method) || 'GET').toUpperCase();
      if (method === 'POST' && url && /chat\/completions/i.test(String(url))) {
        let bodyObj = {};
        try {
          bodyObj = JSON.parse(init.body || '{}');
        } catch (_) {}
        const rewritten = rewriteChatRequest(bodyObj, vault, opts);
        const { _virtualContext, ...payload } = rewritten;
        const next = {
          ...init,
          headers: {
            'Content-Type': 'application/json',
            ...(init.headers || {}),
          },
          body: JSON.stringify(payload),
        };
        const res = await baseFetch(input, next);
        if (!payload.stream && res.ok) {
          const clone = res.clone();
          try {
            const json = await clone.json();
            if (json && typeof json === 'object') json._virtualContext = _virtualContext;
          } catch (_) {}
        }
        return res;
      }
      return baseFetch(input, init);
    };
  }

  return {
    vault,
    remember: (...args) => vault.remember(...args),
    add: (...args) => vault.add(...args),
    addFromTool: (...args) => vault.addFromTool(...args),
    pack: (messages, packOpts) => packMessages(messages, vault, { ...opts, ...packOpts }),
    rewrite: (body, packOpts) => rewriteChatRequest(body, vault, { ...opts, ...packOpts }),
    wrapFetch,
    chat: {
      completions: {
        create: chatCompletionsCreate,
      },
    },
    /** Stats for UIs */
    stats: () => ({
      virtualTok: vault.virtualTokens(),
      chunks: vault.chunks.size,
      gpuBudget: vault.gpuBudget,
      integrity: vault.verifyIntegrity().ok,
    }),
  };
}

module.exports = {
  ContextVault,
  packForGpu,
  packWorkingSet,
  packMessages,
  rewriteChatRequest,
  attach,
  bodyHash,
  estTok,
  extractKeywords,
  assertMarkersPreserved,
  markersIn,
};
