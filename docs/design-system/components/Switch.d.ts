export interface SwitchProps {
  /** Controlled on/off state. */
  checked?: boolean;
  /** Called with the next boolean value. */
  onChange?: (next: boolean) => void;
  /** Inline label shown beside the track. */
  label?: string;
  disabled?: boolean;
  id?: string;
}

/** Boolean toggle (controlled) — feature flags, periodic mode, gate enable. */
export function Switch(props: SwitchProps): JSX.Element;
