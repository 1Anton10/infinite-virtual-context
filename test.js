'use strict';
const {
  ContextVault,
  packForGpu,
  packMessages,
  rewriteChatRequest,
  attach,
  bodyHash,
  assertMarkersPreserved,
} = require('./index');

let failed = 0;
function ok(name, cond, d) {
  if (!cond) {
    failed++;
    console.error('FAIL', name, d || '');
  } else console.log('  OK', name);
}

console.log('infinite-virtual-context proofs\n');

const vault = new ContextVault({ virtualTarget: 100000, gpuBudget: 4096 });
const FACT = 'FACT_PROOF_99';
vault.add({ id: 'a', body: `hello ${FACT}\n` + 'x'.repeat(8000), pinned: true });
vault.addFromTool('read_file', { path: 'a.js' }, `content ${FACT}`);

ok('hash set', vault.chunks.get('a').bodyHash === bodyHash(vault.chunks.get('a').body));
ok('integrity', vault.verifyIntegrity().ok);

const packed = packForGpu(vault, { user: 'find FACT_PROOF', system: 'agent' });
ok('gpu under budget', packed.stats.gpuTok <= 4096 + 500);
ok('virtual large', packed.stats.virtualTok > 1000);
ok('fact in pack', packed.messages[0].content.includes(FACT));

const fromMsgs = packMessages(
  [
    { role: 'system', content: 'agent' },
    { role: 'user', content: 'find FACT_PROOF' },
  ],
  vault
);
ok('packMessages has vault slice', /VIRTUAL CONTEXT|VAULT SLICE|FACT_PROOF/i.test(fromMsgs.messages[0].content));

const rewritten = rewriteChatRequest(
  { model: 'x', messages: [{ role: 'user', content: 'hi ' + FACT }] },
  vault
);
ok('rewrite keeps model', rewritten.model === 'x');
ok('rewrite has stats', rewritten._virtualContext && rewritten._virtualContext.virtualTok > 0);

const ai = attach({ baseUrl: 'http://127.0.0.1:9', gpuBudget: 4096 });
ai.remember('note ' + FACT, { id: 'n1', pinned: true });
ok('attach remember', ai.stats().chunks >= 1);
const packed2 = ai.pack([{ role: 'user', content: 'q' }]);
ok('attach.pack', packed2.messages.length >= 1);

const c = vault.chunks.get('a');
c.body += 'MUT';
ok('detect mutate', !vault.verifyIntegrity().ok);
c.body = c.body.replace(/MUT$/, '');
c.bodyHash = bodyHash(c.body);

const r = assertMarkersPreserved(
  [{ role: 'user', content: FACT }],
  [{ role: 'assistant', content: `kept ${FACT}` }]
);
ok('markers', r.ok);

if (failed) process.exit(1);
console.log('\nALL PROOFS PASS');
