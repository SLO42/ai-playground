// server/markdown — a SMALL, escape-first Markdown → safe HTML renderer (TASK 11.2).
//
// Used to render agent-generated changelog content (the `changelog` release step's
// session output, DATA-MODEL §4.11) on /release. The content is UNTRUSTED model output,
// so safety is the first-class requirement: we SANITIZE AT THE BOUNDARY by escaping the
// ENTIRE input first (so no raw HTML the model emitted can ever reach the DOM), and only
// THEN layer a constrained Markdown subset on top of the already-escaped text. The output
// therefore contains ONLY the tags this renderer itself emits — there is no passthrough of
// model-authored HTML, and `{@html}` on the result is safe by construction.
//
// Deliberately NOT a full CommonMark implementation (no new dependency, no font/binary):
// we support exactly the subset a changelog needs — headings, paragraphs, unordered +
// ordered lists, blockquotes, fenced + inline code, bold/italic, and links with a
// safe-protocol allowlist. Anything outside the subset renders as escaped literal text
// (honest: we never silently drop content). Links to non-http(s)/mailto schemes
// (javascript:, data:, vbscript:, …) are rendered as plain escaped text, never an <a>.

/** HTML-escape every metacharacter so no input byte can open a tag or attribute. */
export function escapeHtml(s: string): string {
	return s
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#39;');
}

/** Only these URL schemes may become a real link; everything else stays literal text. */
const SAFE_LINK = /^(https?:|mailto:)/i;

/**
 * Render INLINE markdown on an ALREADY-ESCAPED string. Order matters: code spans first
 * (their contents are taken literally), then links, then bold, then italic. Because the
 * input is already HTML-escaped, the only `<`/`>` present are the ones we introduce here.
 */
function renderInline(escaped: string): string {
	let out = escaped;

	// Inline code: `code` → <code>code</code>. The capture is already escaped.
	out = out.replace(/`([^`]+)`/g, (_m, code: string) => `<code>${code}</code>`);

	// Links: [text](url). `url` is matched on the escaped text, so it cannot contain a
	// raw quote/space; we still re-escape defensively and enforce the scheme allowlist.
	// A disallowed scheme degrades to the literal "text" (no anchor) — never a dead/unsafe link.
	out = out.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, text: string, url: string) => {
		// The url came from already-escaped text; decode the entities we added so the
		// scheme test sees the real characters, then re-escape for the attribute.
		const decoded = url
			.replace(/&amp;/g, '&')
			.replace(/&lt;/g, '<')
			.replace(/&gt;/g, '>')
			.replace(/&quot;/g, '"')
			.replace(/&#39;/g, "'");
		if (!SAFE_LINK.test(decoded)) return text; // unsafe scheme → plain text, no anchor
		return `<a href="${escapeHtml(decoded)}" rel="noopener noreferrer nofollow" target="_blank">${text}</a>`;
	});

	// Bold (**x** / __x__) then italic (*x* / _x_). Bold first so ** is not eaten by *.
	out = out.replace(/\*\*([^*]+)\*\*/g, (_m, x: string) => `<strong>${x}</strong>`);
	out = out.replace(/__([^_]+)__/g, (_m, x: string) => `<strong>${x}</strong>`);
	out = out.replace(/\*([^*]+)\*/g, (_m, x: string) => `<em>${x}</em>`);
	out = out.replace(/(^|[^\w])_([^_]+)_(?=[^\w]|$)/g, (_m, pre: string, x: string) => `${pre}<em>${x}</em>`);

	return out;
}

/**
 * Render a constrained Markdown subset to SAFE HTML. The input is escaped in full before
 * any structure is parsed, so the result contains only tags this function emits — safe to
 * inject with `{@html}`. Returns '' for empty/whitespace-only input (honest empty state).
 */
export function renderMarkdown(input: string): string {
	if (typeof input !== 'string' || input.trim() === '') return '';

	// Normalize line endings, then escape EVERYTHING up front (the boundary).
	const escaped = escapeHtml(input.replace(/\r\n?/g, '\n'));
	const lines = escaped.split('\n');

	const html: string[] = [];
	let i = 0;

	// Buffered list/paragraph accumulators.
	let para: string[] = [];
	const flushPara = () => {
		if (para.length) {
			html.push(`<p>${renderInline(para.join(' ').trim())}</p>`);
			para = [];
		}
	};

	while (i < lines.length) {
		const line = lines[i];

		// Fenced code block: ```lang … ``` (escaped fence is literal ``` since backticks
		// are not HTML metacharacters). Contents render verbatim (already escaped).
		if (/^\s*```/.test(line)) {
			flushPara();
			const body: string[] = [];
			i++;
			while (i < lines.length && !/^\s*```/.test(lines[i])) {
				body.push(lines[i]);
				i++;
			}
			i++; // consume the closing fence (or EOF)
			html.push(`<pre><code>${body.join('\n')}</code></pre>`);
			continue;
		}

		// Blank line → paragraph boundary.
		if (line.trim() === '') {
			flushPara();
			i++;
			continue;
		}

		// ATX heading: #..###### text (the # is escaped to itself; not an HTML char).
		const h = /^(#{1,6})\s+(.*)$/.exec(line);
		if (h) {
			flushPara();
			const level = h[1].length;
			html.push(`<h${level}>${renderInline(h[2].trim())}</h${level}>`);
			i++;
			continue;
		}

		// Blockquote: one or more leading "> " lines.
		if (/^\s*&gt;\s?/.test(line)) {
			flushPara();
			const quote: string[] = [];
			while (i < lines.length && /^\s*&gt;\s?/.test(lines[i])) {
				quote.push(lines[i].replace(/^\s*&gt;\s?/, ''));
				i++;
			}
			html.push(`<blockquote>${renderInline(quote.join(' ').trim())}</blockquote>`);
			continue;
		}

		// Unordered list: -, *, or + bullets.
		if (/^\s*[-*+]\s+/.test(line)) {
			flushPara();
			const items: string[] = [];
			while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) {
				items.push(lines[i].replace(/^\s*[-*+]\s+/, ''));
				i++;
			}
			html.push(`<ul>${items.map((it) => `<li>${renderInline(it.trim())}</li>`).join('')}</ul>`);
			continue;
		}

		// Ordered list: "1. ", "2) ", etc.
		if (/^\s*\d+[.)]\s+/.test(line)) {
			flushPara();
			const items: string[] = [];
			while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i])) {
				items.push(lines[i].replace(/^\s*\d+[.)]\s+/, ''));
				i++;
			}
			html.push(`<ol>${items.map((it) => `<li>${renderInline(it.trim())}</li>`).join('')}</ol>`);
			continue;
		}

		// Otherwise: part of a paragraph.
		para.push(line.trim());
		i++;
	}
	flushPara();

	return html.join('\n');
}
