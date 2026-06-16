// TASK 16.2 — the PM TRIGGER ENGINE (PM-SPEC §3, D-004-gated).
//
// When does the PM wake? Three trigger classes, all flowing into the SAME
// runPmReview pass (pm-review.ts) with the trigger recorded as provenance:
//
//   • PERIODIC — per-project cron (`pm.cadence`) + per-project stagger
//     (`pm.cadence_offset`, so PMs don't all fire on the same minute). Evaluated by
//     a cheap unref'd tick; due-ness is minute-deduped so one cron match fires once.
//   • EVENT — the four PM-SPEC §3 events, wired onto the EXISTING events bus
//     (ARCHITECTURE §2.11 — the engine NEVER opens its own live query; it is just
//     another bus consumer, exactly like the orchestrator):
//       ① session failed / task blocked > threshold — threshold is the operator-
//          tunable `pm.triggers.failure_threshold` (config/workforce.yaml); ships
//          null = UNARMED (F-008: no invented bound — until the operator sets one,
//          distress never auto-fires).
//       ② GitHub issue/PR arrival — detected by the 9.4/12.4 SyncAdapter during a
//          sync run (SyncResult.arrivals) and forwarded here by the sync action;
//          creds-absent degrades honestly upstream (probe fails → no sync → no
//          event). Arrivals are deduped persistently against prior pm_review
//          provenance so the same issue never wakes the PM twice.
//       ③ a new security/UX finding lands (`security_finding` CREATE; ux.* rules
//          share the table — 11.1 family convention). Burst writes coalesce.
//       ④ a release completes/fails (`workflow_run` terminal status on a workflow
//          named "release …" — the 12.x pipeline's naming contract). The review
//          variant writes the retro memory + follow-up proposal seed (pm-review.ts).
//   • MANUAL — the existing PM-tab buttons + chat (route actions). NOT this
//     module's concern: manual triggers live at the route boundary and are always
//     allowed (D-004), untouched by this engine.
//
// GATES — every automatic fire passes ALL of these, in order (fail-closed):
//   1. D-004 orchestration mode (`pmTriggerAllowed`, the 11.4/11.5
//      uxInspectionAllowed-style gate): manual mode = NO automatic fires of any
//      kind. In manual mode start() subscribes to nothing and arms no timer.
//   2. A HIRED PM (PM-SPEC §1): triggers NEVER fire for a project without a `pm`
//      row — no PM, no wake, regardless of signals.
//   3. pm.authority (`reviewAllowedByAuthority`): a review pass only OBSERVES
//      (pm_memory + pm_review writes), the floor of the observe<propose<act ladder,
//      so every VALID authority permits it — but an unknown/malformed authority
//      fails CLOSED (never fire on a row we cannot classify). Proposal-creating
//      variants (16.3) tighten this same seam to propose/act.
//
// HONESTY (F-008): every fire's provenance carries the REAL evidence rows that
// produced it; an unarmed threshold means no fire (not a default bound); a project
// the engine skips is a silent no-op, never a fabricated review.
//
// F-014 discipline: the tick timer is unref'd and stop() tears down every timer +
// subscription; in-flight reviews are tracked so shutdown/tests can await idle().

import { StringRecordId } from 'surrealdb';
import type { Db } from '../db/client';
import { assertRecordId } from '../db/validate';
import type { BusEvent, EventBus, Unsubscribe } from '../events/bus';
import type { DbChange } from '../events/db-source';
import type { OrchMode } from '../config/index';
import type { WorkforceConfig } from '../config/load';
import { evaluateDriftAndAutoRaise } from '../workforce/drift';
import { getPm, listPmsWithCadence, PM_AUTHORITIES, type PmReviewTrigger } from './pm-repo';
import { runPmReview } from './pm-review';

// ── D-004 mode gate (the uxInspectionAllowed pattern, 11.4/11.5) ──────────────────

/**
 * The D-004 gate for PM triggers: a MANUAL trigger is always permitted; an automatic
 * (periodic/event) trigger is permitted only when the orchestration mode is not
 * "manual". Pure — the caller supplies the live mode. Mirrors uxInspectionAllowed so
 * "manual mode" consistently means "button-triggered only" across the PM surface.
 */
export function pmTriggerAllowed(trigger: PmReviewTrigger, mode: OrchMode): boolean {
	if (trigger === 'manual') return true;
	return mode !== 'manual';
}

/**
 * The pm.authority gate (PM-SPEC §4). A review pass only OBSERVES — it writes
 * pm_memory + a pm_review row and takes no action — which is the FLOOR of the
 * observe < propose < act ladder, so every valid authority permits it. The gate is
 * fail-CLOSED on anything else: an unknown/malformed authority value never fires
 * (and the proposal-creating 16.3 variants tighten this same seam to propose/act).
 */
export function reviewAllowedByAuthority(authority: unknown): boolean {
	return typeof authority === 'string' && (PM_AUTHORITIES as readonly string[]).includes(authority);
}

// ── Cron (5-field) + duration parsing — pure, dependency-free ─────────────────────
//
// `pm.cadence` is a standard 5-field cron expression (minute hour day-of-month month
// day-of-week) with `*`, lists, ranges and steps. No new dependency (reuse-first):
// the matcher below covers the standard field syntax; anything it cannot parse is
// honestly NOT due (fail-closed) and surfaced once via the engine's warn log.

interface CronField {
	/** True for a bare `*` (unrestricted). */
	any: boolean;
	values: Set<number>;
}

export interface CronSpec {
	minute: CronField;
	hour: CronField;
	dom: CronField;
	month: CronField;
	dow: CronField;
}

function parseCronField(raw: string, min: number, max: number): CronField | null {
	const field: CronField = { any: false, values: new Set() };
	if (raw === '*') return { any: true, values: field.values };
	for (const part of raw.split(',')) {
		const m = part.match(/^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/);
		if (!m) return null;
		const step = m[2] !== undefined ? Number(m[2]) : 1;
		if (!Number.isInteger(step) || step < 1) return null;
		let lo: number;
		let hi: number;
		if (m[1] === '*') {
			lo = min;
			hi = max;
		} else if (m[1].includes('-')) {
			const [a, b] = m[1].split('-').map(Number);
			lo = a;
			hi = b;
		} else {
			lo = Number(m[1]);
			// A bare value with a step (`3/5`) extends to the field max (vixie semantics).
			hi = m[2] !== undefined ? max : lo;
		}
		if (lo < min || hi > max || lo > hi) return null;
		for (let v = lo; v <= hi; v += step) field.values.add(v);
	}
	return field.values.size > 0 ? field : null;
}

/** Parse a 5-field cron expression. Returns null (honestly unparseable) on any error. */
export function parseCron(expr: string): CronSpec | null {
	const fields = expr.trim().split(/\s+/);
	if (fields.length !== 5) return null;
	const minute = parseCronField(fields[0], 0, 59);
	const hour = parseCronField(fields[1], 0, 23);
	const dom = parseCronField(fields[2], 1, 31);
	const month = parseCronField(fields[3], 1, 12);
	// DOW 0–7, 7 ≡ 0 (Sunday) — normalized below.
	const dowRaw = parseCronField(fields[4], 0, 7);
	if (!minute || !hour || !dom || !month || !dowRaw) return null;
	const dow: CronField = { any: dowRaw.any, values: new Set() };
	for (const v of dowRaw.values) dow.values.add(v === 7 ? 0 : v);
	return { minute, hour, dom, month, dow };
}

/**
 * Does `spec` match the wall-clock minute of `at` (local time)? Standard (vixie)
 * day semantics: when BOTH day-of-month and day-of-week are restricted, the day
 * matches if EITHER does; otherwise the restricted one must match.
 */
export function cronMatches(spec: CronSpec, at: Date): boolean {
	const hit = (f: CronField, v: number): boolean => f.any || f.values.has(v);
	if (!hit(spec.minute, at.getMinutes())) return false;
	if (!hit(spec.hour, at.getHours())) return false;
	if (!hit(spec.month, at.getMonth() + 1)) return false;
	const domHit = hit(spec.dom, at.getDate());
	const dowHit = hit(spec.dow, at.getDay());
	if (!spec.dom.any && !spec.dow.any) return domHit || dowHit;
	return domHit && dowHit;
}

/**
 * Parse a SurrealDB duration string ('5m', '1h30m', '90s', '1d', '250ms') to
 * milliseconds. Returns null when the string is not entirely duration components
 * (the caller treats an unparseable offset honestly as no stagger).
 */
export function parseDurationMs(s: string): number | null {
	const str = s.trim();
	if (!str) return null;
	const re = /(\d+)(ms|s|m|h|d|w)/g;
	let total = 0;
	let consumed = 0;
	for (const m of str.matchAll(re)) {
		consumed += m[0].length;
		const n = Number(m[1]);
		const unit = m[2];
		const factor =
			unit === 'ms' ? 1 : unit === 's' ? 1000 : unit === 'm' ? 60_000 : unit === 'h' ? 3_600_000 : unit === 'd' ? 86_400_000 : 604_800_000;
		total += n * factor;
	}
	return consumed === str.length ? total : null;
}

/**
 * Is a PM's periodic cadence due at `at`? The cadence cron is evaluated at the
 * OFFSET-SHIFTED instant (at − cadence_offset), so two PMs sharing a cron but
 * carrying different offsets fire on different wall-clock minutes (PM-SPEC §3
 * stagger). Returns the due-ness plus the minute key the engine dedups on.
 */
export function periodicDue(
	pm: { cadence?: string; cadence_offset?: string },
	at: Date
): { due: boolean; minuteKey: number } {
	const offsetMs = pm.cadence_offset ? (parseDurationMs(pm.cadence_offset) ?? 0) : 0;
	const shifted = new Date(at.getTime() - offsetMs);
	const minuteKey = Math.floor(shifted.getTime() / 60_000);
	if (!pm.cadence) return { due: false, minuteKey };
	const spec = parseCron(pm.cadence);
	if (!spec) return { due: false, minuteKey }; // unparseable → honestly never due
	return { due: cronMatches(spec, shifted), minuteKey };
}

// ── The engine ─────────────────────────────────────────────────────────────────────

/** One GitHub arrival the SyncAdapter detected (an unmapped open issue / open PR). */
export interface PmGithubArrival {
	kind: 'issue' | 'pr';
	externalId: string;
	title?: string;
	url?: string;
}

/** The provenance kinds the engine produces (PM-SPEC §3 periodic + the four events). */
export type PmTriggerKind =
	| 'periodic'
	| 'session_failed'
	| 'task_blocked'
	| 'github_arrival'
	| 'finding'
	| 'release';

export interface PmTriggerEngineOptions {
	db: Db;
	bus: EventBus;
	/** Orchestration mode (D-004) — read once per boot, like the orchestrator. */
	mode: OrchMode;
	/**
	 * Event ① threshold (config/workforce.yaml pm.triggers.failure_threshold).
	 * null = UNARMED (F-008): distress signals never auto-fire until the operator
	 * sets a bound from real history. When armed, a fire needs distress > threshold.
	 */
	failureThreshold: number | null;
	/** Periodic tick interval. Only armed when mode permits automatic fires. */
	tickMs?: number;
	/** Finding-burst coalescing window (a scan writes findings row-by-row). */
	coalesceMs?: number;
	/**
	 * WORKFORCE-SPEC §5 drift wiring (operator decision 4). When supplied (and mode
	 * permits automatic fires — D-004), each periodic tick ALSO runs a BOUNDED
	 * drift-evaluation pass that auto-raises review_proposal{status:'proposed'} rows for
	 * fired armed signals. null/absent = drift never auto-raises (the count-and-surface
	 * posture). Raising a TRIGGER costs nothing (no gauntlet/swap — those stay operator-
	 * gated), so it is mode-gated only, not budget-gated.
	 */
	driftConfig?: WorkforceConfig | null;
	/** Clock seam (tests). */
	now?: () => Date;
}

const DEFAULT_TICK_MS = 15_000; // < the 60s cron resolution; minute-deduped anyway
const DEFAULT_COALESCE_MS = 1_500; // one scan's burst of finding rows → one review
const BUS_TOPICS = new Set(['session', 'task', 'security_finding', 'workflow_run']);

export class PmTriggerEngine {
	readonly #db: Db;
	readonly #bus: EventBus;
	readonly #mode: OrchMode;
	readonly #threshold: number | null;
	readonly #tickMs: number;
	readonly #coalesceMs: number;
	readonly #driftConfig: WorkforceConfig | null;
	readonly #now: () => Date;

	#unsub?: Unsubscribe;
	#timer?: ReturnType<typeof setInterval>;
	#started = false;
	#stopped = false;

	/** In-flight async work (bus handlers / fires) — awaited by idle(). */
	readonly #inFlight = new Set<Promise<unknown>>();
	/** Projects with a review currently running (concurrent fires coalesce — the
	 *  running pass already reads the live rows the second signal points at). */
	readonly #reviewing = new Set<string>();
	/** Per-PM minute dedup for periodic fires (one cron match = one review). */
	readonly #lastPeriodicKey = new Map<string, number>();
	/** Per-project finding-burst buffers (coalesced into one event fire). */
	readonly #findingBuffer = new Map<string, { ids: Set<string>; timer: ReturnType<typeof setTimeout> }>();
	/** Per-project seen GitHub arrivals — lazily seeded from prior pm_review provenance
	 *  (persistent dedup), then grown in-memory. */
	readonly #ghSeen = new Map<string, Set<string>>();
	/** Cadences already warned about (one warn per bad expression, not per tick). */
	readonly #warnedCadence = new Set<string>();

	/** Reviews this engine has fired (diagnostics / the verify count). */
	reviewCount = 0;
	/** §5 drift proposals this engine has auto-raised (diagnostics / the verify count). */
	driftRaiseCount = 0;

	constructor(opts: PmTriggerEngineOptions) {
		this.#db = opts.db;
		this.#bus = opts.bus;
		this.#mode = opts.mode;
		this.#threshold = opts.failureThreshold;
		this.#tickMs = opts.tickMs ?? DEFAULT_TICK_MS;
		this.#coalesceMs = opts.coalesceMs ?? DEFAULT_COALESCE_MS;
		this.#driftConfig = opts.driftConfig ?? null;
		this.#now = opts.now ?? (() => new Date());
	}

	/** True only when the §5 drift auto-raise is wired (config supplied + mode permits). */
	get driftArmed(): boolean {
		return this.#driftConfig !== null && this.#mode !== 'manual';
	}

	get mode(): OrchMode {
		return this.#mode;
	}

	/** True only while the periodic tick timer is armed (never in manual mode — D-004). */
	get periodicArmed(): boolean {
		return this.#timer !== undefined;
	}

	/**
	 * Start the engine. In MANUAL mode this subscribes to NOTHING and arms NO timer —
	 * D-004: manual mode means no automatic fires of any kind; the operator's buttons
	 * (route actions) remain the only PM triggers. Otherwise: one bus subscription
	 * (event triggers) + one unref'd tick timer (periodic cadences).
	 */
	start(): void {
		if (this.#started || this.#stopped) return;
		this.#started = true;
		if (this.#mode === 'manual') return;

		this.#unsub = this.#bus.subscribe(
			(e) => {
				this.#track(this.#onBusEvent(e));
			},
			(e) => e.type === 'db_change' && BUS_TOPICS.has(e.topic)
		);
		if (this.#tickMs > 0) {
			this.#timer = setInterval(() => {
				this.#track(this.tickOnce());
			}, this.#tickMs);
			if (typeof this.#timer.unref === 'function') this.#timer.unref();
		}
	}

	/** Stop subscriptions + every timer (F-014 teardown). Idempotent. */
	stop(): void {
		this.#stopped = true;
		this.#unsub?.();
		this.#unsub = undefined;
		if (this.#timer) clearInterval(this.#timer);
		this.#timer = undefined;
		for (const buf of this.#findingBuffer.values()) clearTimeout(buf.timer);
		this.#findingBuffer.clear();
		this.#started = false;
	}

	/** Await all in-flight work, flushing pending finding buffers first (tests). */
	async idle(): Promise<void> {
		// Flush coalescing buffers NOW so a test doesn't wait on real timers.
		for (const [projectId, buf] of [...this.#findingBuffer]) {
			clearTimeout(buf.timer);
			this.#findingBuffer.delete(projectId);
			this.#track(this.#fireFindings(projectId, buf.ids));
		}
		while (this.#inFlight.size > 0) {
			await Promise.allSettled([...this.#inFlight]);
		}
	}

	/** Track a fire-and-forget promise so idle()/tests can await it; errors are logged
	 *  and swallowed (a trigger failure must never take down the bus or the server). */
	#track(p: Promise<unknown>): void {
		const tracked = p.catch((err) => {
			console.warn(`[pm-triggers] trigger handling failed: ${(err as Error).message}`);
		});
		this.#inFlight.add(tracked);
		void tracked.finally(() => this.#inFlight.delete(tracked));
	}

	// ── Periodic (PM-SPEC §3 cron + offset) ─────────────────────────────────────────

	/**
	 * One periodic pass: evaluate every hired PM's cadence at `at` (offset-shifted,
	 * minute-deduped) and fire the due ones. Public + deterministic so tests drive it
	 * without timers. Returns how many reviews fired.
	 */
	async tickOnce(at?: Date): Promise<number> {
		if (this.#stopped) return 0;
		if (!pmTriggerAllowed('periodic', this.#mode)) return 0;
		const when = at ?? this.#now();
		let fired = 0;
		const pms = await listPmsWithCadence(this.#db);
		for (const pm of pms) {
			const cadence = pm.cadence ?? '';
			if (!parseCron(cadence)) {
				if (!this.#warnedCadence.has(pm.id)) {
					this.#warnedCadence.add(pm.id);
					console.warn(`[pm-triggers] ${pm.id}: unparseable cadence ${JSON.stringify(cadence)} — periodic reviews will not fire for it.`);
				}
				continue;
			}
			const { due, minuteKey } = periodicDue(pm, when);
			if (!due) continue;
			if (this.#lastPeriodicKey.get(pm.id) === minuteKey) continue; // already fired this match
			this.#lastPeriodicKey.set(pm.id, minuteKey);
			const ok = await this.#fire('periodic', pm.project, {
				kind: 'periodic',
				evidence: [pm.id],
				detail: {
					cadence,
					...(pm.cadence_offset ? { cadence_offset: pm.cadence_offset } : {})
				}
			});
			if (ok) fired++;
		}
		// WORKFORCE-SPEC §5 — the BOUNDED drift auto-raise pass rides the SAME periodic
		// cadence (no separate loop, no live query). It auto-raises 'proposed' rows only;
		// the swap/prompt-authoring stay operator-gated (D-010/D-039). A drift failure must
		// never break the PM cadence — it is awaited but its error is logged + swallowed.
		if (this.driftArmed) await this.#driftPass();
		return fired;
	}

	/** One bounded §5 drift evaluation across active incumbents (auto-raise on fired
	 *  signals). Errors are logged + swallowed (a drift hiccup never breaks the cadence). */
	async #driftPass(): Promise<void> {
		if (this.#stopped || this.#driftConfig === null) return;
		try {
			const res = await evaluateDriftAndAutoRaise(this.#db, this.#driftConfig, { now: this.#now });
			if (res.raised > 0) {
				this.driftRaiseCount += res.raised;
				console.log(
					`[pm-triggers] §5 drift pass: raised ${res.raised} proposal(s) over ${res.evaluated} incumbent(s).`
				);
			}
		} catch (err) {
			console.warn(`[pm-triggers] §5 drift pass failed (cadence unaffected): ${(err as Error).message}`);
		}
	}

	// ── Event triggers (bus) ────────────────────────────────────────────────────────

	async #onBusEvent(e: BusEvent): Promise<void> {
		if (this.#stopped) return;
		const change = e.data as DbChange;
		if (!change || change.action === 'DELETE') return;
		const row = change.result as Record<string, unknown> | null;
		if (!row) return;

		switch (e.topic) {
			case 'session': {
				// Event ① (session failed): a session row reaching status 'failed'.
				if (row.status !== 'failed' || row.project == null) return;
				await this.#distress(String(row.project), 'session_failed', change.record);
				return;
			}
			case 'task': {
				// Event ① (task blocked): a task row reaching status 'blocked'.
				if (row.status !== 'blocked' || row.project == null) return;
				await this.#distress(String(row.project), 'task_blocked', change.record);
				return;
			}
			case 'security_finding': {
				// Event ③: a NEW security/UX finding lands (CREATE only — archive sweeps
				// and status flips are not arrivals). Burst writes coalesce per project.
				if (change.action !== 'CREATE' || row.project == null) return;
				if ((row.status ?? 'active') !== 'active') return;
				this.#bufferFinding(String(row.project), change.record);
				return;
			}
			case 'workflow_run': {
				// Event ④: a release run reaches a terminal status. The release pipeline
				// names its workflows "release <version>" (12.x contract) — resolve the
				// workflow row to identify release runs + their project.
				if (row.status !== 'done' && row.status !== 'failed') return;
				if (row.workflow == null) return;
				await this.#releaseEnded(String(row.workflow), change.record, String(row.status));
				return;
			}
		}
	}

	/**
	 * Event ① — distress (session failed / task blocked). UNARMED (threshold null) →
	 * never auto-fires (F-008). Armed → fire when the distress count since the PM's
	 * last review (failed sessions + freshly-blocked tasks) EXCEEDS the threshold.
	 * Anchoring on the last pm_review makes the trigger self-limiting: a fired review
	 * resets the baseline, so the same stuck rows don't re-fire forever.
	 */
	async #distress(projectId: string, kind: 'session_failed' | 'task_blocked', evidenceId: string): Promise<void> {
		if (this.#threshold === null) return; // unarmed — surface-only, no auto fire
		const since = await this.#lastReviewAt(projectId);
		const [failedSessions, blockedTasks] = await Promise.all([
			this.#countSince(
				`SELECT count() AS n FROM session WHERE project = $project AND status = 'failed'`,
				'ended_at',
				projectId,
				since
			),
			this.#countSince(
				`SELECT count() AS n FROM task WHERE project = $project AND status = 'blocked'`,
				'updated_at',
				projectId,
				since
			)
		]);
		const distress = failedSessions + blockedTasks;
		if (distress <= this.#threshold) return;
		await this.#fire('event', projectId, {
			kind,
			evidence: [evidenceId],
			detail: {
				failed_sessions: failedSessions,
				blocked_tasks: blockedTasks,
				threshold: this.#threshold
			}
		});
	}

	#bufferFinding(projectId: string, findingId: string): void {
		const existing = this.#findingBuffer.get(projectId);
		if (existing) {
			existing.ids.add(findingId);
			return;
		}
		const ids = new Set([findingId]);
		const timer = setTimeout(() => {
			this.#findingBuffer.delete(projectId);
			this.#track(this.#fireFindings(projectId, ids));
		}, this.#coalesceMs);
		if (typeof timer.unref === 'function') timer.unref();
		this.#findingBuffer.set(projectId, { ids, timer });
	}

	async #fireFindings(projectId: string, ids: Set<string>): Promise<void> {
		if (ids.size === 0) return;
		await this.#fire('event', projectId, {
			kind: 'finding',
			evidence: [...ids],
			detail: { findings: ids.size }
		});
	}

	async #releaseEnded(workflowId: string, runId: string, status: string): Promise<void> {
		const wf = await this.#readWorkflow(workflowId);
		if (!wf || !wf.project) return;
		if (!wf.name.startsWith('release ')) return; // not a release run — not event ④
		await this.#fire('event', wf.project, {
			kind: 'release',
			evidence: [runId],
			detail: { status, workflow: wf.name }
		});
	}

	// ── Event ② — GitHub issue/PR arrival (forwarded by the sync action) ────────────

	/**
	 * Forward GitHub arrivals the SyncAdapter detected (SyncResult.arrivals). Deduped
	 * PERSISTENTLY: the seen-set seeds from prior pm_review github_arrival provenance,
	 * so a re-sync (or a restart) never wakes the PM twice for the same issue/PR.
	 * Returns true when a review fired. Mode/PM/authority gates apply as everywhere.
	 *
	 * TASK 16.5 (PM-SPEC §5): the fresh arrivals' REAL metadata (kind/externalId/
	 * title/url, bounded) rides in `detail.arrivals` so the review pass can TRIAGE
	 * them (summary + task_sync dup-check + risk flags + §4 proposals) without ever
	 * re-reaching GitHub — the PM triages from what the SyncAdapter already saw.
	 */
	async githubArrival(projectId: string, arrivals: PmGithubArrival[]): Promise<boolean> {
		if (this.#stopped || arrivals.length === 0) return false;
		const seen = await this.#seenArrivals(projectId);
		const fresh = arrivals.filter((a) => !seen.has(arrivalRef(a)));
		if (fresh.length === 0) return false;
		const fired = await this.#fire('event', projectId, {
			kind: 'github_arrival',
			evidence: fresh.map(arrivalRef),
			detail: {
				issues: fresh.filter((a) => a.kind === 'issue').length,
				prs: fresh.filter((a) => a.kind === 'pr').length,
				// TASK 16.5 — the triage payload (bounded; real SyncAdapter metadata only).
				arrivals: fresh.slice(0, 20).map((a) => ({
					kind: a.kind,
					externalId: a.externalId,
					...(a.title !== undefined ? { title: a.title } : {}),
					...(a.url !== undefined ? { url: a.url } : {})
				}))
			}
		});
		if (fired) for (const a of fresh) seen.add(arrivalRef(a));
		return fired;
	}

	async #seenArrivals(projectId: string): Promise<Set<string>> {
		const cached = this.#ghSeen.get(projectId);
		if (cached) return cached;
		const seen = new Set<string>();
		try {
			const project = new StringRecordId(assertRecordId(projectId));
			// SurrealDB 2.x: an ORDER BY field MUST appear in the selection ("Missing
			// order idiom" otherwise) — created_at is selected solely for the ORDER BY.
			const [rows] = await this.#db.query<[Array<{ provenance?: { kind?: string; evidence?: unknown[] } }>]>(
				`SELECT provenance, created_at FROM pm_review
					WHERE project = $project AND provenance.kind = 'github_arrival'
					ORDER BY created_at DESC LIMIT 50;`,
				{ project }
			);
			for (const r of rows) {
				for (const ev of r.provenance?.evidence ?? []) seen.add(String(ev));
			}
		} catch (err) {
			// Seed failure degrades to in-memory dedup only — a re-fire is possible but
			// every fire still records real provenance; never block the arrival itself.
			// LOUD degrade (F-022): a swallowed query error here once hid a parse error.
			console.warn(`[pm-triggers] arrival-dedup seed failed (in-memory only): ${(err as Error).message}`);
		}
		this.#ghSeen.set(projectId, seen);
		return seen;
	}

	// ── The one fire path (all gates, in order) ─────────────────────────────────────

	async #fire(trigger: PmReviewTrigger, projectId: string, prov: { kind: PmTriggerKind; evidence: string[]; detail?: Record<string, unknown> }): Promise<boolean> {
		if (this.#stopped) return false;
		// Gate 1 — D-004 orchestration mode.
		if (!pmTriggerAllowed(trigger, this.#mode)) return false;
		// Gate 2 — a HIRED PM (PM-SPEC §1): no pm row, no wake. Ever.
		const pm = await getPm(this.#db, projectId).catch(() => null);
		if (!pm) return false;
		// Gate 3 — pm.authority (fail-closed on an unclassifiable value).
		if (!reviewAllowedByAuthority(pm.authority)) return false;
		// Coalesce concurrent fires per project: the running pass reads the live rows
		// the second signal points at, so a parallel duplicate adds nothing but noise.
		if (this.#reviewing.has(projectId)) return false;
		this.#reviewing.add(projectId);
		try {
			await runPmReview(this.#db, projectId, trigger, {
				kind: prov.kind,
				evidence: prov.evidence,
				authority: pm.authority,
				...(prov.detail !== undefined ? { detail: prov.detail } : {})
			});
			this.reviewCount++;
			return true;
		} finally {
			this.#reviewing.delete(projectId);
		}
	}

	// ── Small bounded reads (D-016: ids via the validate chokepoint, values via $param) ──

	async #lastReviewAt(projectId: string): Promise<Date | null> {
		const project = new StringRecordId(assertRecordId(projectId));
		const [rows] = await this.#db.query<[Array<{ created_at: unknown }>]>(
			`SELECT created_at FROM pm_review WHERE project = $project ORDER BY created_at DESC LIMIT 1;`,
			{ project }
		);
		if (!rows.length || rows[0].created_at == null) return null;
		const d = new Date(String(rows[0].created_at));
		return Number.isNaN(d.getTime()) ? null : d;
	}

	async #countSince(baseSelect: string, sinceField: string, projectId: string, since: Date | null): Promise<number> {
		const project = new StringRecordId(assertRecordId(projectId));
		// `sinceField` is a code-supplied constant ('ended_at' / 'updated_at'), never input.
		const q = since
			? `${baseSelect} AND ${sinceField} > $since GROUP ALL;`
			: `${baseSelect} GROUP ALL;`;
		const [rows] = await this.#db.query<[Array<{ n: number }>]>(q, since ? { project, since } : { project });
		return rows[0]?.n ?? 0;
	}

	async #readWorkflow(workflowId: string): Promise<{ name: string; project: string | null } | null> {
		try {
			const wid = new StringRecordId(assertRecordId(workflowId));
			const [rows] = await this.#db.query<[Array<{ name?: unknown; project?: unknown }>]>(
				`SELECT name, project FROM $wid;`,
				{ wid }
			);
			const row = rows[0];
			if (!row || typeof row.name !== 'string') return null;
			return { name: row.name, project: row.project != null ? String(row.project) : null };
		} catch {
			return null;
		}
	}
}

/** Make the dedup/evidence ref for one arrival ('issue#12' / 'pr#3'). */
function arrivalRef(a: PmGithubArrival): string {
	return `${a.kind}#${a.externalId}`;
}

// ── Process-wide registry (mirrors hooks.server.ts's orchestrator registry) ─────────
// The sync route action forwards SyncResult.arrivals to the LIVE engine; routes must
// not import hooks.server.ts (circularity), so the handle lives here.

let active: PmTriggerEngine | null = null;

/** Register the boot-started engine (hooks.server.ts). */
export function setActivePmTriggerEngine(engine: PmTriggerEngine | null): void {
	active = engine;
}

/** The live engine, or null when none is running (degraded boot / manual-only). */
export function activePmTriggerEngine(): PmTriggerEngine | null {
	return active;
}
