import React from 'react';

/**
 * Props for the primary action control.
 * @startingPoint section="Components" subtitle="Buttons, inputs, selects, switches" viewport="700x340"
 */
export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  /** Visual emphasis. @default "secondary" */
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
  /** @default "md" */
  size?: 'sm' | 'md' | 'lg';
  /** Leading icon node (e.g. a Lucide <svg>). */
  icon?: React.ReactNode;
  /** Trailing icon node. */
  iconRight?: React.ReactNode;
  children?: React.ReactNode;
}

/**
 * Primary action control. Verb+object labels, sentence case ("Start run").
 */
export function Button(props: ButtonProps): JSX.Element;
