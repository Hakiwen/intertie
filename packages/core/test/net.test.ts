import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { isForbiddenAddress, safeFetch } from '../src/index.ts';

test('forbidden address ranges', () => {
  for (const a of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', 'fc00::1', 'fe80::1', '::ffff:127.0.0.1', '::ffff:10.0.0.1']) {
    assert.ok(isForbiddenAddress(a), a);
  }
  for (const a of ['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111']) assert.ok(!isForbiddenAddress(a), a);
});

test('safeFetch refuses http, private targets, and never follows redirects', async () => {
  await assert.rejects(safeFetch('http://example.com/'), /non-https/);
  await assert.rejects(safeFetch('https://127.0.0.1/'), /forbidden/);
  await assert.rejects(safeFetch('https://localhost/'), /forbidden/);
  await assert.rejects(safeFetch('https://169.254.169.254/latest/meta-data'), /forbidden/);
  const s = createServer((_q, r) => { r.writeHead(302, { location: 'http://127.0.0.1:1/' }).end(); });
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  const port = (s.address() as { port: number }).port;
  const r = await safeFetch(`http://localhost:${port}/`, { devInsecure: true });
  assert.equal(r.status, 302, 'redirect returned, not followed');
  s.close();
});

test('dev mode allows loopback only', async () => {
  await assert.rejects(safeFetch('http://10.0.0.1/', { devInsecure: true }), /loopback only/);
});
