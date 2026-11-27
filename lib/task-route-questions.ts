import type { Json } from '../types/kitto.d.ts';

function label(option: Json): string {
  const route = `${option.provider}/${option.model}`;
  const charge = option.billing === 'metered' ? (option.estimateUsd === undefined ? 'metered · estimate required' :
    `metered · estimated $${option.estimateUsd}`) : option.billing;
  return [route, charge, option.status !== 'ready' && option.reason].filter(Boolean).join(' · ');
}

export function routeQuestions(plan: Json | null | undefined): Json[] {
  return (plan?.questions ?? []).map(({ id, reason, options }: Json) => ({ id, header: id.slice(0, 16),
    question: `Choose a route for ${id} (${reason}), or defer it.`,
    options: options.filter((option: Json) => option.status !== 'unavailable').map((option: Json) => ({
      label: label(option), description: `Upstream: ${option.upstream ?? 'unverified'}. Selection does not authorize dispatch.`,
      choice: { provider: option.provider, model: option.model },
    })).concat({ label: 'Defer', description: 'Leave the role and its dependants pending.', choice: 'defer' }),
  }));
}
