import { createInterface } from 'node:readline';

export async function setupPrompts(input, output) {
  const print = message => output.write(message + '\n');
  if (input.isTTY && output.isTTY && typeof input.setRawMode === 'function') {
    const ui = await import('@clack/prompts');
    const settings = { input, output };
    const answer = async prompt => {
      const result = await prompt;
      return ui.isCancel(result) ? undefined : result;
    };
    return {
      print,
      close() {},
      hosts: (options, defaults) => answer(ui.multiselect({
        ...settings, message: '选择宿主（↑↓ 移动，空格勾选，Enter 确认）', options,
        initialValues: defaults, required: true, showInstructions: false,
      })),
      select: (message, options, initialValue) => answer(ui.select({ ...settings, message, options, initialValue })),
      yesNo: (message, initialValue) => answer(ui.confirm({ ...settings, message, initialValue, active: '是', inactive: '否' })),
      text: (message, { initialValue, validate } = {}) => answer(ui.text({
        ...settings, message, initialValue, validate: value => validate?.((value ?? '').trim()),
      })).then(value => value?.trim()),
    };
  }

  const rl = createInterface({ input, output, terminal: Boolean(input.isTTY && output.isTTY) });
  const lines = rl[Symbol.asyncIterator]();
  rl.on('SIGINT', () => rl.close());
  async function read(message, parse) {
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
    hosts(options, defaults) {
      options.forEach(({ label, hint }, i) => print(`  ${i + 1}. ${label}（${hint}）`));
      return read(`选择宿主 [${defaults.join(',')}]，可输入多个名称或编号，0 取消。`, answer => {
        if (answer === '0') return [];
        if (!answer && defaults.length) return defaults;
        const values = answer.toLowerCase().split(/[,，\s]+/).filter(Boolean)
          .map(item => options.find((o, i) => o.value === item || String(i + 1) === item)?.value);
        if (values.length && values.every(Boolean)) return [...new Set(values)];
      });
    },
    select(message, options, initialValue) {
      return read(message + ' ' + options.map(o => o.value + ' ' + o.label).join('，') + '。', value =>
        options.find(o => o.value === (value || initialValue))?.value);
    },
    yesNo(message, initialValue) {
      return read(message + (initialValue ? ' [Y/n]' : ' [y/N]'), value => {
        if (!value) return initialValue;
        if (/^(y|yes|是)$/i.test(value)) return true;
        if (/^(n|no|否)$/i.test(value)) return false;
      });
    },
    text(message, { initialValue = '', validate } = {}) {
      return read(message, value => validate?.(value || initialValue) ? undefined : value || initialValue);
    },
  };
}
