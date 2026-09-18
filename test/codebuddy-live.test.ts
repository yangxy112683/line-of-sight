import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { codebuddyAdapter } from '../src/adapters/codebuddy.js';

const ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

function unusedPid(): number {
  for (let pid = 40_000; pid < 50_000; pid++) {
    try {
      process.kill(pid, 0);
    } catch {
      return pid;
    }
  }
  throw new Error('no unused pid in 40000-49999');
}

describe('codebuddyAdapter.liveSessions', () => {
  const dirs: string[] = [];
  const deadPid = unusedPid();

  afterEach(() => {
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  function probe(files: Record<string, unknown>) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sight-cbc-live-'));
    dirs.push(dir);
    for (const [name, body] of Object.entries(files)) {
      const text = typeof body === 'string' ? body : JSON.stringify(body);
      fs.writeFileSync(path.join(dir, name), text);
    }
    return codebuddyAdapter(path.join(dir, 'projects'), dir);
  }

  function valid(over: Record<string, unknown> = {}) {
    return {
      kind: 'interactive',
      pid: process.pid,
      lastHeartbeat: Date.now(),
      sessionId: ID,
      ...over,
    };
  }

  it('missing heartbeat dir is an empty map', () => {
    const a = codebuddyAdapter(
      '/tmp/definitely-not-here/projects',
      '/tmp/definitely-not-here/sessions',
    );
    expect(a.liveSessions!()).toEqual(new Map());
  });

  it('a live interactive heartbeat maps to alive with since 0', () => {
    const a = probe({ '1.json': valid() });
    expect(a.liveSessions!()).toEqual(new Map([
      [ID, { state: 'alive', since: 0 }],
    ]));
  });

  it('never copies lastHeartbeat into since', () => {
    const lastHeartbeat = Date.now() - 1_000;
    const a = probe({ '1.json': valid({ lastHeartbeat }) });
    expect(a.liveSessions!().get(ID)).toEqual({ state: 'alive', since: 0 });
  });

  it.each([
    ['non-numeric filename', { 'other.key': valid() }],
    ['manual-* filename', { 'manual-1.json': valid() }],
    ['bad JSON', { '1.json': '{ not json' }],
    ['kind is not interactive', { '1.json': valid({ kind: 'daemon' }) }],
    ['pid is zero', { '1.json': valid({ pid: 0 }) }],
    ['pid is out of range', { '1.json': valid({ pid: 2 ** 22 }) }],
    ['pid is dead', { '1.json': valid({ pid: deadPid }) }],
    ['stale lastHeartbeat', { '1.json': valid({ lastHeartbeat: Date.now() - 121_000 }) }],
    ['placeholder interactive-* id', { '1.json': valid({ sessionId: 'interactive-ask' }) }],
    ['placeholder daemon-* id', { '1.json': valid({ sessionId: 'daemon-x' }) }],
    ['placeholder prewarm-* id', { '1.json': valid({ sessionId: 'prewarm-x' }) }],
    ['empty sessionId', { '1.json': valid({ sessionId: '' }) }],
    ['Ask-shaped: no lastHeartbeat', { '1.json': {
      kind: 'interactive', pid: process.pid, sessionId: ID,
    } }],
  ] as const)('skips %s', (_label, files) => {
    expect(probe(files).liveSessions!()).toEqual(new Map());
  });

  it('one bad file does not drop a neighbouring live heartbeat', () => {
    const a = probe({
      '1.json': valid(),
      'other.key': valid({ sessionId: 'bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeeeee' }),
      '2.json': '{ not json',
    });
    expect(a.liveSessions!()).toEqual(new Map([
      [ID, { state: 'alive', since: 0 }],
    ]));
  });
});
