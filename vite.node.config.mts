// Minimal Vite config for `vite-node` CLI scripts (TASK 6.1).
//
// The app's vite.config.ts loads the SvelteKit plugin, which pins Vite's `root` to
// the SvelteKit app and confines `server.fs.allow`, so `vite-node scripts/*.ts`
// cannot resolve files under scripts/. These standalone scripts (db:up / db:migrate
// / db:import) only need Vite's resolver for extensionless `.ts` imports inside
// src/lib/server — NOT the SvelteKit plugin. This bare config gives them exactly
// that. Run via `npm run db:up` etc.

import { defineConfig } from 'vite';

export default defineConfig({});
