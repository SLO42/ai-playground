<script lang="ts">
  /**
   * /claude-code — harness hub, v0.1 READ-ONLY config catalog (UI-SPEC §313).
   *
   * Lists the Claude Code config mirror per scope (hooks / skills / agents / MCP
   * servers) with each scope's synced / out-of-sync state (UI-SPEC §214). All data
   * is LIVE from the cc_* mirror (F-008 — no fabricated rows); honest empty states
   * when nothing is synced or the DB isn't connected yet. Svelte 5 runes only.
   */
  import { enhance } from '$app/forms';
  import { invalidate } from '$app/navigation';
  import { stream } from '$lib/client/stream.svelte';
  import type { PageData, ActionData } from './$types';

  let { data, form }: { data: PageData; form: ActionData } = $props();

  const scopes = $derived(data.scopes ?? []);
  const connected = $derived(data.connected);

  // The editor is a single shared panel; `editing` identifies which scope+kind it's open for
  // so only that scope's card shows the panel. The action phases (editing → confirming →
  // saved) flow through `form.edit` (D-010 diff-and-confirm).
  let editing = $state<{ scopeId: string; kind: string } | null>(null);

  // The `form.edit` action result is a union across loadFile/planEdit/applyEdit (+ their
  // fail returns). Narrow it ONCE here into a plain, fully-typed view the template reads —
  // so the markup never wrestles the union (D-010 phases: editing → confirming → saved).
  interface EditView {
    phase: 'editing' | 'confirming' | 'saved' | 'error';
    error?: string;
    issues?: Array<{ path: string; message: string }>;
    claudeDir?: string;
    kind?: string;
    filePath?: string;
    content?: string;
    bytesWritten?: number;
    status?: string;
    validation?: { ok: boolean; issues: Array<{ path: string; message: string }> };
    diff?: { unchanged: boolean; hunks: Array<{ op: string; line: string }> };
    confirmToken?: string;
  }
  const edit = $derived.by((): EditView | null => {
    const e = form?.edit as Record<string, unknown> | null | undefined;
    if (!e) return null;
    const out: EditView = { phase: 'editing' };
    if ('error' in e) out.phase = 'error';
    if (typeof e.phase === 'string') out.phase = e.phase as EditView['phase'];
    if (typeof e.error === 'string') out.error = e.error;
    if (Array.isArray(e.issues)) out.issues = e.issues as EditView['issues'];
    if (typeof e.claudeDir === 'string') out.claudeDir = e.claudeDir;
    if (typeof e.kind === 'string') out.kind = e.kind;
    if (typeof e.filePath === 'string') out.filePath = e.filePath;
    if (typeof e.content === 'string') out.content = e.content;
    if (typeof e.bytesWritten === 'number') out.bytesWritten = e.bytesWritten;
    if (typeof e.status === 'string') out.status = e.status;
    if (e.validation) out.validation = e.validation as EditView['validation'];
    if (e.diff) out.diff = e.diff as EditView['diff'];
    if (typeof e.confirmToken === 'string') out.confirmToken = e.confirmToken;
    return out;
  });

  // Live: a cc_* re-sync after an apply changes the catalog — re-invalidate so the synced
  // badge updates in place. The catalog isn't a watched table, so we re-run the loader on
  // any saved apply directly (below) AND on session/project changes the SSE already carries.
  $effect(() => {
    const off = stream.onDbChange('project', () => void invalidate(() => true));
    return off;
  });

  function statusLabel(s: string): string {
    if (s === 'synced') return 'synced';
    if (s === 'out_of_sync') return 'out of sync · edited on disk';
    return 'not synced';
  }

  // Which editable file kinds a scope offers (settings + the two siblings — the common set).
  const FILE_KINDS = [
    { kind: 'settings', label: 'settings.json' },
    { kind: 'claude_md', label: 'CLAUDE.md' },
    { kind: 'mcp_json', label: '.mcp.json' }
  ] as const;

  function openEditor(scopeId: string, kind: string): void {
    editing = { scopeId, kind };
  }
  function closeEditor(): void {
    editing = null;
  }
</script>

<section class="page">
  <header class="page-head">
    <span class="eyebrow">harness</span>
    <h1 class="title">Claude Code</h1>
    <p class="lede">
      Read-only catalog of the Claude Code config mirror — hooks, skills, agents,
      and MCP servers per scope. The filesystem is authoritative; this view mirrors
      <span class="mono">.claude/</span> + <span class="mono">.mcp.json</span> and
      flags drift when a file is edited on disk.
    </p>
  </header>

  {#if !connected}
    <div class="card empty">
      <span class="eyebrow">offline</span>
      <p class="card-body">
        The database is not connected — no mirror to read yet. Run a config sync
        once the runtime is wired.
      </p>
    </div>
  {:else if scopes.length === 0}
    <div class="card empty">
      <span class="eyebrow">empty</span>
      <p class="card-body">
        No config scopes synced yet. Sync a project's
        <span class="mono">.claude/</span> directory to populate the catalog.
      </p>
    </div>
  {:else}
    <div class="scopes">
      {#each scopes as scope (scope.scopeId)}
        <article class="card scope">
          <div class="scope-head">
            <div class="scope-id">
              <span class="kind mono">{scope.kind}</span>
              <span class="path mono" title={scope.path}>{scope.path}</span>
            </div>
            <span class="status status-{scope.status}">{statusLabel(scope.status)}</span>
          </div>

          <div class="catalog">
            <!-- Hooks -->
            <div class="cat">
              <div class="cat-head">
                <span class="eyebrow">hooks</span>
                <span class="count mono">{scope.hooks.length}</span>
              </div>
              {#if scope.hooks.length}
                <ul class="rows">
                  {#each scope.hooks as h (h.event + h.command)}
                    <li class="row">
                      <span class="tag mono">{h.event}</span>
                      {#if h.matcher}<span class="matcher mono">{h.matcher}</span>{/if}
                      <span class="cmd mono">{h.command}</span>
                    </li>
                  {/each}
                </ul>
              {:else}
                <p class="none">none</p>
              {/if}
            </div>

            <!-- Skills -->
            <div class="cat">
              <div class="cat-head">
                <span class="eyebrow">skills</span>
                <span class="count mono">{scope.skills.length}</span>
              </div>
              {#if scope.skills.length}
                <ul class="rows">
                  {#each scope.skills as k (k.file_path)}
                    <li class="row">
                      <span class="name mono">{k.name}</span>
                      {#if k.plugin}<span class="tag mono">{k.plugin}</span>{/if}
                      {#if k.description}<span class="desc">{k.description}</span>{/if}
                    </li>
                  {/each}
                </ul>
              {:else}
                <p class="none">none</p>
              {/if}
            </div>

            <!-- Agents -->
            <div class="cat">
              <div class="cat-head">
                <span class="eyebrow">agents</span>
                <span class="count mono">{scope.agents.length}</span>
              </div>
              {#if scope.agents.length}
                <ul class="rows">
                  {#each scope.agents as a (a.file_path)}
                    <li class="row">
                      <span class="name mono">{a.name}</span>
                      {#if a.category}<span class="tag mono">{a.category}</span>{/if}
                      {#if a.description}<span class="desc">{a.description}</span>{/if}
                    </li>
                  {/each}
                </ul>
              {:else}
                <p class="none">none</p>
              {/if}
            </div>

            <!-- MCP servers -->
            <div class="cat">
              <div class="cat-head">
                <span class="eyebrow">mcp servers</span>
                <span class="count mono">{scope.mcpServers.length}</span>
              </div>
              {#if scope.mcpServers.length}
                <ul class="rows">
                  {#each scope.mcpServers as m (m.name)}
                    <li class="row">
                      <span class="name mono">{m.name}</span>
                      <span class="tag mono">{m.type}</span>
                      <span class="cmd mono">{m.command ?? m.url ?? ''}</span>
                    </li>
                  {/each}
                </ul>
              {:else}
                <p class="none">none</p>
              {/if}
            </div>
          </div>

          <!-- Job 9: config edit (D-010 diff + confirm). Filesystem stays authoritative. -->
          {#if scope.kind === 'project' || scope.kind === 'global'}
            <div class="edit-bar">
              <span class="eyebrow">edit config</span>
              {#each FILE_KINDS as fk (fk.kind)}
                <form
                  method="POST"
                  action="?/loadFile"
                  use:enhance={() => {
                    openEditor(scope.scopeId, fk.kind);
                    return async ({ update }) => update({ reset: false });
                  }}
                >
                  <input type="hidden" name="kind" value={fk.kind} />
                  <input type="hidden" name="claudeDir" value={scope.path} />
                  <input type="hidden" name="scopeKind" value={scope.kind} />
                  {#if scope.project}<input type="hidden" name="project" value={scope.project} />{/if}
                  <button
                    class="edit-btn"
                    type="submit"
                    aria-pressed={editing?.scopeId === scope.scopeId && editing?.kind === fk.kind}
                    >{fk.label}</button
                  >
                </form>
              {/each}
            </div>

            {#if (editing?.scopeId === scope.scopeId) || (edit?.claudeDir === scope.path)}
              {@const k = edit?.kind ?? editing?.kind ?? 'settings'}
              <div class="editor" aria-label="config editor">
                <div class="editor-head">
                  <span class="mono">{k}</span>
                  {#if edit && 'filePath' in edit && edit.filePath}
                    <span class="path mono" title={edit.filePath}>{edit.filePath}</span>
                  {/if}
                  <button class="edit-btn" type="button" onclick={closeEditor}>close</button>
                </div>

                {#if edit?.error}
                  <p class="form-error" role="alert">{edit.error}</p>
                  {#if edit.issues}
                    <ul class="issues">
                      {#each edit.issues as iss (iss.path + iss.message)}
                        <li class="mono"><b>{iss.path}</b> — {iss.message}</li>
                      {/each}
                    </ul>
                  {/if}
                {/if}

                {#if edit?.phase === 'saved'}
                  <p class="form-ok">
                    Config saved — {edit.bytesWritten} bytes · mirror {edit.status}
                  </p>
                {/if}

                <!-- The edit form: textarea content → planEdit (diff) → applyEdit (confirm). -->
                {#if edit && edit.phase !== 'saved'}
                  <form
                    method="POST"
                    action="?/planEdit"
                    use:enhance={() => async ({ update }) => update({ reset: false })}
                  >
                    <input type="hidden" name="kind" value={k} />
                    <input type="hidden" name="claudeDir" value={scope.path} />
                    <input type="hidden" name="scopeKind" value={scope.kind} />
                    {#if scope.project}<input type="hidden" name="project" value={scope.project} />{/if}
                    {#if edit.filePath}<input type="hidden" name="filePath" value={edit.filePath} />{/if}
                    <textarea class="editor-area mono" name="content" rows="12">{edit.content ?? ''}</textarea>
                    <div class="editor-actions">
                      <button class="edit-btn primary" type="submit">Review diff</button>
                    </div>
                  </form>
                {/if}

                <!-- The confirm step: show the diff + a confirm button bound to the token. -->
                {#if edit?.phase === 'confirming' && edit.diff && edit.validation}
                  <div class="diff" aria-label="config diff">
                    {#if edit.diff.unchanged}
                      <p class="state-body">No changes — the proposed content matches disk.</p>
                    {:else}
                      <pre class="diff-pre mono">{#each edit.diff.hunks as h, i (i)}<span
                            class="hunk"
                            data-op={h.op}>{h.op} {h.line}
</span>{/each}</pre>
                    {/if}
                  </div>
                  {#if !edit.validation.ok}
                    <p class="form-error" role="alert">
                      Validation failed — fix the issues before saving:
                    </p>
                    <ul class="issues">
                      {#each edit.validation.issues as iss (iss.path + iss.message)}
                        <li class="mono"><b>{iss.path}</b> — {iss.message}</li>
                      {/each}
                    </ul>
                  {/if}
                  <form
                    method="POST"
                    action="?/applyEdit"
                    use:enhance={() => async ({ update }) => update({ reset: false })}
                  >
                    <input type="hidden" name="kind" value={k} />
                    <input type="hidden" name="claudeDir" value={scope.path} />
                    <input type="hidden" name="scopeKind" value={scope.kind} />
                    {#if scope.project}<input type="hidden" name="project" value={scope.project} />{/if}
                    {#if edit.filePath}<input type="hidden" name="filePath" value={edit.filePath} />{/if}
                    <input type="hidden" name="content" value={edit.content ?? ''} />
                    <input type="hidden" name="confirmToken" value={edit.confirmToken ?? ''} />
                    <div class="editor-actions">
                      <button
                        class="edit-btn primary"
                        type="submit"
                        disabled={!edit.validation.ok || edit.diff.unchanged}>Confirm &amp; save</button
                      >
                    </div>
                  </form>
                {/if}
              </div>
            {/if}
          {/if}
        </article>
      {/each}
    </div>
  {/if}
</section>

<style>
  .page {
    display: flex;
    flex-direction: column;
    gap: var(--gap-stack);
    max-width: 980px;
  }
  .page-head {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }
  .title {
    font: var(--type-h1);
    color: var(--color-text);
  }
  .lede {
    font: var(--type-body);
    color: var(--color-text-muted);
    max-width: 70ch;
  }
  .mono {
    font-family: var(--font-mono, ui-monospace, monospace);
  }
  .card {
    background: var(--color-surface-card);
    border: var(--border-width, 1px) solid var(--color-border);
    border-radius: var(--radius-md, 10px);
    box-shadow: var(--shadow-card);
    padding: var(--pad-card, 1rem);
  }
  .empty {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }
  .card-body {
    font: var(--type-body-sm);
    color: var(--color-text-2);
  }
  .scopes {
    display: flex;
    flex-direction: column;
    gap: var(--space-4, 1rem);
  }
  .scope {
    display: flex;
    flex-direction: column;
    gap: var(--space-4, 1rem);
  }
  .scope-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-3, 0.75rem);
    flex-wrap: wrap;
  }
  .scope-id {
    display: flex;
    align-items: baseline;
    gap: var(--space-3, 0.75rem);
    min-width: 0;
  }
  .kind {
    font-size: 0.72rem;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--color-accent);
  }
  .path {
    font-size: 0.8rem;
    color: var(--color-text-2);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  /* Sync-state chips (UI-SPEC §214). */
  .status {
    font-size: 0.72rem;
    font-weight: 600;
    padding: 0.15rem 0.55rem;
    border-radius: var(--radius-sm, 6px);
    white-space: nowrap;
  }
  .status-synced {
    color: var(--color-success);
    background: var(--color-success-bg);
  }
  .status-out_of_sync {
    color: var(--color-warn);
    background: var(--color-warn-bg);
  }
  .status-unsynced {
    color: var(--color-blocked);
    background: var(--color-blocked-bg);
  }
  .catalog {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
    gap: var(--space-4, 1rem);
  }
  .cat {
    display: flex;
    flex-direction: column;
    gap: var(--space-2, 0.5rem);
    min-width: 0;
  }
  .cat-head {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    border-bottom: 1px solid var(--color-border-faint, var(--color-border));
    padding-bottom: var(--space-1, 0.25rem);
  }
  .count {
    font-size: 0.75rem;
    color: var(--color-text-muted);
  }
  .rows {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: var(--space-1, 0.25rem);
  }
  .row {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 0.4rem;
    font-size: 0.78rem;
    padding: 0.25rem 0.4rem;
    border-radius: var(--radius-sm, 6px);
    background: var(--color-surface-overlay);
    min-width: 0;
  }
  .name {
    color: var(--color-text);
    font-weight: 500;
  }
  .tag {
    font-size: 0.68rem;
    color: var(--color-accent);
    background: var(--color-accent-muted, transparent);
    padding: 0.05rem 0.35rem;
    border-radius: var(--radius-sm, 6px);
  }
  .matcher {
    font-size: 0.7rem;
    color: var(--color-text-2);
  }
  .cmd {
    font-size: 0.72rem;
    color: var(--color-text-muted);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
    flex: 1 1 auto;
  }
  .desc {
    font-size: 0.72rem;
    color: var(--color-text-muted);
    flex: 1 1 100%;
  }
  .none {
    font-size: 0.75rem;
    color: var(--color-text-muted);
    font-style: italic;
  }

  /* ── Job-9 config editor (D-010 diff + confirm) ──────────────────────────── */
  .edit-bar {
    display: flex;
    align-items: center;
    gap: var(--space-2, 0.5rem);
    flex-wrap: wrap;
    border-top: 1px solid var(--color-border-faint, var(--color-border));
    padding-top: var(--space-3, 0.75rem);
  }
  .edit-bar form {
    display: contents;
  }
  .edit-btn {
    appearance: none;
    background: var(--color-surface-overlay);
    color: var(--color-text);
    border: var(--border-width, 1px) solid var(--color-border);
    border-radius: var(--radius-sm, 6px);
    font-size: 0.72rem;
    font-weight: 600;
    padding: 0.2rem 0.6rem;
    cursor: pointer;
    min-height: 24px;
  }
  .edit-btn:hover {
    background: var(--color-surface-card);
  }
  .edit-btn:focus-visible {
    outline: 2px solid var(--color-accent);
    outline-offset: 2px;
  }
  .edit-btn[aria-pressed='true'] {
    border-color: var(--color-accent);
    color: var(--color-accent);
  }
  .edit-btn.primary {
    background: var(--color-accent);
    color: var(--color-text-inverse, var(--color-bg, #03120e));
    border-color: var(--color-accent);
  }
  .edit-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
  .editor {
    display: flex;
    flex-direction: column;
    gap: var(--space-2, 0.5rem);
    border: var(--border-width, 1px) solid var(--color-border);
    border-radius: var(--radius-sm, 6px);
    padding: var(--space-3, 0.75rem);
    background: var(--color-surface-overlay);
  }
  .editor-head {
    display: flex;
    align-items: center;
    gap: var(--space-2, 0.5rem);
  }
  .editor-head .path {
    flex: 1 1 auto;
    min-width: 0;
    font-size: 0.72rem;
    color: var(--color-text-muted);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .editor-area {
    width: 100%;
    box-sizing: border-box;
    resize: vertical;
    background: var(--color-bg, #03120e);
    color: var(--color-text);
    border: var(--border-width, 1px) solid var(--color-border);
    border-radius: var(--radius-sm, 6px);
    padding: 0.6rem 0.7rem;
    font-size: 0.78rem;
    line-height: 1.4;
  }
  .editor-area:focus-visible {
    outline: 2px solid var(--color-accent);
    outline-offset: 1px;
  }
  .editor-actions {
    display: flex;
    gap: var(--space-2, 0.5rem);
    margin-top: var(--space-2, 0.5rem);
  }
  .diff {
    max-height: 18rem;
    overflow: auto;
    border: var(--border-width, 1px) solid var(--color-border);
    border-radius: var(--radius-sm, 6px);
    background: var(--color-bg, #03120e);
  }
  .diff-pre {
    margin: 0;
    padding: 0.5rem 0.7rem;
    font-size: 0.76rem;
    line-height: 1.4;
    white-space: pre-wrap;
    word-break: break-word;
  }
  .hunk[data-op='+'] {
    color: var(--color-success, #6fae6f);
  }
  .hunk[data-op='-'] {
    color: var(--color-error, var(--color-danger, crimson));
  }
  .hunk[data-op=' '] {
    color: var(--color-text-muted);
  }
  .issues {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.2rem;
    font-size: 0.74rem;
    color: var(--color-error, var(--color-danger, crimson));
  }
  .form-error {
    font: var(--type-body-sm);
    color: var(--color-error, var(--color-danger, crimson));
  }
  .form-ok {
    font: var(--type-body-sm);
    color: var(--color-success, var(--color-running, var(--color-accent)));
  }
  .state-body {
    font: var(--type-body-sm);
    color: var(--color-text-2);
  }
</style>
