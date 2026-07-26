// server/sessions — session launch + persistence plumbing (TASK 1.6b; D-011).
export {
	launchSession,
	type LaunchInput,
	type LaunchResult,
	type LaunchDeps,
	type SessionStatus
} from './launch';

// TASK 6.7 — transcript read-side for the Sessions surface (historical messages; live
// streaming rides the `transcript` bus event, §2.11).
export { listSessionMessages, type TranscriptMessage } from './messages';

// SPAWN-IDENTITY — the purposeful `session.agent` name for every non-drain spawn seam, so a row is
// born saying WHAT ran it instead of which tier bucket did (operator naming rule, 2026-07-26).
export {
	spawnIdentity,
	SPAWN_IDENTITIES,
	type SpawnIdentity,
	type SpawnIdentityKey
} from './spawn-identity';
