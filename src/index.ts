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

interface WebSearchParams {
	query: string;
	max_results?: number;
}

interface WebFetchParams {
	url: string;
	max_chars?: number;
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
			"library versions, or live docs not in the codebase. Follow up with web_fetch on the best result, and always cite sources.",
		promptSnippet: "Search the web via the local SearXNG instance; then fetch + cite the best result",
		promptGuidelines: [
			"Use web_search for current info beyond the codebase — recent events, library versions, live API docs, or external behavior. Run targeted queries, then web_fetch the single most relevant result to verify specifics before relying on it.",
			"CITE every searched fact: when you relay any date, figure, quote, or finding from web_search or web_fetch, link the source URL inline as markdown AND list every source under a final '## Sources' heading. Never present a searched fact without its source URL.",
			"Separate fact from inference: state only what a cited source supports; flag anything you infer or assume, and call out when a result's date or relevance is uncertain (check the article's own date before treating a result as current).",
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
		}),
		async execute(_toolCallId, params: WebSearchParams, signal) {
			const query = (params.query ?? "").trim();
			if (!query) throw new Error("Empty search query.");

			const max = clampInt(params.max_results, 5, 1, 20);

			const url = new URL(`${SEARXNG}/search`);
			url.searchParams.set("q", query);
			url.searchParams.set("format", "json");
			url.searchParams.set("safesearch", "0");
			url.searchParams.set("categories", "general");

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
					details: { query, count: 0, total: data.number_of_results, engines: [] },
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
			const text =
				`Search: ${query} (${results.length}${totalLabel} results)\n\n` +
				`${lines.join("\n\n")}\n\n` +
				`Fetch the most relevant result with web_fetch to verify specifics, then cite its URL.`;

			return {
				content: [{ type: "text", text }],
				details: {
					query,
					count: results.length,
					total,
					engines: results.map((r) => r.engines ?? []),
				},
			};
		},
	});

	// ── web_fetch ────────────────────────────────────────────────────────
	pi.registerTool({
		name: "web_fetch",
		label: "Web Fetch",
		description:
			"Fetch a web page (http/https) and extract its readable text content. Use after web_search narrows to the best source (or when a " +
			"specific URL is known) to verify specifics before citing. HTML is stripped to text; scripts, styles, and tags are removed.",
		promptSnippet: "Fetch a URL's text to verify specifics, then cite it",
		promptGuidelines: [
			"Use web_fetch to read a URL you intend to cite or quote — usually after web_search narrows to the best source, or when a specific URL is already known.",
			"CITE every fetched fact: link the source URL inline as markdown AND list sources under a final '## Sources' heading. Never present fetched facts without their source URL.",
		],
		parameters: Type.Object({
			url: Type.String({ description: "The http:// or https:// URL to fetch." }),
			max_chars: Type.Optional(
				Type.Integer({
					description: "Cap on returned characters (default 10000, max 50000).",
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
			const body = await res.text();
			const text = contentType.toLowerCase().includes("html") ? htmlToText(body) : body;
			const trimmed =
				text.length > cap
					? text.slice(0, cap) + `\n\n[... truncated; ${text.length} total chars]`
					: text;

			return {
				content: [{ type: "text", text: `${raw}\n\n${trimmed}` }],
				details: { url: raw, chars: trimmed.length, contentType },
			};
		},
	});
}

/**
 * Minimal HTML → readable text. Not a full readability parser (no Readability.js),
 * but good enough for docs/articles: drops scripts/styles/comments, decodes
 * common entities, turns block elements into newlines, collapses whitespace.
 */
function htmlToText(html: string): string {
	return html
		.replace(/<script[\s\S]*?<\/script>/gi, " ")
		.replace(/<style[\s\S]*?<\/style>/gi, " ")
		.replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
		.replace(/<!--[\s\S]*?-->/g, " ")
		.replace(/&nbsp;/g, " ")
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
		.replace(/<\/(p|div|section|article|li|h[1-6]|tr|br|hr|header|footer|nav|pre|blockquote)>/gi, "\n")
		.replace(/<br\s*\/?>/gi, "\n")
		.replace(/<[^>]+>/g, "")
		.replace(/\r\n/g, "\n")
		.replace(/[ \t]+/g, " ")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}
