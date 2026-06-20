// server/scene — public barrel (MEMORY-SCENE-SPEC §5/§7.1).
//
// The scene_event projection writer + its bus wiring. The node/edge TRUTH still
// derives LIVE from the source tables (§2/§3) — this module owns ONLY the derived,
// append-only, rolling activity feed (the §7.2 aggregator + the §7.3 UI are separate
// later waves).

export {
	SceneProjector,
	appendSceneEvent,
	pruneSceneEvents,
	screenSceneMeta,
	SCENE_EVENT_CAP,
	type SceneEventKind,
	type AppendSceneEventInput,
	type SceneProjectorOptions
} from './projector';

// §7.2 — the read-only node/edge AGGREGATOR (the scene's TRUTH, derived live; F-008).
export {
	buildSceneGraph,
	listSceneEvents,
	type SceneGraph,
	type SceneNode,
	type SceneEdge,
	type SceneNodeClass,
	type SceneGraphLimits,
	type SceneEvent
} from './scene';
