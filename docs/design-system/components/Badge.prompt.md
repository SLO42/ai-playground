Compact tinted label. For data-model status enums, prefer `StatusBadge` (it maps the enum for you). Use `Badge` for free-form tags like counts or severities.

```jsx
<Badge tone="accent" variant="soft">12 open</Badge>
<Badge tone="error" variant="outline" dot>critical</Badge>
<Badge tone="info" variant="solid">new</Badge>
```

Tones: running/success/warn/error/info/blocked/neutral/accent. Variants: soft (tinted bg), solid (filled), outline.
