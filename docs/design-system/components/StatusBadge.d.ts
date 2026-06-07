import React from 'react';

export type EntityStatus =
  | 'backlog' | 'ready' | 'in_progress' | 'review' | 'blocked' | 'done' | 'failed'
  | 'running' | 'cancelled'
  | 'stopped' | 'crashed' | 'unknown'
  | 'planned' | 'active' | 'shipped'
  | 'todo' | 'dropped'
  | 'low' | 'medium' | 'high' | 'critical';

export interface StatusBadgeProps {
  /** A DATA-MODEL enum value — mapped to color role + label + (live) dot. */
  status: EntityStatus | string;
  /** @default "soft" */
  variant?: 'soft' | 'solid' | 'outline';
  /** Override the displayed label (defaults to a humanised enum). */
  label?: string;
}

/**
 * Status pill bound to the data-model enums — color is always paired with a word
 * (and a pulsing dot for live states). The canonical way to render entity status.
 */
export function StatusBadge(props: StatusBadgeProps): JSX.Element;
