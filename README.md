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

## How it works

- `index.html`, `styles.css`: the page. Brand tokens are CSS custom properties at the top of the stylesheet.
- `src/app.js` → `dist/app.js` (esbuild): CodeMirror 6 editor with Python mode, a light theme in the brand's terminal face (yellow selection), the run → report flow, Markdown rendering with `marked` + `DOMPurify`. The script is kept in `localStorage`.
- `server.mjs`: static files plus two endpoints.
  - `POST /api/run` `{code}` → writes `script.py` into a fresh temp directory and runs `python3 -I -B -u script.py` with a scrubbed environment, a timeout and an output cap. Returns `{exitCode, stdout, stderr, timedOut, durationMs}`.
  - `POST /api/explain` `{output}` → Claude (Anthropic SDK, streaming, server-side refusal fallback on) with a system prompt that forbids inventing numbers and advice. Returns `{markdown, model}`. Claude sees only the printed output, never the code.

## Security note

The runner isolates the working directory and environment and enforces a time limit, but it is **not** a sandbox: the script runs as the server's user with network access. Keep this behind authentication or on a trusted host; do not expose it to the public internet as-is. Python packages available to scripts are whatever `PYTHON_BIN` has installed (the local Homebrew Python has no numpy/pandas).
