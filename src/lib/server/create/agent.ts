// server/create/agent.ts — the PRODUCTION agent leg for the CA-1 proposal generator.
//
// Wraps launchSession (sessions/launch.ts) as a ProposalGenerator: it runs a CHEAP-TIER,
// READ-ONLY session whose prompt instructs the agent to emit the structured proposal as a single
// fenced ```json block, then parses that block. The READ-ONLY guarantee is the toolPolicy allow-
// list (no Edit/Write/Bash-write — D-018/F-008: this leg NEVER scaffolds; CA-2 does, gated). For
// §2.1 greenfield-with-reference the prompt MAY read a reference repo as prior art; it still
// generates a FRESH layout (fork 1 LOCKED greenfield — NOT adoption).
//
// Unit tests do NOT use this — they inject a stub ProposalGenerator (no creds/network/spend),
// mirroring how launchSession's own tests script the CcBackend. This adapter is the thin real
// wiring; the structured-output PARSER (parseProposalOutput) is pure and IS unit-tested.

import type { Db } from '../db/client';
import type { EventBus } from '../events/bus';
import type { AgentRuntime } from '../runtime/index';
import { launchSession, type LaunchInput } from '../sessions/launch';
import type { CreateBrief, ProposalGenerator } from './plan';
import { ProposalContractError } from './plan';

/** Inputs the production proposal agent needs beyond the brief. */
export interface ProposalAgentDeps {
	db: Db;
	bus: EventBus;
	runtime: AgentRuntime;
	/**
	 * The HOST project id the read-only proposal session runs under (its root_path becomes the
	 * session cwd — launchSession requires an existing project to resolve cwd; CA-1's flow has no
	 * project yet). A dedicated scratch/host project; the agent writes NOTHING under it (read-only).
	 */
	hostProjectId: string;
	/** The agent slot id the session runs as. */
	agentId: string;
	/** Cheap-tier model selection (opus-everywhere model id, cheap tier). */
	model: LaunchInput['model'];
}

/**
 * Parse the structured proposal JSON out of the agent's final summary text. The contract: the
 * agent emits the proposal as the LAST fenced ```json block (the SAME carrier convention
 * pm-panel's verdict parser uses), with an outermost-braces fallback so a fence-less but honest
 * reply still parses.
 *
 * Shadow paths each fail LOUD with the channel named (never silence-as-success):
 *   • nil/empty text → ProposalContractError ('EMPTY output');
 *   • text with no JSON block → ProposalContractError ('no JSON block');
 *   • a JSON block that does not parse → ProposalContractError ('malformed JSON').
 * The SHAPE is then proven by validateProposal downstream — this only extracts the object.
 */
export function parseProposalOutput(text: string | null | undefined): unknown {
	if (!text || !text.trim()) {
		throw new ProposalContractError('proposal contract violated: the agent produced EMPTY output');
	}
	const fences = [...text.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)].map((m) => m[1]);
	let candidate: string | undefined = fences.length > 0 ? fences[fences.length - 1] : undefined;
	if (candidate === undefined) {
		// Fallback: the outermost {...} span.
		const first = text.indexOf('{');
		const last = text.lastIndexOf('}');
		if (first !== -1 && last > first) candidate = text.slice(first, last + 1);
	}
	if (candidate === undefined) {
		throw new ProposalContractError(
			'proposal contract violated: no JSON block found in the agent output'
		);
	}
	try {
		return JSON.parse(candidate);
	} catch (e) {
		throw new ProposalContractError(
			`proposal contract violated: the JSON block did not parse — ${(e as Error).message}`
		);
	}
}

/** The read-only tool allow-list for the proposal session (NO write tools — D-018/F-008). */
const READ_ONLY_TOOLS = ['Read', 'Grep', 'Glob', 'WebFetch'] as const;

/** Build the prompt that instructs the agent to emit the structured proposal contract. */
function buildPrompt(brief: CreateBrief): { title: string; description: string } {
	const hints = brief.hints ?? {};
	const hintLines = [
		hints.ecosystem ? `- ecosystem hint: ${hints.ecosystem}` : '',
		hints.targetPlatform ? `- target platform hint: ${hints.targetPlatform}` : '',
		hints.refRepoUrl ? `- reference repo (read-only PRIOR ART, generate FRESH — NOT adopt): ${hints.refRepoUrl}` : ''
	]
		.filter(Boolean)
		.join('\n');
	const description = [
		`Produce a CREATION PROPOSAL for a new project. READ-ONLY: you scaffold NOTHING.`,
		`Brief name: ${brief.name}`,
		`Brief description: ${brief.description}`,
		hintLines ? `Hints:\n${hintLines}` : '',
		``,
		`Emit ONE fenced \`\`\`json block with: dirLayout[], stack[], planMacro{purpose,vision,role,definition_of_done}, foundingTasks[3-7]{objective,purpose}, targetDrafts[]{kind,adapterId,config}, capabilityNeeds{languages[],frameworks[],defect_classes[]}, optional pmCharterDraft, clarifiers[0-4]{question,position,falsifier}.`,
		`TAKE POSITIONS (CREATE-SPEC §3): no hedging phrases; every clarifier pairs a position with its falsifier. Config references env NAMES only (D-026), never secret values.`
	]
		.filter((l) => l !== '')
		.join('\n');
	return { title: `Create-with-AI proposal: ${brief.name}`, description };
}

/**
 * Build a production ProposalGenerator that runs the read-only cheap-tier session and parses its
 * structured output. The returned function is what `generateCreationProposal` calls; it surfaces
 * the runtime's own error (env/timeout) UNSWALLOWED — never reported as a phantom success.
 */
export function makeProposalAgent(deps: ProposalAgentDeps): ProposalGenerator {
	return async (brief: CreateBrief): Promise<unknown> => {
		const prompt = buildPrompt(brief);
		const input: LaunchInput = {
			projectId: deps.hostProjectId,
			// No real task — a synthetic prompt task (D-013 shape), so nothing is written to `task`.
			promptTask: { id: `create_proposal_${Date.now()}`, title: prompt.title, description: prompt.description },
			agentId: deps.agentId,
			model: deps.model,
			intent: 'deep-explore',
			budgets: { thinking: 'high', toolCalls: 30, concurrency: 1 },
			// READ-ONLY: allow-list carries no write/exec tools (D-018). WebSearch is NOT granted.
			toolPolicy: { allow: [...READ_ONLY_TOOLS] }
		};
		const res = await launchSession({ db: deps.db, bus: deps.bus, runtime: deps.runtime, input });
		if (res.status !== 'done') {
			throw new ProposalContractError(
				`proposal session ended '${res.status}' (not 'done') — no proposal produced. summary: ${res.summary}`
			);
		}
		return parseProposalOutput(res.summary);
	};
}
