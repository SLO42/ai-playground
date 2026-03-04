<script lang="ts">
	import { redirect } from '@sveltejs/kit';
</script>

<!-- Overview page — shows quick summary -->
<div class="space-y-6">
	<div>
		<h1 class="text-xl font-bold text-text-primary">Project Overview</h1>
		<p class="text-sm text-text-secondary mt-1">Quick summary and navigation</p>
	</div>

	<div class="grid grid-cols-2 md:grid-cols-4 gap-4">
		<a href="about" class="bg-bg-secondary border border-border rounded-lg p-4 hover:border-accent-blue/50 transition-colors">
			<p class="text-xs text-text-secondary uppercase tracking-wider">About</p>
			<p class="text-sm text-text-primary mt-1">Stack & config</p>
		</a>
		<a href="services" class="bg-bg-secondary border border-border rounded-lg p-4 hover:border-accent-blue/50 transition-colors">
			<p class="text-xs text-text-secondary uppercase tracking-wider">Services</p>
			<p class="text-sm text-text-primary mt-1">Running processes</p>
		</a>
		<a href="agents" class="bg-bg-secondary border border-border rounded-lg p-4 hover:border-accent-blue/50 transition-colors">
			<p class="text-xs text-text-secondary uppercase tracking-wider">Agents</p>
			<p class="text-sm text-text-primary mt-1">Spawned agents</p>
		</a>
		<a href="sessions" class="bg-bg-secondary border border-border rounded-lg p-4 hover:border-accent-blue/50 transition-colors">
			<p class="text-xs text-text-secondary uppercase tracking-wider">Sessions</p>
			<p class="text-sm text-text-primary mt-1">Active workflows</p>
		</a>
		<a href="memory" class="bg-bg-secondary border border-border rounded-lg p-4 hover:border-accent-blue/50 transition-colors">
			<p class="text-xs text-text-secondary uppercase tracking-wider">Memory</p>
			<p class="text-sm text-text-primary mt-1">HNSW nodes</p>
		</a>
		<a href="hooks" class="bg-bg-secondary border border-border rounded-lg p-4 hover:border-accent-blue/50 transition-colors">
			<p class="text-xs text-text-secondary uppercase tracking-wider">Hooks</p>
			<p class="text-sm text-text-primary mt-1">Self-learning</p>
		</a>
		<a href="security" class="bg-bg-secondary border border-border rounded-lg p-4 hover:border-accent-blue/50 transition-colors">
			<p class="text-xs text-text-secondary uppercase tracking-wider">Security</p>
			<p class="text-sm text-text-primary mt-1">Audit & policies</p>
		</a>
		<a href="settings" class="bg-bg-secondary border border-border rounded-lg p-4 hover:border-accent-blue/50 transition-colors">
			<p class="text-xs text-text-secondary uppercase tracking-wider">Settings</p>
			<p class="text-sm text-text-primary mt-1">Configuration</p>
		</a>
	</div>
</div>
