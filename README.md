# /markets Python workbench

A one-page sibling of the /markets site: a headline, a one-line quote about the Indian market, and a workbench with two modes.

- **Natural language** (default): type a market question. Claude writes a `slashdhan` script for it using the same guide the /markets Dhan MCP gives Claude in chat, the script opens in the editor, runs, and the printed output becomes a Markdown report. If the script fails, the traceback goes back to Claude for a rewrite, up to **three scripts per question**. Editing a generated script turns auto-fix off.
- **Python script**: write or edit a script yourself and run it once. No auto-fix, ever.

Scripts run through the /markets Dhan MCP (`run_python`), so `import slashdhan` works and the shared feed, rate limits and 60 s limit apply. Standard library only there (no numpy/pandas).

Theme, fonts, icons and components come from `slash-dashboard/` (see its `BRAND_GUIDELINES.md`). No new fonts, no remote imports.

## Login gate (demo)

The page opens on a sign-in screen (email, then a 6-digit code) that mirrors the account app's flow. It is a demo gate only: the credentials are fixed in `src/app.js` (`test@slash.markets` / `123456`), checked in the browser, and success stores a flag in `localStorage` (`slash-python.session`). The server has no sessions and the API endpoints are not protected by it.

## Run locally

```sh
npm install
ANTHROPIC_API_KEY='your-key' npm run dev     # builds dist/app.js, serves http://127.0.0.1:5180
```

The server reads a `.env` file beside `server.mjs` on start (copy `.env.example`); variables already in your shell take precedence. Environment (all optional except the key):

| Variable | Default | Meaning |
|---|---|---|
| `ANTHROPIC_API_KEY` | – | Needed for reports and for natural-language mode. Without it, scripts still run and the page explains that the writers are off. |
| `SLASH_DHAN_MCP_URL` | – | The /markets Dhan MCP to run scripts through (e.g. `https://dhan-mcp-test1.slash.markets`). Unset = local `python3`, no market data, natural-language mode still works but scripts can't import slashdhan. |
| `MCP_RUN_TIMEOUT_SECONDS` | `60` | Per-script limit passed to `run_python`. |
| `COMPOSE_FAULT_FIRST` | – | Dev only: `1` appends a `raise` to the first generated script so the auto-fix loop can be watched. |
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
- `src/app.js` → `dist/app.js` (esbuild): mode dropdown, question box, the compose → run → fix loop (browser-driven so each script is visible), CodeMirror 6 editor with Python mode, a light theme in the brand's terminal face (yellow selection), the run → report flow, Markdown rendering with `marked` + `DOMPurify`. The script is kept in `localStorage`.
- `server.mjs`: static files plus four endpoints.
  - `GET /api/config` → which runner is active and whether natural-language mode is on.
  - `POST /api/compose` `{query, attempt, previous?}` → Claude writes one script from the question, with the MCP's `SKILL.md` (fetched from the MCP at boot, or read from `../slash-dhan-mcp/SKILL.md`) as a prompt-cached system prompt. For attempts 2 and 3 the previous script, traceback and partial output are included. `attempt` is capped at 3 server-side.
  - `POST /api/run` `{code}` → with `SLASH_DHAN_MCP_URL`, calls the MCP's `run_python` as an MCP client and parses its `exit_code=… --- stdout --- … --- stderr ---` text; otherwise writes `script.py` into a fresh temp directory and runs `python3 -I -B -u script.py` with a scrubbed environment, a timeout and an output cap. Returns `{exitCode, stdout, stderr, timedOut, durationMs}`.
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
