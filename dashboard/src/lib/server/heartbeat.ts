/**
 * Re-export from modular heartbeat directory.
 * Kept for backwards compatibility — all imports resolve to heartbeat/index.ts.
 */
export { startHeartbeat, stopHeartbeat, isHeartbeatRunning } from './heartbeat/index.js';
