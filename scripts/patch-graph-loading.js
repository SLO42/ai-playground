const fs = require('fs');
const filePath = 'dashboard/src/routes/memory/+page.svelte';
let content = fs.readFileSync(filePath, 'utf-8');

// Detect line ending
const eol = content.includes('\r\n') ? '\r\n' : '\n';

const old = [
  '\t\t\t{:else if graphNodes.length > 0 && BubbleGraph}',
  '\t\t\t\t<BubbleGraph nodes={graphNodes} edges={graphEdges} onNodeClick={handleNodeClick} />',
  '\t\t\t{:else if graphNodes.length > 0 || loading}',
].join(eol);

if (!content.includes(old)) {
  console.log('ERROR: old string not found');
  process.exit(1);
}

const replacement = [
  '\t\t\t{:else if graphNodes.length > 0 && BubbleGraph}',
  '\t\t\t\t<div class="relative">',
  '\t\t\t\t\t{#if loading}',
  '\t\t\t\t\t\t<div class="absolute inset-0 z-10 flex items-center justify-center bg-bg-secondary/70 rounded-lg">',
  '\t\t\t\t\t\t\t<div class="flex items-center gap-2 text-text-secondary text-sm">',
  '\t\t\t\t\t\t\t\t<svg class="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">',
  '\t\t\t\t\t\t\t\t\t<circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="3" fill="none" />',
  '\t\t\t\t\t\t\t\t\t<path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />',
  '\t\t\t\t\t\t\t\t</svg>',
  '\t\t\t\t\t\t\t\tRefreshing graph\u2026',
  '\t\t\t\t\t\t\t</div>',
  '\t\t\t\t\t\t</div>',
  '\t\t\t\t\t{/if}',
  '\t\t\t\t\t<BubbleGraph nodes={graphNodes} edges={graphEdges} onNodeClick={handleNodeClick} />',
  '\t\t\t\t</div>',
  '\t\t\t{:else if graphNodes.length > 0 || loading}',
].join(eol);

content = content.replace(old, replacement);
fs.writeFileSync(filePath, content);
console.log('Done - loading overlay added');
