import { describe, expect, it } from 'vitest';
import { codebuddyDialect } from '../src/shared/dialects/codebuddy.js';
import type { RenderBlock, StoredEvent } from '../src/shared/types.js';

const ASK_ARGS = {
  questions: [{
    header: 'Control placement',
    question: 'Where should the two sliders go?',
    multiSelect: false,
    options: [
      { label: 'Aa button + popover (Recommended)', description: 'One chip in the top bar', preview: '┌─┐\n└─┘' },
      { label: 'Two sliders always in the top bar', description: 'Drag any time' },
    ],
  }],
};

const use = (toolName: string, input: unknown): RenderBlock =>
  ({ type: 'tool_use', id: 'call_1', toolName, summary: toolName, input });

describe('codebuddyDialect.askQuestions', () => {
  it('parses AskUserQuestion; extra keys including preview are ignored', () => {
    const b = use('AskUserQuestion', ASK_ARGS);
    expect(codebuddyDialect.isBlockingUse(b)).toBe(true);
    const qs = codebuddyDialect.askQuestions(b)!;
    expect(qs).toHaveLength(1);
    expect(qs[0]).toMatchObject({
      question: 'Where should the two sliders go?',
      header: 'Control placement',
      multiSelect: false,
    });
    expect(qs[0]!.options).toEqual([
      { label: 'Aa button + popover (Recommended)', description: 'One chip in the top bar' },
      { label: 'Two sliders always in the top bar', description: 'Drag any time' },
    ]);
    expect(qs[0]!.options[0]!.preview).toBeUndefined();
  });

  it('rejects drifted shapes and other tools instead of guessing', () => {
    expect(codebuddyDialect.askQuestions(use('AskUserQuestion', null))).toBeNull();
    expect(codebuddyDialect.askQuestions(use('AskUserQuestion', { questions: [] }))).toBeNull();
    expect(codebuddyDialect.askQuestions(use('AskUserQuestion', { questions: [{}] }))).toBeNull();
    expect(codebuddyDialect.askQuestions(use('AskUserQuestion', { questions: [{ question: 'q', options: [{}] }] }))).toBeNull();
    expect(codebuddyDialect.askQuestions(use('Edit', ASK_ARGS))).toBeNull();
    expect(codebuddyDialect.isBlockingUse(use('AskUserQuestion', null))).toBe(true);
    expect(codebuddyDialect.isBlockingUse(use('Edit', {}))).toBe(false);
  });

  it('optional header, description, and multiSelect default without crashing', () => {
    const qs = codebuddyDialect.askQuestions(use('AskUserQuestion', {
      questions: [{ question: 'q', options: [{ label: 'A' }], extra: true }],
    }))!;
    expect(qs[0]).toMatchObject({ question: 'q', header: '', multiSelect: false });
    expect(qs[0]!.options[0]).toEqual({ label: 'A', description: '' });
  });

  it('ExitPlanMode is not a blocking question card', () => {
    const b = use('ExitPlanMode', { plan: '# p' });
    expect(codebuddyDialect.isBlockingUse(b)).toBe(false);
    expect(codebuddyDialect.askQuestions(b)).toBeNull();
    expect(codebuddyDialect.isPlanUse(b)).toBe(false);
  });
});

describe('codebuddyDialect.chosenAnswer', () => {
  const q = codebuddyDialect.askQuestions(use('AskUserQuestion', ASK_ARGS))![0]!;

  it('Claude quoted substring wins when present', () => {
    const output = 'Your questions have been answered: "Where should the two sliders go?"="Aa button + popover (Recommended)". You can now continue.';
    expect(codebuddyDialect.chosenAnswer(output, q)).toBe('Aa button + popover (Recommended)');
  });

  it('quoted substring wins even when another option label also appears', () => {
    const output = 'Picked "Where should the two sliders go?"="Two sliders always in the top bar" after considering Aa button + popover (Recommended)';
    expect(codebuddyDialect.chosenAnswer(output, q)).toBe('Two sliders always in the top bar');
  });

  it('falls back to the single option label that appears in the result', () => {
    expect(codebuddyDialect.chosenAnswer('User picked: Two sliders always in the top bar', q))
      .toBe('Two sliders always in the top bar');
  });

  it('null when zero or several option labels appear and there is no quoted answer', () => {
    expect(codebuddyDialect.chosenAnswer('The user doesn\'t want to proceed', q)).toBeNull();
    expect(codebuddyDialect.chosenAnswer(
      'Aa button + popover (Recommended) or Two sliders always in the top bar', q)).toBeNull();
  });
});

describe('codebuddyDialect.editDiff', () => {
  it('Edit old_string/new_string and Write content become pairs', () => {
    expect(codebuddyDialect.editDiff(use('Edit', { old_string: 'a', new_string: 'b' })))
      .toEqual([{ oldText: 'a', newText: 'b' }]);
    expect(codebuddyDialect.editDiff(use('Write', { content: 'hello' })))
      .toEqual([{ oldText: '', newText: 'hello' }]);
  });

  it('MultiEdit and drifted Edit/Write stay at the generic fold', () => {
    expect(codebuddyDialect.editDiff(use('MultiEdit', {
      edits: [{ old_string: 'a', new_string: 'b' }],
    }))).toBeNull();
    expect(codebuddyDialect.editDiff(use('Edit', { old_string: 'a' }))).toBeNull();
    expect(codebuddyDialect.editDiff(use('Write', { file_path: '/x' }))).toBeNull();
    expect(codebuddyDialect.editDiff(use('AskUserQuestion', ASK_ARGS))).toBeNull();
  });
});

describe('codebuddyDialect.plumbing', () => {
  it('human prompts pass through as null', () => {
    expect(codebuddyDialect.plumbing('fix this bug')).toBeNull();
    expect(codebuddyDialect.plumbing('  fix < 3 issues')).toBeNull();
  });

  it('leading-< CBC tags fold as plumbing', () => {
    for (const tag of [
      'system-reminder', 'teammate-message', 'bash-input', 'bash-stdout',
      'command-name', 'command-args',
    ]) {
      expect(codebuddyDialect.plumbing(`<${tag}>x`)).toMatchObject({ tag, label: tag, result: null });
    }
  });

  it('task-notification extracts summary label and markdown result', () => {
    const text = '<task-notification> <task-id>abc</task-id> '
      + '<status>completed</status> <summary>Agent "Map demand signals" finished</summary> '
      + '<note>fires each time</note> <result>## Research value: high\n\ndetails here</result>';
    const p = codebuddyDialect.plumbing(text)!;
    expect(p.tag).toBe('task-notification');
    expect(p.label).toBe('Agent "Map demand signals" finished');
    expect(p.result).toContain('## Research value: high');
    expect(p.result).not.toContain('<result>');
  });

  it('task-notification without closing result tag still extracts', () => {
    const p = codebuddyDialect.plumbing('<task-notification><summary>s</summary><result>partial…')!;
    expect(p.result).toBe('partial…');
  });
});

describe('codebuddyDialect inert surfaces', () => {
  it('plan and queue methods are no-ops', () => {
    expect(codebuddyDialect.isPlanUse(use('ExitPlanMode', { plan: '# p' }))).toBe(false);
    expect(codebuddyDialect.planMarkdown({ plan: '# p' }, null)).toBeNull();
    expect(codebuddyDialect.planDraft(use('Write', {
      file_path: '/u/.claude/plans/x.md', content: '# p',
    }))).toBeNull();
    const queueOp: StoredEvent = {
      id: 'e', seq: 1, kind: 'meta', role: null, ts: 0,
      body: { label: 'queue-operation', raw: { operation: 'enqueue', content: 'x' } },
    };
    expect(codebuddyDialect.isQueueOp(queueOp)).toBe(false);
    expect(codebuddyDialect.queuedInputs([queueOp])).toEqual([]);
  });

  it('CBC-only tools stay at the generic fold', () => {
    for (const name of [
      'Agent', 'TaskCreate', 'TaskUpdate', 'TaskGet', 'TaskList', 'TaskOutput', 'TaskStop',
      'SendMessage', 'DeferExecuteTool', 'ToolSearch', 'WaitForMcpServers',
    ]) {
      const b = use(name, { questions: ASK_ARGS.questions, old_string: 'a', new_string: 'b', content: 'x' });
      expect(codebuddyDialect.isBlockingUse(b)).toBe(false);
      expect(codebuddyDialect.askQuestions(b)).toBeNull();
      expect(codebuddyDialect.editDiff(b)).toBeNull();
      expect(codebuddyDialect.isPlanUse(b)).toBe(false);
      expect(codebuddyDialect.planDraft(b)).toBeNull();
    }
  });
});

