import { error } from '@sveltejs/kit';
import { stat, readFile, readdir } from 'fs/promises';
import { watchFile, unwatchFile } from 'fs';
import { resolve } from 'path';
import { SERVICES } from '$lib/server/constants.js';
import type { RequestHandler } from './$types.js';

export const GET: RequestHandler = async ({ params }) => {
	const service = SERVICES[params.id as keyof typeof SERVICES];
	if (!service) throw error(404, 'Service not found');
	if (!service.logFile) throw error(404, 'No logs configured for this service');

	const logPath = service.logFile;

	const stream = new ReadableStream({
		start(controller) {
			const encoder = new TextEncoder();
			let positions = new Map<string, number>();
			let watchedFiles: string[] = [];
			let dirInterval: ReturnType<typeof setInterval> | null = null;
			let closed = false;

			function send(data: string) {
				if (closed) return;
				try {
					controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
				} catch {
					cleanup();
				}
			}

			async function tailFile(filePath: string) {
				try {
					const s = await stat(filePath);
					const prev = positions.get(filePath) ?? s.size;
					if (s.size <= prev) {
						positions.set(filePath, s.size);
						return;
					}
					const buf = Buffer.alloc(s.size - prev);
					const fh = await (await import('fs/promises')).open(filePath, 'r');
					await fh.read(buf, 0, buf.length, prev);
					await fh.close();
					positions.set(filePath, s.size);
					const newLines = buf.toString('utf-8').split('\n').filter(Boolean);
					for (const line of newLines) {
						send(line);
					}
				} catch {
					// file may have been rotated
				}
			}

			async function watchSingleFile(filePath: string) {
				try {
					const s = await stat(filePath);
					positions.set(filePath, s.size);
				} catch {
					positions.set(filePath, 0);
				}
				watchFile(filePath, { interval: 1000 }, () => tailFile(filePath));
				watchedFiles.push(filePath);
			}

			async function setup() {
				try {
					const info = await stat(logPath);

					if (info.isDirectory()) {
						// Watch directory for new/changed files
						async function scanDir() {
							try {
								const files = await readdir(logPath);
								const logFiles = files.filter((f) => f.endsWith('.log'));
								for (const f of logFiles) {
									const fp = resolve(logPath, f);
									if (!watchedFiles.includes(fp)) {
										await watchSingleFile(fp);
									}
								}
							} catch { /* dir may not exist yet */ }
						}
						await scanDir();
						dirInterval = setInterval(scanDir, 3000);
					} else {
						await watchSingleFile(logPath);
					}
				} catch {
					send('[log source not available]');
				}
			}

			function cleanup() {
				closed = true;
				for (const fp of watchedFiles) {
					unwatchFile(fp);
				}
				watchedFiles = [];
				if (dirInterval) clearInterval(dirInterval);
			}

			setup();

			// Send keepalive every 15s
			const keepalive = setInterval(() => {
				if (closed) { clearInterval(keepalive); return; }
				try {
					controller.enqueue(encoder.encode(': keepalive\n\n'));
				} catch {
					cleanup();
					clearInterval(keepalive);
				}
			}, 15000);

			// Clean up when the client disconnects
			// The controller's cancel signal is handled via the pull/cancel mechanism
			controller.enqueue(encoder.encode(': connected\n\n'));
		}
	});

	return new Response(stream, {
		headers: {
			'Content-Type': 'text/event-stream',
			'Cache-Control': 'no-cache',
			Connection: 'keep-alive'
		}
	});
};
