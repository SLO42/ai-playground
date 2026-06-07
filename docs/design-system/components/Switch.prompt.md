Controlled boolean toggle — feature-flag page visibility, opt-in periodic mode, per-gate enable.

```jsx
<Switch checked={periodic} onChange={setPeriodic} label="Periodic mode" />
<Switch checked={flag} onChange={setFlag} label="/workflows" disabled />
```

Keyboard operable (Space/Enter), `role="switch"`. Calls `onChange(next)`.
