// Unit tests for the escape-first safe Markdown renderer (TASK 11.2).
//
// The renderer is the SANITIZATION BOUNDARY for untrusted agent-generated changelog
// content, so the security properties (no raw HTML passthrough, no unsafe link schemes)
// are tested as hard invariants alongside the formatting subset.

import { describe, it, expect } from 'vitest';
import { renderMarkdown, escapeHtml } from './markdown';

describe('escapeHtml', () => {
	it('escapes every HTML metacharacter', () => {
		expect(escapeHtml(`<a href="x" onclick='y'>&</a>`)).toBe(
			'&lt;a href=&quot;x&quot; onclick=&#39;y&#39;&gt;&amp;&lt;/a&gt;'
		);
	});
});

describe('renderMarkdown — safety (the boundary)', () => {
	it('never passes through raw HTML the model emitted', () => {
		const out = renderMarkdown('<script>alert(1)</script>');
		expect(out).not.toContain('<script>');
		expect(out).toContain('&lt;script&gt;');
	});

	it('escapes an injected img/onerror payload to literal text', () => {
		const out = renderMarkdown(`hello <img src=x onerror="alert(1)">`);
		expect(out).not.toContain('<img');
		expect(out).toContain('&lt;img src=x onerror=&quot;alert(1)&quot;&gt;');
	});

	it('renders a javascript: link as plain text, not an anchor', () => {
		const out = renderMarkdown('[click](javascript:alert(1))');
		expect(out).not.toContain('<a ');
		expect(out).not.toContain('javascript:');
		expect(out).toContain('click');
	});

	it('renders a data: link as plain text, not an anchor', () => {
		const out = renderMarkdown('[x](data:text/html,<script>alert(1)</script>)');
		expect(out).not.toContain('<a ');
	});

	it('allows http(s) and mailto links with hardening rel/target', () => {
		const out = renderMarkdown('[site](https://example.com)');
		expect(out).toContain('<a href="https://example.com"');
		expect(out).toContain('rel="noopener noreferrer nofollow"');
		expect(out).toContain('target="_blank"');
		expect(out).toContain('>site</a>');
		expect(renderMarkdown('[mail](mailto:a@b.com)')).toContain('<a href="mailto:a@b.com"');
	});
});

describe('renderMarkdown — formatting subset', () => {
	it('returns empty string for empty / whitespace input (honest empty)', () => {
		expect(renderMarkdown('')).toBe('');
		expect(renderMarkdown('   \n  ')).toBe('');
		// @ts-expect-error — defensive non-string guard
		expect(renderMarkdown(null)).toBe('');
	});

	it('renders ATX headings at the right level', () => {
		expect(renderMarkdown('# v0.4')).toBe('<h1>v0.4</h1>');
		expect(renderMarkdown('### Fixes')).toBe('<h3>Fixes</h3>');
	});

	it('renders an unordered list', () => {
		const out = renderMarkdown('- one\n- two');
		expect(out).toBe('<ul><li>one</li><li>two</li></ul>');
	});

	it('renders an ordered list', () => {
		const out = renderMarkdown('1. first\n2. second');
		expect(out).toBe('<ol><li>first</li><li>second</li></ol>');
	});

	it('renders bold, italic, and inline code', () => {
		expect(renderMarkdown('**bold** and *italic* and `code`')).toBe(
			'<p><strong>bold</strong> and <em>italic</em> and <code>code</code></p>'
		);
	});

	it('renders a fenced code block verbatim (escaped)', () => {
		const out = renderMarkdown('```\nconst x = a < b;\n```');
		expect(out).toBe('<pre><code>const x = a &lt; b;</code></pre>');
	});

	it('renders a blockquote', () => {
		expect(renderMarkdown('> note')).toBe('<blockquote>note</blockquote>');
	});

	it('renders a realistic changelog with mixed structure', () => {
		const md = ['# v0.4', '', 'Highlights:', '', '- **Added** release rendering', '- Fixed a bug'].join('\n');
		const out = renderMarkdown(md);
		expect(out).toContain('<h1>v0.4</h1>');
		expect(out).toContain('<p>Highlights:</p>');
		expect(out).toContain('<li><strong>Added</strong> release rendering</li>');
		expect(out).toContain('<li>Fixed a bug</li>');
	});
});
