import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { claudeCodeAdapter } from '../src/adapters/claudeCode.js';
import { codebuddyAdapter } from '../src/adapters/codebuddy.js';
import { Ingester } from '../src/daemon/ingest.js';
import { Store } from '../src/store/store.js';

const ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

function userLine(id: string, text: string): string {
  return JSON.stringify({
    id, timestamp: 1700000001000, type: 'message', role: 'user',
    content: [{ type: 'input_text', text }], cwd: '/repo',
  }) + '\n';
}

describe('codebuddy ingest', () => {
  let root: string;
  let file: string;
  let store: Store;
  let logs: string[];
  const adapter = () => codebuddyAdapter(root);

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'sight-cbc-'));
    fs.mkdirSync(path.join(root, '-repo'));
    file = path.join(root, '-repo', `${ID}.jsonl`);
    store = new Store(':memory:');
    logs = [];
  });

  afterEach(() => {
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('does not bump SCHEMA_VERSION', () => {
    expect(store.db.pragma('user_version', { simple: true })).toBe(5);
  });

  it('ingests a main session, titles from the first real prompt, cwd as projectDir', () => {
    fs.writeFileSync(file, userLine('evt-plumb', '<system-reminder>skip</system-reminder>')
      + userLine('evt-user', 'fix the login bug'));
    const ingester = new Ingester(store, [adapter()], (m) => logs.push(m), () => false);
    ingester.ingestFile(adapter(), file);
    expect(store.getSession(ID)).toMatchObject({
      adapter: 'codebuddy', title: 'fix the login bug', projectDir: '/repo', messageCount: 2,
    });
    expect(store.getEvents(ID)).toHaveLength(2);
  });

  it('a zero-byte file is not a session', () => {
    const emptyId = 'bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    const empty = path.join(root, '-repo', `${emptyId}.jsonl`);
    fs.copyFileSync(path.join(import.meta.dirname, 'fixtures', 'codebuddy', 'empty.jsonl'), empty);
    expect(fs.statSync(empty).size).toBe(0);
    const ingester = new Ingester(store, [adapter()], (m) => logs.push(m), () => false);
    ingester.ingestFile(adapter(), empty);
    expect(store.getSession(emptyId)).toBeNull();
    expect(store.getSessionByPath(empty)).toBeNull();
  });

  it('skips a colliding id, logs, leaves the first session untouched, stays up', () => {
    const claudeRoot = path.join(root, 'claude');
    fs.mkdirSync(path.join(claudeRoot, '-proj'), { recursive: true });
    const claudeFile = path.join(claudeRoot, '-proj', `${ID}.jsonl`);
    fs.writeFileSync(claudeFile, JSON.stringify({
      type: 'user', uuid: 'u1', timestamp: '2026-08-24T00:00:00.000Z',
      cwd: '/tmp/proj', message: { role: 'user', content: 'claude first' },
    }) + '\n');
    const claude = claudeCodeAdapter(claudeRoot);
    const ingester = new Ingester(store, [claude, adapter()], (m) => logs.push(m), () => false);
    ingester.ingestFile(claude, claudeFile);
    expect(store.getSession(ID)).toMatchObject({ adapter: 'claude-code', title: 'claude first' });

    fs.writeFileSync(file, userLine('evt-cbc', 'cbc must not mix in'));
    expect(() => ingester.ingestFile(adapter(), file)).not.toThrow();
    expect(store.getSession(ID)).toMatchObject({
      adapter: 'claude-code', title: 'claude first', messageCount: 1,
    });
    expect(store.getEvents(ID).map((e) => e.id)).toEqual(['u1']);
    expect(logs.some((m) => m.includes('session UUID collision') && m.includes(ID))).toBe(true);
  });
});
