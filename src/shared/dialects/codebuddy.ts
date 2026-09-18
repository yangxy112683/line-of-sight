import type { RenderBlock } from '../types.js';
import type { AskOption, AskQuestion, Dialect, EditPair, Plumbing } from './types.js';

// CodeBuddy Code's presentation policy. Derived from tool names, not
// renderer.type. Shape drift returns null/false/[] — never a crash.

function isBlockingUse(b: RenderBlock): boolean {
  return b.type === 'tool_use' && b.toolName === 'AskUserQuestion';
}

/** AskUserQuestion input.questions; extra keys (preview included) ignored.
 *  null → shape drift, use the raw fold. */
function askQuestions(b: RenderBlock): AskQuestion[] | null {
  if (b.type !== 'tool_use' || b.toolName !== 'AskUserQuestion') return null;
  const qs = (b.input as { questions?: unknown } | null)?.questions;
  if (!Array.isArray(qs) || qs.length === 0) return null;
  const out: AskQuestion[] = [];
  for (const q of qs) {
    const o = (q ?? {}) as Record<string, unknown>;
    if (typeof o.question !== 'string' || !Array.isArray(o.options)) return null;
    const options: AskOption[] = [];
    for (const raw of o.options) {
      const opt = (raw ?? {}) as Record<string, unknown>;
      if (typeof opt.label !== 'string') return null;
      options.push({
        label: opt.label,
        description: typeof opt.description === 'string' ? opt.description : '',
      });
    }
    out.push({
      question: o.question,
      header: typeof o.header === 'string' ? o.header : '',
      multiSelect: o.multiSelect === true,
      options,
    });
  }
  return out;
}

/** Claude `"<question>"="<answer>"` substring first; else exactly one
 *  option label in the result text; otherwise null (card still renders). */
function chosenAnswer(output: string, q: AskQuestion): string | null {
  const at = output.indexOf(`"${q.question}"="`);
  if (at >= 0) {
    const rest = output.slice(at + q.question.length + 4);
    const end = rest.indexOf('"');
    if (end > 0) return rest.slice(0, end);
  }
  const hits = q.options.filter((o) => o.label !== '' && output.includes(o.label));
  return hits.length === 1 ? hits[0]!.label : null;
}

/** Diff pairs for Edit and Write; MultiEdit is not a CBC card. */
function editDiff(b: RenderBlock): EditPair[] | null {
  if (b.type !== 'tool_use') return null;
  const i = (b.input ?? {}) as Record<string, unknown>;
  if (b.toolName === 'Edit' && typeof i.old_string === 'string' && typeof i.new_string === 'string') {
    return [{ oldText: i.old_string, newText: i.new_string }];
  }
  if (b.toolName === 'Write' && typeof i.content === 'string') {
    return [{ oldText: '', newText: i.content }];
  }
  return null;
}

// CLI-plumbing user messages: leading-< lines no human typed
// (system-reminder, teammate-message, bash-input/stdout, command-*,
// task-notification). Same extract as Claude for task-notification.
function plumbing(text: string): Plumbing | null {
  const t = text.trimStart();
  if (!t.startsWith('<')) return null;
  const tag = /^<([a-z][\w-]*)/i.exec(t)?.[1] ?? 'system';
  if (tag === 'task-notification') {
    const summary = /<summary>([\s\S]*?)<\/summary>/.exec(t)?.[1]?.trim();
    const result = /<result>([\s\S]*?)(?:<\/result>|$)/.exec(t)?.[1]?.trim() ?? null;
    return { tag, label: summary ?? tag, result };
  }
  return { tag, label: tag, result: null };
}

export const codebuddyDialect: Dialect = {
  displayName: 'cbc',
  resumeArgv: (id) => ['cbc', '--resume', id],
  isBlockingUse,
  askQuestions,
  chosenAnswer,
  isPlanUse: () => false,
  planMarkdown: () => null,
  planDraft: () => null,
  editDiff,
  plumbing,
  isQueueOp: () => false,
  queuedInputs: () => [],
};
