/**
 * Pluggable release publisher types.
 *
 * Every platform publisher implements the `ReleasePublisher` interface,
 * enabling uniform validation, dry-run, and publish across targets.
 */

export interface ReleasePublisher {
	/** Unique identifier (e.g., 'github', 'thunderstore') */
	id: string;
	/** Human-readable name */
	name: string;
	/** Platform slugs this publisher handles */
	platforms: string[];
	/** Validate publisher-specific configuration before attempting publish */
	validate(config: PublisherConfig): PublisherValidation;
	/** Publish a release. When dryRun is true, validate and package but do not upload. */
	publish(release: ReleaseInfo, config: PublisherConfig, dryRun?: boolean): Promise<PublishResult>;
}

export interface PublisherConfig {
	authToken?: string;
	namespace?: string;
	/** Platform-specific overrides */
	[key: string]: unknown;
}

export interface ReleaseInfo {
	version: string;
	changelog: string;
	/** Absolute file paths to publish */
	artifacts: string[];
	projectPath: string;
	projectName: string;
}

export interface PublishResult {
	success: boolean;
	url?: string;
	error?: string;
	platform: string;
	/** True when dry-run mode was used */
	dryRun?: boolean;
}

export interface PublisherValidation {
	valid: boolean;
	errors: string[];
}
