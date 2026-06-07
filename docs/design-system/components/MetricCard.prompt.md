Single KPI tile for the home/portfolio overview. Honest states: pass `value={null}` to render "unknown" instead of a fake number; `loading` shows a placeholder.

```jsx
<MetricCard label="Active projects" value={12} />
<MetricCard label="Running agents" value={3} delta="2" deltaDir="up" />
<MetricCard label="Today's cost" value="4.21" unit="$" />
<MetricCard label="p95 duration" value={null} />   {/* renders "unknown" */}
```
