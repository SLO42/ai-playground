import React from 'react';

export interface TagProps extends React.HTMLAttributes<HTMLSpanElement> {
  /** Optional leading icon node. */
  icon?: React.ReactNode;
  /** Show a remove (×) button and call this on click. */
  onRemove?: () => void;
  children?: React.ReactNode;
}

/** Monospace keyword chip — ecosystem badges, filters, MCP/skill ids. */
export function Tag(props: TagProps): JSX.Element;
