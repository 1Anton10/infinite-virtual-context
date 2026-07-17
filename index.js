'use strict';

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
  const system = opts.system || 'You are a coding agent with tools.';
  const user = opts.user || '';
  const task = opts.task || user;
  const history = opts.history || [];

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

  const messages = [
    { role: 'system', content: system + (ctxBlock ? `\n\n--- VAULT SLICE ---\n${ctxBlock}` : '') },
    ...history.slice(-6),
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

module.exports = {
  ContextVault,
  packForGpu,
  bodyHash,
  estTok,
  extractKeywords,
  assertMarkersPreserved,
  markersIn,
};
