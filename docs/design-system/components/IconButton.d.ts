import React from 'react';

export interface IconButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  /** @default "ghost" */
  variant?: 'ghost' | 'solid';
  /** @default "md" */
  size?: 'sm' | 'md';
  /** Toggled/active state (e.g. a pinned panel). */
  active?: boolean;
  /** Accessible label — REQUIRED (icon-only control). */
  label: string;
  /** The icon node (SVG). */
  children: React.ReactNode;
}

/** Icon-only square control for toolbars, table rows, session controls. */
export function IconButton(props: IconButtonProps): JSX.Element;
