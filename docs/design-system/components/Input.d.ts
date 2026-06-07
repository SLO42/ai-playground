import React from 'react';

export interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  /** Field label rendered above the control. */
  label?: string;
  /** Subtle hint appended to the label (e.g. "optional"). */
  hint?: string;
  /** Error message — also turns the border red + sets aria-invalid. */
  error?: string;
  /** Monospace input (paths, ids, commands, SurrealQL). */
  mono?: boolean;
  /** Render a <textarea> instead of <input>. */
  multiline?: boolean;
  /** Textarea rows when multiline. @default 3 */
  rows?: number;
}

/** Text field; mono variant for paths/ids/queries. Quotes the real error message. */
export function Input(props: InputProps): JSX.Element;
