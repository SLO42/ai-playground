Icon-only square control — toolbar actions, row actions, session controls (interject/stop/resume). Always pass `label` for accessibility.

```jsx
<IconButton label="Stop agent" onClick={stop}><SquareIcon/></IconButton>
<IconButton label="Pin tray" active={pinned} variant="solid"><PinIcon/></IconButton>
```

`active` renders the toggled accent state. `variant="solid"` gives it a bordered surface (use in dense toolbars).
