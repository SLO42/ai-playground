Action control for the operator — verb+object, sentence-case labels ("Start run", "Stop agent", "Save config"), never "OK / Submit".

```jsx
<Button variant="primary" onClick={startRun}>Start run</Button>
<Button variant="secondary" icon={<PlayIcon/>}>Resume</Button>
<Button variant="danger" size="sm">Stop agent</Button>
<Button variant="ghost" disabled>Save config</Button>
```

Variants: `primary` (accent fill — the one main action), `secondary` (bordered, default), `ghost` (text-only, toolbar/inline), `danger` (destructive — pair with a confirm). Sizes `sm | md | lg`. Pass `icon` / `iconRight` as SVG nodes.
