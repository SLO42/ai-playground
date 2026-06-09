import { describe, expect, it, vi } from 'vitest';
import { ConfirmCore } from './confirm-core';

describe('ConfirmCore — blocking confirm', () => {
	it('opens a confirm and resolves true on accept', async () => {
		const core = new ConfirmCore();
		const p = core.confirm({ title: 'Save config' });
		expect(core.active?.request.title).toBe('Save config');
		core.accept();
		await expect(p).resolves.toBe(true);
		expect(core.active).toBeNull();
	});

	it('resolves false on cancel', async () => {
		const core = new ConfirmCore();
		const p = core.confirm({ title: 'Stop agent', danger: true });
		core.cancel();
		await expect(p).resolves.toBe(false);
	});

	it('carries a diff for config writes (D-010)', () => {
		const core = new ConfirmCore();
		core.confirm({
			title: 'Save config',
			diff: [
				{ kind: 'context', text: '  "model": "sonnet"' },
				{ kind: 'remove', text: '  "maxTurns": 5' },
				{ kind: 'add', text: '  "maxTurns": 10' }
			]
		});
		expect(core.active?.request.diff).toHaveLength(3);
	});

	it('rejects a second confirm while one is open (no stacked modals)', async () => {
		const core = new ConfirmCore();
		const first = core.confirm({ title: 'A' });
		const second = core.confirm({ title: 'B' });
		await expect(second).resolves.toBe(false); // immediately rejected
		expect(core.active?.request.title).toBe('A'); // first still active
		core.accept();
		await expect(first).resolves.toBe(true);
	});

	it('resolve is idempotent (a double settle does not re-fire)', async () => {
		const core = new ConfirmCore();
		const p = core.confirm({ title: 'X' });
		core.accept();
		core.accept(); // no-op
		await expect(p).resolves.toBe(true);
	});

	it('notifies on open and on settle', () => {
		const onChange = vi.fn();
		const core = new ConfirmCore(onChange);
		core.confirm({ title: 'X' });
		core.accept();
		expect(onChange).toHaveBeenCalledTimes(2);
	});
});

describe('ConfirmCore — non-blocking gate banners (D-018/D-024)', () => {
	it('raises a warn and a block banner and stacks them', () => {
		const core = new ConfirmCore();
		core.raiseGate({ severity: 'warn', gate: 'read-before-edit', message: 'flagged' });
		core.raiseGate({ severity: 'block', gate: 'dangerous-bash', message: 'denied rm -rf' });
		expect(core.gates).toHaveLength(2);
		expect(core.gates[0].severity).toBe('warn');
		expect(core.gates[1].severity).toBe('block');
	});

	it('dismisses a single banner (idempotent)', () => {
		const core = new ConfirmCore();
		const id = core.raiseGate({ severity: 'block', gate: 'path-confinement', message: 'outside root' });
		core.dismissGate(id);
		expect(core.gates).toHaveLength(0);
		expect(() => core.dismissGate(id)).not.toThrow();
	});

	it('clears all banners', () => {
		const core = new ConfirmCore();
		core.raiseGate({ severity: 'warn', gate: 'g1', message: 'm1' });
		core.raiseGate({ severity: 'warn', gate: 'g2', message: 'm2' });
		core.clearGates();
		expect(core.gates).toHaveLength(0);
	});

	it('confirm and gates are independent (a gate does not block a confirm)', async () => {
		const core = new ConfirmCore();
		core.raiseGate({ severity: 'block', gate: 'g', message: 'm' });
		const p = core.confirm({ title: 'Proceed anyway' });
		expect(core.active).not.toBeNull();
		core.accept();
		await expect(p).resolves.toBe(true);
		expect(core.gates).toHaveLength(1); // banner unaffected
	});
});
