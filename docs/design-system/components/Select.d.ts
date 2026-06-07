import React from 'react';

export interface SelectOption {
  value: string;
  label: string;
}

export interface SelectProps extends Omit<React.SelectHTMLAttributes<HTMLSelectElement>, 'onChange'> {
  /** Field label rendered above the control. */
  label?: string;
  /** Options — strings or {value,label} objects. */
  options: Array<string | SelectOption>;
  value?: string;
  onChange?: React.ChangeEventHandler<HTMLSelectElement>;
}

/** Styled native select (model slot, orchestration mode, provider, project scope). */
export function Select(props: SelectProps): JSX.Element;
