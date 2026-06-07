Underline tab strip (controlled), arrow-key operable. Project tabs (Overview · Tasks · Roadmap · …) and page sub-navigation.

```jsx
const [tab, setTab] = React.useState('overview');
<Tabs value={tab} onChange={setTab} tabs={[
  {value:'overview', label:'Overview'},
  {value:'tasks', label:'Tasks', count:12},
  {value:'sessions', label:'Sessions'},
]} />
```
