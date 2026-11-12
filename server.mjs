import { createReadStream, existsSync, statSync } from "node:fs";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join, normalize, dirname } from "node:path";
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
const pythonBin = process.env.PYTHON_BIN || "python3";
const runTimeoutMs = Number(process.env.RUN_TIMEOUT_MS || 10_000);
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

// Runs the script in a fresh temp directory with a scrubbed environment and a wall-clock limit.
// This is isolation for a trusted local workbench, not a sandbox for strangers' code.
async function runPython(code) {
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
    child.on("error", (error) => {
      clearTimeout(timer);
      rm(dir, { recursive: true, force: true }).catch(() => {});
      resolve({ exitCode: 1, stdout, stderr: `Could not start ${pythonBin}: ${error.message}`, timedOut: false, truncated, durationMs: Date.now() - started, timeoutMs: runTimeoutMs });
    });
    child.on("close", (exitCode, signal) => {
      clearTimeout(timer);
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
  console.log(`/markets Python workbench at http://${host}:${port}  (python: ${pythonBin}, model: ${model}, report writer: ${process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN ? "on" : "OFF - set ANTHROPIC_API_KEY"})`);
});
