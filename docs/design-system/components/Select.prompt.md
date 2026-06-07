Styled native select — model slots, orchestration mode, provider/project scope pickers.

```jsx
<Select label="Orchestration mode" value={mode} onChange={e => setMode(e.target.value)}
  options={['event', 'periodic', 'manual']} />
<Select label="Model slot" options={[{value:'opus', label:'Opus 4.x'}, {value:'sonnet', label:'Sonnet'}]} />
```

Options accept bare strings or `{value, label}`.
