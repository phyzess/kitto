import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';

export interface PromptOption {
  value: string;
  label: string;
  hint?: string;
}

export interface TextOptions {
  initialValue?: string;
  validate?: (value: string) => string | undefined | boolean | void;
}

export interface SetupPrompts {
  print(message: string): void;
  close(): void;
  hosts(options: PromptOption[], defaults: string[]): Promise<string[] | undefined>;
  select(message: string, options: PromptOption[], initialValue?: string): Promise<string | undefined>;
  yesNo(message: string, initialValue?: boolean): Promise<boolean | undefined>;
  text(message: string, options?: TextOptions): Promise<string | undefined>;
}

type TtyInput = Readable & { isTTY?: boolean; setRawMode?: (mode: boolean) => unknown };
type TtyOutput = Writable & { isTTY?: boolean };

export async function setupPrompts(input: TtyInput, output: TtyOutput): Promise<SetupPrompts> {
  const print = (message: string) => output.write(message + '\n');
  if (input.isTTY && output.isTTY && typeof input.setRawMode === 'function') {
    const ui = await import('@clack/prompts');
    const settings = { input, output };
    const answer = async (prompt: Promise<unknown> | unknown): Promise<any> => {
      const result = await prompt;
      return ui.isCancel(result) ? undefined : result;
    };
    return {
      print,
      close() {},
      hosts: (options: PromptOption[], defaults: string[]) =>
        answer(
          ui.multiselect({
            ...settings,
            message: '选择宿主（↑↓ 移动，空格勾选，Enter 确认）',
            options,
            initialValues: defaults,
            required: true,
            showInstructions: false,
          }),
        ),
      select: (message: string, options: PromptOption[], initialValue?: string) =>
        answer(ui.select({ ...settings, message, options, initialValue })),
      yesNo: (message: string, initialValue?: boolean) =>
        answer(ui.confirm({ ...settings, message, initialValue, active: '是', inactive: '否' })),
      text: (message: string, { initialValue, validate }: TextOptions = {}) =>
        answer(
          ui.text({
            ...settings,
            message,
            initialValue,
            validate: (value: string | undefined) => validate?.((value ?? '').trim()) as string | undefined,
          }),
        ).then((value: string | undefined) => value?.trim()),
    };
  }

  const rl = createInterface({ input, output, terminal: Boolean(input.isTTY && output.isTTY) });
  const lines = rl[Symbol.asyncIterator]();
  rl.on('SIGINT', () => rl.close());
  async function read<T>(message: string, parse: (value: string) => T | undefined): Promise<T | undefined> {
    while (true) {
      print(message);
      const reply = await lines.next();
      if (reply.done) return;
      const value = parse(reply.value.trim());
      if (value !== undefined) return value;
      print('输入无效，请重试。');
    }
  }
  return {
    print,
    close: () => rl.close(),
    hosts(options: PromptOption[], defaults: string[]) {
      options.forEach(({ label, hint }, i) => print(`  ${i + 1}. ${label}（${hint}）`));
      return read<string[]>(`选择宿主 [${defaults.join(',')}]，可输入多个名称或编号，0 取消。`, (answer: string) => {
        if (answer === '0') return [];
        if (!answer && defaults.length) return defaults;
        const values = answer
          .toLowerCase()
          .split(/[,，\s]+/)
          .filter(Boolean)
          .map((item) => options.find((o, i) => o.value === item || String(i + 1) === item)?.value);
        if (values.length && values.every(Boolean)) return [...new Set(values)] as string[];
      });
    },
    select(message: string, options: PromptOption[], initialValue?: string) {
      return read<string>(
        message + ' ' + options.map((o) => o.value + ' ' + o.label).join('，') + '。',
        (value) => options.find((o) => o.value === (value || initialValue))?.value,
      );
    },
    yesNo(message: string, initialValue?: boolean) {
      return read<boolean>(message + (initialValue ? ' [Y/n]' : ' [y/N]'), (value: string) => {
        if (!value) return initialValue;
        if (/^(y|yes|是)$/i.test(value)) return true;
        if (/^(n|no|否)$/i.test(value)) return false;
      });
    },
    text(message: string, { initialValue = '', validate }: TextOptions = {}) {
      return read<string>(message, (value: string) => (validate?.(value || initialValue) ? undefined : value || initialValue));
    },
  };
}
