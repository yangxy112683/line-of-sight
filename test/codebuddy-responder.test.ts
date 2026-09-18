import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { composePrompt } from '../src/responders/prompt.js';
import type { ResponderRequest } from '../src/responders/types.js';

const spawn = vi.fn(() => new FakeChild());
vi.mock('node:child_process', async (orig) => ({
  ...(await orig<typeof import('node:child_process')>()),
  spawn: (...args: unknown[]) => spawn(...(args as [])),
}));

class FakeChild extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  exitCode: number | null = null;
  signalCode: string | null = null;
  stdin = { end: () => {}, on: () => {} };
  kill(): boolean { return true; }
}

const { CODEBUDDY_ARGS, codebuddyCliResponder } = await import('../src/responders/codebuddyCli.js');

const REQ: ResponderRequest = {
  chatId: 'chat-1',
  question: 'What is the evidence for this?',
  anchorText: 'the parser is incremental',
  sessionFilePath: '/home/u/.codebuddy/projects/-p/abc.jsonl',
  projectDir: '/home/u/proj',
  priorTurns: [],
};

describe('codebuddy-cli command construction', () => {
  it('uses exactly the pinned cbc 2.150.0 flags with a --tools cage', () => {
    const args = CODEBUDDY_ARGS('PROMPT', '/t');
    expect(args).toEqual([
      '-p', 'PROMPT',
      '--tools', 'Read,Grep,Glob',
      '--allowedTools', 'Read,Grep,Glob',
      '--disallowedTools', 'Write,Edit,MultiEdit,NotebookEdit,Bash,PowerShell,Agent,REPL,Skill,WebFetch,WebSearch',
      '--permission-mode', 'dontAsk',
      '--strict-mcp-config',
      '--setting-sources', 'none',
      '--no-session-persistence',
      '--add-dir', '/t',
      '--output-format', 'stream-json',
      '--include-partial-messages',
    ]);
    expect(args).not.toContain('--restricted');
    expect(args).not.toContain('--verbose');
    const allowed = args[args.indexOf('--allowedTools') + 1]!;
    const tools = args[args.indexOf('--tools') + 1]!;
    const disallowed = args[args.indexOf('--disallowedTools') + 1]!;
    expect(args[args.indexOf('--setting-sources') + 1]).toBe('none');
    for (const banned of ['Write', 'Edit', 'Bash', 'PowerShell', 'Agent', 'REPL', 'Skill', 'WebFetch']) {
      expect(allowed).not.toContain(banned);
      expect(tools).not.toContain(banned);
      expect(disallowed).toContain(banned);
    }
  });

  it('the pre-spawned variant differs only in where the prompt comes from', () => {
    expect(CODEBUDDY_ARGS(null, '/t')).toEqual(
      ['-p', '--input-format', 'stream-json', ...CODEBUDDY_ARGS('PROMPT', '/t').slice(2)]);
  });

  it('does not persist an Ask run as a session', () => {
    const args = CODEBUDDY_ARGS('PROMPT', '/t');
    expect(args).toContain('--no-session-persistence');
    expect(args).not.toContain('--resume');
    expect(CODEBUDDY_ARGS(null, '/t')).not.toContain('--resume');
  });
});

describe('codebuddy-cli prompt path', () => {
  it('reuses composePrompt with no read-only promise', async () => {
    const prompt = composePrompt(REQ);
    expect(prompt).not.toMatch(/read-only/i);
    expect(prompt).not.toMatch(/you must not write/i);
    expect(prompt).not.toMatch(/you are read-only/i);

    spawn.mockClear();
    const pending = codebuddyCliResponder.answer(REQ, () => {}, new AbortController().signal);
    expect(spawn).toHaveBeenCalledOnce();
    const [cmd, args, opts] = spawn.mock.calls[0] as unknown as [string, string[], { cwd: string }];
    expect(cmd).toBe('cbc');
    expect(args[0]).toBe('-p');
    expect(args[1]).toBe(prompt);
    expect(opts.cwd).toBe('/home/u/proj');
    (spawn.mock.results[0]!.value as FakeChild).emit('close', 0);
    await pending;
  });

  it('uses the transcript dir as cwd when no project dir is known', async () => {
    spawn.mockClear();
    const req = { ...REQ, projectDir: null };
    const pending = codebuddyCliResponder.answer(req, () => {}, new AbortController().signal);
    const opts = spawn.mock.calls[0]![2] as { cwd: string };
    expect(opts.cwd).toBe('/home/u/.codebuddy/projects/-p');
    expect((spawn.mock.calls[0] as unknown as [string, string[]])[1])
      .toEqual(CODEBUDDY_ARGS(composePrompt(req), '/home/u/.codebuddy/projects/-p'));
    (spawn.mock.results[0]!.value as FakeChild).emit('close', 0);
    await pending;
  });
});
