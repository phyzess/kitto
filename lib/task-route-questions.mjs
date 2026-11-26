function label(option) {
  const route = `${option.provider}/${option.model}`;
  const charge = option.billing === 'metered' ? (option.estimateUsd === undefined ? 'metered · estimate required' :
    `metered · estimated $${option.estimateUsd}`) : option.billing;
  return [route, charge, option.status !== 'ready' && option.reason].filter(Boolean).join(' · ');
}

/** Native presenters receive one group per unresolved role; a response is a preference, not approval. */
export function routeQuestions(plan) {
  return (plan?.questions ?? []).map(({ id, reason, options }) => ({ id, header: id.slice(0, 16),
    question: `Choose a route for ${id} (${reason}), or defer it.`,
    options: options.filter(option => option.status !== 'unavailable').map(option => ({
      label: label(option), description: `Upstream: ${option.upstream ?? 'unverified'}. Selection does not authorize dispatch.`,
      choice: { provider: option.provider, model: option.model },
    })).concat({ label: 'Defer', description: 'Leave the role and its dependants pending.', choice: 'defer' }),
  }));
}
