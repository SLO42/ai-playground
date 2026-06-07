import React from 'react';

export interface AvatarProps extends React.HTMLAttributes<HTMLSpanElement> {
  /** Person name — initials are derived from it. */
  name?: string;
  /** Image URL (overrides initials). */
  src?: string;
  /** Render as an agent-tier square tinted by tier instead of a round avatar. */
  tier?: 'local' | 'haiku' | 'sonnet' | 'opus';
  /** @default "md" */
  size?: 'sm' | 'md' | 'lg';
}

/** Round operator avatar (initials/image) or a square agent-tier marker. */
export function Avatar(props: AvatarProps): JSX.Element;
