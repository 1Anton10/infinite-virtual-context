#!/usr/bin/env node
'use strict';

/**
 * Drop-in HTTP proxy: any client → this port → upstream OpenAI-compatible server.
 * Virtual context packing is applied automatically on /v1/chat/completions.
 *
 *   node proxy.js --upstream http://127.0.0.1:8080 --port 8787
 *   # then point your app at http://127.0.0.1:8787/v1
 */

const http = require('http');
const { URL } = require('url');
const { attach } = require('./index');

function arg(name, def) {
  const i = process.argv.indexOf(name);
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1];
  return def;
}

const upstream = String(arg('--upstream', 'http://127.0.0.1:8080')).replace(/\/+$/, '');
const port = Number(arg('--port', '8787')) || 8787;
const gpuBudget = Number(arg('--gpu-budget', '8192')) || 8192;

const vc = attach({
  baseUrl: upstream,
  gpuBudget,
  virtualTarget: Number(arg('--virtual', '100000')) || 100000,
});

const server = http.createServer(async (req, res) => {
  const path = req.url || '/';
  if (req.method === 'GET' && (path === '/' || path === '/health')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, upstream, virtual: vc.stats() }));
    return;
  }

  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString('utf8');

  let body = raw;
  const isChat = /\/v1\/chat\/completions\/?$/i.test(path.split('?')[0]);
  if (isChat && raw) {
    try {
      const rewritten = vc.rewrite(JSON.parse(raw));
      const { _virtualContext, ...payload } = rewritten;
      body = JSON.stringify(payload);
      res.setHeader('x-virtual-tok', String(_virtualContext.virtualTok || 0));
      res.setHeader('x-gpu-tok', String(_virtualContext.gpuTok || 0));
    } catch (e) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: String(e.message || e) }));
      return;
    }
  }

  const u = new URL(path, upstream.endsWith('/') ? upstream : upstream + '/');
  // Prefer upstream origin + request path
  const target = new URL(upstream);
  const dest = `${target.origin}${path.startsWith('/') ? path : '/' + path}`;

  const headers = { ...req.headers, host: target.host };
  delete headers['content-length'];
  headers['content-length'] = Buffer.byteLength(body);

  const lib = dest.startsWith('https') ? require('https') : http;
  const preq = lib.request(
    dest,
    { method: req.method, headers },
    (pres) => {
      res.writeHead(pres.statusCode || 502, pres.headers);
      pres.pipe(res);
    }
  );
  preq.on('error', (e) => {
    res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: String(e.message || e), upstream: dest }));
  });
  preq.end(body);
});

server.listen(port, '127.0.0.1', () => {
  console.log(`[infinite-virtual-context] proxy :${port} → ${upstream}`);
  console.log(`  Point any OpenAI client at http://127.0.0.1:${port}/v1`);
  console.log(`  GPU budget ${gpuBudget}; ingest via POST /vault (optional) not required for pack-on-chat`);
});
