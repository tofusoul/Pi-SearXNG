# pi-searxng

**Local SearXNG-backed `web_search` + `web_fetch` tools for [pi](https://pi.dev).**

No API key. No quota. Your localhost [SearXNG](https://searxng.org) instance fans each query out to ~70 upstream engines (Google, Bing, DuckDuckGo, Wikipedia, …), dedupes and re-ranks, and returns JSON. This package wraps it as two pi tools the agent can call, with **citation-enforcing guidelines** built in.

> Replaces key-gated search APIs (Brave, etc.) and the removed `@ollama/pi-web-search` for general agent use.

---

## Why

- **No API key friction** — SearXNG runs on your machine.
- **Metasearch, not an index** — SearXNG forwards queries live and aggregates; zero crawl, zero storage, zero maintenance.
- **Citation discipline** — the tools' `promptGuidelines` instruct the agent to link every source inline and append a `## Sources` list, and to check article dates before treating results as current.

## Prerequisites: a SearXNG instance

You need SearXNG running locally with **JSON output enabled** (off by default).

**NixOS** (recommended config — localhost only, JSON on):

```nix
# configuration.nix / a module
{ ... }:
{
  services.searx = {
    enable = true;
    settings = {
      use_default_settings = true;
      server = {
        bind_address = "127.0.0.1";
        port = 8888;
        secret_key = "generate-a-64-char-hex-secret";
        limiter = false;
        image_proxy = false;
      };
      search.formats = [ "html" "json" ];   # ← JSON must be enabled
    };
  };
}
```

Verify it serves JSON:

```bash
curl -s 'http://127.0.0.1:8888/search?q=nixos&format=json' | jq '.results[0].title'
```

**Non-NixOS:** see the [SearXNG install docs](https://docs.searxng.org/admin/installation.html). Point the extension at a different host/port via the `SEARXNG_URL` override below.

## Install

```bash
pi install git:github.com/tofusoul/Pi-SearXNG
```

Then restart pi (or `/reload`). The tools `web_search` and `web_fetch` become available.

> If you previously had a standalone `~/.pi/agent/extensions/searxng-search.ts`, **remove it** after installing this package to avoid double-registering the tools.

## Tools

### `web_search`
Queries SearXNG, returns a concise ranked list (titles + URLs + short snippets). Defaults to 5 results. Optional `time_range` (`day`/`week`/`month`/`year`) filters to recent results — use for "today"/"latest" queries, but still verify each result's date (the filter is by engine crawl time, which can lag the true publish date).

### `web_fetch`
GETs an http(s) URL and extracts the **main content as clean Markdown** — boilerplate (nav/footer/sidebar/ads) is dropped, and a `Title`/`URL`/`Site`/`Published` metadata header is prepended. Optional `format`:
- `markdown` (default) — clean main content with links preserved (for citation)
- `text` — plain text
- `metadata` — compact page summary only (title/site/date/description)

Use after `web_search` narrows to the best source. On a real news page this cut a 116KB raw page / ~7.7KB noisy old fetch down to ~3KB of clean article text.

Both tools enforce (via guidelines): **cite every searched/fetched fact** with an inline markdown link and a `## Sources` list, separate fact from inference, and check dates before treating a result as current.

## Configuration

The SearXNG endpoint defaults to `http://127.0.0.1:8888`. To change it, edit `src/index.ts`:

```ts
const SEARXNG = "http://127.0.0.1:8888";
```

(A future release will read this from an env var / pi config.)

## Development

This project uses [direnv](https://direnv.net) + a Nix flake dev shell:

```bash
cd Pi-SearXNG
direnv allow          # loads the dev shell (node + git)
npm install           # first time — installs typescript + @types/node + peer types
npm run typecheck     # tsc --noEmit, strict
```

The extension is **not compiled** — pi loads the TypeScript directly via jiti, so there is no build step. `npm run typecheck` is the only check.

### Nix package

The flake also exposes a package output that stages the extension under `$out/lib/pi-searxng`:

```bash
nix build                          # → ./result/lib/pi-searxng/
nix run github:tofusoul/Pi-SearXNG # (no binary — informational)
```

Useful if you want to consume it as a flake input from a NixOS module.

## Layout

```
Pi-SearXNG/
├── flake.nix        # devShell (direnv) + package output
├── .envrc           # use flake
├── package.json     # pi-package manifest (pi.extensions → ./src)
├── tsconfig.json    # strict type-check config
├── src/
│   └── index.ts     # the extension (web_search + web_fetch)
├── README.md
└── LICENSE          # MIT
```

## License

MIT © Andrew Shih
