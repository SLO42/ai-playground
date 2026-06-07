import React from 'react';

export type BadgeTone =
  | 'running' | 'success' | 'warn' | 'error' | 'info' | 'blocked' | 'neutral' | 'accent';

export interface BadgeProps extends React.HTMLAttributes<HTMLSpanElement> {
  /** Semantic color role. @default "neutral" */
  tone?: BadgeTone;
  /** @default "soft" */
  variant?: 'soft' | 'solid' | 'outline';
  /** Show a leading status dot. */
  dot?: boolean;
  children?: React.ReactNode;
}

/** Compact label tinted by status role. Prefer StatusBadge for data-model enums. */
export function Badge(props: BadgeProps): JSX.Element;
