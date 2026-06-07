Surface container with optional header. Don't nest cards — flatten with spacing/dividers (UI-SPEC §9 density).

```jsx
<Card title="Sessions" actions={<IconButton label="Refresh"><RefreshIcon/></IconButton>}>
  …rows…
</Card>
<Card interactive padded onClick={open}>Project: swip</Card>
```
