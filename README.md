# /markets Python workbench

A one-page sibling of the /markets site: a headline, a one-line quote about the Indian market, an IDE-style Python editor, and one button. The button runs the script on the server; a failure shows the Python traceback, a success sends what the script printed to Claude, which writes a short Markdown report shown on the page.

Theme, fonts, icons and components come from `slash-dashboard/` (see its `BRAND_GUIDELINES.md`). No new fonts, no remote imports.

## Run locally

```sh
npm install
ANTHROPIC_API_KEY='your-key' npm run dev     # builds dist/app.js, serves http://127.0.0.1:5180
```

The server reads a `.env` file beside `server.mjs` on start (copy `.env.example`); variables already in your shell take precedence. Environment (all optional except the key):

| Variable | Default | Meaning |
|---|---|---|
| `ANTHROPIC_API_KEY` | – | Needed for reports. Without it, scripts still run and the page explains that the report writer is off. |
| `CLAUDE_MODEL` | `claude-opus-5-5` | Report model. |
| `PYTHON_BIN` | `python3` | Interpreter used for scripts. |
| `RUN_TIMEOUT_MS` | `10000` | Wall-clock limit per script. |
| `RUN_OUTPUT_CAP` | `64000` | Characters of stdout/stderr kept. |
| `PORT` / `HOST` | `5180` / `127.0.0.1` | Bind address. |
| `SLASH_DHAN_MCP_URL` | unset | The /markets Dhan MCP. Alone: scripts run remotely in its sandbox. With the admin secret: local runs get a gateway token (see below). |
| `SLASH_DHAN_MCP_ADMIN_SECRET` | unset | Admin secret of that MCP (same host only). |
| `SLASHDHAN_CACHE_DIR` | `<tmpdir>/slash-python-slashdhan-cache` | Where `slashdhan` keeps the instrument master between runs. |

## How it works

- `index.html`, `styles.css`: the page. Brand tokens are CSS custom properties at the top of the stylesheet.
- `src/app.js` → `dist/app.js` (esbuild): CodeMirror 6 editor with Python mode, a light theme in the brand's terminal face (yellow selection), the run → report flow, Markdown rendering with `marked` + `DOMPurify`. The script is kept in `localStorage`.
- `server.mjs`: static files plus two endpoints.
  - `POST /api/run` `{code}` → writes `script.py` into a fresh temp directory and runs `python3 -I -B -u script.py` with a scrubbed environment, a timeout and an output cap. Returns `{exitCode, stdout, stderr, timedOut, durationMs}`.
  - `POST /api/explain` `{output}` → Claude (Anthropic SDK, streaming, server-side refusal fallback on) with a system prompt that forbids inventing numbers and advice. Returns `{markdown, model}`. Claude gets the printed output and, as context for what the printed fields mean, the script itself (`code`, optional); the system prompt forbids taking any number from the code.

## Dhan data in scripts (`import slashdhan`)

Two modes, picked by which variables are set.

**Remote (URL only).** `POST /api/run` forwards the script to the MCP's plain HTTP API (`POST /api/v1/run`,
the same runner its `run_python` tool uses) and maps the JSON back (`exit_code`, stdout, stderr, truncation, timeout). The script runs in the MCP's own sandbox
against its feed, so `import slashdhan` works with no credentials on this side; `PYTHON_BIN` is not
used, and only the standard library is available there (no numpy/pandas). The MCP's workspace is shared
by all of its users, so saved files need distinctive names. Timeout is `RUN_TIMEOUT_MS` capped at the
MCP's 180 s.

**Local + gateway (URL and admin secret, same host).** With `SLASH_DHAN_MCP_URL` and `SLASH_DHAN_MCP_ADMIN_SECRET` set, the workbench talks to the `/markets`
Dhan MCP (`slash-dhan-mcp`) on the same host: before each run it mints a short-lived gateway run token
(`POST /admin/run-token`), hands it to the script as `SLASHDHAN_RUN_TOKEN` together with the gateway
URL, and revokes it when the script ends. Scripts then use the same read-only `slashdhan` library the
MCP's `run_python` tool offers (`z.daily_candles("RELIANCE", days_back=400)`, `z.option_chain("NIFTY")`,
indicators, …), with the gateway's allowlist, rate limits and ~40-call budget. The Dhan token itself
never reaches this process or the script. `PYTHON_BIN` must have the package installed:

```sh
uv venv .venv && uv pip install --python .venv/bin/python -e ../slash-dhan-mcp numpy pandas
# .env: PYTHON_BIN=.venv/bin/python  SLASH_DHAN_MCP_URL=http://127.0.0.1:8020  SLASH_DHAN_MCP_ADMIN_SECRET=<its admin secret>
```

If the MCP is down or the feed token has expired, the run fails fast with a "feed is not reachable"
message instead of running without data. `RUN_TIMEOUT_MS` (10 s by default) still applies; a multi-year
daily-candle pull takes well under a second, so the default is fine for most scripts.

## Security note

The runner isolates the working directory and environment and enforces a time limit, but it is **not** a sandbox: the script runs as the server's user with network access. Keep this behind authentication or on a trusted host; do not expose it to the public internet as-is. Python packages available to scripts are whatever `PYTHON_BIN` has installed (the local Homebrew Python has no numpy/pandas). With the Dhan bridge enabled, anyone who can reach this page can read the shared feed's market data and the operator's account reads through the gateway (never trade, never see the token).
