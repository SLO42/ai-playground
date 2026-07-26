/**
 * NAMING — one shared composer for every human-facing agent / session / role label.
 *
 * OPERATOR RULE (standing, 2026-07-26): *"our agents should have names that give clarity into
 * what they do and are. so the memory scene says agent sonnet 1, but that just tells me it uses
 * sonnet, not its purpose."* A display name that degrades to a MODEL TIER, a POOL-SLOT ORDINAL,
 * a repeated intent slug, or a RAW RECORD ID is a DEFECT of the same severity class as a
 * fabricated value under F-008.
 *
 * The named case: the memory scene rendered `agent:sonnet-1`. `sonnet-1` is a pool SLOT id
 * (`config/agent-pool.yaml` → `boot.ts` `agentForTier` → `launch.ts` `agent: input.agentId`) —
 * F-046 (a session-unique resource keyed by a pool/slot id) leaking into the UI. The slot id is
 * still USEFUL (it says which bucket ran the work) so it is kept — but DEMOTED to a trailing
 * QUALIFIER. It is never the identity.
 *
 * ── The shape ────────────────────────────────────────────────────────────────────────────
 *   `<identity> · <subject> · <qualifier>`
 *      identity  — WHO/WHAT it is:  role.name → role.slug → specialist → intent  (→ kind, last)
 *      subject   — WHAT it is doing: the task title
 *      qualifier — the demoted model / tier / slot id
 *
 * For the operator's live row (`sonnet-1 / code-write / "Unblock 1 stalled task(s)"`) that is:
 *      `code-write · Unblock 1 stalled task(s) · sonnet-1`
 *
 * ── Honesty (F-008) ──────────────────────────────────────────────────────────────────────
 * When NOTHING purposeful exists the composer returns an explicit PLACEHOLDER
 * (`unnamed session` / `unnamed agent` / `unnamed role`) — never an invented name, and never a
 * silent promotion of the qualifier into the identity slot. `describeName()` exposes
 * `isPlaceholder` so a renderer can style the honest-unknown state differently.
 *
 * ── Why `$lib/shared` ────────────────────────────────────────────────────────────────────
 * Both SERVER projections (scene / workforce / atelier / timeline) and `.svelte` CALL SITES
 * need the identical composition — a name that differs between the graph and the card is the
 * same defect wearing two faces. Pure, dependency-free, no runes: importable from either side.
 *
 * ── Shadow paths, all four, on every exported function ───────────────────────────────────
 *   • happy — real fields → composed name.
 *   • nil   — `null` / `undefined` input → the honest placeholder (never `"undefined"`, F-013).
 *   • empty — present-but-blank / whitespace-only fields → treated as absent, not rendered.
 *   • upstream error — a non-string (number, object, SurrealDB RecordId, Symbol) → coerced or
 *     rejected at the boundary; the composer NEVER throws and never emits `[object Object]`.
 */

/** The separator between the composed name parts. Middot + hair spacing reads as one name. */
const SEP = ' · ';

/**
 * A record-id tail that carries no human content: a SurrealDB auto-id / ULID — long, unbroken,
 * lower-alnum. `gq3glfee2zcw993suhto` matches; `hr-recruiter` and `probe_fit` do not.
 */
const OPAQUE_TAIL = /^[a-z0-9]{16,}$/;

/** An epoch-millisecond suffix minted by the role/gauntlet seeders: `probe_fit_1781894354268`. */
const EPOCH_SUFFIX = /_\d{10,}$/;

/**
 * Normalize any candidate label value to a trimmed non-empty string, or `undefined`.
 *
 * Named failures this catches:
 *   • nil            — `null`/`undefined` → `undefined` (the caller renders a placeholder).
 *   • empty          — `''` / `'   '` → `undefined` (a blank is not a name).
 *   • stringified-nil— the literal `'undefined'`/`'null'`/`'NaN'` that `String(x)` produces on a
 *                      missing field (F-013's sibling defect) → `undefined`.
 *   • upstream error — a plain object / array whose `String()` is `[object Object]` → `undefined`
 *                      rather than leaking that into a label. A RecordId-like value with a real
 *                      `toString()` survives (it stringifies to `table:id`, which
 *                      `stripRecordId()` then humanizes).
 */
function clean(v: unknown): string | undefined {
	if (v == null) return undefined;
	if (typeof v === 'number') return Number.isFinite(v) ? String(v) : undefined;
	if (typeof v === 'boolean' || typeof v === 'symbol' || typeof v === 'function') return undefined;
	let s: string;
	if (typeof v === 'string') s = v;
	else {
		try {
			s = String(v);
		} catch {
			return undefined; // a toString() that throws is an upstream error, not a name.
		}
	}
	s = s.trim();
	if (!s) return undefined;
	if (s === 'undefined' || s === 'null' || s === 'NaN' || s === '[object Object]') return undefined;
	return s;
}

/**
 * Turn a raw record id into something a human can read, or `null` when the id carries no human
 * content at all.
 *
 *   `role:probe_fit_1781894354268`  → `probe_fit`      (strip table prefix + epoch suffix)
 *   `role:hr-recruiter`             → `hr-recruiter`
 *   `role:gq3glfee2zcw993suhto`     → `null`           (opaque auto-id — honestly nameless)
 *   `session:01k9abc…`              → `null`
 *   `bare-slug`                     → `bare-slug`      (no colon: already a slug)
 *   `null` / `''` / `'   '`         → `null`
 *
 * Returning `null` (rather than the opaque tail) is deliberate: an auto-id is NOT a name, and
 * the standing operator rule makes rendering one a defect. Callers that still want to show the
 * id for traceability should render it separately as an id — see `shortRef()`.
 */
export function stripRecordId(value: unknown): string | null {
	const s = clean(value);
	if (!s) return null;
	const i = s.indexOf(':');
	const tail = (i >= 0 ? s.slice(i + 1) : s).trim();
	if (!tail) return null;
	// SurrealDB may bracket a complex id: `role:⟨probe fit⟩`.
	const unbracketed = tail.replace(/^[⟨`]|[⟩`]$/g, '').trim();
	if (!unbracketed) return null;
	const named = unbracketed.replace(EPOCH_SUFFIX, '').trim();
	if (!named) return null;
	if (OPAQUE_TAIL.test(named)) return null; // an auto-id is not a name (F-008 honesty).
	return named;
}

/**
 * The honest "no name, here is the id" fallback: a short, stable id tail for TRACEABILITY —
 * rendered as an id (mono/dim), never in the name slot. nil/empty → `'—'`.
 */
export function shortRef(value: unknown, len = 8): string {
	const s = clean(value);
	if (!s) return '—';
	const i = s.indexOf(':');
	const tail = i >= 0 ? s.slice(i + 1) : s;
	return tail.length > len ? tail.slice(-len) : tail;
}

/** The composed parts of a display name — for renderers that style the qualifier separately. */
export interface NameDescription {
	/** WHO/WHAT: role name/slug, specialist, intent — or the placeholder when nothing exists. */
	identity: string;
	/** WHAT it is doing (the task title), when present and not a duplicate of `identity`. */
	subject: string | null;
	/** The DEMOTED model / tier / pool-slot id. Never the identity. */
	qualifier: string | null;
	/** The joined `identity · subject · qualifier` string. */
	name: string;
	/**
	 * TRUE when no purposeful field existed and `identity` is the honest placeholder. A renderer
	 * SHOULD dim/italicize this rather than present it as a real name (F-008).
	 */
	isPlaceholder: boolean;
}

/** The naming fields a session-shaped row can offer. Every one is optional and nil-tolerant. */
export interface SessionNameInput {
	/** `role.name` — the highest-priority identity (human-authored). */
	roleName?: unknown;
	/** `role.slug` — the machine handle, still human-readable (`hr-recruiter`). */
	roleSlug?: unknown;
	/** A raw `role:…` link, used only if neither name nor slug resolved (via `stripRecordId`). */
	role?: unknown;
	/** `session.specialist` — the routed specialist agent type (0/177 live today; wired for (b)). */
	specialist?: unknown;
	/** `task.title` — WHAT the session is doing. Screen it (D-026) BEFORE passing it in. */
	taskTitle?: unknown;
	/** `session.granted_intent` — the capability intent (`code-write`, `read-only`, …). */
	intent?: unknown;
	/** `session.kind` — the coarsest discriminator; used ONLY when nothing else exists. */
	kind?: unknown;
	/** The DEMOTED qualifier: pool-slot id / model id / tier. Never promoted to the identity. */
	qualifier?: unknown;
}

/** Placeholder text per subject — honest, explicit, never a fabricated name. */
const PLACEHOLDER = {
	session: 'unnamed session',
	agent: 'unnamed agent',
	role: 'unnamed role'
} as const;

export interface NameOptions {
	/** Override the honest-unknown text (e.g. `'—'` in a dense table cell). */
	placeholder?: string;
	/** Drop the trailing qualifier (e.g. a card that already renders the model in its own chip). */
	includeQualifier?: boolean;
	/**
	 * Append the coarse `kind` as a secondary part even when a richer identity already exists —
	 * `HR Recruiter · interview` instead of `HR Recruiter`.
	 *
	 * OFF by default because the operator's agreed shape for the memory scene
	 * (`code-write · Unblock 1 stalled task(s) · sonnet-1`) deliberately omits the kind: three
	 * parts is the readable ceiling for a graph node label. Surfaces with room — a restart row, a
	 * session card — opt in so the coarse "what class of work" is not lost. `kind` is still never
	 * duplicated: it is dropped if it already IS the identity or the subject.
	 */
	includeKind?: boolean;
	/**
	 * Cap the SUBJECT (task title) at N characters, ellipsizing with `…`.
	 *
	 * Live task titles run past 200 characters ("Establish SDK-style project targeting net472
	 * with a Directory.Build.props that resolves…"), which is unreadable as a graph-node label.
	 * Truncation is HONEST because it is VISIBLE — the `…` says "there is more", unlike a silent
	 * CSS clip. Callers that truncate should also expose the full text (a `title` tooltip, the
	 * inspector, the linked task). Unset ⇒ no cap; the identity and qualifier are NEVER capped.
	 */
	maxSubjectChars?: number;
}

/** Ellipsize on a word boundary where possible; the `…` makes the truncation visible. */
function clip(s: string, max: number | undefined): string {
	if (!max || !Number.isFinite(max) || max <= 1 || s.length <= max) return s;
	const cut = s.slice(0, max - 1);
	const sp = cut.lastIndexOf(' ');
	return `${(sp > max * 0.6 ? cut.slice(0, sp) : cut).trimEnd()}…`;
}

/**
 * Compose a session's display name from whatever purposeful fields exist.
 *
 * Priority (the operator-agreed order): `role.name → role.slug → specialist → task.title →
 * granted_intent → kind`, expressed as two slots so the richest rows read naturally:
 *   identity = roleName → roleSlug → stripRecordId(role) → specialist → intent
 *   subject  = taskTitle
 *   kind     = the LAST resort — used as identity only when neither slot filled.
 *
 * Examples (all real live shapes):
 *   `{intent:'code-write', taskTitle:'Unblock 1 stalled task(s)', qualifier:'sonnet-1'}`
 *      → `code-write · Unblock 1 stalled task(s) · sonnet-1`
 *   `{roleName:'HR Recruiter', kind:'interview', qualifier:'opus-1'}`
 *      → `HR Recruiter · opus-1`
 *   `{kind:'chat'}`                → `chat`
 *   `{qualifier:'sonnet-1'}`       → `unnamed session · sonnet-1`   ← slot id NEVER the identity
 *   `{}` / `null` / `undefined`    → `unnamed session`
 */
export function describeSession(
	input: SessionNameInput | null | undefined,
	opts: NameOptions = {}
): NameDescription {
	const src = input ?? {};
	const placeholder = clean(opts.placeholder) ?? PLACEHOLDER.session;
	const includeQualifier = opts.includeQualifier !== false;

	const identityRaw =
		clean(src.roleName) ??
		clean(src.roleSlug) ??
		stripRecordId(src.role) ??
		clean(src.specialist) ??
		clean(src.intent);
	const subjectRaw = clean(src.taskTitle);
	const kind = clean(src.kind);
	const qualifier = includeQualifier ? (clean(src.qualifier) ?? null) : null;

	// `kind` is the last resort — promoted only when neither identity nor subject exists, so a
	// row with a real task title never reads `session · <title>`.
	let identity = identityRaw ?? (subjectRaw ? undefined : kind);
	const isPlaceholder = !identity && !subjectRaw;
	if (isPlaceholder) identity = placeholder;

	// Drop a subject that merely repeats the identity — `code-write · code-write` is the
	// "intent slug repeated N times" defect the operator called out.
	const subject =
		subjectRaw && identity && subjectRaw.toLowerCase() === identity.toLowerCase()
			? null
			: subjectRaw
				? clip(subjectRaw, opts.maxSubjectChars)
				: null;

	const parts = [identity, subject].filter((p): p is string => !!p);
	// Opt-in coarse kind, de-duplicated against whatever is already shown.
	if (opts.includeKind && kind && !parts.some((p) => p.toLowerCase() === kind.toLowerCase())) {
		parts.push(kind);
	}
	if (qualifier) parts.push(qualifier);

	return {
		identity: identity ?? placeholder,
		subject,
		qualifier,
		name: parts.join(SEP),
		isPlaceholder
	};
}

/** `describeSession(...).name` — the string form for the common call site. */
export function sessionDisplayName(
	input: SessionNameInput | null | undefined,
	opts: NameOptions = {}
): string {
	return describeSession(input, opts).name;
}

/**
 * The naming fields an AGENT node can offer. An agent node is a CLUSTER (the scene synthesizes
 * one per distinct `session.agent` slot id), so each dimension is a LIST gathered across the
 * clustered sessions — the composer picks the first dimension that has content and discloses
 * the spread (`code-write +2`) instead of silently showing one of several.
 */
export interface AgentNameInput {
	/** The pool-slot id / model tier. DEMOTED to the trailing qualifier (F-046). */
	slot?: unknown;
	roleNames?: readonly unknown[];
	specialists?: readonly unknown[];
	intents?: readonly unknown[];
	kinds?: readonly unknown[];
}

/** Distinct, cleaned, order-preserving values from a possibly-nil list. */
function distinct(list: readonly unknown[] | null | undefined): string[] {
	if (!Array.isArray(list)) return [];
	const seen = new Set<string>();
	const out: string[] = [];
	for (const v of list) {
		const s = clean(v);
		if (!s || seen.has(s.toLowerCase())) continue;
		seen.add(s.toLowerCase());
		out.push(s);
	}
	return out;
}

/**
 * Compose an agent CLUSTER's display name.
 *
 *   `{slot:'sonnet-1', intents:['code-write']}`             → `code-write · sonnet-1`
 *   `{slot:'sonnet-1', intents:['code-write','read-only']}` → `code-write +1 · sonnet-1`
 *   `{slot:'sonnet-1'}`                                     → `unnamed agent · sonnet-1`
 *   `{}` / nil                                              → `unnamed agent`
 *
 * The `+N` is an honest disclosure of the cluster spread, not a truncation: the operator can
 * see the node bundles more than one kind of work rather than being shown one at random.
 */
export function describeAgent(
	input: AgentNameInput | null | undefined,
	opts: NameOptions = {}
): NameDescription {
	const src = input ?? {};
	const placeholder = clean(opts.placeholder) ?? PLACEHOLDER.agent;
	const includeQualifier = opts.includeQualifier !== false;
	const qualifier = includeQualifier ? (clean(src.slot) ?? null) : null;

	const dimension =
		[distinct(src.roleNames), distinct(src.specialists), distinct(src.intents), distinct(src.kinds)].find(
			(d) => d.length > 0
		) ?? [];

	const isPlaceholder = dimension.length === 0;
	const head = isPlaceholder ? placeholder : dimension[0];
	const identity = dimension.length > 1 ? `${head} +${dimension.length - 1}` : head;

	const parts = [identity];
	if (qualifier) parts.push(qualifier);
	return { identity, subject: null, qualifier, name: parts.join(SEP), isPlaceholder };
}

/** `describeAgent(...).name`. */
export function agentDisplayName(
	input: AgentNameInput | null | undefined,
	opts: NameOptions = {}
): string {
	return describeAgent(input, opts).name;
}

/** The naming fields a workforce ROLE offers, plus the raw link to fall back through. */
export interface RoleNameInput {
	/** `role.name` — human-authored. */
	name?: unknown;
	/** `role.slug` — machine handle, still readable. */
	slug?: unknown;
	/** The raw `role:…` record id, humanized via `stripRecordId` only if name+slug are absent. */
	ref?: unknown;
}

/**
 * Compose a role label.
 *
 *   `{name:'HR Recruiter'}`                    → `HR Recruiter`
 *   `{slug:'hr-recruiter'}`                    → `hr-recruiter`
 *   `{ref:'role:probe_fit_1781894354268'}`     → `probe_fit`            ← was the raw id
 *   `{ref:'role:gq3glfee2zcw993suhto'}`        → `unnamed role`         ← opaque, honest
 *   `{}` / nil                                 → `unnamed role`
 *
 * This is the fix for the SECOND systemic class in the naming inventory: raw `role:` record ids
 * rendered verbatim across the workforce surfaces. It never HIDES a row — a dangling role still
 * renders, honestly labelled.
 */
export function describeRole(
	input: RoleNameInput | null | undefined,
	opts: NameOptions = {}
): NameDescription {
	const src = input ?? {};
	const placeholder = clean(opts.placeholder) ?? PLACEHOLDER.role;
	const resolved = clean(src.name) ?? clean(src.slug) ?? stripRecordId(src.ref);
	const isPlaceholder = !resolved;
	const identity = resolved ?? placeholder;
	return { identity, subject: null, qualifier: null, name: identity, isPlaceholder };
}

/** `describeRole(...).name` — the drop-in for every `role?.name ?? rawId` site. */
export function roleDisplayName(
	input: RoleNameInput | null | undefined,
	opts: NameOptions = {}
): string {
	return describeRole(input, opts).name;
}
