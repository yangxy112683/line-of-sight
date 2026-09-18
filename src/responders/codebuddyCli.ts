import { type ChildProcess, type ChildProcessWithoutNullStreams, execFile, spawn } from 'node:child_process';
import path from 'node:path';
import { composePrompt } from './prompt.js';
import { type Responder, type ResponderRequest } from './types.js';

// Read-only cage (product promise B5): no Write/Edit/Bash. WebFetch is also
// excluded — transcript content is untrusted, and WebFetch would let an
// injected prompt exfiltrate transcript text to an arbitrary URL.
// Belt and braces: --tools / --allowedTools auto-approve the read-only set,
// and --disallowedTools hard-blocks mutating/exfiltrating tools. CBC-only
// deny names (PowerShell, Agent, REPL, Skill) are on the pinned 2.150.0 list.
const ALLOWED_TOOLS = 'Read,Grep,Glob';
const DISALLOWED_TOOLS =
  'Write,Edit,MultiEdit,NotebookEdit,Bash,PowerShell,Agent,REPL,Skill,WebFetch,WebSearch';

// Residual vs Claude: CBC has no --restricted (read from --help and the
// installed package on 2.150.0; not live-fired against a model). Same class
// of residual as Codex --sandbox read-only — writes and denied tools are
// blocked, but an out-of-trusted-dir Read is a permission deny, not a
// structural file-tool error. --add-dir <transcriptDir> is required so the
// jsonl under ~/.codebuddy/projects/ is reachable from project cwd; it is
// not a fence. Do not add a prompt-level read-only promise.
//
// --setting-sources none is required; an empty string is not equivalent
// (it loads all sources). --no-session-persistence plus no --resume so an
// Ask run cannot register a real uuid into the live map.
//
// prompt === null: the process is pre-spawned before the reader has typed
// the question and reads it from stdin later. Same cage, same output
// format either way — only where the prompt comes from.
export const CODEBUDDY_ARGS = (prompt: string | null, transcriptDir: string): string[] => [
  '-p', ...(prompt === null ? ['--input-format', 'stream-json'] : [prompt]),
  '--tools', ALLOWED_TOOLS,
  '--allowedTools', ALLOWED_TOOLS,
  '--disallowedTools', DISALLOWED_TOOLS,
  '--permission-mode', 'dontAsk',
  '--strict-mcp-config',
  '--setting-sources', 'none',
  '--no-session-persistence',
  '--add-dir', transcriptDir,
  '--output-format', 'stream-json',
  '--include-partial-messages',
];

interface StreamLine {
  type?: string;
  event?: { type?: string; delta?: { type?: string; text?: string } };
  message?: { content?: unknown };
}

/** Extract answer text from one stream-json stdout line ('' if none). */
function textFromStreamLine(line: string): string {
  let parsed: StreamLine;
  try {
    parsed = JSON.parse(line) as StreamLine;
  } catch {
    return '';
  }
  if (parsed.type === 'stream_event'
      && parsed.event?.type === 'content_block_delta'
      && parsed.event.delta?.type === 'text_delta') {
    return parsed.event.delta.text ?? '';
  }
  return '';
}

const VERBS: Record<string, string> = { Grep: 'searching', Glob: 'searching', Read: 'reading' };

function statusTarget(arg: string, ctx?: { sessionFilePath?: string; projectDir?: string | null }): string {
  if (ctx?.sessionFilePath && arg.includes(path.basename(ctx.sessionFilePath, '.jsonl'))) {
    return 'the transcript';
  }
  if (ctx?.projectDir && arg.startsWith(`${ctx.projectDir}/`)) return arg.slice(ctx.projectDir.length + 1);
  return arg.startsWith('/') ? path.basename(arg) : arg;
}

function statusFromStreamLine(line: string,
    ctx?: { sessionFilePath?: string; projectDir?: string | null }): string {
  let parsed: StreamLine;
  try {
    parsed = JSON.parse(line) as StreamLine;
  } catch {
    return '';
  }
  if (parsed.type !== 'assistant' || !Array.isArray(parsed.message?.content)) return '';
  for (const block of parsed.message.content as Record<string, unknown>[]) {
    if (block.type !== 'tool_use') continue;
    const input = (block.input ?? {}) as Record<string, unknown>;
    const arg = [input.file_path, input.path, input.pattern, input.query, input.command]
      .find((v) => typeof v === 'string') as string | undefined;
    const name = String(block.name ?? 'tool');
    const s = `${VERBS[name] ?? name} ${arg ? statusTarget(arg, ctx) : ''}`.trim();
    return s.length > 80 ? s.slice(0, 79) + '…' : s;
  }
  return '';
}

const WARM_IDLE_MS = 60_000;

interface Warm { chatId: string; child: ChildProcessWithoutNullStreams; timer: NodeJS.Timeout }
let warm: Warm | null = null;

function forget(child: ChildProcess): void {
  if (warm?.child !== child) return;
  clearTimeout(warm.timer);
  warm = null;
}

function dropWarm(): void {
  if (!warm) return;
  const { child, timer } = warm;
  warm = null;
  clearTimeout(timer);
  child.kill();
}

process.on('exit', () => { warm?.child.kill(); });

function takeWarm(chatId: string): ChildProcessWithoutNullStreams | null {
  if (!warm || warm.chatId !== chatId) return null;
  const { child, timer } = warm;
  if (child.exitCode !== null || child.signalCode !== null) return null;
  warm = null;
  clearTimeout(timer);
  return child;
}

function feed(child: ChildProcessWithoutNullStreams | null, prompt: string):
    ChildProcessWithoutNullStreams | null {
  if (!child) return null;
  try {
    child.stdin.end(`${JSON.stringify({ type: 'user', message: { role: 'user', content: prompt } })}\n`);
    return child;
  } catch {
    child.kill();
    return null;
  }
}

export const codebuddyCliResponder: Responder = {
  id: 'codebuddy-cli',
  options: null,
  label: () => 'cbc',

  available(): Promise<boolean> {
    return new Promise((resolve) => {
      execFile('which', ['cbc'], (err) => resolve(!err));
    });
  },

  prewarm(chatId: string, projectDir: string | null, sessionFilePath: string): void {
    dropWarm();
    const transcriptDir = path.dirname(sessionFilePath);
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn('cbc', CODEBUDDY_ARGS(null, transcriptDir), { cwd: projectDir ?? transcriptDir });
    } catch {
      return;
    }
    child.on('error', () => forget(child));
    child.on('exit', () => forget(child));
    child.stdin.on('error', () => {});
    const timer = setTimeout(dropWarm, WARM_IDLE_MS);
    timer.unref();
    warm = { chatId, child, timer };
  },

  answer(req: ResponderRequest, onChunk: (s: string) => void, signal: AbortSignal,
         onStatus?: (s: string) => void): Promise<string> {
    const prompt = composePrompt(req);
    const transcriptDir = path.dirname(req.sessionFilePath);
    const hot = feed(takeWarm(req.chatId), prompt);
    const child = hot ?? spawn('cbc', CODEBUDDY_ARGS(prompt, transcriptDir), {
      cwd: req.projectDir ?? transcriptDir,
      stdio: ['ignore', 'pipe', 'pipe'],
      signal,
    });
    if (hot) signal.addEventListener('abort', () => hot.kill(), { once: true });
    return new Promise((resolve, reject) => {
      let answer = '';
      let stderr = '';
      let buf = '';
      child.stdout.on('data', (chunk: Buffer) => {
        buf += chunk.toString('utf8');
        let nl;
        while ((nl = buf.indexOf('\n')) !== -1) {
          const line = buf.slice(0, nl);
          buf = buf.slice(nl + 1);
          const text = textFromStreamLine(line);
          if (text) { answer += text; onChunk(text); continue; }
          const status = statusFromStreamLine(line, req);
          if (status) onStatus?.(status);
        }
      });
      child.stderr.on('data', (c: Buffer) => { stderr += c.toString('utf8'); });
      child.on('error', reject);
      child.on('close', (code) => {
        if (signal.aborted) return reject(new Error('canceled'));
        if (code !== 0 && !answer) {
          return reject(new Error(`cbc exited ${code}: ${stderr.slice(0, 500)}`));
        }
        resolve(answer);
      });
    });
  },
};
