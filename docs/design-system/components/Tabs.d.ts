export interface TabItem {
  value: string;
  label: string;
  /** Optional count shown after the label (e.g. open-task count). */
  count?: number;
}

export interface TabsProps {
  /** Tabs — strings or {value,label,count} objects. */
  tabs: Array<string | TabItem>;
  /** Active tab value (controlled). */
  value: string;
  onChange?: (value: string) => void;
  className?: string;
}

/** Underline tab strip with roving arrow-key nav — project tabs, page sub-nav. */
export function Tabs(props: TabsProps): JSX.Element;
