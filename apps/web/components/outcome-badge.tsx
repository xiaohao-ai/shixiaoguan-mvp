import type { DecisionOutcome } from "@/lib/types";
import { outcomeMeta } from "@/lib/presentation";

export function OutcomeBadge({
  outcome,
  compact = false,
}: {
  outcome?: DecisionOutcome | string;
  compact?: boolean;
}) {
  const known = outcome && outcome in outcomeMeta ? (outcome as DecisionOutcome) : undefined;
  if (!known) return <span className="outcome-badge outcome-badge--pending">等待决策</span>;
  const meta = outcomeMeta[known];
  return (
    <span className={`outcome-badge outcome-badge--${meta.tone}`}>
      {compact ? meta.short : meta.label}
    </span>
  );
}
