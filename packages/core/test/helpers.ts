import { IntertieNode, generateKey, type NodeOptions } from '../src/index.ts';
import { createServer } from 'node:net';

export async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => { const p = (s.address() as { port: number }).port; s.close(() => resolve(p)); });
  });
}

/** A dev-mode node listening on a free loopback port. */
export async function devNode(name: string, extra: Partial<NodeOptions> = {}): Promise<IntertieNode> {
  const port = await freePort();
  const org = `localhost:${port}`;
  const node = new IntertieNode({
    org, endpoint: `http://${org}/intertie`, keys: [generateKey('k1')], displayName: name,
    devInsecure: true, retryBaseMs: 20, retryCapMs: 200, pullWaitS: 1,
    capabilities: ['threads', 'reactions', 'files'], ...extra,
  });
  await node.listen(port);
  node.start();
  return node;
}

export async function until(cond: () => boolean | Promise<boolean>, ms = 5000, what = 'condition'): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`timed out waiting for ${what}`);
}

export async function settle(...nodes: IntertieNode[]): Promise<void> {
  await until(() => nodes.every((n) => n.isIdle()), 5000, 'nodes idle');
}

export const user = (node: IntertieNode, local: string, name = local) => ({ id: `${local}@${node.org}`, name });
