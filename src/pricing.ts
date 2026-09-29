// What a shared-bike rental costs, from the operator's GBFS pricing plan. No imports,
// so it can be checked in Node.

export interface PricingPlan {
  plan_id: string; name: string | { text: string; language: string }[]; currency: string; price: number;
  per_min_pricing?: { start: number; interval: number; rate: number; end?: number }[];
}

// The price after `minutes` of riding: the plan's starting price, then each segment's
// rate for every interval begun in it. The first segment always applies; a later one
// only once its start has passed.
export function rentalCost(plan: PricingPlan | undefined, minutes: number) {
  if (!plan) return 0;
  let sum = plan.price;
  (plan.per_min_pricing || []).forEach((seg, i) => {
    if (i > 0 && !(minutes > seg.start)) return;
    if (seg.interval > 0) sum += seg.rate * Math.max(1, Math.ceil((Math.min(minutes, seg.end ?? Infinity) - seg.start) / seg.interval));
    else sum += seg.rate;
  });
  return Math.round(sum);
}
