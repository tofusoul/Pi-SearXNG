/**
 * pi-searxng — local SearXNG-backed web search + fetch tools for pi.
 *
 * A pi extension package: register the local SearXNG service (see README) as a
 * pair of agent tools — web_search + web_fetch — with no API key and no quota.
 * SearXNG aggregates ~70 upstream engines (Google, Bing, DuckDuckGo, Wikipedia…)
 * and returns JSON.
 *
 * Tools:
 *   - web_search : query SearXNG, return ranked titles + URLs + short snippets
 *   - web_fetch  : GET a URL, strip HTML to readable text (complements search)
 *
 * Design goals:
 *   - CONCISE: few results by default, short snippets, URLs kept prominent.
 *   - CITED: promptGuidelines enforce inline source links + a Sources list for
 *     any factual finding, and steer the search → fetch → verify → cite flow.
 *
 * Install:  pi install git:github.com/tofusoul/Pi-SearXNG
 * Dev:     npm run typecheck   (loaded by pi via jiti — no build step needed)
 *
 * Error convention (per pi's AgentToolResult): THROW on failure rather than
 * encoding errors in content — the framework surfaces thrown errors to the
 * model as tool errors, and every return path keeps the required `details`.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const SEARXNG = "http://127.0.0.1:8888";

interface SearxResult {
	title?: string;
	url?: string;
	content?: string; // snippet
	engines?: string[];
	publishedDate?: string;
}

interface SearxResponse {
	results?: SearxResult[];
	number_of_results?: number;
	unresponsive_engines?: Array<{ engine: string; error: string }>;
}

type TimeRange = "day" | "week" | "month" | "year";
const TIME_RANGES: readonly TimeRange[] = ["day", "week", "month", "year"];

interface WebSearchParams {
	query: string;
	max_results?: number;
	time_range?: TimeRange;
	categories?: string;
	language?: string;
}

type FetchFormat = "markdown" | "text" | "metadata";
const FETCH_FORMATS: readonly FetchFormat[] = ["markdown", "text", "metadata"];

interface WebFetchParams {
	url: string;
	max_chars?: number;
	format?: FetchFormat;
}

function clampInt(n: unknown, fallback: number, lo: number, hi: number): number {
	if (typeof n !== "number" || !Number.isFinite(n)) return fallback;
	return Math.max(lo, Math.min(hi, Math.floor(n)));
}

/** Trim to `max` chars on a word boundary, appending an ellipsis if cut. */
function truncate(text: string, max: number): string {
	const t = text.trim();
	if (t.length <= max) return t;
	const cut = t.slice(0, max);
	// Snip back to the last space so we don't cut mid-word.
	const lastSpace = cut.lastIndexOf(" ");
	return `${(lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}

export default function searxngSearchExtension(pi: ExtensionAPI) {
	// ── web_search ───────────────────────────────────────────────────────
	pi.registerTool({
		name: "web_search",
		label: "Web Search",
		description:
			"Search the web via the local SearXNG metasearch instance (aggregates Google, Bing, DuckDuckGo, Wikipedia, and more). " +
			"Returns a concise ranked list of titles, URLs, and short snippets — no API key required. Use for current info, recent events, " +
			"library versions, or live docs not in the codebase. Pass time_range ('day'|'week'|'month'|'year') for recency-sensitive " +
			"queries. Scope with categories ('news','it','science','images','files','videos','map') and language (BCP-47 like 'en','zh','ja'); " +
			"defaults to the 'general' category. Follow up with web_fetch on the best result, and always cite sources.",
		promptSnippet: "Search the web via the local SearXNG instance; then fetch + cite the best result",
		promptGuidelines: [
			"Use web_search for current info beyond the codebase — recent events, library versions, live API docs, or external behavior. Run targeted queries, then web_fetch the single most relevant result to verify specifics before relying on it.",
			"CITE every searched fact: when you relay any date, figure, quote, or finding from web_search or web_fetch, link the source URL inline as markdown AND list every source under a final '## Sources' heading. Never present a searched fact without its source URL.",
			"Separate fact from inference: state only what a cited source supports; flag anything you infer or assume, and call out when a result's date or relevance is uncertain (check the article's own date before treating a result as current).",
			"For 'today'/'latest'/'recent'/'this week' queries, pass time_range ('day' or 'week') to filter to recent results — but STILL verify each result's published date, since time_range filters by engine index/crawl time, which can lag an article's true publish date.",
			"Scope results: use categories='news' for current events, 'it' for code/libraries/tech, or 'science' for papers; pass language (e.g. 'zh','ja') for non-English queries to get better local results.",
		],
		parameters: Type.Object({
			query: Type.String({
				description: "The search query. Be specific and use natural language.",
			}),
			max_results: Type.Optional(
				Type.Integer({
					description: "Maximum results to return (default 5, max 20). Fewer is usually better — fetch the best one.",
					minimum: 1,
					maximum: 20,
				}),
			),
			time_range: Type.Optional(
				Type.Union(
					[
						Type.Literal("day"),
						Type.Literal("week"),
						Type.Literal("month"),
						Type.Literal("year"),
					],
					{ description: "Restrict to results from the last day/week/month/year (recency filter). Omit for all-time results." },
				),
			),
			categories: Type.Optional(
				Type.String({
					description: "SearXNG category to search. Common: 'general' (default), 'news', 'it', 'science', 'images', 'files', 'videos', 'music', 'social media', 'map'. Comma-separated for several.",
				}),
			),
			language: Type.Optional(
				Type.String({
					description: "BCP-47 language code to bias results (e.g. 'en', 'zh', 'ja', 'de', 'fr'). Omit for all languages / auto.",
				}),
			),
		}),
		async execute(_toolCallId, params: WebSearchParams, signal) {
			const query = (params.query ?? "").trim();
			if (!query) throw new Error("Empty search query.");

			const max = clampInt(params.max_results, 5, 1, 20);
			const timeRange =
				typeof params.time_range === "string" && (TIME_RANGES as readonly string[]).includes(params.time_range)
					? (params.time_range as TimeRange)
					: undefined;
			// categories: sanitize to a safe comma-separated list (word chars/spaces/commas); default 'general'.
			const rawCats = typeof params.categories === "string" ? params.categories.trim() : "";
			const categories = /^[\w ,]+$/i.test(rawCats) && rawCats ? rawCats : "general";
			const language =
				typeof params.language === "string" && /^[\w-]{2,}$/i.test(params.language.trim())
					? params.language.trim()
					: undefined;

			const url = new URL(`${SEARXNG}/search`);
			url.searchParams.set("q", query);
			url.searchParams.set("format", "json");
			url.searchParams.set("safesearch", "0");
			url.searchParams.set("categories", categories);
			if (language) url.searchParams.set("language", language);
			if (timeRange) url.searchParams.set("time_range", timeRange);

			let res: Response;
			try {
				res = await fetch(url, {
					headers: { Accept: "application/json" },
					signal,
				});
			} catch (err) {
				throw new Error(
					`SearXNG request failed: ${String(err)}. Is the service up on ${SEARXNG}? Check: sudo systemctl status searx.service`,
				);
			}

			if (!res.ok) {
				throw new Error(`SearXNG returned HTTP ${res.status} ${res.statusText}.`);
			}

			let data: SearxResponse;
			try {
				data = (await res.json()) as SearxResponse;
			} catch (err) {
				throw new Error(
					`Failed to parse SearXNG JSON response: ${String(err)}. JSON output may be disabled in the service config (search.formats).`,
				);
			}

			const results = (data.results ?? []).slice(0, max);
			if (results.length === 0) {
				const unresponsive = data.unresponsive_engines ?? [];
				const note =
					unresponsive.length > 0
						? `\n(${unresponsive.length} upstream engine(s) unresponsive — SearXNG may be rate-limited or pointing at offline engines.)`
						: "";
				return {
					content: [{ type: "text", text: `No results for: ${query}${note}` }],
					details: { query, count: 0, total: data.number_of_results, engines: [], time_range: timeRange ?? null, categories, language: language ?? null },
				};
			}

			// Compact 3-line entries: title(+date) / url / short snippet.
			// URL stays on its own line so it's trivial to cite as a markdown link.
			const lines = results.map((r, i) => {
				const title = (r.title ?? "").trim() || "(untitled)";
				const link = (r.url ?? "").trim();
				const snippet = truncate((r.content ?? "").replace(/\s+/g, " ").trim(), 180);
				const date = r.publishedDate ? ` (${r.publishedDate.slice(0, 10)})` : "";
				return `${i + 1}. ${title}${date}\n   ${link}\n   ${snippet}`.trimEnd();
			});

			const total = data.number_of_results;
			const totalLabel = typeof total === "number" && total > 0 ? ` of ~${total}` : "";
			const label = [
				categories !== "general" ? categories : "",
				language ?? "",
				timeRange ? `past ${timeRange}` : "",
			].filter(Boolean).join(" · ");
			const text =
				`Search: ${query}${label ? ` · ${label}` : ""} (${results.length}${totalLabel} results)\n\n` +
				`${lines.join("\n\n")}\n\n` +
				`Fetch the most relevant result with web_fetch to verify specifics, then cite its URL.`;

			return {
				content: [{ type: "text", text }],
				details: {
					query,
					count: results.length,
					total,
					engines: results.map((r) => r.engines ?? []),
					time_range: timeRange ?? null,
					categories,
					language: language ?? null,
				},
			};
		},
	});

	// ── web_fetch ────────────────────────────────────────────────────────
	pi.registerTool({
		name: "web_fetch",
		label: "Web Fetch",
		description:
		"Fetch a web page (http/https) and extract its MAIN content as clean Markdown (boilerplate like nav/footer/sidebar/ads is dropped; " +
		"title/site/published-date metadata is prepended). Use after web_search narrows to the best source (or when a specific URL is known) " +
		"to verify specifics before citing. Set format='metadata' for just a compact page summary, or 'text' for plain text.",
		promptSnippet: "Fetch a URL's text to verify specifics, then cite it",
		promptGuidelines: [
			"Use web_fetch to read a URL you intend to cite or quote — usually after web_search narrows to the best source, or when a specific URL is already known.",
			"CITE every fetched fact: link the source URL inline as markdown AND list sources under a final '## Sources' heading. Never present fetched facts without their source URL.",
		],
		parameters: Type.Object({
			url: Type.String({ description: "The http:// or https:// URL to fetch." }),
			format: Type.Optional(
				Type.Union(
					[Type.Literal("markdown"), Type.Literal("text"), Type.Literal("metadata")],
					{ description: "Output format: 'markdown' (default, clean main content with links), 'text' (plain text), or 'metadata' (title/site/date summary only)." },
				),
			),
			max_chars: Type.Optional(
				Type.Integer({
					description: "Cap on returned characters for the body (default 10000, max 50000). Ignored for format='metadata'.",
					minimum: 500,
					maximum: 50000,
				}),
			),
		}),
		async execute(_toolCallId, params: WebFetchParams, signal) {
			const raw = (params.url ?? "").trim();
			if (!/^https?:\/\//i.test(raw)) {
				throw new Error("url must start with http:// or https://");
			}
			const cap = clampInt(params.max_chars, 10000, 500, 50000);
			const format =
				typeof params.format === "string" && (FETCH_FORMATS as readonly string[]).includes(params.format)
					? (params.format as FetchFormat)
					: "markdown";

			let res: Response;
			try {
				res = await fetch(raw, {
					headers: {
						Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,text/*;q=0.8,*/*;q=0.5",
						"User-Agent": "pi-searxng-ext/1.0 (+localhost)",
					},
					redirect: "follow",
					signal,
				});
			} catch (err) {
				throw new Error(`Fetch failed: ${String(err)}`);
			}

			if (!res.ok) {
				throw new Error(`HTTP ${res.status} ${res.statusText} for ${raw}`);
			}

			const contentType = res.headers.get("content-type") ?? "";
			const isHtml = contentType.toLowerCase().includes("html");
			const body = await res.text();
			const meta: PageMeta = isHtml ? extractMeta(body) : {};
			const header = formatMetaHeader(raw, meta);

			if (format === "metadata") {
				return {
					content: [{ type: "text", text: header }],
					details: { url: raw, format: format as FetchFormat, chars: header.length, contentType, meta },
				};
			}

			const main = isHtml ? selectMainContent(body) : body;
			const content = isHtml ? (format === "text" ? htmlToText(main) : htmlToMarkdown(main)) : body;
			const trimmed = truncateAtBoundary(content, cap);

			return {
				content: [{ type: "text", text: `${header}\n\n${trimmed}` }],
				details: { url: raw, format: format as FetchFormat, chars: trimmed.length, contentType, meta },
			};
		},
	});
}

/**
 * ── Content extraction helpers ────────────────────────────────────────
 * Pure-TS (no DOM parser, no deps). Heuristic pipeline inspired by Jina
 * Reader / Tavily / Firecrawl: pick the main content, drop boilerplate
 * (nav/footer/sidebar/ads), convert to Markdown, prepend metadata. Not
 * perfect on every page, but removes the site-chrome noise that made plain-
 * text fetches huge and keeps links for citation.
 */
interface PageMeta {
	title?: string;
	description?: string;
	siteName?: string;
	published?: string;
}

function decodeEntities(s: string): string {
	return s
		.replace(/&nbsp;/g, " ")
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)));
}

function stripTags(s: string): string {
	return s.replace(/<[^>]+>/g, "");
}

/** Collapse inner tag soup of a heading/link/list item to clean text. */
function stripInline(s: string): string {
	return stripTags(s).replace(/\s+/g, " ").trim();
}

/** First <meta> content whose tag matches keyRe (attribute-order agnostic). */
function metaContent(html: string, keyRe: RegExp): string | undefined {
	const tags = html.match(/<meta\b[^>]*>/gi) ?? [];
	for (const tag of tags) {
		if (keyRe.test(tag)) {
			const c = tag.match(/\bcontent=["']([^"']*)["']/i);
			if (c) return decodeEntities(c[1]).trim();
		}
	}
	return undefined;
}

function firstMatch(html: string, re: RegExp): string | undefined {
	const m = html.match(re);
	return m ? decodeEntities(m[1]).trim() : undefined;
}

function extractMeta(html: string): PageMeta {
	const title =
		metaContent(html, /\bog:title\b/i) ||
		firstMatch(html, /<title[^>]*>([\s\S]*?)<\/title>/i) ||
		firstMatch(html, /<h1[^>]*>([\s\S]*?)<\/h1>/i);
	const description =
		metaContent(html, /\bog:description\b/i) ||
		metaContent(html, /\bname=["']description["']/i);
	const siteName = metaContent(html, /\bog:site_name\b/i);
	const published =
		metaContent(html, /\barticle:published_time\b/i) ||
		metaContent(html, /\b(?:name|itemprop)=["'](?:datePublished|pubdate|date)["']/i) ||
		firstMatch(html, /<time\b[^>]*datetime=["']([^"']+)["']/i);
	return { title, description, siteName, published };
}

function formatMetaHeader(url: string, meta: PageMeta): string {
	const lines = [`# ${meta.title || url}`];
	lines.push(`URL: ${url}`);
	if (meta.siteName) lines.push(`Site: ${meta.siteName}`);
	if (meta.published) lines.push(`Published: ${meta.published.slice(0, 10)}`);
	if (meta.description) lines.push("", meta.description.trim());
	return lines.join("\n").trim();
}

/** Prefer <article>/<main>/content container; fall back to <body>. */
function selectMainContent(html: string): string {
	const pick = (re: RegExp): string | undefined => {
		const m = html.match(re);
		return m ? m[1] : undefined;
	};
	return (
		pick(/<article\b[^>]*>([\s\S]*?)<\/article>/i) ||
		pick(/<main\b[^>]*>([\s\S]*?)<\/main>/i) ||
		pick(/<[^>]+(?:id|class)=["'][^"']*(?:content|post-body|entry-content|article-body|main-content)[^"']*["'][^>]*>([\s\S]*?)<\/(?:div|section|article)>/i) ||
		pick(/<body\b[^>]*>([\s\S]*?)<\/body>/i) ||
		html
	);
}

/** Remove scripts/styles/comments and boilerplate block tags from a fragment. */
function stripNoise(html: string): string {
	return html
		.replace(/<script[\s\S]*?<\/script>/gi, " ")
		.replace(/<style[\s\S]*?<\/style>/gi, " ")
		.replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
		.replace(/<template[\s\S]*?<\/template>/gi, " ")
		.replace(/<!--[\s\S]*?-->/g, " ")
		.replace(/<(nav|footer|aside|form|svg|iframe)\b[\s\S]*?<\/\1>/gi, " ")
		.replace(/<img\b[^>]*>/gi, " ");
}

/** Heuristic HTML → Markdown (headings, lists, links, emphasis, code, blockquote). */
function htmlToMarkdown(html: string): string {
	let s = stripNoise(html);

	s = s.replace(/<pre\b[^>]*>([\s\S]*?)<\/pre>/gi, (_m, code) => `\n\n\`\`\`\n${stripTags(code).trim()}\n\`\`\`\n\n`);
	s = s.replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi, (_m, lvl, inner) => `\n\n${"#".repeat(Number(lvl))} ${stripInline(inner)}\n\n`);
	s = s.replace(/<blockquote\b[^>]*>([\s\S]*?)<\/blockquote>/gi, (_m, inner) =>
		`\n` + stripInline(inner).split(/\n+/).map((l: string) => `> ${l}`).join("\n") + `\n`);
	s = s.replace(/<li\b[^>]*>([\s\S]*?)<\/li>/gi, (_m, inner) => `\n- ${stripInline(inner)}`);
	s = s.replace(/<\/?(ul|ol)\b[^>]*>/gi, "\n");
	s = s.replace(/<a\b[^>]*href=["']([^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi, (_m, href, inner) => {
		const text = stripInline(inner) || href;
		return href ? `[${text}](${href})` : text;
	});
	s = s.replace(/<(strong|b)\b[^>]*>([\s\S]*?)<\/\1>/gi, "**$2**");
	s = s.replace(/<(em|i)\b[^>]*>([\s\S]*?)<\/\1>/gi, "*$2*");
	s = s.replace(/<code\b[^>]*>([\s\S]*?)<\/code>/gi, "`$1`");
	s = s.replace(/<hr\b[^>]*\/?>/gi, "\n\n---\n\n");
	s = s.replace(/<br\s*\/?>/gi, "\n");
	s = s.replace(/<\/(p|div|section|article|header|main|tr|td)>/gi, "\n\n");

	s = stripTags(s);
	s = decodeEntities(s);
	return s.replace(/\r\n/g, "\n").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
}

/** Plain-text fallback: de-noise + strip tags + collapse whitespace. */
function htmlToText(html: string): string {
	let s = stripNoise(html);
	s = s.replace(/<\/?(p|div|section|article|li|tr|td|h[1-6]|blockquote|pre|header|footer|main|br|hr)\b[^>]*>/gi, "\n");
	s = stripTags(s);
	s = decodeEntities(s);
	return s.replace(/\r\n/g, "\n").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
}

/** Truncate at a paragraph/heading boundary, noting the original length. */
function truncateAtBoundary(text: string, max: number): string {
	if (text.length <= max) return text;
	const slice = text.slice(0, max);
	const lastBreak = slice.lastIndexOf("\n\n");
	const cut = lastBreak > max * 0.5 ? slice.slice(0, lastBreak) : slice;
	return `${cut.trimEnd()}\n\n[... truncated; ${text.length} total chars]`;
}
