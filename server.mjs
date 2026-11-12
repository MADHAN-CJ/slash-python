import { createReadStream, existsSync, statSync } from "node:fs";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join, normalize, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import Anthropic from "@anthropic-ai/sdk";

const root = dirname(fileURLToPath(import.meta.url));
// Load .env next to this file (values already in the environment win).
if (existsSync(join(root, ".env"))) {
  try { process.loadEnvFile(join(root, ".env")); } catch (error) { console.warn(`Could not read .env: ${error.message}`); }
}
const port = Number(process.env.PORT || 5180);
const host = process.env.HOST || "127.0.0.1";
const pythonBin = (process.env.PYTHON_BIN || "python3").includes("/") ? resolve(root, process.env.PYTHON_BIN) : (process.env.PYTHON_BIN || "python3");
const runTimeoutMs = Number(process.env.RUN_TIMEOUT_MS || 10_000);
// Optional: the /markets Dhan MCP on the same host. When both are set, every run gets a short-lived
// gateway token so `import slashdhan` works in scripts (read-only Dhan data through the gateway).
const dhanMcpUrl = (process.env.SLASH_DHAN_MCP_URL || "").replace(/\/+$/, "");
const dhanAdminSecret = process.env.SLASH_DHAN_MCP_ADMIN_SECRET || "";
const dhanEnabled = Boolean(dhanMcpUrl && dhanAdminSecret);
// Without the admin secret the script is sent to that MCP's own `run_python` tool instead (its
// sandbox, its feed, no credentials needed): a remote runner rather than a local one.
const dhanRemote = Boolean(dhanMcpUrl && !dhanAdminSecret);
const dhanCacheDir = process.env.SLASHDHAN_CACHE_DIR || join(tmpdir(), "slash-python-slashdhan-cache");
const outputCap = Number(process.env.RUN_OUTPUT_CAP || 64_000);
const codeCap = 40_000;
const model = process.env.CLAUDE_MODEL || "claude-opus-5-5";

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

async function dhanAdmin(method, body) {
  const response = await fetch(`${dhanMcpUrl}/admin/run-token`, {
    method,
    headers: { Authorization: `Bearer ${dhanAdminSecret}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) throw new Error(`${method} /admin/run-token -> ${response.status} ${(await response.text()).slice(0, 200)}`);
  return response.json();
}

// One gateway run token per script, revoked when the script ends. The gateway itself enforces the
// read-only allowlist, the rate limits and the per-token call budget; the Dhan token never comes here.
async function mintDhanRun() {
  const issued = await dhanAdmin("POST", { ttl_seconds: Math.ceil(runTimeoutMs / 1000) + 30 });
  return {
    env: {
      SLASHDHAN_GATEWAY_URL: issued.gatewayUrl,
      SLASHDHAN_RUN_TOKEN: issued.token,
      SLASHDHAN_SCRIP_MASTER_URL: issued.scripMasterUrl,
      SLASHDHAN_CALL_BUDGET: String(issued.callBudget),
      SLASHDHAN_CACHE_DIR: dhanCacheDir,
    },
    revoke: (() => { let done = false; return () => { if (done) return; done = true; dhanAdmin("DELETE", { token: issued.token }).catch(() => {}); }; })(),
  };
}

// Runs the script in the /markets Dhan MCP's sandbox through its plain HTTP API (POST /api/v1/run,
// the same runner and feed its run_python tool uses). Its JSON already has the runner's shape; only
// the traceback path is rewritten to script.py so the editor can jump to the line.
async function runPythonRemote(code) {
  const started = Date.now();
  const timeoutS = Math.min(180, Math.max(1, Math.ceil(runTimeoutMs / 1000)));
  const fail = (stderr) => ({ exitCode: 1, stdout: "", stderr, timedOut: false, truncated: false, durationMs: Date.now() - started, timeoutMs: runTimeoutMs });
  let body;
  try {
    const response = await fetch(`${dhanMcpUrl}/api/v1/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code, timeout_seconds: timeoutS }),
      signal: AbortSignal.timeout(runTimeoutMs + 15_000),
    });
    body = await response.json().catch(() => null);
    if (response.status === 503 && body?.feed) return fail(body.message || `The /markets Dhan feed is ${body.feed}. Try again in a few minutes.`);
    if (!response.ok || !body) return fail(`The /markets Dhan sandbox answered ${response.status}${body?.error ? `: ${body.error}` : ""}. Try again in a few minutes.`);
  } catch (error) {
    return fail(`The /markets Dhan sandbox is not reachable right now (${error.message}). Try again in a few minutes.`);
  }
  const clean = (text) => (text || "").replace(/File "[^"\n]*run_[0-9_]+_[0-9a-f]+\.py"/g, 'File "script.py"');
  return {
    exitCode: Number(body.exit_code ?? 1),
    stdout: body.stdout || "",
    stderr: clean(body.stderr),
    timedOut: Boolean(body.timed_out),
    truncated: Boolean(body.truncated),
    durationMs: Number(body.duration_ms ?? Date.now() - started),
    timeoutMs: timeoutS * 1000,
  };
}

// Runs the script in a fresh temp directory with a scrubbed environment and a wall-clock limit.
// This is isolation for a trusted local workbench, not a sandbox for strangers' code.
async function runPython(code) {
  if (dhanRemote) return runPythonRemote(code);
  const dir = await mkdtemp(join(tmpdir(), "slash-python-"));
  const file = join(dir, "script.py");
  await writeFile(file, code, "utf8");
  const started = Date.now();
  let dhan = null;
  if (dhanEnabled) {
    try {
      dhan = await mintDhanRun();
    } catch (error) {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
      return { exitCode: 1, stdout: "", stderr: `The /markets Dhan feed is not reachable right now (${error.message}). Try again in a few minutes.`, timedOut: false, truncated: false, durationMs: Date.now() - started, timeoutMs: runTimeoutMs };
    }
  }
  return new Promise((resolve) => {
    const child = spawn(pythonBin, ["-I", "-B", "-u", "script.py"], {
      cwd: dir,
      env: { PATH: process.env.PATH, LANG: "C.UTF-8", PYTHONIOENCODING: "utf-8", PYTHONDONTWRITEBYTECODE: "1", HOME: dir, ...(dhan ? dhan.env : {}) },
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
    child.on("error", (error) => {
      clearTimeout(timer);
      dhan?.revoke();
      rm(dir, { recursive: true, force: true }).catch(() => {});
      resolve({ exitCode: 1, stdout, stderr: `Could not start ${pythonBin}: ${error.message}`, timedOut: false, truncated, durationMs: Date.now() - started, timeoutMs: runTimeoutMs });
    });
    child.on("close", (exitCode, signal) => {
      clearTimeout(timer);
      dhan?.revoke();
      rm(dir, { recursive: true, force: true }).catch(() => {});
      const clean = (text) => text.replace(/File "[^"\n]*script\.py"/g, 'File "script.py"');
      resolve({
        exitCode: exitCode ?? (signal ? 1 : 0),
        stdout: clean(stdout),
        stderr: clean(stderr),
        timedOut,
        truncated,
        durationMs: Date.now() - started,
        timeoutMs: runTimeoutMs,
      });
    });
  });
}

async function handleRun(request, response) {
  try {
    const { code } = await readJson(request);
    if (typeof code !== "string" || !code.trim()) return sendJson(response, 400, { error: "Send a non-empty Python script." });
    if (code.length > codeCap) return sendJson(response, 400, { error: `Scripts are limited to ${codeCap.toLocaleString()} characters.` });
    const result = await runPython(code);
    sendJson(response, 200, result);
  } catch (error) {
    sendJson(response, 500, { error: error instanceof Error ? error.message : "Unable to run the script." });
  }
}

const SYSTEM_PROMPT = `You write short Markdown reports for /markets, a research assistant for Indian market data, from the text a user's Python script printed.

Rules:
- Use only facts and numbers that appear in the output. Never invent, extrapolate or "correct" figures. If the output is thin, say so briefly and report what is there.
- When the script is included, use it only to understand what the printed fields mean (definitions, units, windows, thresholds, method) and to explain the method in a sentence where it helps the reader. Never compute, re-derive or fill in numbers from the code; if a figure is not printed, it is not in the report. Do not quote or describe the code itself.
- Lead with a one-paragraph summary of what the output shows, then structured sections. Use a Markdown table when the output is tabular. Keep it under about 300 words.
- Indian market conventions: rupees as ₹ with Indian digit grouping when the output uses them; NSE/BSE, Nifty, Sensex, F&O terms as printed. Do not convert units or currencies.
- Plain, concrete language. No hype, no emoji, no investment advice, no buy/sell/hold recommendations, no predictions. You may note what a reader might look at next.
- If the output is clearly not about markets, still report it faithfully under the same rules.
- Output Markdown only, starting with a level-2 heading that names the subject. No preamble, no code fences around the whole document.`;

let client = null;
function anthropic() {
  if (!client) client = new Anthropic();
  return client;
}

async function handleExplain(request, response) {
  if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) {
    return sendJson(response, 503, { error: "The report writer is not configured. Start the server with ANTHROPIC_API_KEY set." });
  }
  try {
    const { output, code } = await readJson(request);
    if (typeof output !== "string" || !output.trim()) return sendJson(response, 400, { error: "There is no script output to write about." });
    const text = output.slice(0, outputCap);
    // The script travels with the output as context for what the printed fields mean; the prompt
    // forbids taking any number from it.
    const script = typeof code === "string" && code.trim() ? `\n\nThe script that printed it (context only, never a source of numbers):\n\n\`\`\`python\n${code.slice(0, codeCap)}\n\`\`\`` : "";

    const stream = anthropic().beta.messages.stream({
      model,
      max_tokens: 4000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      output_config: { effort: "medium" },
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: `Script output:\n\n${text}${script}` }],
    });
    const message = await stream.finalMessage();

    if (message.stop_reason === "refusal") {
      return sendJson(response, 502, { error: "The report writer declined this output." });
    }
    const markdown = message.content.filter((b) => b.type === "text").map((b) => b.text).join("\n").trim();
    if (!markdown) return sendJson(response, 502, { error: "The report writer returned no text." });
    sendJson(response, 200, { markdown, model: message.model, truncated: message.stop_reason === "max_tokens" });
  } catch (error) {
    if (error instanceof Anthropic.AuthenticationError) return sendJson(response, 502, { error: "The Anthropic API key was rejected." });
    if (error instanceof Anthropic.RateLimitError) return sendJson(response, 503, { error: "The report writer is rate limited. Try again in a moment." });
    if (error instanceof Anthropic.BadRequestError) return sendJson(response, 502, { error: `Report request rejected: ${error.message}` });
    if (error instanceof Anthropic.APIError) return sendJson(response, 502, { error: `Report writer error ${error.status}: ${error.message}` });
    sendJson(response, 500, { error: error instanceof Error ? error.message : "Unable to write the report." });
  }
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
  if (request.method === "POST" && request.url === "/api/run") return handleRun(request, response);
  if (request.method === "POST" && request.url === "/api/explain") return handleExplain(request, response);
  if (request.method === "GET" || request.method === "HEAD") return serveStatic(request, response);
  response.writeHead(405); response.end();
});

server.listen(port, host, () => {
  console.log(`/markets Python workbench at http://${host}:${port}  (python: ${pythonBin}, model: ${model}, report writer: ${process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN ? "on" : "OFF - set ANTHROPIC_API_KEY"}, slashdhan: ${dhanEnabled ? `local python + gateway ${dhanMcpUrl}` : dhanRemote ? `scripts run remotely in ${dhanMcpUrl}` : "OFF - set SLASH_DHAN_MCP_URL"})`);
});
