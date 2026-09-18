import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { claudeCodeAdapter } from '../src/adapters/claudeCode.js';
import { codebuddyAdapter } from '../src/adapters/codebuddy.js';
import { codexAdapter } from '../src/adapters/codex.js';

const ROOT = '/tmp/fake-codebuddy/projects';
const ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const FILE = `${ROOT}/-repo/${ID}.jsonl`;
const adapter = codebuddyAdapter(ROOT);
const ctx = { filePath: FILE, byteOffset: 0 };

function fixtureLines(name: string): string[] {
  const p = path.join(import.meta.dirname, 'fixtures', 'codebuddy', name);
  return fs.readFileSync(p, 'utf8').split('\n').filter((l) => l.trim());
}

describe('codebuddyAdapter.matches', () => {
  it('accepts main-session transcripts only', () => {
    expect(adapter.matches(FILE)).toBe(true);
    expect(adapter.matches(`${ROOT}/-repo/notes.jsonl`)).toBe(false);
    expect(adapter.matches(`${ROOT}/${ID}.jsonl`)).toBe(false); // too shallow
    expect(adapter.matches(`${ROOT}/-repo/${ID}/subagents/agent-x.jsonl`)).toBe(false);
    expect(adapter.matches(`${ROOT}/-repo/${ID}/subagents/agent-x.meta.json`)).toBe(false);
    expect(adapter.matches(`/elsewhere/-repo/${ID}.jsonl`)).toBe(false);
  });
});

describe('codebuddyAdapter.sessionMeta', () => {
  it('id is the filename stem with no adapter prefix', () => {
    const meta = adapter.sessionMeta(FILE, []);
    expect(meta.id).toBe(ID);
    expect(meta.adapter).toBe('codebuddy');
    expect(meta.projectDir).toBeNull();
    expect(meta.title).toBe('');
  });
});

describe('codebuddy.parseLine on fixture lines', () => {
  const lines = fixtureLines('entries.jsonl');

  it('never throws and never returns undefined', () => {
    for (const line of lines) {
      const evs = adapter.parseLine(line, ctx);
      expect(Array.isArray(evs)).toBe(true);
    }
  });

  it('maps user/assistant/reasoning/tool call and result, pairing by callId', () => {
    const all = lines.flatMap((l) => adapter.parseLine(l, ctx));
    const messages = all.filter((e) => e.kind === 'message');
    expect(messages).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'message', id: 'evt-user', role: 'user', ts: 1700000001000, parentId: 'evt-plumb',
        blocks: [{ type: 'text', markdown: 'fix the login bug' }],
        sessionPatch: { title: 'fix the login bug', titleSource: 'prompt', projectDir: '/repo' },
      }),
      expect.objectContaining({
        kind: 'message', id: 'evt-asst', role: 'assistant',
        blocks: [{ type: 'text', markdown: 'I will look at `src/login.ts`.' }],
      }),
      expect.objectContaining({
        kind: 'message', id: 'evt-think', role: 'assistant',
        blocks: [{ type: 'thinking', text: 'Need to find the auth handler first.' }],
      }),
    ]));
    const uses = messages.flatMap((m) => m.kind === 'message' ? m.blocks : [])
      .filter((b) => b.type === 'tool_use');
    const results = messages.flatMap((m) => m.kind === 'message' ? m.blocks : [])
      .filter((b) => b.type === 'tool_result');
    expect(uses).toEqual([expect.objectContaining({
      type: 'tool_use', id: 'call_read_1', toolName: 'Read',
      input: { file_path: 'src/login.ts' },
    })]);
    expect(results).toEqual([expect.objectContaining({
      type: 'tool_result', toolUseId: 'call_read_1', isError: false,
      output: 'export function login() {}',
    })]);
    expect(JSON.stringify(uses)).not.toContain('duplicate of the reasoning line');
  });

  it('a leading-< user line is still a message but not a title patch', () => {
    const [ev] = adapter.parseLine(lines[0]!, ctx);
    expect(ev).toMatchObject({ kind: 'message', role: 'user', id: 'evt-plumb' });
    if (ev?.kind !== 'message') throw new Error('unreachable');
    expect(ev.sessionPatch?.title).toBeUndefined();
    expect(ev.sessionPatch?.projectDir).toBe('/repo');
  });

  it('summary and ai-title are patch-only ai titles; last ai still a patch', () => {
    const byType = (t: string) => lines.filter((l) => (JSON.parse(l) as { type: string }).type === t)
      .flatMap((l) => adapter.parseLine(l, ctx));
    for (const ev of [...byType('summary'), ...byType('ai-title')]) {
      expect(ev).toMatchObject({ kind: 'meta', sessionPatch: { titleSource: 'ai' } });
      if (ev.kind !== 'meta') throw new Error('unreachable');
      expect(ev.raw).toBeNull();
      expect(ev.sessionPatch?.turnOpen).toBeUndefined();
    }
    expect(byType('summary')[0]).toMatchObject({ sessionPatch: { title: 'Fix login' } });
    expect(byType('ai-title')[0]).toMatchObject({
      sessionPatch: { title: 'Fix the login bug', projectDir: '/repo' },
    });
  });

  it('orchestration types are meta; snapshots, metrics, session-meta disappear', () => {
    const byType = (t: string) => lines.filter((l) => (JSON.parse(l) as { type: string }).type === t)
      .flatMap((l) => adapter.parseLine(l, ctx));
    for (const t of ['goal-progress', 'goal-result', 'agent_started', 'agent_finished', 'run_started', 'run_finished']) {
      expect(byType(t), t).toEqual([expect.objectContaining({ kind: 'meta', label: t })]);
    }
    expect(byType('file-history-snapshot')).toHaveLength(0);
    expect(byType('turn-metrics')).toHaveLength(0);
    expect(byType('session-meta')).toHaveLength(0);
    expect(byType('turn-metrics')[0]?.kind === 'meta' ? byType('turn-metrics')[0] : undefined)
      .toBeUndefined();
  });
});

describe('codebuddy.parseLine on edge cases', () => {
  const lines = fixtureLines('edge-cases.jsonl');

  it('never throws', () => {
    for (const line of lines) expect(() => adapter.parseLine(line, ctx)).not.toThrow();
    expect(() => adapter.parseLine('not json at all', ctx)).not.toThrow();
  });

  it('shows a persisted-output preview in-line and does not invent a sidecar read', () => {
    const persist = lines.find((l) => l.includes('<persisted-output>'))!;
    const [ev] = adapter.parseLine(persist, ctx);
    expect(ev).toMatchObject({ kind: 'message' });
    if (ev?.kind !== 'message') throw new Error('unreachable');
    const result = ev.blocks.find((b) => b.type === 'tool_result');
    expect(result).toMatchObject({ type: 'tool_result', toolUseId: 'call_big', isError: false });
    if (result?.type !== 'tool_result') throw new Error('unreachable');
    expect(result.output).toContain('<persisted-output>');
    expect(result.output).toContain('x'.repeat(2048));
    expect(result.output).not.toMatch(/tool-results\/call_big\.txt[\s\S]*[^x]$/);
  });

  it('incomplete tool results are errors; malformed arguments stay a tool_use string', () => {
    const incomplete = lines.find((l) => l.includes('"incomplete"'))!;
    const [err] = adapter.parseLine(incomplete, ctx);
    expect(err).toMatchObject({ kind: 'message' });
    if (err?.kind !== 'message') throw new Error('unreachable');
    expect(err.blocks[0]).toMatchObject({ type: 'tool_result', isError: true, toolUseId: 'call_ask' });

    const bad = lines.find((l) => l.includes('not-json{'))!;
    const [call] = adapter.parseLine(bad, ctx);
    expect(call).toMatchObject({ kind: 'message' });
    if (call?.kind !== 'message') throw new Error('unreachable');
    expect(call.blocks[0]).toMatchObject({
      type: 'tool_use', id: 'call_bad', toolName: 'Read', input: 'not-json{',
    });
  });

  it('_meta does not change a known type; unknown types and bad json are unknown', () => {
    const withMeta = lines.find((l) => l.includes('"_meta"'))!;
    expect(adapter.parseLine(withMeta, ctx)[0]).toMatchObject({
      kind: 'message', role: 'assistant',
      blocks: [{ type: 'text', markdown: 'still a message' }],
    });
    const future = lines.find((l) => l.includes('some-future-type'))!;
    expect(adapter.parseLine(future, ctx)[0]).toMatchObject({ kind: 'unknown' });
    expect(adapter.parseLine('not json at all', ctx)[0]).toMatchObject({
      kind: 'unknown', id: `${FILE}:0`,
    });
  });
});

describe('sight inspect adapter pick', () => {
  it('reports a CBC fixture as codebuddy even outside the usual root', () => {
    const lines = fixtureLines('entries.jsonl');
    const abs = `/tmp/elsewhere/${ID}.jsonl`;
    const scored = [claudeCodeAdapter(), codexAdapter(), codebuddyAdapter()].map((a) => ({
      id: a.id,
      unknown: lines.flatMap((l) => a.parseLine(l, { filePath: abs, byteOffset: 0 }))
        .filter((e) => e.kind === 'unknown').length,
    }));
    scored.sort((x, y) => x.unknown - y.unknown);
    expect(scored[0]!.id).toBe('codebuddy');
  });
});
