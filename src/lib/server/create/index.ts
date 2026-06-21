// server/create — public barrel for Create-with-AI (CREATE-SPEC).
//
// CA-1 = the generative PLAN half: a confirm-gated, EPHEMERAL creation proposal. NOTHING here
// touches disk or writes the DB (the only DB read is the defect-class vocabulary for enum
// validation). The execute half (scaffold + scanner ingest + plan/tasks/targets writers) is CA-2.

export {
	BANNED_SYCOPHANCY_PHRASES,
	scanForSycophancy,
	hasSycophancy,
	assertNoSycophancy,
	SycophancyError,
	type SycophancyHit,
	type SycophancyScan
} from './anti-sycophancy';

export {
	generateCreationProposal,
	validateProposal,
	computeConfirmToken,
	assertProposalFresh,
	briefHintsFromTemplate,
	ProposalContractError,
	SecretEchoError,
	StaleProposalError,
	ProposalPathError,
	type CreateBrief,
	type CreateHints,
	type CreationProposal,
	type CreationProposalEnvelope,
	type PlanMacroDraft,
	type FoundingTaskDraft,
	type TargetDraft,
	type CapabilityNeedsDraft,
	type Clarifier,
	type ProposalGenerator
} from './plan';

export {
	makeProposalAgent,
	parseProposalOutput,
	buildPrompt,
	resolveTemplateContext,
	type ProposalAgentDeps
} from './agent';

export {
	createProposalRun,
	attachSession,
	markProposalDone,
	markProposalFailed,
	getProposalRun,
	runProposalInBackground,
	type ProposalRun,
	type ProposalRunStatus
} from './proposal-run';

export {
	executeCreation,
	executeTemplateCreation,
	resumeCreation,
	ProjectExistsError,
	UnstableSlugError,
	ScaffoldPathError,
	ScaffoldSecretError,
	ScaffoldFailedError,
	ConcurrentCreateError,
	PostRegisterWriterError,
	AutonomousArmWithoutPmError,
	TemplateNotFoundError,
	ResumeProjectNotFoundError,
	ResumeNotIncompleteError,
	ResumeScaffoldMissingError,
	type ExecuteCreationOptions,
	type ExecuteCreationResult,
	type ExecuteTemplateCreationOptions,
	type ExecuteTemplateCreationResult,
	type ResumeCreationOptions,
	type ResumeCreationResult
} from './execute';

export {
	getTemplate,
	listTemplateMetadata,
	toTemplateMetadata,
	registry as templateRegistry,
	BEPINEX_GAME_CONFIGS,
	type ProjectTemplate,
	type TemplateMetadata,
	type TemplateParam
} from './templates';
