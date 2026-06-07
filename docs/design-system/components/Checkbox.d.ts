export interface CheckboxProps {
  checked?: boolean;
  onChange?: (next: boolean) => void;
  label?: string;
  disabled?: boolean;
  id?: string;
}

/** Boolean checkbox with inline label (controlled) — filters, multi-select rows. */
export function Checkbox(props: CheckboxProps): JSX.Element;
