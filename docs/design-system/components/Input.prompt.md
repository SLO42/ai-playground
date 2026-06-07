Text field with optional label, hint, and error. Use `mono` for paths, record ids, commands, SurrealQL.

```jsx
<Input label="Code root" placeholder="F:/code" mono />
<Input label="Test command" hint="optional" defaultValue="npm test" mono />
<Input label="Version" error="Couldn't parse. Use semver (v0.2.1)." defaultValue="v0..2" />
<Input multiline label="Task description" rows={4} />
```

Without `label`/`error` it renders a bare control you can place anywhere. Errors follow `[what]. [cause]. [recovery]`.
