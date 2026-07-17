'use strict';
const {
  ContextVault,
  packForGpu,
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
