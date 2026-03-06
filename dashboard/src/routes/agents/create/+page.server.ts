import type { PageServerLoad, Actions } from './$types.js';
import { readFile, writeFile, mkdir } from 'fs/promises';
import { resolve, dirname } from 'path';
import { PATHS } from '$lib/server/constants.js';
import { fail, redirect } from '@sveltejs/kit';
import { getCategories } from '$lib/server/agent-scanner.js';

const TEMPLATES: Record<string, { label: string; content: string }> = {
	basic: {
		label: 'Basic Agent',
		content: `---
name: "{NAME}"
type: general
description: "{DESCRIPTION}"
capabilities:
  - task_execution
priority: medium
---

# {NAME}

{DESCRIPTION}

## Core Responsibilities

1. Execute assigned tasks efficiently
2. Report progress and results

## Guidelines

- Follow project conventions
- Validate inputs before processing
- Handle errors gracefully
`
	},
	coder: {
		label: 'Coder Agent',
		content: `---
name: "{NAME}"
type: developer
description: "{DESCRIPTION}"
capabilities:
  - code_generation
  - refactoring
  - optimization
priority: high
---

# {NAME}

{DESCRIPTION}

## Core Responsibilities

1. Write clean, maintainable code
2. Follow project coding standards
3. Write tests for new functionality

## Guidelines

- Use TypeScript with strict typing
- Follow SOLID principles
- Write unit tests first (TDD)
- Keep functions small and focused
`
	},
	researcher: {
		label: 'Researcher Agent',
		content: `---
name: "{NAME}"
type: researcher
description: "{DESCRIPTION}"
capabilities:
  - information_gathering
  - analysis
  - summarization
priority: medium
---

# {NAME}

{DESCRIPTION}

## Core Responsibilities

1. Gather relevant information
2. Analyze findings
3. Produce clear summaries

## Guidelines

- Verify information from multiple sources
- Present findings in structured format
- Note confidence levels for conclusions
`
	},
	coordinator: {
		label: 'Coordinator Agent',
		content: `---
name: "{NAME}"
type: coordinator
description: "{DESCRIPTION}"
capabilities:
  - task_delegation
  - progress_tracking
  - coordination
priority: high
---

# {NAME}

{DESCRIPTION}

## Core Responsibilities

1. Break down complex tasks
2. Delegate to specialized agents
3. Track progress and synthesize results

## Guidelines

- Assign tasks based on agent capabilities
- Monitor progress checkpoints
- Resolve conflicts between agents
`
	}
};

export const load: PageServerLoad = async () => {
	const categories = await getCategories();
	const templates = Object.entries(TEMPLATES).map(([id, t]) => ({ id, label: t.label }));
	return { categories, templates };
};

export const actions: Actions = {
	default: async ({ request }) => {
		const formData = await request.formData();
		const name = (formData.get('name') as string)?.trim();
		const description = (formData.get('description') as string)?.trim();
		const category = (formData.get('category') as string)?.trim();
		const template = (formData.get('template') as string) || 'basic';

		if (!name) return fail(400, { error: 'Name is required' });
		if (!category) return fail(400, { error: 'Category is required' });

		const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
		const filename = `${category}/${slug}.md`;
		const agentPath = resolve(PATHS.agentsDir, filename);

		try {
			await readFile(agentPath, 'utf-8');
			return fail(409, { error: `Agent file already exists: ${filename}` });
		} catch {
			// Good, file doesn't exist
		}

		const tmpl = TEMPLATES[template] ?? TEMPLATES.basic;
		const content = tmpl.content
			.replace(/\{NAME\}/g, name)
			.replace(/\{DESCRIPTION\}/g, description || 'No description provided');

		await mkdir(dirname(agentPath), { recursive: true });
		await writeFile(agentPath, content, 'utf-8');

		redirect(303, `/agents/${filename}`);
	}
};
