import os from 'node:os';
import path from 'node:path';
import type { RenderBlock, SessionPatch } from '../shared/types.js';
import type { AgentAdapter } from './types.js';
import { parseTs, str, truncate } from './util.js';

const UUID_JSONL = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl$/i;
const DROP_TYPES = new Set(['file-history-snapshot', 'turn-metrics', 'session-meta']);
const META_TYPES = new Set([
  'goal-progress', 'goal-result', 'agent_started', 'agent_finished',
  'run_started', 'run_finished',
]);
const TEXT_BLOCKS = new Set(['input_text', 'output_text', 'text', 'reasoning_text']);
const OK_STATUS = new Set(['success', 'completed']);

type Json = Record<string, unknown>;

function object(value: unknown): Json {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Json : {};
}

function eventTs(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : parseTs(v);
}

function contentText(content: unknown): string | null {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return null;
  return content.map((c) => {
    const blk = object(c);
    return TEXT_BLOCKS.has(str(blk.type) ?? '') ? str(blk.text) ?? '' : '';
  }).join('');
}

function parseArgs(raw: unknown): unknown {
  if (typeof raw !== 'string') return raw;
  try { return JSON.parse(raw) as unknown; } catch { return raw; }
}

function toolSummary(name: string, input: unknown): string {
  const i = object(input);
  const arg = str(i.file_path) ?? str(i.path) ?? str(i.command) ?? str(i.pattern)
    ?? str(i.url) ?? str(i.query) ?? str(i.description) ?? '';
  return truncate(`${name} ${arg}`.trim(), 100);
}

function resultOutput(output: unknown): string {
  if (typeof output === 'string') return output;
  const text = str(object(output).text);
  if (text != null) return text;
  return output == null ? '' : JSON.stringify(output);
}

function withCwd(line: Json, extra?: SessionPatch): SessionPatch | undefined {
  const patch: SessionPatch = { ...extra };
  const cwd = str(line.cwd);
  if (cwd) patch.projectDir = cwd;
  return Object.keys(patch).length ? patch : undefined;
}

function isRealPrompt(text: string): boolean {
  const t = text.trimStart();
  return t.length > 0 && !t.startsWith('<');
}

export function codebuddyAdapter(root = path.join(os.homedir(), '.codebuddy', 'projects')): AgentAdapter {
  return {
    id: 'codebuddy',
    roots: () => [root],
    // <slug>/<uuid>.jsonl — v1 is main sessions only; subagents are not matched
    watchDepth: 2,

    matches(filePath) {
      return UUID_JSONL.test(path.basename(filePath))
        && path.dirname(path.dirname(filePath)) === root;
    },

    parseLine(rawLine, ctx) {
      const fallbackId = `${ctx.filePath}:${ctx.byteOffset}`;
      let line: Json;
      try {
        const parsed: unknown = JSON.parse(rawLine);
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
          return [{ kind: 'unknown', id: fallbackId, ts: 0, raw: parsed }];
        }
        line = parsed as Json;
      } catch {
        return [{ kind: 'unknown', id: fallbackId, ts: 0, raw: rawLine }];
      }

      const type = str(line.type);
      const id = str(line.id) ?? fallbackId;
      const ts = eventTs(line.timestamp);
      const parentId = str(line.parentId) ?? null;

      if (type && DROP_TYPES.has(type)) return [];

      if (type === 'summary' || type === 'ai-title') {
        const title = str(line.summary) ?? str(line.aiTitle);
        if (!title?.trim()) return [];
        return [{ kind: 'meta', id, ts, label: type, raw: null,
          sessionPatch: withCwd(line, { title: truncate(title.trim(), 120), titleSource: 'ai' }) }];
      }

      if (type && META_TYPES.has(type)) {
        return [{ kind: 'meta', id, ts, label: type, raw: line, parentId }];
      }

      if (type === 'message') {
        const role = str(line.role);
        if (role !== 'user' && role !== 'assistant') {
          return [{ kind: 'unknown', id, ts, raw: line }];
        }
        const text = contentText(line.content);
        if (text == null) return [{ kind: 'unknown', id, ts, raw: line }];
        const extra: SessionPatch = {};
        if (role === 'user' && isRealPrompt(text)) {
          extra.title = truncate(text.trim(), 120);
          extra.titleSource = 'prompt';
        }
        const sessionPatch = withCwd(line, extra);
        return [{ kind: 'message', id, ts, role, parentId, blocks: [{ type: 'text', markdown: text }],
          ...(sessionPatch ? { sessionPatch } : {}) }];
      }

      if (type === 'reasoning') {
        const text = contentText(line.rawContent) ?? contentText(line.content) ?? '';
        if (!text.trim()) return [];
        const sessionPatch = withCwd(line);
        return [{ kind: 'message', id, ts, role: 'assistant', parentId,
          blocks: [{ type: 'thinking', text }],
          ...(sessionPatch ? { sessionPatch } : {}) }];
      }

      if (type === 'function_call') {
        const name = str(line.name) ?? 'tool';
        const callId = str(line.callId) ?? id;
        const input = parseArgs(line.arguments);
        const sessionPatch = withCwd(line);
        const blocks: RenderBlock[] = [{
          type: 'tool_use', id: callId, toolName: name,
          summary: toolSummary(name, input), input,
        }];
        return [{ kind: 'message', id, ts, role: 'assistant', parentId, blocks,
          ...(sessionPatch ? { sessionPatch } : {}) }];
      }

      if (type === 'function_call_result') {
        const output = resultOutput(line.output);
        const status = str(line.status);
        const sessionPatch = withCwd(line);
        const blocks: RenderBlock[] = [{
          type: 'tool_result',
          toolUseId: str(line.callId),
          summary: truncate((output.split('\n', 1)[0] ?? ''), 100),
          output,
          isError: status != null && !OK_STATUS.has(status),
        }];
        return [{ kind: 'message', id, ts, role: 'assistant', parentId, blocks,
          ...(sessionPatch ? { sessionPatch } : {}) }];
      }

      return [{ kind: 'unknown', id, ts, raw: line }];
    },

    sessionMeta(filePath, firstEvents) {
      const ts = firstEvents[0]?.ts ?? 0;
      return {
        id: path.basename(filePath, '.jsonl'),
        adapter: 'codebuddy',
        filePath,
        projectDir: null,
        title: '',
        startedAt: ts,
        updatedAt: ts,
        messageCount: 0,
        parentId: null,
        toolUseId: null,
      };
    },
  };
}
