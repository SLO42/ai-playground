/**
 * Publisher registry.
 *
 * Central lookup for all registered release publishers. Provides
 * auto-detection of applicable publishers based on project metadata
 * (detected dependencies, frameworks, etc.).
 */
import type { DetectedProjectMeta } from '$lib/types/projects.js';
import type { ReleasePublisher } from './types.js';
import { githubPublisher } from './github.js';
import { thunderstorePublisher } from './thunderstore.js';
import { curseforgePublisher } from './curseforge.js';
import { nexusPublisher } from './nexus.js';
import { npmPublisher } from './npm-publish.js';

// ── Registry ────────────────────────────────────────────────────────

const publishers = new Map<string, ReleasePublisher>();

function register(publisher: ReleasePublisher): void {
	publishers.set(publisher.id, publisher);
}

// Register all built-in publishers
register(githubPublisher);
register(thunderstorePublisher);
register(curseforgePublisher);
register(nexusPublisher);
register(npmPublisher);

// ── Public API ──────────────────────────────────────────────────────

/** Look up a publisher by platform ID. */
export function getPublisher(platform: string): ReleasePublisher | null {
	// Direct lookup
	const direct = publishers.get(platform);
	if (direct) return direct;

	// Search by platform alias
	for (const pub of publishers.values()) {
		if (pub.platforms.includes(platform)) return pub;
	}

	return null;
}

/** Return all registered publishers. */
export function getAllPublishers(): ReleasePublisher[] {
	return [...publishers.values()];
}

/**
 * Auto-detect which publishers are relevant for a project based on its
 * detected metadata (dependencies, framework, language, etc.).
 *
 * Detection rules:
 * - BepInEx dependency       -> Thunderstore
 * - Fabric/Forge/NeoForge    -> CurseForge/Modrinth
 * - BG3 / Baldur's Gate 3    -> Nexus Mods
 * - Skyrim / Fallout / Starfield -> Nexus Mods
 * - Node.js / npm package    -> npm
 * - Any git repo with remote -> GitHub Releases
 */
export function getPublishersForProject(projectMeta: DetectedProjectMeta): ReleasePublisher[] {
	const matched: ReleasePublisher[] = [];
	const depNames = new Set(projectMeta.dependencies.map((d) => d.name.toLowerCase()));
	const framework = (projectMeta.framework ?? '').toLowerCase();
	const language = (projectMeta.language ?? '').toLowerCase();

	// BepInEx -> Thunderstore (Unity modding)
	const bepinexIndicators = ['bepinex', 'bepinex.core', 'bepinexpack'];
	if (bepinexIndicators.some((ind) => depNames.has(ind))) {
		matched.push(thunderstorePublisher);
	}

	// Fabric / Forge / NeoForge / Quilt -> CurseForge + Modrinth
	const mcModIndicators = ['fabric', 'forge', 'neoforge', 'quilt', 'fabric-api', 'fabricloader'];
	if (
		mcModIndicators.some((ind) => depNames.has(ind)) ||
		['fabric', 'forge', 'neoforge', 'quilt'].includes(framework)
	) {
		matched.push(curseforgePublisher);
	}

	// BG3, Skyrim, Fallout, Starfield -> Nexus Mods
	const nexusIndicators = [
		'bg3', 'baldursgate3', 'baldurs-gate-3',
		'skyrim', 'skyrimse', 'fallout4', 'fallout76', 'starfield',
		'nativedb', 'lslib', 'bg3-modding'
	];
	if (nexusIndicators.some((ind) => depNames.has(ind))) {
		matched.push(nexusPublisher);
	}

	// Also check tags/techStack from the project for nexus game hints
	const allTags = [
		...(projectMeta.dependencies.map((d) => d.name.toLowerCase())),
		framework,
		language
	];
	const nexusGameHints = ['bg3', 'baldursgate3', 'skyrim', 'fallout', 'starfield', 'nexus'];
	if (nexusGameHints.some((hint) => allTags.some((tag) => tag.includes(hint)))) {
		if (!matched.includes(nexusPublisher)) {
			matched.push(nexusPublisher);
		}
	}

	// Node.js / npm packages
	if (
		language === 'javascript' || language === 'typescript' ||
		framework === 'node' || framework === 'sveltekit' || framework === 'next' ||
		depNames.has('node') || depNames.has('npm')
	) {
		matched.push(npmPublisher);
	}

	// GitHub Releases — available for any project with a git remote
	if (projectMeta.gitRemote) {
		matched.push(githubPublisher);
	}

	return matched;
}

/** Register a custom publisher at runtime. */
export function registerPublisher(publisher: ReleasePublisher): void {
	register(publisher);
}
