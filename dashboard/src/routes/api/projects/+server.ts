import { json } from '@sveltejs/kit';
import { resolve } from 'path';
import { readFile, writeFile, access, mkdir } from 'fs/promises';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { PATHS } from '$lib/server/constants.js';
import { scanAllProjects, scanProject } from '$lib/server/project-scanner.js';
import type { ProjectRegistry, PlaygroundConfig } from '$lib/types/projects.js';

const execFileAsync = promisify(execFile);

const favoritesPath = resolve(PATHS.root, '.playground/favorites.json');

async function readFavorites(): Promise<string[]> {
	try {
		const raw = await readFile(favoritesPath, 'utf-8');
		const data = JSON.parse(raw);
		return Array.isArray(data) ? data : [];
	} catch {
		return [];
	}
}

async function writeFavorites(ids: string[]): Promise<void> {
	await mkdir(resolve(favoritesPath, '..'), { recursive: true });
	await writeFile(favoritesPath, JSON.stringify(ids, null, '\t'), 'utf-8');
}

export async function GET({ url }) {
	const projects = await scanAllProjects(PATHS.playgroundRegistry, PATHS.root);
	const favorites = await readFavorites();

	for (const p of projects) {
		p.favorite = favorites.includes(p.id);
	}

	return json({ projects, favorites });
}

export async function PATCH({ request }) {
	const body = await request.json();
	const { id, favorite } = body as { id: string; favorite: boolean };

	if (!id || typeof favorite !== 'boolean') {
		return json({ error: 'id and favorite (boolean) are required' }, { status: 400 });
	}

	const favorites = await readFavorites();
	const idx = favorites.indexOf(id);

	if (favorite && idx === -1) {
		favorites.push(id);
	} else if (!favorite && idx !== -1) {
		favorites.splice(idx, 1);
	}

	await writeFavorites(favorites);
	return json({ ok: true, favorites });
}

interface CreateProjectBody {
	name: string;
	path: string;
	template: string;
	description?: string;
	initGit?: boolean;
	createGithub?: boolean;
	primaryModel?: string;
	escalation?: string;
	memoryNamespace?: string;
	isolateMemory?: boolean;
	sharePatterns?: boolean;
	maxAgents?: number;
	topology?: string;
	services?: string[];
}

/** Template file generators keyed by template ID */
const TEMPLATES: Record<string, (name: string, description: string) => Record<string, string>> = {
	blank: (name, description) => ({
		'CLAUDE.md': `# ${name}\n\n${description || 'A new project.'}\n`,
		'.gitignore': 'node_modules/\n.env\n.playground/\n'
	}),
	sveltekit: (name, description) => ({
		'CLAUDE.md': `# ${name}\n\n${description || 'SvelteKit project.'}\n\n## Stack\n- SvelteKit + TypeScript\n- TailwindCSS\n`,
		'package.json': JSON.stringify({
			name,
			version: '0.0.1',
			private: true,
			description: description || '',
			type: 'module',
			scripts: {
				dev: 'vite dev',
				build: 'vite build',
				preview: 'vite preview'
			},
			devDependencies: {
				'@sveltejs/adapter-auto': '^6.0.0',
				'@sveltejs/kit': '^2.0.0',
				svelte: '^5.0.0',
				typescript: '^5.0.0',
				vite: '^6.0.0'
			}
		}, null, '\t'),
		'svelte.config.js': `import adapter from '@sveltejs/adapter-auto';\n\nexport default {\n\tkit: { adapter: adapter() }\n};\n`,
		'tsconfig.json': '{\n\t"extends": "./.svelte-kit/tsconfig.json"\n}\n',
		'.env.example': '# Environment variables\n',
		'.gitignore': 'node_modules/\n.svelte-kit/\nbuild/\n.env\n.playground/\n',
		'src/routes/+page.svelte': `<h1>Welcome to ${name}</h1>\n`
	}),
	nextjs: (name, description) => ({
		'CLAUDE.md': `# ${name}\n\n${description || 'Next.js project.'}\n\n## Stack\n- Next.js 15 App Router\n- TypeScript\n`,
		'package.json': JSON.stringify({
			name,
			version: '0.0.1',
			private: true,
			description: description || '',
			scripts: {
				dev: 'next dev',
				build: 'next build',
				start: 'next start'
			},
			dependencies: {
				next: '^15.0.0',
				react: '^19.0.0',
				'react-dom': '^19.0.0'
			},
			devDependencies: {
				typescript: '^5.0.0',
				'@types/react': '^19.0.0'
			}
		}, null, '\t'),
		'tsconfig.json': JSON.stringify({
			compilerOptions: {
				target: 'ES2017',
				lib: ['dom', 'dom.iterable', 'esnext'],
				jsx: 'preserve',
				module: 'esnext',
				moduleResolution: 'bundler',
				strict: true,
				esModuleInterop: true
			},
			include: ['**/*.ts', '**/*.tsx'],
			exclude: ['node_modules']
		}, null, '\t'),
		'next.config.ts': 'import type { NextConfig } from "next";\n\nconst config: NextConfig = {};\nexport default config;\n',
		'.env.example': '# Environment variables\n',
		'.gitignore': 'node_modules/\n.next/\nout/\n.env\n.playground/\n',
		'app/page.tsx': `export default function Home() {\n\treturn <h1>Welcome to ${name}</h1>;\n}\n`,
		'app/layout.tsx': `export const metadata = { title: '${name}' };\n\nexport default function RootLayout({ children }: { children: React.ReactNode }) {\n\treturn <html><body>{children}</body></html>;\n}\n`
	}),
	python: (name, description) => ({
		'CLAUDE.md': `# ${name}\n\n${description || 'Python project.'}\n\n## Stack\n- Python + FastAPI\n- uv package manager\n`,
		'pyproject.toml': `[project]\nname = "${name}"\nversion = "0.1.0"\ndescription = "${description || ''}"\nrequires-python = ">=3.11"\ndependencies = ["fastapi", "uvicorn"]\n\n[build-system]\nrequires = ["hatchling"]\nbuild-backend = "hatchling.build"\n`,
		'src/__init__.py': '',
		'src/main.py': `from fastapi import FastAPI\n\napp = FastAPI(title="${name}")\n\n@app.get("/")\ndef root():\n    return {"message": "Hello from ${name}"}\n`,
		'.env.example': '# Environment variables\n',
		'.gitignore': '__pycache__/\n*.pyc\n.venv/\n.env\n.playground/\ndist/\n',
		'.python-version': '3.13\n'
	}),
	fullstack: (name, description) => ({
		'CLAUDE.md': `# ${name}\n\n${description || 'Full-stack monorepo.'}\n\n## Stack\n- Frontend: SvelteKit + TypeScript\n- Backend: Python + FastAPI\n`,
		'package.json': JSON.stringify({
			name,
			version: '0.0.1',
			private: true,
			description: description || '',
			scripts: { dev: 'npm run dev:frontend & npm run dev:backend', 'dev:frontend': 'cd frontend && npm run dev', 'dev:backend': 'cd backend && uvicorn src.main:app --reload' }
		}, null, '\t'),
		'frontend/package.json': JSON.stringify({ name: `${name}-frontend`, version: '0.0.1', private: true, type: 'module', scripts: { dev: 'vite dev', build: 'vite build' }, devDependencies: { '@sveltejs/kit': '^2.0.0', svelte: '^5.0.0', vite: '^6.0.0' } }, null, '\t'),
		'frontend/svelte.config.js': `import adapter from '@sveltejs/adapter-auto';\nexport default { kit: { adapter: adapter() } };\n`,
		'backend/pyproject.toml': `[project]\nname = "${name}-backend"\nversion = "0.1.0"\ndependencies = ["fastapi", "uvicorn"]\n`,
		'backend/src/__init__.py': '',
		'backend/src/main.py': `from fastapi import FastAPI\n\napp = FastAPI(title="${name}")\n\n@app.get("/")\ndef root():\n    return {"message": "Hello from ${name}"}\n`,
		'.env.example': '# Environment variables\n',
		'.gitignore': 'node_modules/\n__pycache__/\n*.pyc\n.venv/\n.svelte-kit/\nbuild/\n.env\n.playground/\n'
	}),
	agent: (name, description) => ({
		'CLAUDE.md': `# ${name}\n\n${description || 'Claude Agent project.'}\n\n## Stack\n- Claude Agent SDK\n- MCP Server\n`,
		'package.json': JSON.stringify({
			name,
			version: '0.0.1',
			private: true,
			description: description || '',
			type: 'module',
			scripts: { start: 'node src/index.js', dev: 'node --watch src/index.js' },
			dependencies: { '@anthropic-ai/sdk': '^0.30.0' }
		}, null, '\t'),
		'tsconfig.json': JSON.stringify({ compilerOptions: { target: 'ES2022', module: 'ESNext', moduleResolution: 'bundler', strict: true, outDir: 'dist' }, include: ['src'] }, null, '\t'),
		'src/index.ts': `import Anthropic from '@anthropic-ai/sdk';\n\nconst client = new Anthropic();\n\nasync function main() {\n\tconsole.log('${name} agent starting...');\n\t// TODO: implement agent logic\n}\n\nmain().catch(console.error);\n`,
		'.mcp.json': JSON.stringify({ mcpServers: {} }, null, '\t'),
		'.env.example': 'ANTHROPIC_API_KEY=\n',
		'.gitignore': 'node_modules/\ndist/\n.env\n.playground/\n'
	}),
	go: (name, description) => ({
		'CLAUDE.md': `# ${name}\n\n${description || 'Go project.'}\n\n## Build & Run\n\`\`\`bash\ngo build -o ${name} .\ngo run .\ngo test ./...\n\`\`\`\n`,
		'main.go': `package main\n\nimport "fmt"\n\nfunc main() {\n\tfmt.Println("Hello from ${name}")\n}\n`,
		'main_test.go': `package main\n\nimport "testing"\n\nfunc TestMain(t *testing.T) {\n\t// placeholder test\n\tif false {\n\t\tt.Fatal("unreachable")\n\t}\n}\n`,
		'go.mod': `module ${name}\n\ngo 1.22\n`,
		'README.md': `# ${name}\n\n${description || 'A Go project.'}\n\n## Getting Started\n\n\`\`\`bash\ngo run .\n\`\`\`\n`,
		'.gitignore': `# Binaries\n${name}\n*.exe\n*.exe~\n*.dll\n*.so\n*.dylib\n\n# Test binary\n*.test\n\n# Output\n*.out\n\n# Dependency directories\nvendor/\n\n# IDE\n.idea/\n.vscode/\n\n# Project\n.env\n.playground/\n`
	}),
	rust: (name, description) => ({
		'CLAUDE.md': `# ${name}\n\n${description || 'Rust project.'}\n\n## Build & Run\n\`\`\`bash\ncargo build\ncargo run\ncargo test\n\`\`\`\n`,
		'Cargo.toml': `[package]\nname = "${name}"\nversion = "0.1.0"\nedition = "2021"\ndescription = "${description || ''}"\n\n[dependencies]\n`,
		'src/main.rs': `fn main() {\n    println!("Hello from ${name}");\n}\n\n#[cfg(test)]\nmod tests {\n    #[test]\n    fn it_works() {\n        assert_eq!(2 + 2, 4);\n    }\n}\n`,
		'.gitignore': `# Generated files\n/target/\n\n# Cargo.lock for binaries\n# Cargo.lock\n\n# IDE\n.idea/\n.vscode/\n*.swp\n\n# Project\n.env\n.playground/\n`
	}),
	'python-cli': (name, description) => ({
		'CLAUDE.md': `# ${name}\n\n${description || 'Python project.'}\n\n## Setup & Run\n\`\`\`bash\npython -m venv .venv\nsource .venv/bin/activate  # or .venv\\\\Scripts\\\\activate on Windows\npip install -e ".[dev]"\npython main.py\npytest\n\`\`\`\n`,
		'pyproject.toml': `[project]\nname = "${name}"\nversion = "0.1.0"\ndescription = "${description || ''}"\nrequires-python = ">=3.11"\ndependencies = []\n\n[project.optional-dependencies]\ndev = ["pytest>=8.0"]\n\n[build-system]\nrequires = ["hatchling"]\nbuild-backend = "hatchling.build"\n`,
		'main.py': `\"\"\"${name} — ${description || 'A Python application.'}\"\"\"\n\n\ndef greet(name: str = "World") -> str:\n    \"\"\"Return a greeting string.\"\"\"\n    return f"Hello, {name}!"\n\n\ndef main() -> None:\n    print(greet())\n\n\nif __name__ == "__main__":\n    main()\n`,
		'requirements.txt': `# Pin your production dependencies here\n# Or use: pip install -e .\n`,
		'tests/__init__.py': '',
		'tests/test_main.py': `from main import greet\n\n\ndef test_greet_default():\n    assert greet() == "Hello, World!"\n\n\ndef test_greet_custom():\n    assert greet("Python") == "Hello, Python!"\n`,
		'.gitignore': `# Byte-compiled\n__pycache__/\n*.py[cod]\n*$py.class\n\n# Virtual environments\n.venv/\nvenv/\nENV/\n\n# Distribution\ndist/\nbuild/\n*.egg-info/\n*.egg\n\n# IDE\n.idea/\n.vscode/\n*.swp\n\n# Testing\n.pytest_cache/\nhtmlcov/\n.coverage\n\n# Project\n.env\n.playground/\n`
	}),
	ruby: (name, description) => ({
		'CLAUDE.md': `# ${name}\n\n${description || 'Ruby project.'}\n\n## Setup & Run\n\`\`\`bash\nbundle install\nruby lib/main.rb\nbundle exec rspec\n\`\`\`\n`,
		'Gemfile': `source "https://rubygems.org"\n\ngem "rspec", "~> 3.13", group: :test\n`,
		'lib/main.rb': `# frozen_string_literal: true\n\n# ${name} — ${description || 'A Ruby application.'}\nmodule ${name.replace(/[^a-zA-Z0-9]/g, '_').replace(/^_+|_+$/g, '').replace(/_([a-z])/g, (_, c) => c.toUpperCase()).replace(/^[a-z]/, (c) => c.toUpperCase())}\n  def self.greet(name = "World")\n    "Hello, #{name}!"\n  end\nend\n\nputs ${name.replace(/[^a-zA-Z0-9]/g, '_').replace(/^_+|_+$/g, '').replace(/_([a-z])/g, (_, c) => c.toUpperCase()).replace(/^[a-z]/, (c) => c.toUpperCase())}.greet if __FILE__ == $PROGRAM_NAME\n`,
		'spec/main_spec.rb': `require_relative "../lib/main"\n\nRSpec.describe ${name.replace(/[^a-zA-Z0-9]/g, '_').replace(/^_+|_+$/g, '').replace(/_([a-z])/g, (_, c) => c.toUpperCase()).replace(/^[a-z]/, (c) => c.toUpperCase())} do\n  it "greets the world by default" do\n    expect(described_class.greet).to eq("Hello, World!")\n  end\n\n  it "greets a custom name" do\n    expect(described_class.greet("Ruby")).to eq("Hello, Ruby!")\n  end\nend\n`,
		'.gitignore': `# Bundler\n/.bundle/\nvendor/bundle/\n\n# Gems\n*.gem\n\n# IDE\n.idea/\n.vscode/\n*.swp\n\n# Project\n.env\n.playground/\n`
	}),
	java: (name, description) => ({
		'CLAUDE.md': `# ${name}\n\n${description || 'Java project.'}\n\n## Build & Run\n\`\`\`bash\nmvn compile\nmvn exec:java -Dexec.mainClass="App"\nmvn test\n\`\`\`\n`,
		'pom.xml': `<?xml version="1.0" encoding="UTF-8"?>\n<project xmlns="http://maven.apache.org/POM/4.0.0"\n         xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"\n         xsi:schemaLocation="http://maven.apache.org/POM/4.0.0 http://maven.apache.org/xsd/maven-4.0.0.xsd">\n    <modelVersion>4.0.0</modelVersion>\n\n    <groupId>com.example</groupId>\n    <artifactId>${name}</artifactId>\n    <version>0.1.0</version>\n    <packaging>jar</packaging>\n\n    <name>${name}</name>\n    <description>${description || ''}</description>\n\n    <properties>\n        <maven.compiler.source>21</maven.compiler.source>\n        <maven.compiler.target>21</maven.compiler.target>\n        <project.build.sourceEncoding>UTF-8</project.build.sourceEncoding>\n    </properties>\n\n    <dependencies>\n        <dependency>\n            <groupId>org.junit.jupiter</groupId>\n            <artifactId>junit-jupiter</artifactId>\n            <version>5.11.0</version>\n            <scope>test</scope>\n        </dependency>\n    </dependencies>\n</project>\n`,
		'src/main/java/App.java': `/**\n * ${name} — ${description || 'A Java application.'}\n */\npublic class App {\n    public static String greet(String name) {\n        return "Hello, " + name + "!";\n    }\n\n    public static void main(String[] args) {\n        System.out.println(greet("World"));\n    }\n}\n`,
		'src/test/java/AppTest.java': `import static org.junit.jupiter.api.Assertions.assertEquals;\nimport org.junit.jupiter.api.Test;\n\nclass AppTest {\n    @Test\n    void greetReturnsCorrectMessage() {\n        assertEquals("Hello, World!", App.greet("World"));\n    }\n\n    @Test\n    void greetWithCustomName() {\n        assertEquals("Hello, Java!", App.greet("Java"));\n    }\n}\n`,
		'.gitignore': `# Compiled class files\n*.class\n\n# Maven\ntarget/\n\n# Package files\n*.jar\n*.war\n*.ear\n\n# IDE\n.idea/\n*.iml\n.vscode/\n.project\n.classpath\n.settings/\n\n# Project\n.env\n.playground/\n`
	}),
	dotnet: (name, description) => ({
		'CLAUDE.md': `# ${name}\n\n${description || 'C#/.NET project.'}\n\n## Build & Run\n\`\`\`bash\ndotnet build\ndotnet run\ndotnet test\n\`\`\`\n`,
		[`${name}.csproj`]: `<Project Sdk="Microsoft.NET.Sdk">\n\n  <PropertyGroup>\n    <OutputType>Exe</OutputType>\n    <TargetFramework>net8.0</TargetFramework>\n    <RootNamespace>${name.replace(/[^a-zA-Z0-9]/g, '_')}</RootNamespace>\n    <ImplicitUsings>enable</ImplicitUsings>\n    <Nullable>enable</Nullable>\n  </PropertyGroup>\n\n</Project>\n`,
		'Program.cs': `// ${name} — ${description || 'A C#/.NET application.'}\n\nnamespace ${name.replace(/[^a-zA-Z0-9]/g, '_')};\n\nclass Program\n{\n    static string Greet(string name = "World") => $"Hello, {name}!";\n\n    static void Main(string[] args)\n    {\n        Console.WriteLine(Greet());\n    }\n}\n`,
		'.gitignore': `# Build results\nbin/\nobj/\n\n# User-specific files\n*.user\n*.suo\n*.userosscache\n*.sln.docstates\n\n# NuGet\n*.nupkg\n.nuget/\n\n# IDE\n.idea/\n.vscode/\n*.swp\n\n# Project\n.env\n.playground/\n`
	})
};

async function scaffoldTemplate(
	projectPath: string,
	template: string,
	name: string,
	description: string
) {
	const generator = TEMPLATES[template] ?? TEMPLATES['blank'];
	const files = generator(name, description);

	for (const [relPath, content] of Object.entries(files)) {
		const fullPath = resolve(projectPath, relPath);
		const dir = resolve(fullPath, '..');
		await mkdir(dir, { recursive: true });
		await writeFile(fullPath, content, 'utf-8');
	}
}

async function addToRegistry(projectPath: string) {
	const registryPath = PATHS.playgroundRegistry;
	let registry: ProjectRegistry;
	try {
		const raw = await readFile(registryPath, 'utf-8');
		registry = JSON.parse(raw);
	} catch {
		registry = { version: 1, projects: [] };
	}

	const normalizedPath = resolve(projectPath);
	const selfPath = resolve(PATHS.root);
	const entryPath = normalizedPath === selfPath ? '.' : normalizedPath;

	if (!registry.projects.some((e) => resolve(PATHS.root, e.path === '.' ? '.' : e.path) === normalizedPath)) {
		registry.projects.push({ path: entryPath, addedAt: new Date().toISOString() });
		// Ensure .playground dir exists for registry
		await mkdir(resolve(PATHS.playgroundRegistry, '..'), { recursive: true });
		await writeFile(registryPath, JSON.stringify(registry, null, '\t'), 'utf-8');
	}
}

export async function POST({ request }) {
	const body: CreateProjectBody = await request.json();

	// Support legacy import flow (just path, no name)
	if (!body.name && body.path) {
		return handleImport(body.path);
	}

	if (!body.name || typeof body.name !== 'string') {
		return json({ error: 'name is required' }, { status: 400 });
	}
	if (!body.path || typeof body.path !== 'string') {
		return json({ error: 'path is required' }, { status: 400 });
	}

	const projectPath = resolve(body.path);
	const template = body.template || 'blank';

	// 1. Create project directory
	await mkdir(projectPath, { recursive: true });

	// 2. Scaffold template files
	await scaffoldTemplate(projectPath, template, body.name, body.description || '');

	// 3. Create .playground/config.json with all configured settings
	const config: PlaygroundConfig = {
		name: body.name,
		description: body.description || undefined,
		tags: [],
		techStack: detectTechFromTemplate(template),
		agents: {
			topology: body.topology || 'hierarchical-mesh',
			maxAgents: body.maxAgents ?? 8,
			memoryNamespace: body.memoryNamespace || body.name,
			modelPreferences: [body.primaryModel || 'GPT-OSS 20B (local)', body.escalation || 'Claude Sonnet 4.6']
		},
		services: (body.services || []).map((s) => ({ name: s })),
		stats: {
			lastSynced: new Date().toISOString(),
			totalToolUses: 0,
			totalSessions: 0,
			totalAgentSpawns: 0
		}
	};

	const playgroundDir = resolve(projectPath, '.playground');
	await mkdir(playgroundDir, { recursive: true });
	await writeFile(resolve(playgroundDir, 'config.json'), JSON.stringify(config, null, '\t'), 'utf-8');

	// 4. Git init if requested
	let gitInitialized = false;
	if (body.initGit) {
		try {
			await execFileAsync('git', ['init'], { cwd: projectPath });
			gitInitialized = true;
		} catch {
			// git init failed — non-fatal
		}
	}

	// 5. Create GitHub repo if requested
	let githubCreated = false;
	if (body.createGithub && gitInitialized) {
		try {
			await execFileAsync('gh', ['repo', 'create', body.name, '--private', '--source', projectPath], {
				cwd: projectPath
			});
			githubCreated = true;
		} catch {
			// gh CLI not available or failed — non-fatal
		}
	}

	// 6. Add to project registry
	await addToRegistry(projectPath);

	// 7. Scan and return the created project
	const project = await scanProject(projectPath);
	return json({ project, gitInitialized, githubCreated }, { status: 201 });
}

/** Legacy import handler — existing directories only */
async function handleImport(path: string) {
	if (!path || typeof path !== 'string') {
		return json({ error: 'path is required' }, { status: 400 });
	}

	try {
		await access(path);
	} catch {
		return json({ error: 'Directory does not exist' }, { status: 400 });
	}

	const configPath = resolve(path, '.playground/config.json');
	try {
		await access(configPath);
	} catch {
		const { createDefaultConfig } = await import('$lib/server/project-scanner.js');
		const config = await createDefaultConfig(path);
		await mkdir(resolve(path, '.playground'), { recursive: true });
		await writeFile(configPath, JSON.stringify(config, null, '\t'), 'utf-8');
	}

	await addToRegistry(path);
	const project = await scanProject(path);
	return json({ project }, { status: 201 });
}

function detectTechFromTemplate(template: string): string[] {
	const map: Record<string, string[]> = {
		blank: [],
		sveltekit: ['SvelteKit', 'TypeScript', 'Tailwind'],
		nextjs: ['Next.js', 'TypeScript', 'React'],
		python: ['Python', 'FastAPI'],
		fullstack: ['SvelteKit', 'TypeScript', 'Python', 'FastAPI'],
		agent: ['TypeScript', 'MCP'],
		go: ['Go'],
		rust: ['Rust'],
		'python-cli': ['Python'],
		ruby: ['Ruby'],
		java: ['Java', 'Maven'],
		dotnet: ['C#', '.NET']
	};
	return map[template] ?? [];
}
