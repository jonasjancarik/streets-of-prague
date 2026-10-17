// What a shared-bike rental costs, from the operator's GBFS pricing plan. No imports,
// so it can be checked in Node.

export interface PricingPlan {
  plan_id: string; name: string | { text: string; language: string }[]; currency: string; price: number;
  per_min_pricing?: { start: number; interval: number; rate: number; end?: number }[];
}

const nonnegative = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;

// The price after `minutes` of riding: the plan's starting price, then each segment's
// rate for every interval begun in it. The first segment always applies; a later one
// only once its start has passed.
export function rentalCost(plan: PricingPlan | undefined, minutes: number) {
  if (plan === undefined) return 0;
  if (!plan || !nonnegative(plan.price) || !nonnegative(minutes)) return NaN;
  const segments = plan.per_min_pricing === undefined ? [] : plan.per_min_pricing;
  if (!Array.isArray(segments) || segments.some((seg) => !seg || !nonnegative(seg.start) || !nonnegative(seg.interval) || !nonnegative(seg.rate)
      || (seg.end !== undefined && (!nonnegative(seg.end) || seg.end < seg.start)))) return NaN;
  let sum = plan.price;
  segments.forEach((seg, i) => {
    if (i > 0 && !(minutes > seg.start)) return;
    if (seg.interval > 0) sum += seg.rate * Math.max(1, Math.ceil((Math.min(minutes, seg.end ?? Infinity) - seg.start) / seg.interval));
    else sum += seg.rate;
  });
  return Number.isFinite(sum) ? Math.round(sum) : NaN;
}
