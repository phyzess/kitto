import type { PlanChoice, PlanQuestion } from './task-route-plan.ts';
import type { RouteRef } from '../types/kitto.d.ts';

interface RouteQuestionOption {
  label: string;
  description: string;
  choice: RouteRef | 'defer';
}

export interface RouteQuestion {
  id: string;
  header: string;
  question: string;
  options: RouteQuestionOption[];
}

function label(option: PlanChoice): string {
  const route = `${option.provider}/${option.model}`;
  const charge =
    option.billing === 'metered'
      ? option.estimateUsd === undefined
        ? 'metered · estimate required'
        : `metered · estimated $${option.estimateUsd}`
      : option.billing;
  return [route, charge, option.status !== 'ready' && option.reason].filter(Boolean).join(' · ');
}

export function routeQuestions(plan: { questions?: PlanQuestion[] } | null | undefined): RouteQuestion[] {
  return (plan?.questions ?? []).map(({ id, reason, options }) => {
    const eligible: RouteQuestionOption[] = (options ?? [])
      .filter((option) => option.status !== 'unavailable')
      .map((option) => ({
        label: label(option),
        description: `Upstream: ${option.upstream ?? 'unverified'}. Selection does not authorize dispatch.`,
        choice: { provider: option.provider, model: option.model },
      }));
    return {
      id,
      header: id.slice(0, 16),
      question: `Choose a route for ${id} (${reason}), or defer it.`,
      options: [...eligible, { label: 'Defer', description: 'Leave the role and its dependants pending.', choice: 'defer' }],
    };
  });
}
