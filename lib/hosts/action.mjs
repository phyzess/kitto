const nothing = async () => {};

export function hostAction(host, kind, description, { phase, apply, preview = nothing }) {
  return { host, kind, phase, describe: () => description, preview, apply };
}

export const noteAction = (host, message) => hostAction(host, 'note', message, {
  apply: async () => console.log(message),
  preview: async ({ announce = true } = {}) => { if (announce) console.log(message); },
});
