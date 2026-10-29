#!/usr/bin/env node
// intertie-conformance: test an Intertie implementation and emit a (signed) JSON report.
import { readFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { parseArgs } from 'node:util';
import { generateKey, IntertieNode, type PrivateJwk } from '@intertie/core';
import { signReport, verifyReport, type Report, type TestResult } from './report.ts';
import { runHomeSuite, runPeerSuite, serveIdentity, type Identity } from './runner.ts';

const VERSION = '0.1.0';
const USAGE = `intertie-conformance: conformance runner for Intertie v0.1

  intertie-conformance home --invite <intertie:org/token> [options]   test the subject's home role
  intertie-conformance peer [options]                                 test the subject's peer role (prints an invite)
  intertie-conformance sign <report.json> --key <jwk.json> --keyid <org#kid> [--out signed.json]
  intertie-conformance verify <report.json> [--dev-insecure]

Options:
  --port N               where the runner listens (default 8790; a second identity uses N+1)
  --org NAME --endpoint URL   the runner's public identity (needed outside dev mode, e.g. via a tunnel)
  --dev-insecure         loopback testing: runner orgs are localhost:N
  --implementation STR   free text for the report, e.g. "acme-chat 3.2"
  --out FILE             write the report (default: stdout)

The runner's identities are throwaway keys. Reports are signed by the SUBJECT's key
(sign subcommand), because the claim is the subject's: see spec/conformance.md.`;

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    invite: { type: 'string' }, port: { type: 'string' }, org: { type: 'string' }, endpoint: { type: 'string' },
    'dev-insecure': { type: 'boolean' }, implementation: { type: 'string' }, out: { type: 'string' },
    key: { type: 'string' }, keyid: { type: 'string' }, help: { type: 'boolean', short: 'h' },
  },
});
const dev = values['dev-insecure'] === true;
const port = Number(values.port ?? 8790);

async function identity(n: number): Promise<{ id: Identity; close: () => Promise<void> }> {
  const p = port + n;
  const org = n === 0 && values.org ? values.org : `localhost:${p}`;
  if (!dev && n > 0) throw new Error('second identity requires --dev-insecure');
  const endpoint = n === 0 && values.endpoint ? values.endpoint : `http://${org}/intertie`;
  const key = generateKey('runner');
  const node = new IntertieNode({ org, endpoint, keys: [key], devInsecure: dev, displayName: `conformance runner ${n + 1}`, retryBaseMs: 200, retryCapMs: 2000, pullWaitS: 5 });
  const { id, server } = await serveIdentity(node, key, p);
  return { id, close: async () => { await node.stop(); server.closeAllConnections(); server.close(); } };
}

function finish(results: TestResult[], subject: Report['subject'], roles: string[]): Report {
  const levels = [...new Set(results.filter((r) => !r.skipped).map((r) => r.level))];
  const passedLevels = levels.filter((l) => results.filter((r) => r.level === l && !r.skipped).every((r) => r.pass));
  return {
    intertie_report: '0.1', subject: { ...subject, ...(values.implementation ? { implementation: values.implementation } : {}) },
    runner: { name: '@intertie/conformance', version: VERSION }, date: new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
    claim: { roles, levels: passedLevels }, results, passed: results.every((r) => r.pass),
  };
}

function emit(r: Report): void {
  const s = JSON.stringify(r, null, 2) + '\n';
  if (values.out) writeFileSync(values.out, s); else process.stdout.write(s);
  for (const x of r.results) process.stderr.write(`${x.skipped ? '·' : x.pass ? '✔' : '✖'} ${x.id.padEnd(32)} ${x.detail}\n`);
  const failed = r.results.filter((x) => !x.pass).length;
  process.stderr.write(`\n${r.passed ? 'PASS' : 'FAIL'}: ${r.results.length - failed}/${r.results.length} (levels passed: ${r.claim.levels.join(', ') || 'none'})\n`);
  if (!r.passed) process.exitCode = 1;
}

async function main(): Promise<void> {
  const cmd = positionals[0];
  if (cmd === 'home') {
    if (!values.invite) throw new Error('--invite required');
    const a = await identity(0);
    const b = dev ? await identity(1) : null;
    try {
      const { results, subject } = await runHomeSuite({ invite: values.invite, r1: a.id, r2: b?.id, devInsecure: dev });
      emit(finish(results, { org: subject.org, endpoint: subject.endpoint }, ['home']));
    } finally { await a.close(); await b?.close(); }
    return;
  }
  if (cmd === 'peer') {
    const a = await identity(0);
    const b = dev ? await identity(1) : null;
    try {
      const { results, subjectOrg } = await runPeerSuite({
        home: a.id, r2: b?.id, devInsecure: dev,
        onInvite: async (invite) => {
          process.stderr.write(`\nPaste this invite into the implementation under test, so it accepts:\n\n  ${invite}\n\nWaiting up to 5 minutes…\n`);
          if (process.stdin.isTTY) {
            const rl = createInterface({ input: process.stdin, output: process.stderr });
            void rl.question('').finally(() => rl.close());
          }
        },
      });
      const doc = subjectOrg ? await a.id.node.discovery.get(subjectOrg) : null;
      emit(finish(results, { org: subjectOrg ?? '?', endpoint: doc?.endpoint ?? '' }, ['peer-push']));
    } finally { await a.close(); await b?.close(); }
    return;
  }
  if (cmd === 'sign') {
    if (!positionals[1] || !values.key || !values.keyid) throw new Error('usage: sign <report.json> --key <jwk.json> --keyid <org#kid>');
    const r = JSON.parse(readFileSync(positionals[1], 'utf8')) as Report;
    const key = JSON.parse(readFileSync(values.key, 'utf8')) as PrivateJwk;
    const signed = signReport(r, values.keyid, key);
    const s = JSON.stringify(signed, null, 2) + '\n';
    if (values.out) writeFileSync(values.out, s); else process.stdout.write(s);
    return;
  }
  if (cmd === 'verify') {
    if (!positionals[1]) throw new Error('usage: verify <report.json>');
    const r = JSON.parse(readFileSync(positionals[1], 'utf8')) as Report;
    const v = await verifyReport(r, { devInsecure: dev });
    process.stdout.write(v.ok ? `valid: ${r.subject.org} signed this report (${r.passed ? 'passed' : 'FAILED'}; levels ${r.claim.levels.join(', ')})\n` : `INVALID: ${v.reason}\n`);
    if (!v.ok) process.exitCode = 1;
    return;
  }
  console.log(USAGE);
  if (cmd && !values.help) process.exitCode = 2;
}

main().catch((e) => { process.stderr.write(`intertie-conformance: ${e instanceof Error ? e.message : String(e)}\n`); process.exit(1); });
