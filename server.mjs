import { createReadStream, existsSync, statSync, readFileSync } from "node:fs";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join, normalize, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import Anthropic from "@anthropic-ai/sdk";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const root = dirname(fileURLToPath(import.meta.url));
// Load .env next to this file (values already in the environment win).
if (existsSync(join(root, ".env"))) {
  try { process.loadEnvFile(join(root, ".env")); } catch (error) { console.warn(`Could not read .env: ${error.message}`); }
}

const port = Number(process.env.PORT || 5180);
const host = process.env.HOST || "127.0.0.1";
const pythonBin = process.env.PYTHON_BIN || "python3";
const runTimeoutMs = Number(process.env.RUN_TIMEOUT_MS || 10_000);
const outputCap = Number(process.env.RUN_OUTPUT_CAP || 64_000);
const codeCap = 40_000;
const queryCap = 2_000;
const model = process.env.CLAUDE_MODEL || "claude-opus-5-5";
// When set, every script runs through the /markets Dhan MCP's run_python (slashdhan available).
const mcpUrl = (process.env.SLASH_DHAN_MCP_URL || "").replace(/\/$/, "");
const mcpTimeoutS = Number(process.env.MCP_RUN_TIMEOUT_SECONDS || 60);
const skillFile = process.env.SLASHDHAN_SKILL_FILE || join(root, "..", "slash-dhan-mcp", "SKILL.md");
// Dev-only: make the first composed script fail so the auto-fix loop can be exercised locally.
const composeFaultFirst = process.env.COMPOSE_FAULT_FIRST === "1";
export const MAX_COMPOSE_ATTEMPTS = 3;

const mimeTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".woff2": "font/woff2",
  ".png": "image/png",
  ".txt": "text/plain; charset=utf-8",
};

function sendJson(response, status, body) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

async function readJson(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 200_000) throw new Error("Request is too large.");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

// ---------------------------------------------------------------------------------------------
// Runner 1: local subprocess (no market data). Used only when SLASH_DHAN_MCP_URL is unset.
// Fresh temp directory, scrubbed environment, wall-clock limit. Isolation, not a sandbox.
async function runLocal(code) {
  const dir = await mkdtemp(join(tmpdir(), "slash-python-"));
  const file = join(dir, "script.py");
  await writeFile(file, code, "utf8");
  const started = Date.now();
  return new Promise((resolve) => {
    const child = spawn(pythonBin, ["-I", "-B", "-u", "script.py"], {
      cwd: dir,
      env: { PATH: process.env.PATH, LANG: "C.UTF-8", PYTHONIOENCODING: "utf-8", PYTHONDONTWRITEBYTECODE: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let truncated = false;
    const append = (current, chunk) => {
      if (current.length >= outputCap) { truncated = true; return current; }
      return current + chunk.toString("utf8").slice(0, outputCap - current.length);
    };
    child.stdout.on("data", (chunk) => { stdout = append(stdout, chunk); });
    child.stderr.on("data", (chunk) => { stderr = append(stderr, chunk); });
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, runTimeoutMs);
    const finish = (exitCode, err) => {
      clearTimeout(timer);
      rm(dir, { recursive: true, force: true }).catch(() => {});
      const clean = (text) => text.replace(/File "[^"\n]*script\.py"/g, 'File "script.py"');
      resolve({ exitCode, stdout: clean(stdout), stderr: clean(err ?? stderr), timedOut, truncated, durationMs: Date.now() - started, timeoutMs: runTimeoutMs, runner: "local" });
    };
    child.on("error", (error) => finish(1, `Could not start ${pythonBin}: ${error.message}`));
    child.on("close", (exitCode, signal) => finish(exitCode ?? (signal ? 1 : 0)));
  });
}

// Runner 2: the /markets Dhan MCP. Same tool Claude uses in chat; the script gets slashdhan,
// the shared feed through the gateway and the server's limits. Stateless transport, one client per run.
async function runViaMcp(code) {
  const client = new Client({ name: "slash-python-workbench", version: "0.1.0" });
  const transport = new StreamableHTTPClientTransport(new URL(mcpUrl));
  const started = Date.now();
  try {
    await client.connect(transport);
    const result = await client.callTool({ name: "run_python", arguments: { code, timeout_seconds: mcpTimeoutS } }, undefined, { timeout: (mcpTimeoutS + 30) * 1000 });
    const text = (result.content || []).filter((b) => b.type === "text").map((b) => b.text).join("\n");
    return { ...parseMcpResult(text, Boolean(result.isError)), durationMs: Date.now() - started, timeoutMs: mcpTimeoutS * 1000, runner: "mcp" };
  } finally {
    await client.close().catch(() => {});
  }
}

// run_python returns "exit_code=N duration=Nms[ TRUNCATED]\n--- stdout ---\n…[\n--- stderr ---\n…]";
// a feed outage returns a plain sentence instead (surfaced as an error so the loop can stop).
export function parseMcpResult(text, isError) {
  // A failing run arrives as a tool error, which the MCP layer prefixes with the tool name.
  const body = text.trim().replace(/^Error executing tool run_python:\s*/i, "");
  const match = /^exit_code=(-?\d+) duration=(\d+)ms( TRUNCATED)?\n--- stdout ---\n([\s\S]*?)(?:\n--- stderr ---\n([\s\S]*))?$/.exec(body);
  if (!match) {
    return { exitCode: isError ? 1 : 0, stdout: isError ? "" : text, stderr: isError ? text.trim() : "", timedOut: false, truncated: false, feedDown: true };
  }
  const exitCode = Number(match[1]);
  const stdoutRaw = match[4] === "(empty)" ? "" : match[4];
  return {
    exitCode,
    stdout: stdoutRaw ? `${stdoutRaw}\n` : "",
    stderr: (match[5] || "").replace(/File "[^"\n]*\/run_[^/"\n]+\.py"/g, 'File "script.py"').replace(/File "[^"\n]*\/([^/"\n]+\.py)"/g, 'File "$1"'),
    timedOut: exitCode === -9,
    truncated: Boolean(match[3]),
  };
}

async function handleRun(request, response) {
  try {
    const { code } = await readJson(request);
    if (typeof code !== "string" || !code.trim()) return sendJson(response, 400, { error: "Send a non-empty Python script." });
    if (code.length > codeCap) return sendJson(response, 400, { error: `Scripts are limited to ${codeCap.toLocaleString()} characters.` });
    const result = mcpUrl ? await runViaMcp(code) : await runLocal(code);
    sendJson(response, 200, result);
  } catch (error) {
    sendJson(response, 502, { error: error instanceof Error ? `Could not run the script: ${error.message}` : "Unable to run the script." });
  }
}

// ---------------------------------------------------------------------------------------------
// Compose: question -> slashdhan script, using the same guide the MCP gives Claude in chat.
let skillText = "";
async function loadSkill() {
  if (mcpUrl) {
    try {
      const res = await fetch(`${mcpUrl}/SKILL.md`, { signal: AbortSignal.timeout(10_000) });
      if (res.ok) { skillText = await res.text(); return `fetched from ${mcpUrl}/SKILL.md (${skillText.length} chars)`; }
    } catch (error) { console.warn(`SKILL.md fetch failed: ${error.message}`); }
  }
  if (existsSync(skillFile)) { skillText = readFileSync(skillFile, "utf8"); return `read ${skillFile} (${skillText.length} chars)`; }
  return "NOT FOUND - natural-language mode is off";
}

const COMPOSE_RULES = `You are writing the script for the /markets Python workbench, a web page where a trader types a market question and the server runs ONE Python script through run_python, then an editor turns whatever the script printed into a short report for them.

Rules for this surface (they refine the guide above):
- Reply with the complete Python script and nothing else: no prose, no Markdown fences, no explanation before or after. The reply is written straight into script.py.
- The only tool that exists here is run_python. Do not call feed_status, do not create or list watchers; if the question asks for an alert, print one line saying alerts are not available on this page and still answer the data part.
- The script must print the complete answer to the question as compact, labelled lines (instrument, figure, date/time in IST), because a separate step writes the user's report from stdout alone and cannot run further code. Print conclusions, not raw rows; a small table is fine.
- Use try/except around Dhan calls that can legitimately fail (TokenExpired, DataPlanMissing, InstrumentNotFound, RateLimited) and print a one-line explanation instead of crashing.
- Standard library plus slashdhan only. Keep well under the 40-call budget and finish within 60 seconds.
- When a previous attempt and its traceback are given, return a corrected full script that fixes the actual cause; do not repeat the same failing call.`;

function stripFences(text) {
  const trimmed = text.trim();
  const fenced = /^```(?:python|py)?\s*\n([\s\S]*?)\n```\s*$/.exec(trimmed);
  return (fenced ? fenced[1] : trimmed).replace(/\s+$/, "") + "\n";
}

async function handleCompose(request, response) {
  if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) {
    return sendJson(response, 503, { error: "The script writer is not configured. Start the server with ANTHROPIC_API_KEY set." });
  }
  if (!skillText) await loadSkill();
  if (!skillText) return sendJson(response, 503, { error: "Natural-language mode is off: the slashdhan guide (SKILL.md) could not be loaded." });
  try {
    const { query, attempt = 1, previous } = await readJson(request);
    if (typeof query !== "string" || !query.trim()) return sendJson(response, 400, { error: "Type a market question first." });
    if (query.length > queryCap) return sendJson(response, 400, { error: `Questions are limited to ${queryCap.toLocaleString()} characters.` });
    const n = Number(attempt);
    if (!Number.isInteger(n) || n < 1 || n > MAX_COMPOSE_ATTEMPTS) return sendJson(response, 400, { error: `attempt must be 1..${MAX_COMPOSE_ATTEMPTS}.` });

    let userText = `Question from the trader:\n${query.trim()}`;
    if (n > 1 && previous && typeof previous.code === "string") {
      userText += `\n\nAttempt ${n - 1} of ${MAX_COMPOSE_ATTEMPTS} failed. The script was:\n\n${previous.code.slice(0, codeCap)}\n\nIt stopped with:\n\n${String(previous.stderr || "").slice(0, 8_000) || "(no traceback)"}`;
      if (previous.stdout) userText += `\n\nIt had printed:\n\n${String(previous.stdout).slice(0, 4_000)}`;
      userText += `\n\nThis is attempt ${n} of ${MAX_COMPOSE_ATTEMPTS}. Return the corrected complete script.`;
    }

    const stream = anthropic().beta.messages.stream({
      model,
      max_tokens: 6000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      output_config: { effort: "medium" },
      system: [
        { type: "text", text: skillText, cache_control: { type: "ephemeral" } },
        { type: "text", text: COMPOSE_RULES },
      ],
      messages: [{ role: "user", content: userText }],
    });
    const message = await stream.finalMessage();
    if (message.stop_reason === "refusal") return sendJson(response, 502, { error: "The script writer declined this question." });
    let code = stripFences(message.content.filter((b) => b.type === "text").map((b) => b.text).join("\n"));
    if (!code.trim()) return sendJson(response, 502, { error: "The script writer returned no code." });
    if (composeFaultFirst && n === 1) code += '\nraise RuntimeError("injected fault: COMPOSE_FAULT_FIRST is set on the server")\n';
    sendJson(response, 200, { code, attempt: n, maxAttempts: MAX_COMPOSE_ATTEMPTS, model: message.model, truncated: message.stop_reason === "max_tokens" });
  } catch (error) {
    sendApiError(response, error, "script writer");
  }
}

// ---------------------------------------------------------------------------------------------
// Explain: stdout -> Markdown report.
const SYSTEM_PROMPT = `You write short Markdown reports for /markets, a research assistant for Indian market data, from the text a user's Python script printed.

Rules:
- Use only facts and numbers that appear in the output. Never invent, extrapolate or "correct" figures. If the output is thin, say so briefly and report what is there.
- Lead with a one-paragraph summary of what the output shows, then structured sections. Use a Markdown table when the output is tabular. Keep it under about 300 words.
- Indian market conventions: rupees as ₹ with Indian digit grouping when the output uses them; NSE/BSE, Nifty, Sensex, F&O terms as printed. Do not convert units or currencies.
- Account figures (positions, holdings, funds, orders) belong to the shared /markets feed account, not the reader; say so when they appear.
- Plain, concrete language. No hype, no emoji, no investment advice, no buy/sell/hold recommendations, no predictions. You may note what a reader might look at next.
- If the output is clearly not about markets, still report it faithfully under the same rules.
- Output Markdown only, starting with a level-2 heading that names the subject. No preamble, no code fences around the whole document.`;

let client = null;
function anthropic() {
  if (!client) client = new Anthropic();
  return client;
}

function sendApiError(response, error, what) {
  if (error instanceof Anthropic.AuthenticationError) return sendJson(response, 502, { error: "The Anthropic API key was rejected." });
  if (error instanceof Anthropic.RateLimitError) return sendJson(response, 503, { error: `The ${what} is rate limited. Try again in a moment.` });
  if (error instanceof Anthropic.BadRequestError) return sendJson(response, 502, { error: `${what} request rejected: ${error.message}` });
  if (error instanceof Anthropic.APIError) return sendJson(response, 502, { error: `${what} error ${error.status}: ${error.message}` });
  sendJson(response, 500, { error: error instanceof Error ? error.message : `Unable to reach the ${what}.` });
}

async function handleExplain(request, response) {
  if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) {
    return sendJson(response, 503, { error: "The report writer is not configured. Start the server with ANTHROPIC_API_KEY set." });
  }
  try {
    const { output } = await readJson(request);
    if (typeof output !== "string" || !output.trim()) return sendJson(response, 400, { error: "There is no script output to write about." });
    const text = output.slice(0, outputCap);

    const stream = anthropic().beta.messages.stream({
      model,
      max_tokens: 4000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      output_config: { effort: "medium" },
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: `Script output:\n\n${text}` }],
    });
    const message = await stream.finalMessage();

    if (message.stop_reason === "refusal") {
      return sendJson(response, 502, { error: "The report writer declined this output." });
    }
    const markdown = message.content.filter((b) => b.type === "text").map((b) => b.text).join("\n").trim();
    if (!markdown) return sendJson(response, 502, { error: "The report writer returned no text." });
    sendJson(response, 200, { markdown, model: message.model, truncated: message.stop_reason === "max_tokens" });
  } catch (error) {
    sendApiError(response, error, "report writer");
  }
}

function handleConfig(response) {
  sendJson(response, 200, {
    runner: mcpUrl ? "mcp" : "local",
    naturalLanguage: Boolean(skillText) && Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN),
    maxAttempts: MAX_COMPOSE_ATTEMPTS,
    faultInjection: composeFaultFirst,
  });
}

function serveStatic(request, response) {
  const url = new URL(request.url, "http://localhost");
  let path = decodeURIComponent(url.pathname);
  if (path === "/") path = "/index.html";
  const file = normalize(join(root, path));
  const allowed = path === "/index.html" || path === "/styles.css" || path.startsWith("/dist/") || path.startsWith("/assets/");
  if (!allowed || !file.startsWith(root) || !existsSync(file) || statSync(file).isDirectory()) {
    response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    return response.end("Not found");
  }
  response.writeHead(200, { "Content-Type": mimeTypes[extname(file)] || "application/octet-stream", "Cache-Control": "no-cache" });
  createReadStream(file).pipe(response);
}

const server = createServer((request, response) => {
  const path = request.url.split("?")[0];
  if (request.method === "POST" && path === "/api/run") return handleRun(request, response);
  if (request.method === "POST" && path === "/api/compose") return handleCompose(request, response);
  if (request.method === "POST" && path === "/api/explain") return handleExplain(request, response);
  if (request.method === "GET" && path === "/api/config") return handleConfig(response);
  if (request.method === "GET" || request.method === "HEAD") return serveStatic(request, response);
  response.writeHead(405); response.end();
});

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const skillStatus = await loadSkill();
  server.listen(port, host, () => {
    const aiOn = process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN;
    console.log(`/markets Python workbench at http://${host}:${port}`);
    console.log(`  runner: ${mcpUrl ? `MCP ${mcpUrl}` : `local ${pythonBin}`}  model: ${model}  claude: ${aiOn ? "on" : "OFF - set ANTHROPIC_API_KEY"}`);
    console.log(`  slashdhan guide: ${skillStatus}${composeFaultFirst ? "  (COMPOSE_FAULT_FIRST on: first script of every question is sabotaged)" : ""}`);
  });
}
