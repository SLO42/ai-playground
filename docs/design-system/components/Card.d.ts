import React from 'react';

export interface CardProps extends React.HTMLAttributes<HTMLDivElement> {
  /** Header title. When set (or actions set), renders a header + padded body. */
  title?: React.ReactNode;
  /** Header actions (right-aligned) — e.g. IconButtons. */
  actions?: React.ReactNode;
  /** Hover affordance for clickable cards (project cards, session rows). */
  interactive?: boolean;
  /** Pad the body when there is no header. */
  padded?: boolean;
  children?: React.ReactNode;
}

/** Surface container. Flatten — don't nest cards (UI-SPEC density rule). */
export function Card(props: CardProps): JSX.Element;
