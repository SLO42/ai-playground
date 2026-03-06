import type { McpToolGroup } from '$lib/types/mcp.js';

/**
 * Known tool definitions per MCP server.
 * Each server maps to categories of tools it exposes.
 * Update this when servers add/remove tools.
 */
const SERVER_TOOLS: Record<string, McpToolGroup[]> = {
	'claude-flow': [
		{
			category: 'Swarm',
			tools: [
				'swarm_init', 'swarm_status', 'swarm_shutdown', 'swarm_health'
			]
		},
		{
			category: 'Agents',
			tools: [
				'agent_spawn', 'agent_list', 'agent_terminate', 'agent_status',
				'agent_health', 'agent_pool', 'agent_update'
			]
		},
		{
			category: 'Memory',
			tools: [
				'memory_store', 'memory_search', 'memory_retrieve',
				'memory_list', 'memory_delete', 'memory_stats', 'memory_migrate'
			]
		},
		{
			category: 'Intelligence',
			tools: [
				'hooks_intelligence', 'hooks_intelligence_learn',
				'hooks_intelligence_pattern-search', 'hooks_intelligence_pattern-store',
				'hooks_intelligence_stats', 'hooks_intelligence_attention',
				'hooks_intelligence_trajectory-start', 'hooks_intelligence_trajectory-step',
				'hooks_intelligence_trajectory-end'
			]
		},
		{
			category: 'Neural',
			tools: [
				'neural_train', 'neural_predict', 'neural_patterns',
				'neural_status', 'neural_optimize', 'neural_compress'
			]
		},
		{
			category: 'Security',
			tools: [
				'aidefence_scan', 'aidefence_analyze', 'aidefence_is_safe',
				'aidefence_has_pii', 'aidefence_learn', 'aidefence_stats',
				'claims_claim', 'claims_release', 'claims_status', 'claims_list',
				'transfer_detect-pii'
			]
		},
		{
			category: 'Tasks',
			tools: [
				'task_create', 'task_list', 'task_status',
				'task_update', 'task_complete', 'task_cancel'
			]
		},
		{
			category: 'Workflows',
			tools: [
				'workflow_create', 'workflow_execute', 'workflow_status',
				'workflow_list', 'workflow_pause', 'workflow_resume',
				'workflow_cancel', 'workflow_delete', 'workflow_template'
			]
		},
		{
			category: 'Sessions',
			tools: [
				'session_save', 'session_restore', 'session_list',
				'session_info', 'session_delete'
			]
		},
		{
			category: 'Hooks',
			tools: [
				'hooks_init', 'hooks_list', 'hooks_metrics', 'hooks_explain',
				'hooks_pre-task', 'hooks_post-task', 'hooks_pre-edit', 'hooks_post-edit',
				'hooks_pre-command', 'hooks_post-command',
				'hooks_session-start', 'hooks_session-end', 'hooks_session-restore',
				'hooks_notify', 'hooks_route', 'hooks_transfer', 'hooks_build-agents', 'hooks_pretrain'
			]
		},
		{
			category: 'Coordination',
			tools: [
				'coordination_orchestrate', 'coordination_sync', 'coordination_consensus',
				'coordination_node', 'coordination_topology', 'coordination_load_balance',
				'coordination_metrics'
			]
		},
		{
			category: 'Hive Mind',
			tools: [
				'hive-mind_init', 'hive-mind_join', 'hive-mind_leave',
				'hive-mind_broadcast', 'hive-mind_consensus',
				'hive-mind_memory', 'hive-mind_status', 'hive-mind_shutdown', 'hive-mind_spawn'
			]
		},
		{
			category: 'Embeddings',
			tools: [
				'embeddings_init', 'embeddings_generate', 'embeddings_search',
				'embeddings_compare', 'embeddings_status',
				'embeddings_neural', 'embeddings_hyperbolic'
			]
		},
		{
			category: 'System',
			tools: [
				'system_health', 'system_info', 'system_metrics',
				'system_status', 'system_reset'
			]
		},
		{
			category: 'Performance',
			tools: [
				'performance_metrics', 'performance_profile', 'performance_benchmark',
				'performance_optimize', 'performance_bottleneck', 'performance_report'
			]
		},
		{
			category: 'Config',
			tools: [
				'config_get', 'config_set', 'config_list',
				'config_reset', 'config_export', 'config_import'
			]
		},
		{
			category: 'GitHub',
			tools: [
				'github_repo_analyze', 'github_pr_manage', 'github_issue_track',
				'github_metrics', 'github_workflow'
			]
		},
		{
			category: 'Analysis',
			tools: [
				'analyze_diff', 'analyze_diff-risk', 'analyze_diff-stats',
				'analyze_diff-classify', 'analyze_diff-reviewers', 'analyze_file-risk'
			]
		},
		{
			category: 'Browser',
			tools: [
				'browser_open', 'browser_click', 'browser_fill', 'browser_type',
				'browser_snapshot', 'browser_screenshot', 'browser_close',
				'browser_hover', 'browser_scroll', 'browser_press',
				'browser_eval', 'browser_select', 'browser_check', 'browser_uncheck',
				'browser_wait', 'browser_reload', 'browser_back', 'browser_forward',
				'browser_get-text', 'browser_get-title', 'browser_get-url', 'browser_get-value',
				'browser_session-list'
			]
		},
		{
			category: 'Model Routing',
			tools: [
				'hooks_model-route', 'hooks_model-outcome', 'hooks_model-stats'
			]
		},
		{
			category: 'AgentDB',
			tools: [
				'agentdb_batch', 'agentdb_health', 'agentdb_route', 'agentdb_consolidate',
				'agentdb_feedback', 'agentdb_controllers',
				'agentdb_hierarchical-store', 'agentdb_hierarchical-recall',
				'agentdb_context-synthesize', 'agentdb_causal-edge',
				'agentdb_pattern-store', 'agentdb_pattern-search',
				'agentdb_semantic-route', 'agentdb_session-start', 'agentdb_session-end'
			]
		},
		{
			category: 'DAA',
			tools: [
				'daa_agent_create', 'daa_agent_adapt', 'daa_cognitive_pattern',
				'daa_knowledge_share', 'daa_learning_status', 'daa_performance_metrics',
				'daa_workflow_create', 'daa_workflow_execute'
			]
		},
		{
			category: 'Workers',
			tools: [
				'hooks_worker-dispatch', 'hooks_worker-status',
				'hooks_worker-list', 'hooks_worker-cancel', 'hooks_worker-detect'
			]
		},
		{
			category: 'Progress',
			tools: [
				'progress_check', 'progress_summary', 'progress_sync', 'progress_watch'
			]
		},
		{
			category: 'Transfer',
			tools: [
				'transfer_detect-pii', 'transfer_ipfs-resolve',
				'transfer_plugin-search', 'transfer_plugin-info',
				'transfer_plugin-featured', 'transfer_plugin-official',
				'transfer_store-search', 'transfer_store-info',
				'transfer_store-download', 'transfer_store-featured', 'transfer_store-trending'
			]
		},
		{
			category: 'Terminal',
			tools: [
				'terminal_create', 'terminal_execute', 'terminal_list',
				'terminal_history', 'terminal_close'
			]
		}
	],
	playwright: [
		{
			category: 'Playwright Browser',
			tools: [
				'browser_navigate', 'browser_navigate_back', 'browser_click',
				'browser_fill_form', 'browser_type', 'browser_press_key',
				'browser_hover', 'browser_drag', 'browser_select_option',
				'browser_take_screenshot', 'browser_snapshot', 'browser_tabs',
				'browser_close', 'browser_resize', 'browser_evaluate',
				'browser_run_code', 'browser_file_upload', 'browser_handle_dialog',
				'browser_wait_for', 'browser_console_messages', 'browser_network_requests',
				'browser_install'
			]
		}
	]
};

/**
 * Build tool catalog from configured MCP servers.
 * Only includes tools for servers that are actually configured.
 */
export function buildToolCatalog(serverNames: string[]): McpToolGroup[] {
	const catalog: McpToolGroup[] = [];

	for (const name of serverNames) {
		const groups = SERVER_TOOLS[name];
		if (groups) {
			for (const group of groups) {
				catalog.push({
					category: `${group.category}`,
					tools: group.tools.map((t) => `${name}__${t}`)
				});
			}
		}
	}

	return catalog;
}
