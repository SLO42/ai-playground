import { writable, derived } from 'svelte/store';
import { browser } from '$app/environment';

export interface Project {
	id: string;
	name: string;
	path: string;
	status: 'active' | 'archived' | 'error';
	lastOpened: string;
	createdAt: string;
}

interface ProjectsState {
	projects: Project[];
	activeProjectId: string | null;
}

const STORAGE_KEY = 'ai-playground-projects';

function loadFromStorage(): ProjectsState {
	if (!browser) return { projects: [], activeProjectId: null };
	try {
		const raw = localStorage.getItem(STORAGE_KEY);
		if (raw) return JSON.parse(raw);
	} catch { /* ignore corrupt data */ }
	return { projects: [], activeProjectId: null };
}

function saveToStorage(state: ProjectsState) {
	if (!browser) return;
	try {
		localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
	} catch { /* ignore quota errors */ }
}

function createProjectsStore() {
	const store = writable<ProjectsState>(loadFromStorage());

	store.subscribe((state) => saveToStorage(state));

	function generateId(): string {
		return `proj-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
	}

	function createProject(name: string, path: string): Project {
		const project: Project = {
			id: generateId(),
			name,
			path,
			status: 'active',
			lastOpened: new Date().toISOString(),
			createdAt: new Date().toISOString()
		};
		store.update((s) => ({
			...s,
			projects: [...s.projects, project],
			activeProjectId: project.id
		}));
		return project;
	}

	function importProject(name: string, path: string): Project {
		return createProject(name, path);
	}

	function deleteProject(id: string) {
		store.update((s) => ({
			projects: s.projects.filter((p) => p.id !== id),
			activeProjectId: s.activeProjectId === id ? null : s.activeProjectId
		}));
	}

	function setActiveProject(id: string | null) {
		store.update((s) => {
			const project = id ? s.projects.find((p) => p.id === id) : null;
			if (id && !project) return s;
			const projects = project
				? s.projects.map((p) =>
						p.id === id ? { ...p, lastOpened: new Date().toISOString() } : p
					)
				: s.projects;
			return { projects, activeProjectId: id };
		});
	}

	function updateProject(id: string, updates: Partial<Pick<Project, 'name' | 'path' | 'status'>>) {
		store.update((s) => ({
			...s,
			projects: s.projects.map((p) => (p.id === id ? { ...p, ...updates } : p))
		}));
	}

	const projects = derived(store, ($s) => $s.projects);
	const activeProject = derived(store, ($s) =>
		$s.activeProjectId ? $s.projects.find((p) => p.id === $s.activeProjectId) ?? null : null
	);

	return {
		subscribe: store.subscribe,
		projects,
		activeProject,
		createProject,
		importProject,
		deleteProject,
		setActiveProject,
		updateProject
	};
}

export const projectsStore = createProjectsStore();
