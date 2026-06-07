Canonical status pill — pass a data-model enum and it maps to the right color role, humanised label, and a pulsing live-dot for active states. Status is never color-only.

```jsx
<StatusBadge status="in_progress" />   {/* running tone + live dot */}
<StatusBadge status="blocked" />       {/* its own blocked role */}
<StatusBadge status="done" />
<StatusBadge status="critical" />      {/* security severity */}
```

Covers task / session / service / release / phase / feature / severity enums. Use plain `Badge` for non-enum labels.
