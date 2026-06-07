import React from 'react';

/**
 * Props for a single KPI tile.
 * @startingPoint section="Components" subtitle="Portfolio KPI tile with honest states" viewport="700x150"
 */
export interface MetricCardProps extends React.HTMLAttributes<HTMLDivElement> {
  /** KPI label (e.g. "Today's cost"). */
  label: string;
  /** Leading icon node. */
  icon?: React.ReactNode;
  /** The value. Pass null/undefined to render the honest "unknown" state. */
  value?: React.ReactNode | null;
  /** Unit suffix (e.g. "$", "ms", "tok"). */
  unit?: string;
  /** Optional delta string (e.g. "12%"). */
  delta?: string;
  /** @default "flat" */
  deltaDir?: 'up' | 'down' | 'flat';
  /** Show a skeleton/placeholder instead of a value. */
  loading?: boolean;
}

/**
 * Single KPI with honest states — renders "unknown" rather than a fabricated
 * number when value is null (UI-SPEC §1.3 / F-008).
 */
export function MetricCard(props: MetricCardProps): JSX.Element;
