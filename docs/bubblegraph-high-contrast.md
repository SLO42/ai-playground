# BubbleGraph High-Contrast Mode

The `BubbleGraph` component supports the `prefers-contrast: more` media query for users who need enhanced visual distinction between elements.

## How It Works

The component uses a CSS custom property (`--node-fill`) for circle fill colors instead of an inline SVG `fill` attribute. This allows the `@media (prefers-contrast: more)` block to override styles via CSS, which would otherwise be impossible since SVG attributes take precedence over CSS properties.

### Base rendering

Each node circle receives its category color through an inline style:

```svelte
<circle
  cx={pos.x}
  cy={pos.y}
  r={r}
  fill-opacity="0.85"
  class="node-circle"
  style="--node-fill: {getColor(node.category)}"
/>
```

The base CSS applies the color:

```css
.node-circle {
  fill: var(--node-fill);
}
```

### High-contrast overrides

When the user's OS or browser requests increased contrast, the following adjustments are applied automatically:

```css
@media (prefers-contrast: more) {
  /* Reduce bubble opacity so text stands out */
  .node-circle {
    opacity: 0.4;
    stroke-width: 2.5;
  }

  /* Brighten labels for maximum readability */
  .node-label {
    fill: #ffffff;
    font-weight: bold;
  }

  /* Lighten detail text */
  .node-detail {
    fill: #cbd5e1;
  }

  /* Stronger focus ring for keyboard navigation */
  .focus-ring {
    stroke: #ffffff;
    stroke-width: 3;
  }
}
```

## Props

| Prop | Type | Description |
|------|------|-------------|
| `nodes` | `GraphNode[]` | Array of nodes to render (sized by `pageRank`) |
| `edges` | `GraphEdge[]` | Optional array of connections between nodes |
| `onNodeClick` | `(id: string) => void` | Optional click handler for node selection |
| `ariaLabel` | `string` | Optional custom ARIA label for the SVG |

## Testing High-Contrast Mode

### Browser DevTools

1. Open Chrome/Edge DevTools
2. Open the **Rendering** tab (three-dot menu > More tools > Rendering)
3. Scroll to **Emulate CSS media feature prefers-contrast**
4. Select **more**

### OS-level settings

- **Windows**: Settings > Accessibility > Contrast themes > select a high-contrast theme
- **macOS**: System Settings > Accessibility > Display > Increase contrast
- **Linux (GNOME)**: Settings > Accessibility > High Contrast

## Customizing High-Contrast Colors

To override the default high-contrast styles in your own theme, target the component's classes within a `prefers-contrast: more` media query:

```css
@media (prefers-contrast: more) {
  .node-circle {
    opacity: 0.5;          /* adjust bubble transparency */
    stroke: #000000;       /* add dark outline */
    stroke-width: 3;
  }

  .node-label {
    fill: #ffff00;         /* high-visibility yellow */
  }
}
```

Note: Because the fill color uses the `--node-fill` CSS custom property, you can also override individual node colors by setting `--node-fill` in a higher-specificity rule or directly in the media query.
