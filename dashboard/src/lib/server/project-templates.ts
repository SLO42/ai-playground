/**
 * Project template registry.
 *
 * Each template defines metadata (shown in the create-project UI) and a
 * `generate` function that returns a filename-to-content map.  Templates
 * can declare typed parameters that the UI renders as form controls.
 */

import type { ProjectTemplateDef, ProjectTemplate } from '$lib/types/projects.js';

// ---------------------------------------------------------------------------
// Helper: extract ProjectTemplate (serialisable metadata) from a full def
// ---------------------------------------------------------------------------

export function toTemplateMetadata(def: ProjectTemplateDef): ProjectTemplate {
	return {
		id: def.id,
		name: def.name,
		description: def.description,
		language: def.language,
		icon: def.icon,
		tags: def.tags,
		params: def.params.length > 0 ? def.params : undefined
	};
}

// ---------------------------------------------------------------------------
// Existing templates (migrated from api/projects/+server.ts)
// ---------------------------------------------------------------------------

const blank: ProjectTemplateDef = {
	id: 'blank',
	name: 'Blank',
	description: 'Empty project with CLAUDE.md',
	language: '',
	icon: '\uD83D\uDCC4',
	tags: [],
	params: [],
	generate: (name, description) => ({
		'CLAUDE.md': `# ${name}\n\n${description || 'A new project.'}\n`,
		'.gitignore': 'node_modules/\n.env\n.playground/\n'
	})
};

const sveltekit: ProjectTemplateDef = {
	id: 'sveltekit',
	name: 'SvelteKit',
	description: 'SvelteKit + TailwindCSS + TypeScript',
	language: 'TypeScript',
	icon: '\uD83D\uDD36',
	tags: ['frontend', 'fullstack', 'web'],
	params: [],
	generate: (name, description) => ({
		'CLAUDE.md': `# ${name}\n\n${description || 'SvelteKit project.'}\n\n## Stack\n- SvelteKit + TypeScript\n- TailwindCSS\n`,
		'package.json': JSON.stringify({
			name,
			version: '0.0.1',
			private: true,
			description: description || '',
			type: 'module',
			scripts: { dev: 'vite dev', build: 'vite build', preview: 'vite preview' },
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
	})
};

const nextjs: ProjectTemplateDef = {
	id: 'nextjs',
	name: 'Next.js',
	description: 'Next.js 15 App Router + TypeScript',
	language: 'TypeScript',
	icon: '\u25B2',
	tags: ['frontend', 'fullstack', 'web'],
	params: [],
	generate: (name, description) => ({
		'CLAUDE.md': `# ${name}\n\n${description || 'Next.js project.'}\n\n## Stack\n- Next.js 15 App Router\n- TypeScript\n`,
		'package.json': JSON.stringify({
			name,
			version: '0.0.1',
			private: true,
			description: description || '',
			scripts: { dev: 'next dev', build: 'next build', start: 'next start' },
			dependencies: { next: '^15.0.0', react: '^19.0.0', 'react-dom': '^19.0.0' },
			devDependencies: { typescript: '^5.0.0', '@types/react': '^19.0.0' }
		}, null, '\t'),
		'tsconfig.json': JSON.stringify({
			compilerOptions: {
				target: 'ES2017', lib: ['dom', 'dom.iterable', 'esnext'],
				jsx: 'preserve', module: 'esnext', moduleResolution: 'bundler',
				strict: true, esModuleInterop: true
			},
			include: ['**/*.ts', '**/*.tsx'],
			exclude: ['node_modules']
		}, null, '\t'),
		'next.config.ts': 'import type { NextConfig } from "next";\n\nconst config: NextConfig = {};\nexport default config;\n',
		'.env.example': '# Environment variables\n',
		'.gitignore': 'node_modules/\n.next/\nout/\n.env\n.playground/\n',
		'app/page.tsx': `export default function Home() {\n\treturn <h1>Welcome to ${name}</h1>;\n}\n`,
		'app/layout.tsx': `export const metadata = { title: '${name}' };\n\nexport default function RootLayout({ children }: { children: React.ReactNode }) {\n\treturn <html><body>{children}</body></html>;\n}\n`
	})
};

const python: ProjectTemplateDef = {
	id: 'python',
	name: 'Python (FastAPI)',
	description: 'Python + FastAPI + uv package manager',
	language: 'Python',
	icon: '\uD83D\uDC0D',
	tags: ['backend', 'api', 'web'],
	params: [],
	generate: (name, description) => ({
		'CLAUDE.md': `# ${name}\n\n${description || 'Python project.'}\n\n## Stack\n- Python + FastAPI\n- uv package manager\n`,
		'pyproject.toml': `[project]\nname = "${name}"\nversion = "0.1.0"\ndescription = "${description || ''}"\nrequires-python = ">=3.11"\ndependencies = ["fastapi", "uvicorn"]\n\n[build-system]\nrequires = ["hatchling"]\nbuild-backend = "hatchling.build"\n`,
		'src/__init__.py': '',
		'src/main.py': `from fastapi import FastAPI\n\napp = FastAPI(title="${name}")\n\n@app.get("/")\ndef root():\n    return {"message": "Hello from ${name}"}\n`,
		'.env.example': '# Environment variables\n',
		'.gitignore': '__pycache__/\n*.pyc\n.venv/\n.env\n.playground/\ndist/\n',
		'.python-version': '3.13\n'
	})
};

const fullstack: ProjectTemplateDef = {
	id: 'fullstack',
	name: 'Full Stack',
	description: 'Monorepo: SvelteKit front + Python back',
	language: 'TypeScript',
	icon: '\uD83C\uDFD7',
	tags: ['fullstack', 'web', 'monorepo'],
	params: [],
	generate: (name, description) => ({
		'CLAUDE.md': `# ${name}\n\n${description || 'Full-stack monorepo.'}\n\n## Stack\n- Frontend: SvelteKit + TypeScript\n- Backend: Python + FastAPI\n`,
		'package.json': JSON.stringify({
			name, version: '0.0.1', private: true, description: description || '',
			scripts: { dev: 'npm run dev:frontend & npm run dev:backend', 'dev:frontend': 'cd frontend && npm run dev', 'dev:backend': 'cd backend && uvicorn src.main:app --reload' }
		}, null, '\t'),
		'frontend/package.json': JSON.stringify({ name: `${name}-frontend`, version: '0.0.1', private: true, type: 'module', scripts: { dev: 'vite dev', build: 'vite build' }, devDependencies: { '@sveltejs/kit': '^2.0.0', svelte: '^5.0.0', vite: '^6.0.0' } }, null, '\t'),
		'frontend/svelte.config.js': `import adapter from '@sveltejs/adapter-auto';\nexport default { kit: { adapter: adapter() } };\n`,
		'backend/pyproject.toml': `[project]\nname = "${name}-backend"\nversion = "0.1.0"\ndependencies = ["fastapi", "uvicorn"]\n`,
		'backend/src/__init__.py': '',
		'backend/src/main.py': `from fastapi import FastAPI\n\napp = FastAPI(title="${name}")\n\n@app.get("/")\ndef root():\n    return {"message": "Hello from ${name}"}\n`,
		'.env.example': '# Environment variables\n',
		'.gitignore': 'node_modules/\n__pycache__/\n*.pyc\n.venv/\n.svelte-kit/\nbuild/\n.env\n.playground/\n'
	})
};

const agent: ProjectTemplateDef = {
	id: 'agent',
	name: 'Agent',
	description: 'Claude Agent SDK + MCP server template',
	language: 'TypeScript',
	icon: '\uD83E\uDD16',
	tags: ['ai', 'agent', 'mcp'],
	params: [],
	generate: (name, description) => ({
		'CLAUDE.md': `# ${name}\n\n${description || 'Claude Agent project.'}\n\n## Stack\n- Claude Agent SDK\n- MCP Server\n`,
		'package.json': JSON.stringify({
			name, version: '0.0.1', private: true, description: description || '',
			type: 'module',
			scripts: { start: 'node src/index.js', dev: 'node --watch src/index.js' },
			dependencies: { '@anthropic-ai/sdk': '^0.30.0' }
		}, null, '\t'),
		'tsconfig.json': JSON.stringify({ compilerOptions: { target: 'ES2022', module: 'ESNext', moduleResolution: 'bundler', strict: true, outDir: 'dist' }, include: ['src'] }, null, '\t'),
		'src/index.ts': `import Anthropic from '@anthropic-ai/sdk';\n\nconst client = new Anthropic();\n\nasync function main() {\n\tconsole.log('${name} agent starting...');\n\t// TODO: implement agent logic\n}\n\nmain().catch(console.error);\n`,
		'.mcp.json': JSON.stringify({ mcpServers: {} }, null, '\t'),
		'.env.example': 'ANTHROPIC_API_KEY=\n',
		'.gitignore': 'node_modules/\ndist/\n.env\n.playground/\n'
	})
};

const go: ProjectTemplateDef = {
	id: 'go',
	name: 'Go',
	description: 'Go module with tests and build tooling',
	language: 'Go',
	icon: '\uD83D\uDC39',
	tags: ['backend', 'cli', 'systems'],
	params: [
		{ key: 'moduleName', label: 'Module Name', type: 'string', default: '', description: 'Go module path (e.g. github.com/user/project). Defaults to project name.' },
		{ key: 'projectType', label: 'Project Type', type: 'select', default: 'binary', options: ['binary', 'library'], description: 'Binary produces an executable; library produces a reusable package.' },
		{ key: 'includeCI', label: 'GitHub Actions CI', type: 'boolean', default: true, description: 'Include CI workflow with go test, go vet, go build' }
	],
	generate: (name, description, params) => {
		const moduleName = (params.moduleName as string) || name;
		const projectType = (params.projectType as string) || 'binary';
		const includeCI = params.includeCI !== false;
		const isBinary = projectType === 'binary';
		const pkgName = name.replace(/-/g, '');

		const files: Record<string, string> = {
			'CLAUDE.md': `# ${name}\n\n${description || 'Go project.'}\n\n## Build & Run\n\`\`\`bash\ngo build ./...\n${isBinary ? 'go run .\n' : ''}go test ./...\n\`\`\`\n`,
			'go.mod': `module ${moduleName}\n\ngo 1.22\n`,
			'README.md': `# ${name}\n\n${description || 'A Go project.'}\n\n## Getting Started\n\n\`\`\`bash\n${isBinary ? 'go run .' : 'go test ./...'}\n\`\`\`\n`,
			'.gitignore': `# Binaries\n${name}\n*.exe\n*.exe~\n*.dll\n*.so\n*.dylib\n\n# Test binary\n*.test\n\n# Output\n*.out\n\n# Dependency directories\nvendor/\n\n# IDE\n.idea/\n.vscode/\n\n# Project\n.env\n.playground/\n`,
			'Makefile': `# ${name} Makefile\n\n.PHONY: build test lint clean\n\nbuild:\n\tgo build ./...\n\ntest:\n\tgo test ./...\n\nlint:\n\tgo vet ./...\n\nclean:\n\trm -f ${name}\n`
		};

		if (isBinary) {
			files['main.go'] = `package main\n\nimport "fmt"\n\nfunc main() {\n\tfmt.Println("Hello from ${name}")\n}\n`;
			files['main_test.go'] = `package main\n\nimport "testing"\n\nfunc TestMain(t *testing.T) {\n\t// placeholder test\n\tif false {\n\t\tt.Fatal("unreachable")\n\t}\n}\n`;
		} else {
			files[`pkg/${pkgName}/${pkgName}.go`] =
				`package ${pkgName}\n\n// Hello returns a greeting string.\nfunc Hello(name string) string {\n\treturn "Hello, " + name + "!"\n}\n`;
			files[`pkg/${pkgName}/${pkgName}_test.go`] =
				`package ${pkgName}\n\nimport "testing"\n\nfunc TestHello(t *testing.T) {\n\tgot := Hello("World")\n\twant := "Hello, World!"\n\tif got != want {\n\t\tt.Errorf("Hello(World) = %q, want %q", got, want)\n\t}\n}\n`;
		}

		if (includeCI) {
			files['.github/workflows/ci.yml'] = [
				'name: CI',
				'on:',
				'  push:',
				'    branches: [main]',
				'  pull_request:',
				'    branches: [main]',
				'',
				'jobs:',
				'  test:',
				'    runs-on: ubuntu-latest',
				'    steps:',
				'      - uses: actions/checkout@v4',
				'      - uses: actions/setup-go@v5',
				'        with:',
				'          go-version: "1.22"',
				'      - run: go build ./...',
				'      - run: go test ./...',
				'      - run: go vet ./...',
				''
			].join('\n');
		}

		return files;
	}
};

const rust: ProjectTemplateDef = {
	id: 'rust',
	name: 'Rust',
	description: 'Cargo project with tests',
	language: 'Rust',
	icon: '\u2699\uFE0F',
	tags: ['backend', 'cli', 'systems'],
	params: [
		{ key: 'projectType', label: 'Project Type', type: 'select', default: 'binary', options: ['binary', 'library'], description: 'Binary produces an executable; library produces a crate.' },
		{ key: 'includeCI', label: 'GitHub Actions CI', type: 'boolean', default: true, description: 'Include CI workflow with cargo test, cargo clippy, cargo fmt --check' }
	],
	generate: (name, description, params) => {
		const projectType = (params.projectType as string) || 'binary';
		const includeCI = params.includeCI !== false;
		const isBinary = projectType === 'binary';

		const files: Record<string, string> = {
			'CLAUDE.md': `# ${name}\n\n${description || 'Rust project.'}\n\n## Build & Run\n\`\`\`bash\ncargo build\n${isBinary ? 'cargo run\n' : ''}cargo test\ncargo clippy\ncargo fmt --check\n\`\`\`\n`,
			'Cargo.toml': `[package]\nname = "${name}"\nversion = "0.1.0"\nedition = "2021"\ndescription = "${description || ''}"\n\n[dependencies]\n`,
			'README.md': `# ${name}\n\n${description || 'A Rust project.'}\n\n## Getting Started\n\n\`\`\`bash\ncargo build\n${isBinary ? 'cargo run\n' : ''}cargo test\n\`\`\`\n`,
			'.gitignore': `# Generated files\n/target/\n${isBinary ? '' : '\n# Cargo.lock for libraries\nCargo.lock\n'}\n# IDE\n.idea/\n.vscode/\n*.swp\n\n# Project\n.env\n.playground/\n`
		};

		if (isBinary) {
			files['src/main.rs'] = `fn main() {\n    println!("Hello from ${name}");\n}\n\n#[cfg(test)]\nmod tests {\n    #[test]\n    fn it_works() {\n        assert_eq!(2 + 2, 4);\n    }\n}\n`;
		} else {
			files['src/lib.rs'] = `/// Returns a greeting string.\npub fn hello(name: &str) -> String {\n    format!("Hello, {}!", name)\n}\n\n#[cfg(test)]\nmod tests {\n    use super::*;\n\n    #[test]\n    fn test_hello() {\n        assert_eq!(hello("World"), "Hello, World!");\n    }\n}\n`;
		}

		if (includeCI) {
			files['.github/workflows/ci.yml'] = [
				'name: CI',
				'on:',
				'  push:',
				'    branches: [main]',
				'  pull_request:',
				'    branches: [main]',
				'',
				'jobs:',
				'  test:',
				'    runs-on: ubuntu-latest',
				'    steps:',
				'      - uses: actions/checkout@v4',
				'      - uses: dtolnay/rust-toolchain@stable',
				'        with:',
				'          components: clippy, rustfmt',
				'      - run: cargo test',
				'      - run: cargo clippy -- -D warnings',
				'      - run: cargo fmt --check',
				''
			].join('\n');
		}

		return files;
	}
};

const pythonCli: ProjectTemplateDef = {
	id: 'python-cli',
	name: 'Python',
	description: 'Python CLI app with pytest and pyproject.toml',
	language: 'Python',
	icon: '\uD83D\uDC0D',
	tags: ['cli', 'tool', 'scripting'],
	params: [],
	generate: (name, description) => ({
		'CLAUDE.md': `# ${name}\n\n${description || 'Python project.'}\n\n## Setup & Run\n\`\`\`bash\npython -m venv .venv\nsource .venv/bin/activate  # or .venv\\\\Scripts\\\\activate on Windows\npip install -e ".[dev]"\npython main.py\npytest\n\`\`\`\n`,
		'pyproject.toml': `[project]\nname = "${name}"\nversion = "0.1.0"\ndescription = "${description || ''}"\nrequires-python = ">=3.11"\ndependencies = []\n\n[project.optional-dependencies]\ndev = ["pytest>=8.0"]\n\n[build-system]\nrequires = ["hatchling"]\nbuild-backend = "hatchling.build"\n`,
		'main.py': `\"\"\"${name} \u2014 ${description || 'A Python application.'}\"\"\"\n\n\ndef greet(name: str = "World") -> str:\n    \"\"\"Return a greeting string.\"\"\"\n    return f"Hello, {name}!"\n\n\ndef main() -> None:\n    print(greet())\n\n\nif __name__ == "__main__":\n    main()\n`,
		'requirements.txt': `# Pin your production dependencies here\n# Or use: pip install -e .\n`,
		'tests/__init__.py': '',
		'tests/test_main.py': `from main import greet\n\n\ndef test_greet_default():\n    assert greet() == "Hello, World!"\n\n\ndef test_greet_custom():\n    assert greet("Python") == "Hello, Python!"\n`,
		'.gitignore': `# Byte-compiled\n__pycache__/\n*.py[cod]\n*$py.class\n\n# Virtual environments\n.venv/\nvenv/\nENV/\n\n# Distribution\ndist/\nbuild/\n*.egg-info/\n*.egg\n\n# IDE\n.idea/\n.vscode/\n*.swp\n\n# Testing\n.pytest_cache/\nhtmlcov/\n.coverage\n\n# Project\n.env\n.playground/\n`
	})
};

function rubyModuleName(name: string): string {
	return name
		.replace(/[^a-zA-Z0-9]/g, '_')
		.replace(/^_+|_+$/g, '')
		.replace(/_([a-z])/g, (_, c) => c.toUpperCase())
		.replace(/^[a-z]/, (c) => c.toUpperCase());
}

const ruby: ProjectTemplateDef = {
	id: 'ruby',
	name: 'Ruby',
	description: 'Ruby project with RSpec tests',
	language: 'Ruby',
	icon: '\uD83D\uDC8E',
	tags: ['backend', 'scripting'],
	params: [],
	generate: (name, description) => {
		const mod = rubyModuleName(name);
		return {
			'CLAUDE.md': `# ${name}\n\n${description || 'Ruby project.'}\n\n## Setup & Run\n\`\`\`bash\nbundle install\nruby lib/main.rb\nbundle exec rspec\n\`\`\`\n`,
			'Gemfile': `source "https://rubygems.org"\n\ngem "rspec", "~> 3.13", group: :test\n`,
			'lib/main.rb': `# frozen_string_literal: true\n\n# ${name} \u2014 ${description || 'A Ruby application.'}\nmodule ${mod}\n  def self.greet(name = "World")\n    "Hello, #{name}!"\n  end\nend\n\nputs ${mod}.greet if __FILE__ == $PROGRAM_NAME\n`,
			'spec/main_spec.rb': `require_relative "../lib/main"\n\nRSpec.describe ${mod} do\n  it "greets the world by default" do\n    expect(described_class.greet).to eq("Hello, World!")\n  end\n\n  it "greets a custom name" do\n    expect(described_class.greet("Ruby")).to eq("Hello, Ruby!")\n  end\nend\n`,
			'.gitignore': `# Bundler\n/.bundle/\nvendor/bundle/\n\n# Gems\n*.gem\n\n# IDE\n.idea/\n.vscode/\n*.swp\n\n# Project\n.env\n.playground/\n`
		};
	}
};

const java: ProjectTemplateDef = {
	id: 'java',
	name: 'Java',
	description: 'Maven project with JUnit 5 tests',
	language: 'Java',
	icon: '\u2615',
	tags: ['backend', 'enterprise'],
	params: [],
	generate: (name, description) => ({
		'CLAUDE.md': `# ${name}\n\n${description || 'Java project.'}\n\n## Build & Run\n\`\`\`bash\nmvn compile\nmvn exec:java -Dexec.mainClass="App"\nmvn test\n\`\`\`\n`,
		'pom.xml': `<?xml version="1.0" encoding="UTF-8"?>\n<project xmlns="http://maven.apache.org/POM/4.0.0"\n         xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"\n         xsi:schemaLocation="http://maven.apache.org/POM/4.0.0 http://maven.apache.org/xsd/maven-4.0.0.xsd">\n    <modelVersion>4.0.0</modelVersion>\n\n    <groupId>com.example</groupId>\n    <artifactId>${name}</artifactId>\n    <version>0.1.0</version>\n    <packaging>jar</packaging>\n\n    <name>${name}</name>\n    <description>${description || ''}</description>\n\n    <properties>\n        <maven.compiler.source>21</maven.compiler.source>\n        <maven.compiler.target>21</maven.compiler.target>\n        <project.build.sourceEncoding>UTF-8</project.build.sourceEncoding>\n    </properties>\n\n    <dependencies>\n        <dependency>\n            <groupId>org.junit.jupiter</groupId>\n            <artifactId>junit-jupiter</artifactId>\n            <version>5.11.0</version>\n            <scope>test</scope>\n        </dependency>\n    </dependencies>\n</project>\n`,
		'src/main/java/App.java': `/**\n * ${name} \u2014 ${description || 'A Java application.'}\n */\npublic class App {\n    public static String greet(String name) {\n        return "Hello, " + name + "!";\n    }\n\n    public static void main(String[] args) {\n        System.out.println(greet("World"));\n    }\n}\n`,
		'src/test/java/AppTest.java': `import static org.junit.jupiter.api.Assertions.assertEquals;\nimport org.junit.jupiter.api.Test;\n\nclass AppTest {\n    @Test\n    void greetReturnsCorrectMessage() {\n        assertEquals("Hello, World!", App.greet("World"));\n    }\n\n    @Test\n    void greetWithCustomName() {\n        assertEquals("Hello, Java!", App.greet("Java"));\n    }\n}\n`,
		'.gitignore': `# Compiled class files\n*.class\n\n# Maven\ntarget/\n\n# Package files\n*.jar\n*.war\n*.ear\n\n# IDE\n.idea/\n*.iml\n.vscode/\n.project\n.classpath\n.settings/\n\n# Project\n.env\n.playground/\n`
	})
};

const dotnet: ProjectTemplateDef = {
	id: 'dotnet',
	name: 'C# / .NET',
	description: '.NET 8 console app with nullable enabled',
	language: 'C#',
	icon: '\uD83D\uDD35',
	tags: ['backend', 'enterprise', 'cli'],
	params: [],
	generate: (name, description) => {
		const ns = name.replace(/[^a-zA-Z0-9]/g, '_');
		return {
			'CLAUDE.md': `# ${name}\n\n${description || 'C#/.NET project.'}\n\n## Build & Run\n\`\`\`bash\ndotnet build\ndotnet run\ndotnet test\n\`\`\`\n`,
			[`${name}.csproj`]: `<Project Sdk="Microsoft.NET.Sdk">\n\n  <PropertyGroup>\n    <OutputType>Exe</OutputType>\n    <TargetFramework>net8.0</TargetFramework>\n    <RootNamespace>${ns}</RootNamespace>\n    <ImplicitUsings>enable</ImplicitUsings>\n    <Nullable>enable</Nullable>\n  </PropertyGroup>\n\n</Project>\n`,
			'Program.cs': `// ${name} \u2014 ${description || 'A C#/.NET application.'}\n\nnamespace ${ns};\n\nclass Program\n{\n    static string Greet(string name = "World") => $"Hello, {name}!";\n\n    static void Main(string[] args)\n    {\n        Console.WriteLine(Greet());\n    }\n}\n`,
			'.gitignore': `# Build results\nbin/\nobj/\n\n# User-specific files\n*.user\n*.suo\n*.userosscache\n*.sln.docstates\n\n# NuGet\n*.nupkg\n.nuget/\n\n# IDE\n.idea/\n.vscode/\n*.swp\n\n# Project\n.env\n.playground/\n`
		};
	}
};

// ---------------------------------------------------------------------------
// G2: BepInEx / Unity mod template
// ---------------------------------------------------------------------------

const BEPINEX_GAME_CONFIGS: Record<string, { framework: string; unityVersion: string; deps: string[] }> = {
	'ROUNDS': { framework: 'net472', unityVersion: '2019.4', deps: ['bbepis-BepInExPack_ROUNDS'] },
	'Lethal Company': { framework: 'netstandard2.1', unityVersion: '2022.3', deps: ['BepInEx-BepInExPack'] },
	'Risk of Rain 2': { framework: 'netstandard2.1', unityVersion: '2021.3', deps: ['bbepis-BepInExPack'] },
	'Valheim': { framework: 'netstandard2.1', unityVersion: '2022.3', deps: ['denikson-BepInExPack_Valheim'] },
	'Content Warning': { framework: 'netstandard2.1', unityVersion: '2022.3', deps: ['BepInEx-BepInExPack'] }
};

const bepinex: ProjectTemplateDef = {
	id: 'bepinex',
	name: 'BepInEx Mod',
	description: 'C# BepInEx plugin for Unity games (Thunderstore-ready)',
	language: 'C#',
	icon: '\uD83C\uDFAE',
	tags: ['mod', 'game', 'unity', 'csharp'],
	params: [
		{ key: 'modName', label: 'Mod Display Name', type: 'string', default: 'My Mod', description: 'Human-readable mod name' },
		{ key: 'modId', label: 'Thunderstore ID', type: 'string', default: 'AuthorName-MyMod', description: 'Author-ModName format for Thunderstore' },
		{ key: 'gameId', label: 'Target Game', type: 'select', default: 'ROUNDS', options: Object.keys(BEPINEX_GAME_CONFIGS), description: 'Which Unity game this mod targets' },
		{ key: 'includeCI', label: 'GitHub Actions CI', type: 'boolean', default: true, description: 'Include build + package workflow' },
		{ key: 'includeThunderstore', label: 'Thunderstore manifest', type: 'boolean', default: true, description: 'Include Thunderstore packaging files' }
	],
	generate: (name, description, params) => {
		const modName = (params.modName as string) || name;
		const modId = (params.modId as string) || `AuthorName-${name}`;
		const gameId = (params.gameId as string) || 'ROUNDS';
		const includeCI = params.includeCI !== false;
		const includeThunderstore = params.includeThunderstore !== false;

		const gameConfig = BEPINEX_GAME_CONFIGS[gameId] || BEPINEX_GAME_CONFIGS['ROUNDS'];
		const [author, modSlug] = modId.includes('-') ? modId.split('-', 2) : ['AuthorName', modId];
		const ns = name.replace(/[^a-zA-Z0-9]/g, '_');
		const guid = `com.${author.toLowerCase()}.${modSlug.toLowerCase()}`;

		const files: Record<string, string> = {};

		// Plugin.cs
		files['Plugin.cs'] = [
			'using BepInEx;',
			'using BepInEx.Logging;',
			'',
			`namespace ${ns};`,
			'',
			`[BepInPlugin(PluginInfo.GUID, PluginInfo.NAME, PluginInfo.VERSION)]`,
			`[BepInProcess("${gameId === 'ROUNDS' ? 'Rounds' : gameId.replace(/ /g, '')}.exe")]`,
			`public class Plugin : BaseUnityPlugin`,
			'{',
			'    internal static new ManualLogSource Logger = null!;',
			'',
			'    private void Awake()',
			'    {',
			'        Logger = base.Logger;',
			`        Logger.LogInfo($"${modName} {PluginInfo.VERSION} loaded!");`,
			'',
			'        // Apply Harmony patches',
			'        // var harmony = new HarmonyLib.Harmony(PluginInfo.GUID);',
			'        // harmony.PatchAll();',
			'    }',
			'}',
			'',
			'internal static class PluginInfo',
			'{',
			`    public const string GUID = "${guid}";`,
			`    public const string NAME = "${modName}";`,
			'    public const string VERSION = "1.0.0";',
			'}',
			''
		].join('\n');

		// .csproj
		files[`${name}.csproj`] = [
			'<Project Sdk="Microsoft.NET.Sdk">',
			'',
			'  <PropertyGroup>',
			`    <TargetFramework>${gameConfig.framework}</TargetFramework>`,
			`    <RootNamespace>${ns}</RootNamespace>`,
			`    <AssemblyName>${name}</AssemblyName>`,
			'    <LangVersion>latest</LangVersion>',
			'    <Nullable>enable</Nullable>',
			'  </PropertyGroup>',
			'',
			'  <ItemGroup>',
			'    <Reference Include="BepInEx.Core">',
			'      <HintPath>$(BepInExDir)\\core\\BepInEx.dll</HintPath>',
			'      <Private>false</Private>',
			'    </Reference>',
			'    <Reference Include="UnityEngine">',
			'      <HintPath>$(GameDir)\\Managed\\UnityEngine.dll</HintPath>',
			'      <Private>false</Private>',
			'    </Reference>',
			'    <Reference Include="UnityEngine.CoreModule">',
			'      <HintPath>$(GameDir)\\Managed\\UnityEngine.CoreModule.dll</HintPath>',
			'      <Private>false</Private>',
			'    </Reference>',
			'  </ItemGroup>',
			'',
			'</Project>',
			''
		].join('\n');

		// CLAUDE.md
		files['CLAUDE.md'] = [
			`# ${modName}`,
			'',
			description || `A BepInEx mod for ${gameId}.`,
			'',
			'## Build',
			'```bash',
			'dotnet build',
			'```',
			'',
			`## Target: ${gameId} (Unity ${gameConfig.unityVersion}, ${gameConfig.framework})`,
			'',
			'## Setup',
			'Set environment variables before building:',
			'- `GameDir` \u2014 Path to the game\'s `<game>_Data` directory',
			'- `BepInExDir` \u2014 Path to the BepInEx installation directory',
			''
		].join('\n');

		// README.md
		files['README.md'] = [
			`# ${modName}`,
			'',
			description || `A BepInEx mod for ${gameId}.`,
			'',
			'## Installation',
			'',
			'1. Install [BepInEx](https://thunderstore.io/) for your game',
			`2. Download the latest release from [Thunderstore](https://thunderstore.io/c/${gameId.toLowerCase().replace(/ /g, '-')}/p/${author}/${modSlug}/)`,
			'3. Extract into your `BepInEx/plugins` folder',
			'',
			'## Building from Source',
			'',
			'```bash',
			'dotnet build',
			'```',
			'',
			'Set `GameDir` and `BepInExDir` environment variables to point at your game installation.',
			'',
			'## Icon',
			'',
			'Place a 256x256 `icon.png` in the project root for Thunderstore.',
			''
		].join('\n');

		// .gitignore
		files['.gitignore'] = [
			'# Build',
			'bin/',
			'obj/',
			'',
			'# IDE',
			'.idea/',
			'.vscode/',
			'*.user',
			'*.suo',
			'',
			'# NuGet',
			'*.nupkg',
			'.nuget/',
			'',
			'# Thunderstore package output',
			'dist/',
			'',
			'# Project',
			'.env',
			'.playground/',
			''
		].join('\n');

		// Thunderstore manifest
		if (includeThunderstore) {
			files['manifest.json'] = JSON.stringify({
				name: modSlug,
				version_number: '1.0.0',
				website_url: '',
				description: description || `A BepInEx mod for ${gameId}`,
				dependencies: gameConfig.deps
			}, null, '\t') + '\n';
		}

		// GitHub Actions CI
		if (includeCI) {
			files['.github/workflows/build.yml'] = [
				'name: Build',
				'',
				'on:',
				'  push:',
				'    branches: [main]',
				'  pull_request:',
				'    branches: [main]',
				'',
				'jobs:',
				'  build:',
				'    runs-on: ubuntu-latest',
				'    steps:',
				'      - uses: actions/checkout@v4',
				'',
				'      - name: Setup .NET',
				'        uses: actions/setup-dotnet@v4',
				'        with:',
				'          dotnet-version: 8.0.x',
				'',
				'      - name: Restore',
				'        run: dotnet restore',
				'',
				'      - name: Build',
				'        run: dotnet build --no-restore --configuration Release',
				'',
				'      - name: Upload artifact',
				'        uses: actions/upload-artifact@v4',
				'        with:',
				`          name: ${name}`,
				'          path: bin/Release/**/*.dll',
				''
			].join('\n');
		}

		return files;
	}
};

// ---------------------------------------------------------------------------
// G3: Fabric Minecraft mod template
// ---------------------------------------------------------------------------

const FABRIC_MC_VERSIONS: Record<string, { fabricApi: string; loom: string; loaderVersion: string; javaVersion: string }> = {
	'1.20.4': { fabricApi: '0.96.11+1.20.4', loom: '1.6-SNAPSHOT', loaderVersion: '0.15.7', javaVersion: '17' },
	'1.21.1': { fabricApi: '0.102.0+1.21.1', loom: '1.7-SNAPSHOT', loaderVersion: '0.16.0', javaVersion: '21' }
};

const fabric: ProjectTemplateDef = {
	id: 'fabric',
	name: 'Fabric Mod',
	description: 'Minecraft Fabric mod with Loom build system',
	language: 'Java',
	icon: '\u26CF\uFE0F',
	tags: ['mod', 'game', 'minecraft', 'java'],
	params: [
		{ key: 'modName', label: 'Mod Name', type: 'string', default: 'My Fabric Mod', description: 'Human-readable mod name' },
		{ key: 'modId', label: 'Mod ID', type: 'string', default: 'mymod', description: 'Lowercase identifier (e.g. "mymod")' },
		{ key: 'minecraftVersion', label: 'Minecraft Version', type: 'select', default: '1.21.1', options: Object.keys(FABRIC_MC_VERSIONS), description: 'Target Minecraft version' },
		{ key: 'language', label: 'Language', type: 'select', default: 'java', options: ['java', 'kotlin'], description: 'Source language' },
		{ key: 'includeCI', label: 'GitHub Actions CI', type: 'boolean', default: true, description: 'Include build workflow' }
	],
	generate: (name, description, params) => {
		const modName = (params.modName as string) || name;
		const modId = ((params.modId as string) || name).toLowerCase().replace(/[^a-z0-9_]/g, '_');
		const mcVersion = (params.minecraftVersion as string) || '1.21.1';
		const lang = (params.language as string) || 'java';
		const includeCI = params.includeCI !== false;
		const isKotlin = lang === 'kotlin';

		const mcConfig = FABRIC_MC_VERSIONS[mcVersion] || FABRIC_MC_VERSIONS['1.21.1'];
		const className = modId.replace(/(^|_)([a-z])/g, (_, _p, c: string) => c.toUpperCase());
		const pkg = `com.example.${modId}`;
		const pkgPath = `com/example/${modId}`;

		const files: Record<string, string> = {};

		// gradle.properties
		files['gradle.properties'] = [
			'# Fabric Properties',
			'# https://fabricmc.net/develop/',
			`minecraft_version=${mcVersion}`,
			`fabric_loader_version=${mcConfig.loaderVersion}`,
			`fabric_api_version=${mcConfig.fabricApi}`,
			'',
			'# Mod Properties',
			`mod_version=1.0.0`,
			`maven_group=com.example`,
			`archives_base_name=${modId}`,
			''
		].join('\n');

		// settings.gradle(.kts)
		if (isKotlin) {
			files['settings.gradle.kts'] = `pluginManagement {\n\trepositories {\n\t\tmaven("https://maven.fabricmc.net/")\n\t\tgradlePluginPortal()\n\t}\n}\n\nrootProject.name = "${modId}"\n`;
		} else {
			files['settings.gradle'] = `pluginManagement {\n\trepositories {\n\t\tmaven { url = "https://maven.fabricmc.net/" }\n\t\tgradlePluginPortal()\n\t}\n}\n\nrootProject.name = "${modId}"\n`;
		}

		// build.gradle(.kts)
		if (isKotlin) {
			files['build.gradle.kts'] = [
				'plugins {',
				`\tid("fabric-loom") version "${mcConfig.loom}"`,
				'\tid("org.jetbrains.kotlin.jvm") version "2.0.0"',
				'}',
				'',
				'version = project.property("mod_version") as String',
				'group = project.property("maven_group") as String',
				'base.archivesName.set(project.property("archives_base_name") as String)',
				'',
				'repositories {',
				'\tmavenCentral()',
				'}',
				'',
				'dependencies {',
				'\tminecraft("com.mojang:minecraft:${project.property("minecraft_version")}")',
				'\tmappings("net.fabricmc:yarn:${project.property("minecraft_version")}+build.1:v2")',
				'\tmodImplementation("net.fabricmc:fabric-loader:${project.property("fabric_loader_version")}")',
				'\tmodImplementation("net.fabricmc.fabric-api:fabric-api:${project.property("fabric_api_version")}")',
				'\tmodImplementation("net.fabricmc:fabric-language-kotlin:1.11.0+kotlin.2.0.0")',
				'}',
				'',
				'tasks.processResources {',
				'\tinputs.property("version", project.property("mod_version"))',
				'\tfilesMatching("fabric.mod.json") {',
				'\t\texpand(mutableMapOf("version" to project.property("mod_version")))',
				'\t}',
				'}',
				'',
				`java { sourceCompatibility = JavaVersion.VERSION_${mcConfig.javaVersion}; targetCompatibility = JavaVersion.VERSION_${mcConfig.javaVersion} }`,
				''
			].join('\n');
		} else {
			files['build.gradle'] = [
				'plugins {',
				`\tid 'fabric-loom' version '${mcConfig.loom}'`,
				'}',
				'',
				"version = project.mod_version",
				"group = project.maven_group",
				"base.archivesName = project.archives_base_name",
				'',
				'repositories {',
				'\tmavenCentral()',
				'}',
				'',
				'dependencies {',
				'\tminecraft "com.mojang:minecraft:${project.minecraft_version}"',
				'\tmappings "net.fabricmc:yarn:${project.minecraft_version}+build.1:v2"',
				'\tmodImplementation "net.fabricmc:fabric-loader:${project.fabric_loader_version}"',
				'\tmodImplementation "net.fabricmc.fabric-api:fabric-api:${project.fabric_api_version}"',
				'}',
				'',
				'processResources {',
				'\tinputs.property "version", project.mod_version',
				'\tfilesMatching("fabric.mod.json") {',
				'\t\texpand "version": project.mod_version',
				'\t}',
				'}',
				'',
				`java { sourceCompatibility = JavaVersion.VERSION_${mcConfig.javaVersion}; targetCompatibility = JavaVersion.VERSION_${mcConfig.javaVersion} }`,
				''
			].join('\n');
		}

		// Main mod class
		const srcExt = isKotlin ? 'kt' : 'java';
		const srcDir = isKotlin ? 'src/main/kotlin' : 'src/main/java';

		if (isKotlin) {
			files[`${srcDir}/${pkgPath}/${className}.kt`] = [
				`package ${pkg}`,
				'',
				'import net.fabricmc.api.ModInitializer',
				'import org.slf4j.LoggerFactory',
				'',
				`object ${className} : ModInitializer {`,
				`\tprivate val logger = LoggerFactory.getLogger("${modId}")`,
				'',
				'\toverride fun onInitialize() {',
				`\t\tlogger.info("${modName} initialized!")`,
				'\t}',
				'}',
				''
			].join('\n');
		} else {
			files[`${srcDir}/${pkgPath}/${className}.java`] = [
				`package ${pkg};`,
				'',
				'import net.fabricmc.api.ModInitializer;',
				'import org.slf4j.Logger;',
				'import org.slf4j.LoggerFactory;',
				'',
				`public class ${className} implements ModInitializer {`,
				`\tpublic static final String MOD_ID = "${modId}";`,
				`\tpublic static final Logger LOGGER = LoggerFactory.getLogger(MOD_ID);`,
				'',
				'\t@Override',
				'\tpublic void onInitialize() {',
				`\t\tLOGGER.info("${modName} initialized!");`,
				'\t}',
				'}',
				''
			].join('\n');
		}

		// fabric.mod.json
		const entrypoint = isKotlin
			? `${pkg}.${className}`
			: `${pkg}.${className}`;
		const entrypointAdapter = isKotlin ? 'kotlin' : undefined;

		const fabricMod: Record<string, unknown> = {
			schemaVersion: 1,
			id: modId,
			version: '${version}',
			name: modName,
			description: description || `A Fabric mod for Minecraft ${mcVersion}`,
			authors: ['Author'],
			contact: {},
			license: 'MIT',
			icon: 'assets/' + modId + '/icon.png',
			environment: '*',
			entrypoints: {
				main: isKotlin
					? [{ adapter: 'kotlin', value: entrypoint }]
					: [entrypoint]
			},
			mixins: [`${modId}.mixins.json`],
			depends: {
				fabricloader: `>=${mcConfig.loaderVersion}`,
				'fabric-api': '*',
				minecraft: `~${mcVersion}`,
				java: `>=${mcConfig.javaVersion}`
			}
		};
		if (isKotlin) {
			(fabricMod.depends as Record<string, string>)['fabric-language-kotlin'] = '>=1.11.0+kotlin.2.0.0';
		}
		files['src/main/resources/fabric.mod.json'] = JSON.stringify(fabricMod, null, '\t') + '\n';

		// Mixin config
		files[`src/main/resources/${modId}.mixins.json`] = JSON.stringify({
			required: true,
			package: `${pkg}.mixin`,
			compatibilityLevel: `JAVA_${mcConfig.javaVersion}`,
			mixins: [],
			client: [],
			injectors: { defaultRequire: 1 }
		}, null, '\t') + '\n';

		// CLAUDE.md
		files['CLAUDE.md'] = [
			`# ${modName}`,
			'',
			description || `A Fabric mod for Minecraft ${mcVersion}.`,
			'',
			'## Build',
			'```bash',
			'./gradlew build',
			'```',
			'',
			`Output jar: \`build/libs/${modId}-1.0.0.jar\``,
			'',
			`## Stack`,
			`- Minecraft ${mcVersion}`,
			`- Fabric Loader ${mcConfig.loaderVersion}`,
			`- ${isKotlin ? 'Kotlin' : 'Java'} ${mcConfig.javaVersion}+`,
			''
		].join('\n');

		// .gitignore
		files['.gitignore'] = [
			'# Gradle',
			'.gradle/',
			'build/',
			'',
			'# IDE',
			'.idea/',
			'*.iml',
			'.vscode/',
			'*.swp',
			'.settings/',
			'.project',
			'.classpath',
			'',
			'# Fabric',
			'run/',
			'remappedSrc/',
			'',
			'# OS',
			'.DS_Store',
			'Thumbs.db',
			'',
			'# Project',
			'.env',
			'.playground/',
			''
		].join('\n');

		// CI
		if (includeCI) {
			files['.github/workflows/build.yml'] = [
				'name: Build',
				'',
				'on:',
				'  push:',
				'    branches: [main]',
				'  pull_request:',
				'    branches: [main]',
				'',
				'jobs:',
				'  build:',
				'    runs-on: ubuntu-latest',
				'    steps:',
				'      - uses: actions/checkout@v4',
				'',
				`      - name: Setup JDK ${mcConfig.javaVersion}`,
				'        uses: actions/setup-java@v4',
				'        with:',
				`          java-version: ${mcConfig.javaVersion}`,
				'          distribution: temurin',
				'',
				'      - name: Setup Gradle',
				'        uses: gradle/actions/setup-gradle@v3',
				'',
				'      - name: Build',
				'        run: ./gradlew build',
				'',
				'      - name: Upload artifact',
				'        uses: actions/upload-artifact@v4',
				'        with:',
				`          name: ${modId}`,
				'          path: build/libs/*.jar',
				''
			].join('\n');
		}

		return files;
	}
};

// ---------------------------------------------------------------------------
// G4: Forge / NeoForge Minecraft mod template
// ---------------------------------------------------------------------------

const forge: ProjectTemplateDef = {
	id: 'forge',
	name: 'Forge Mod',
	description: 'NeoForge/Forge Minecraft mod with Gradle',
	language: 'Java',
	icon: '\u2692\uFE0F',
	tags: ['mod', 'game', 'minecraft', 'java'],
	params: [
		{ key: 'modName', label: 'Mod Name', type: 'string', default: 'My Mod', description: 'Display name of your mod' },
		{ key: 'modId', label: 'Mod ID', type: 'string', default: 'mymod', description: 'Lowercase identifier (no spaces)' },
		{ key: 'minecraftVersion', label: 'Minecraft Version', type: 'select', default: '1.21.1', options: ['1.20.4', '1.21.1'] },
		{ key: 'language', label: 'Language', type: 'select', default: 'java', options: ['java', 'kotlin'] },
		{ key: 'includeCI', label: 'Include CI', type: 'boolean', default: false, description: 'Add GitHub Actions build workflow' }
	],
	generate: (name, description, params) => {
		const modName = (params.modName as string) || name;
		const modId = ((params.modId as string) || name).toLowerCase().replace(/[^a-z0-9]/g, '');
		const mcVersion = (params.minecraftVersion as string) || '1.21.1';
		const lang = (params.language as string) || 'java';
		const includeCI = params.includeCI === true;
		const isKotlin = lang === 'kotlin';
		const neoVersion = mcVersion === '1.20.4' ? '20.4' : '21.1';
		const forgeVersion = mcVersion === '1.20.4' ? '49.0.0' : '51.0.0';
		const className = modId.replace(/(^|_)([a-z])/g, (_, _p, c: string) => c.toUpperCase());
		const pkg = `com.example.${modId}`;
		const pkgPath = `com/example/${modId}`;

		const files: Record<string, string> = {};

		// build.gradle
		const kotlinPlugin = isKotlin ? "\n    id 'org.jetbrains.kotlin.jvm' version '1.9.22'" : '';
		const kotlinDep = isKotlin ? '\n    implementation "org.jetbrains.kotlin:kotlin-stdlib"' : '';
		files['build.gradle'] = [
			'plugins {',
			`    id 'net.neoforged.gradle.userdev' version '7.0.+'${kotlinPlugin}`,
			'}',
			'',
			`version = '1.0.0'`,
			`group = '${pkg}'`,
			'',
			'java {',
			'    toolchain {',
			'        languageVersion = JavaLanguageVersion.of(17)',
			'    }',
			'}',
			'',
			'minecraft {',
			'    accessTransformers {',
			"        file('src/main/resources/META-INF/accesstransformer.cfg')",
			'    }',
			'}',
			'',
			'repositories {',
			'    mavenCentral()',
			'}',
			'',
			'dependencies {',
			`    implementation "net.neoforged:neoforge:${neoVersion}.+"${kotlinDep}`,
			'}',
			'',
			'tasks.withType(ProcessResources).configureEach {',
			'    var replaceProperties = [',
			`        mod_id: '${modId}',`,
			`        mod_name: '${modName}',`,
			'        mod_version: project.version,',
			`        minecraft_version: '${mcVersion}'`,
			'    ]',
			'    inputs.properties replaceProperties',
			"    filesMatching(['META-INF/mods.toml']) {",
			'        expand replaceProperties',
			'    }',
			'}',
			''
		].join('\n');

		// gradle.properties
		files['gradle.properties'] = [
			'org.gradle.jvmargs=-Xmx3G',
			'org.gradle.daemon=false',
			'',
			`mod_id=${modId}`,
			`mod_name=${modName}`,
			'mod_version=1.0.0',
			`minecraft_version=${mcVersion}`,
			`forge_version=${forgeVersion}`,
			`neo_version=${neoVersion}`,
			''
		].join('\n');

		// settings.gradle
		files['settings.gradle'] = [
			'pluginManagement {',
			'    repositories {',
			'        gradlePluginPortal()',
			"        maven { url = 'https://maven.neoforged.net/releases' }",
			'    }',
			'}',
			'',
			'plugins {',
			"    id 'org.gradle.toolchains.foojay-resolver-convention' version '0.8.0'",
			'}',
			'',
			`rootProject.name = '${modId}'`,
			''
		].join('\n');

		// Main mod class
		const srcDir = isKotlin ? 'src/main/kotlin' : 'src/main/java';
		const ext = isKotlin ? 'kt' : 'java';

		if (isKotlin) {
			files[`${srcDir}/${pkgPath}/${className}Mod.kt`] = [
				`package ${pkg}`,
				'',
				'import net.neoforged.bus.api.IEventBus',
				'import net.neoforged.fml.common.Mod',
				'import org.slf4j.LoggerFactory',
				'',
				`@Mod(${className}Mod.MOD_ID)`,
				`class ${className}Mod(modEventBus: IEventBus) {`,
				'    companion object {',
				`        const val MOD_ID = "${modId}"`,
				`        private val LOGGER = LoggerFactory.getLogger(${className}Mod::class.java)`,
				'    }',
				'',
				'    init {',
				`        LOGGER.info("${modName} initializing...")`,
				'    }',
				'}',
				''
			].join('\n');
		} else {
			files[`${srcDir}/${pkgPath}/${className}Mod.java`] = [
				`package ${pkg};`,
				'',
				'import net.neoforged.bus.api.IEventBus;',
				'import net.neoforged.fml.common.Mod;',
				'import org.slf4j.Logger;',
				'import org.slf4j.LoggerFactory;',
				'',
				`@Mod(${className}Mod.MOD_ID)`,
				`public class ${className}Mod {`,
				`    public static final String MOD_ID = "${modId}";`,
				`    private static final Logger LOGGER = LoggerFactory.getLogger(${className}Mod.class);`,
				'',
				`    public ${className}Mod(IEventBus modEventBus) {`,
				`        LOGGER.info("${modName} initializing...");`,
				'    }',
				'}',
				''
			].join('\n');
		}

		// mods.toml
		files['src/main/resources/META-INF/mods.toml'] = [
			'modLoader = "javafml"',
			'loaderVersion = "[1,)"',
			'license = "All Rights Reserved"',
			'',
			'[[mods]]',
			`modId = "${modId}"`,
			'version = "${mod_version}"',
			`displayName = "${modName}"`,
			`description = '''${description || `${modName} - a Minecraft mod.`}'''`,
			'',
			`[[dependencies.${modId}]]`,
			'modId = "neoforge"',
			'type = "required"',
			`versionRange = "[${neoVersion},)"`,
			'ordering = "NONE"',
			'side = "BOTH"',
			'',
			`[[dependencies.${modId}]]`,
			'modId = "minecraft"',
			'type = "required"',
			`versionRange = "[${mcVersion},)"`,
			'ordering = "NONE"',
			'side = "BOTH"',
			''
		].join('\n');

		// .gitignore
		files['.gitignore'] = [
			'# Gradle',
			'.gradle/',
			'build/',
			'!gradle/wrapper/gradle-wrapper.jar',
			'',
			'# IDE',
			'.idea/',
			'*.iml',
			'.vscode/',
			'*.swp',
			'out/',
			'',
			'# Runtime',
			'run/',
			'logs/',
			'crash-reports/',
			'',
			'# Project',
			'.env',
			'.playground/',
			''
		].join('\n');

		// CI
		if (includeCI) {
			files['.github/workflows/build.yml'] = [
				'name: Build',
				'',
				'on:',
				'  push:',
				'    branches: [main]',
				'  pull_request:',
				'    branches: [main]',
				'',
				'jobs:',
				'  build:',
				'    runs-on: ubuntu-latest',
				'    steps:',
				'      - uses: actions/checkout@v4',
				'      - uses: actions/setup-java@v4',
				'        with:',
				'          distribution: temurin',
				'          java-version: 17',
				'      - uses: gradle/actions/setup-gradle@v4',
				'      - run: ./gradlew build',
				''
			].join('\n');
		}

		return files;
	}
};

// ---------------------------------------------------------------------------
// G5: Paper/Spigot Minecraft plugin template
// ---------------------------------------------------------------------------

const paper: ProjectTemplateDef = {
	id: 'paper',
	name: 'Paper Plugin',
	description: 'Paper/Spigot Minecraft plugin',
	language: 'Java',
	icon: '\uD83D\uDCC3',
	tags: ['mod', 'game', 'minecraft', 'java'],
	params: [
		{ key: 'pluginName', label: 'Plugin Name', type: 'string', default: 'My Plugin', description: 'Display name of your plugin' },
		{ key: 'pluginId', label: 'Plugin ID', type: 'string', default: 'myplugin', description: 'Lowercase identifier (no spaces)' },
		{ key: 'minecraftVersion', label: 'Minecraft Version', type: 'select', default: '1.21.1', options: ['1.20.4', '1.21.1'] },
		{ key: 'buildTool', label: 'Build Tool', type: 'select', default: 'gradle', options: ['gradle', 'maven'] },
		{ key: 'language', label: 'Language', type: 'select', default: 'java', options: ['java', 'kotlin'] },
		{ key: 'includeCI', label: 'Include CI', type: 'boolean', default: false, description: 'Add GitHub Actions build workflow' }
	],
	generate: (name, description, params) => {
		const pluginName = (params.pluginName as string) || name;
		const pluginId = ((params.pluginId as string) || name).toLowerCase().replace(/[^a-z0-9]/g, '');
		const mcVersion = (params.minecraftVersion as string) || '1.21.1';
		const buildTool = (params.buildTool as string) || 'gradle';
		const lang = (params.language as string) || 'java';
		const includeCI = params.includeCI === true;
		const isKotlin = lang === 'kotlin';
		const className = pluginId.replace(/(^|_)([a-z])/g, (_, _p, c: string) => c.toUpperCase());
		const apiVersion = mcVersion.replace(/\.\d+$/, '');
		const pkg = `com.example.${pluginId}`;
		const pkgPath = `com/example/${pluginId}`;

		const files: Record<string, string> = {};

		// Main plugin class
		const srcDir = isKotlin ? 'src/main/kotlin' : 'src/main/java';
		if (isKotlin) {
			files[`${srcDir}/${pkgPath}/${className}Plugin.kt`] = [
				`package ${pkg}`,
				'',
				'import org.bukkit.plugin.java.JavaPlugin',
				'',
				`class ${className}Plugin : JavaPlugin() {`,
				'    override fun onEnable() {',
				`        logger.info("${pluginName} has been enabled!")`,
				'    }',
				'',
				'    override fun onDisable() {',
				`        logger.info("${pluginName} has been disabled.")`,
				'    }',
				'}',
				''
			].join('\n');
		} else {
			files[`${srcDir}/${pkgPath}/${className}Plugin.java`] = [
				`package ${pkg};`,
				'',
				'import org.bukkit.plugin.java.JavaPlugin;',
				'',
				`public class ${className}Plugin extends JavaPlugin {`,
				'    @Override',
				'    public void onEnable() {',
				`        getLogger().info("${pluginName} has been enabled!");`,
				'    }',
				'',
				'    @Override',
				'    public void onDisable() {',
				`        getLogger().info("${pluginName} has been disabled.");`,
				'    }',
				'}',
				''
			].join('\n');
		}

		// plugin.yml
		files['src/main/resources/plugin.yml'] = [
			`name: ${pluginName}`,
			"version: '${version}'",
			`main: ${pkg}.${className}Plugin`,
			`api-version: '${apiVersion}'`,
			`description: ${description || `${pluginName} - a Paper/Spigot plugin.`}`,
			'author: author',
			''
		].join('\n');

		// Build files
		if (buildTool === 'maven') {
			files['pom.xml'] = [
				'<?xml version="1.0" encoding="UTF-8"?>',
				'<project xmlns="http://maven.apache.org/POM/4.0.0"',
				'         xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"',
				'         xsi:schemaLocation="http://maven.apache.org/POM/4.0.0 http://maven.apache.org/xsd/maven-4.0.0.xsd">',
				'    <modelVersion>4.0.0</modelVersion>',
				'',
				'    <groupId>com.example</groupId>',
				`    <artifactId>${pluginId}</artifactId>`,
				'    <version>1.0.0-SNAPSHOT</version>',
				'    <packaging>jar</packaging>',
				'',
				`    <name>${pluginName}</name>`,
				`    <description>${description || ''}</description>`,
				'',
				'    <properties>',
				'        <java.version>17</java.version>',
				'        <maven.compiler.source>17</maven.compiler.source>',
				'        <maven.compiler.target>17</maven.compiler.target>',
				'        <project.build.sourceEncoding>UTF-8</project.build.sourceEncoding>',
				'    </properties>',
				'',
				'    <repositories>',
				'        <repository>',
				'            <id>papermc</id>',
				'            <url>https://repo.papermc.io/repository/maven-public/</url>',
				'        </repository>',
				'    </repositories>',
				'',
				'    <dependencies>',
				'        <dependency>',
				'            <groupId>io.papermc.paper</groupId>',
				'            <artifactId>paper-api</artifactId>',
				`            <version>${mcVersion}-R0.1-SNAPSHOT</version>`,
				'            <scope>provided</scope>',
				'        </dependency>',
				'    </dependencies>',
				'',
				'    <build>',
				'        <resources>',
				'            <resource>',
				'                <directory>src/main/resources</directory>',
				'                <filtering>true</filtering>',
				'            </resource>',
				'        </resources>',
				'        <plugins>',
				'            <plugin>',
				'                <groupId>org.apache.maven.plugins</groupId>',
				'                <artifactId>maven-shade-plugin</artifactId>',
				'                <version>3.5.3</version>',
				'                <executions>',
				'                    <execution>',
				'                        <phase>package</phase>',
				'                        <goals><goal>shade</goal></goals>',
				'                    </execution>',
				'                </executions>',
				'            </plugin>',
				'        </plugins>',
				'    </build>',
				'</project>',
				''
			].join('\n');
		} else {
			if (isKotlin) {
				files['build.gradle.kts'] = [
					'plugins {',
					'    kotlin("jvm") version "1.9.22"',
					'    id("com.github.johnrengelman.shadow") version "8.1.1"',
					'    id("io.papermc.paperweight.userdev") version "1.7.1"',
					'}',
					'',
					'group = "com.example"',
					'version = "1.0.0-SNAPSHOT"',
					'',
					'repositories {',
					'    mavenCentral()',
					'    maven("https://repo.papermc.io/repository/maven-public/")',
					'}',
					'',
					'dependencies {',
					`    paperweight.paperDevBundle("${mcVersion}-R0.1-SNAPSHOT")`,
					'    implementation(kotlin("stdlib"))',
					'}',
					'',
					'tasks {',
					'    processResources {',
					'        val props = mapOf("version" to version)',
					'        inputs.properties(props)',
					'        filesMatching("plugin.yml") {',
					'            expand(props)',
					'        }',
					'    }',
					'',
					'    shadowJar {',
					'        archiveClassifier.set("")',
					'    }',
					'',
					'    build {',
					'        dependsOn(shadowJar)',
					'    }',
					'}',
					'',
					'java {',
					'    toolchain.languageVersion.set(JavaLanguageVersion.of(17))',
					'}',
					''
				].join('\n');
			} else {
				files['build.gradle.kts'] = [
					'plugins {',
					'    id("java")',
					'    id("com.github.johnrengelman.shadow") version "8.1.1"',
					'    id("io.papermc.paperweight.userdev") version "1.7.1"',
					'}',
					'',
					'group = "com.example"',
					'version = "1.0.0-SNAPSHOT"',
					'',
					'repositories {',
					'    mavenCentral()',
					'    maven("https://repo.papermc.io/repository/maven-public/")',
					'}',
					'',
					'dependencies {',
					`    paperweight.paperDevBundle("${mcVersion}-R0.1-SNAPSHOT")`,
					'}',
					'',
					'tasks.processResources {',
					'    val props = mapOf("version" to version)',
					'    inputs.properties(props)',
					'    filesMatching("plugin.yml") {',
					'        expand(props)',
					'    }',
					'}',
					'',
					'tasks.shadowJar {',
					'    archiveClassifier.set("")',
					'}',
					'',
					'tasks.build {',
					'    dependsOn(tasks.shadowJar)',
					'}',
					'',
					'java {',
					'    toolchain.languageVersion.set(JavaLanguageVersion.of(17))',
					'}',
					''
				].join('\n');
			}
			files['settings.gradle.kts'] = `rootProject.name = "${pluginId}"\n`;
		}

		// .gitignore
		files['.gitignore'] = [
			'# Build output',
			'build/',
			'target/',
			'',
			'# Gradle',
			'.gradle/',
			'!gradle/wrapper/gradle-wrapper.jar',
			'',
			'# IDE',
			'.idea/',
			'*.iml',
			'.vscode/',
			'*.swp',
			'out/',
			'',
			'# Project',
			'.env',
			'.playground/',
			''
		].join('\n');

		// CI
		if (includeCI) {
			const buildCmd = buildTool === 'maven' ? 'mvn package --no-transfer-progress' : './gradlew build';
			files['.github/workflows/build.yml'] = [
				'name: Build',
				'',
				'on:',
				'  push:',
				'    branches: [main]',
				'  pull_request:',
				'    branches: [main]',
				'',
				'jobs:',
				'  build:',
				'    runs-on: ubuntu-latest',
				'    steps:',
				'      - uses: actions/checkout@v4',
				'      - uses: actions/setup-java@v4',
				'        with:',
				'          distribution: temurin',
				'          java-version: 17',
				...(buildTool === 'gradle' ? ['      - uses: gradle/actions/setup-gradle@v4'] : []),
				`      - run: ${buildCmd}`,
				''
			].join('\n');
		}

		return files;
	}
};

// ---------------------------------------------------------------------------
// G6: Baldur's Gate 3 mod template
// ---------------------------------------------------------------------------

const bg3: ProjectTemplateDef = {
	id: 'bg3',
	name: 'BG3 Mod',
	description: "Baldur's Gate 3 mod with LSX metadata",
	language: '',
	icon: '\uD83D\uDDE1\uFE0F',
	tags: ['mod', 'game', 'bg3'],
	params: [
		{ key: 'modName', label: 'Mod Name', type: 'string', default: 'My BG3 Mod', description: 'Display name of your mod' },
		{ key: 'modAuthor', label: 'Author', type: 'string', default: 'Author', description: 'Mod author name' },
		{ key: 'modDescription', label: 'Description', type: 'string', default: '', description: 'Short description of your mod' },
		{ key: 'includeScriptExtender', label: 'Script Extender', type: 'boolean', default: false, description: 'Include BG3 Script Extender config' }
	],
	generate: (name, description, params) => {
		const modName = (params.modName as string) || name;
		const modAuthor = (params.modAuthor as string) || 'Author';
		const modDescription = (params.modDescription as string) || description || `${modName} - a Baldur's Gate 3 mod.`;
		const includeScriptExtender = params.includeScriptExtender === true;
		const folderName = modName.replace(/[^a-zA-Z0-9]/g, '');

		// Generate a deterministic-looking UUID from the mod name
		const modUUID = 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
			const r = (Math.random() * 16) | 0;
			return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
		});

		const files: Record<string, string> = {};

		// info.json
		files['info.json'] = JSON.stringify({
			Mods: [{
				Author: modAuthor,
				Name: modName,
				Folder: folderName,
				Version: '1.0.0.0',
				Description: modDescription,
				UUID: modUUID,
				Created: new Date().toISOString().split('T')[0],
				Dependencies: [],
				Group: modUUID
			}]
		}, null, '\t') + '\n';

		// meta.lsx
		files['meta.lsx'] = [
			'<?xml version="1.0" encoding="UTF-8"?>',
			'<save>',
			'    <version major="4" minor="0" revision="0" build="49"/>',
			'    <region id="Config">',
			'        <node id="root">',
			'            <children>',
			'                <node id="Dependencies"/>',
			'                <node id="ModuleInfo">',
			`                    <attribute id="Author" type="LSString" value="${modAuthor}"/>`,
			'                    <attribute id="CharacterCreationLevelName" type="FixedString" value=""/>',
			`                    <attribute id="Description" type="LSString" value="${modDescription}"/>`,
			`                    <attribute id="Folder" type="LSString" value="${folderName}"/>`,
			'                    <attribute id="GMTemplate" type="FixedString" value=""/>',
			'                    <attribute id="LobbyLevelName" type="FixedString" value=""/>',
			'                    <attribute id="MD5" type="LSString" value=""/>',
			'                    <attribute id="MainMenuBackgroundVideo" type="FixedString" value=""/>',
			'                    <attribute id="MenuLevelName" type="FixedString" value=""/>',
			`                    <attribute id="Name" type="FixedString" value="${modName}"/>`,
			'                    <attribute id="NumPlayers" type="uint8" value="4"/>',
			'                    <attribute id="PhotoBooth" type="FixedString" value=""/>',
			'                    <attribute id="StartupLevelName" type="FixedString" value=""/>',
			'                    <attribute id="Tags" type="LSString" value=""/>',
			'                    <attribute id="Type" type="FixedString" value="Add-on"/>',
			`                    <attribute id="UUID" type="FixedString" value="${modUUID}"/>`,
			'                    <attribute id="Version64" type="int64" value="36028797018963968"/>',
			'                    <children>',
			'                        <node id="PublishVersion">',
			'                            <attribute id="Version64" type="int64" value="36028797018963968"/>',
			'                        </node>',
			'                        <node id="Scripts"/>',
			'                        <node id="TargetModes">',
			'                            <children>',
			'                                <node id="Target">',
			'                                    <attribute id="Object" type="FixedString" value="Story"/>',
			'                                </node>',
			'                            </children>',
			'                        </node>',
			'                    </children>',
			'                </node>',
			'            </children>',
			'        </node>',
			'    </region>',
			'</save>',
			''
		].join('\n');

		// Directory structure
		files[`Mods/${folderName}/.gitkeep`] = '';
		files[`Public/${folderName}/.gitkeep`] = '';

		// README.md
		files['README.md'] = [
			`# ${modName}`,
			'',
			modDescription,
			'',
			'## Installation',
			'',
			'1. Download the latest release',
			`2. Extract to \`%LocalAppData%\\Larian Studios\\Baldur's Gate 3\\Mods\\${folderName}\\\``,
			'3. Use a mod manager (BG3 Mod Manager recommended) to activate the mod',
			'4. Save the load order and launch the game',
			'',
			'## Structure',
			'',
			`- \`Mods/${folderName}/\` \u2014 mod scripts, story, and data`,
			`- \`Public/${folderName}/\` \u2014 shared data (stats, root templates, etc.)`,
			'- `info.json` \u2014 mod metadata',
			'- `meta.lsx` \u2014 module info for the game engine',
			''
		].join('\n');

		// .gitignore
		files['.gitignore'] = [
			'# BG3 generated files',
			'*.pak',
			'*.lsf',
			'*.lsfx',
			'',
			'# OS',
			'Thumbs.db',
			'.DS_Store',
			'',
			'# IDE',
			'.idea/',
			'.vscode/',
			'*.swp',
			'',
			'# Project',
			'.env',
			'.playground/',
			''
		].join('\n');

		// Script Extender config
		if (includeScriptExtender) {
			files['ScriptExtender/Config.json'] = JSON.stringify({
				RequiredVersion: 19,
				ModTable: folderName,
				FeatureFlags: ['Lua', 'Osiris']
			}, null, '\t') + '\n';
		}

		return files;
	}
};

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export const TEMPLATE_DEFS: ProjectTemplateDef[] = [
	blank,
	sveltekit,
	nextjs,
	python,
	fullstack,
	agent,
	go,
	rust,
	pythonCli,
	ruby,
	java,
	dotnet,
	bepinex,
	fabric,
	forge,
	paper,
	bg3
];

/** Lookup map by template id */
export const TEMPLATE_MAP: Map<string, ProjectTemplateDef> = new Map(
	TEMPLATE_DEFS.map((t) => [t.id, t])
);

/** Template metadata array suitable for sending to the client */
export function getTemplateMetadata(): ProjectTemplate[] {
	return TEMPLATE_DEFS.map(toTemplateMetadata);
}

/** Tech-stack hints keyed by template id */
export function detectTechFromTemplate(templateId: string): string[] {
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
		dotnet: ['C#', '.NET'],
		bepinex: ['C#', 'BepInEx', 'Unity'],
		fabric: ['Java', 'Fabric', 'Minecraft']
	};
	return map[templateId] ?? [];
}
