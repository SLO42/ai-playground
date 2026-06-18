// server/create/template-form.ts — the PURE form↔template plumbing the /projects/create route uses
// (CT-2/CT-4, CREATE-SPEC). Kept OUT of +page.server.ts because SvelteKit forbids arbitrary exports
// from a +page.server module — these helpers are unit-tested directly here, and the route imports
// them. No DB, no fs, no $env, no secrets: depends only on the pure template registry + its args.

import {
	briefHintsFromTemplate,
	getTemplate,
	listTemplateMetadata,
	SycophancyError,
	SecretEchoError,
	ProposalContractError,
	StaleProposalError,
	ProjectExistsError,
	UnstableSlugError,
	ScaffoldPathError,
	ScaffoldSecretError,
	ScaffoldFailedError,
	ConcurrentCreateError,
	PostRegisterWriterError,
	TemplateNotFoundError,
	type TemplateMetadata
} from './index';

/** Bound an operator-supplied template param value at the boundary (mirrors the route's MAX_HINT). */
export const MAX_TEMPLATE_PARAM = 1000;

/**
 * A template's serialisable metadata plus its PRE-FILL hints (CT-2 / CT-4). `briefHintsFromTemplate`
 * needs the full ProjectTemplate (its generate fn is non-serialisable), so we resolve the hints
 * SERVER-SIDE and ship the plain {ecosystem?, targetPlatform?} object — the picker pre-fills the
 * brief hint fields on selection with no round-trip (F-008: only genuinely-mapped fields appear).
 */
export type TemplateChoice = TemplateMetadata & {
	hints: { ecosystem?: string; targetPlatform?: string };
};

/** Resolve the picker's template choices (metadata + pre-fill hints) — pure, no I/O, no secrets. */
export function templateChoices(): TemplateChoice[] {
	return listTemplateMetadata().map((meta) => {
		const full = getTemplate(meta.id);
		return { ...meta, hints: full ? briefHintsFromTemplate(full) : {} };
	});
}

/**
 * Read the template params for `templateId` from the form. Only keys the template DECLARES are read
 * (the registry is the source of truth, F-008) — a boolean param is true iff its checkbox is 'on';
 * a string/select param takes its bounded trimmed value, or its declared default when absent.
 * Returns {} for an unknown templateId (the scaffold action then throws TemplateNotFoundError).
 *
 * Shadow paths: unknown templateId → {} (named error downstream); absent field → declared default;
 * a select value the template doesn't list is passed verbatim (generate() falls back to its default).
 */
export function readTemplateParams(
	form: FormData,
	templateId: string
): Record<string, string | boolean> {
	const template = getTemplate(templateId);
	if (!template) return {};
	const out: Record<string, string | boolean> = {};
	for (const p of template.params) {
		if (p.type === 'boolean') {
			out[p.key] = form.get(`param.${p.key}`) === 'on';
		} else {
			const raw = form.get(`param.${p.key}`);
			const v = typeof raw === 'string' ? raw.trim().slice(0, MAX_TEMPLATE_PARAM) : '';
			out[p.key] = v || (typeof p.default === 'string' ? p.default : '');
		}
	}
	return out;
}

/** Map a named CA-1 validation error to an honest operator-facing reason (EVERY ERROR HAS A NAME). */
export function proposeErrorReason(err: unknown): string {
	if (err instanceof SycophancyError) {
		return `The proposal hedged instead of taking a position (CREATE-SPEC §3) — re-generate. ${err.message}`;
	}
	if (err instanceof SecretEchoError) {
		return `The proposal echoed a literal secret in '${err.field}' (D-026: env names only) — re-generate.`;
	}
	if (err instanceof ProposalContractError) {
		return `The agent did not return a valid proposal — re-generate. ${err.message}`;
	}
	return (err as Error).message;
}

/** Map a named CA-2 execute error to an honest operator-facing reason. */
export function createErrorReason(err: unknown): string {
	if (err instanceof StaleProposalError) {
		return 'The brief or proposal changed since it was generated — regenerate before confirming (D-010).';
	}
	if (err instanceof ProjectExistsError) {
		return `A project already exists at ${err.projectId} — open it instead.`;
	}
	if (err instanceof UnstableSlugError) {
		return err.message;
	}
	if (err instanceof ScaffoldPathError) {
		return `A scaffold path tried to escape the project directory (D-018) — regenerate. Entry: ${err.entry}`;
	}
	if (err instanceof ScaffoldSecretError) {
		return `A scaffold file would have written a literal secret (D-026) — regenerate. File: ${err.path}`;
	}
	if (err instanceof ScaffoldFailedError) {
		return `Scaffold failed — no project was registered${err.incidentId ? ` (incident ${err.incidentId})` : ''}. ${err.message}`;
	}
	return (err as Error).message;
}

/** Map a named template-scaffold error to an honest reason (mirrors createErrorReason; CT-3). */
export function templateScaffoldErrorReason(err: unknown): string {
	if (err instanceof TemplateNotFoundError) {
		return `Unknown template '${err.templateId}' — pick one from the list and retry.`;
	}
	if (err instanceof ConcurrentCreateError) {
		return `A create for '${err.slug}' is already in progress — try again once it completes.`;
	}
	if (err instanceof PostRegisterWriterError) {
		return `Project ${err.projectId} was created but setup did not finish (marked incomplete${err.incidentId ? `, incident ${err.incidentId}` : ''}) — open it to inspect. ${err.message}`;
	}
	// Shared scaffold/slug/exists classes carry the same honest reasons as the AI path.
	return createErrorReason(err);
}
