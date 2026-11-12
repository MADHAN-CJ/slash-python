import { EditorView, basicSetup } from "codemirror";
import { EditorState } from "@codemirror/state";
import { keymap } from "@codemirror/view";
import { indentWithTab } from "@codemirror/commands";
import { python } from "@codemirror/lang-python";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { tags } from "@lezer/highlight";
import { marked } from "marked";
import DOMPurify from "dompurify";

const SAMPLE = `# Sample: is TCS trending up? Runs on the /markets server with the shared Dhan feed.
import slashdhan as z

try:
    d = z.daily_candles("TCS", days_back=320)
except Exception as e:  # TokenExpired, DataPlanMissing, RateLimited...
    print(f"Could not load candles: {type(e).__name__}: {e}")
    raise SystemExit

c = z.closes(d)
e50, e200, r = z.ema(c, 50)[-1], z.ema(c, 200)[-1], z.rsi(c)[-1]
m = z.macd(c)["histogram"][-1]
hi = max(x["high"] for x in d[-30:])
lo = min(x["low"] for x in d[-30:])
trend = "above" if c[-1] > e50 > e200 else "below" if c[-1] < e50 < e200 else "mixed vs"

print(f"TCS (NSE) last close {c[-1]:,.1f} on {d[-1]['time'][:10]}")
print(f"Trend: {trend} EMA50 {e50:,.0f} / EMA200 {e200:,.0f}")
print(f"RSI14 {r:.0f}, MACD histogram {m:+.1f}")
print(f"30-day range {lo:,.0f} to {hi:,.0f} ({(c[-1] - lo) / (hi - lo) * 100:.0f}% of range)")
`;

const STORAGE_KEY = "slash-python.script";
let MAX_ATTEMPTS = 3;

// Editor theme in the brand's light terminal face. Yellow is the selection colour, as on the homepage.
const theme = EditorView.theme({
  "&": { backgroundColor: "#fffef8", color: "#34432e", fontSize: "16px" },
  ".cm-scroller": { fontFamily: '"Departure Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', lineHeight: "1.6" },
  ".cm-content": { padding: "14px 0", caretColor: "#20251b" },
  ".cm-line": { padding: "0 16px" },
  ".cm-gutters": { backgroundColor: "#edf0e6", color: "#8a9780", border: "none", borderRight: "1px solid #d4dccb" },
  ".cm-lineNumbers .cm-gutterElement": { padding: "0 12px 0 16px", minWidth: "3.2em" },
  ".cm-activeLine": { backgroundColor: "#f3f4ea" },
  ".cm-activeLineGutter": { backgroundColor: "#e3e8d9", color: "#34432e" },
  ".cm-cursor, .cm-dropCursor": { borderLeftColor: "#20251b", borderLeftWidth: "2px" },
  "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, ::selection": { backgroundColor: "#f6d64d" },
  ".cm-selectionMatch": { backgroundColor: "#f6d64d66" },
  ".cm-matchingBracket, &.cm-focused .cm-matchingBracket": { backgroundColor: "#e3e8d9", outline: "none" },
  ".cm-tooltip": { backgroundColor: "#fffef8", border: "1px solid #bdc9b6", color: "#34432e", fontFamily: '"Onest", Arial, sans-serif' },
  ".cm-tooltip-autocomplete ul li[aria-selected]": { backgroundColor: "#f6d64d", color: "#20251b" },
  ".cm-panels": { backgroundColor: "#edf0e6", color: "#34432e" },
  ".cm-panels.cm-panels-bottom": { borderTop: "1px solid #d4dccb" },
  ".cm-searchMatch": { backgroundColor: "#f6d64d66" },
  ".cm-searchMatch.cm-searchMatch-selected": { backgroundColor: "#f6d64d" },
});

const highlight = HighlightStyle.define([
  { tag: [tags.keyword, tags.controlKeyword, tags.operatorKeyword], color: "#45613b" },
  { tag: [tags.definitionKeyword, tags.moduleKeyword], color: "#45613b" },
  { tag: [tags.string, tags.special(tags.string)], color: "#8a6a0d" },
  { tag: [tags.number, tags.bool, tags.null], color: "#9a5a44" },
  { tag: tags.comment, color: "#8a9780", fontStyle: "italic" },
  { tag: [tags.function(tags.variableName), tags.function(tags.propertyName)], color: "#283a25" },
  { tag: [tags.className, tags.typeName], color: "#283a25" },
  { tag: [tags.operator, tags.punctuation], color: "#5d7050" },
  { tag: tags.self, color: "#45613b" },
  { tag: [tags.variableName, tags.propertyName], color: "#34432e" },
  { tag: tags.invalid, color: "#9a4d3a" },
]);

const $ = (id) => document.getElementById(id);
const modeOptions = [...document.querySelectorAll(".mode-option")];
let currentMode = "nl";
const askCard = $("ask-card");
const askInput = $("ask-input");
const editorCard = $("editor-card");
const generateButton = $("generate");
const resetButton = $("reset");
const resultCard = $("result");
const resultStatus = $("result-status");
const resultBody = $("result-body");
const buttonLabel = generateButton.querySelector(".button-label");
const hintNl = $("hint-nl");
const hintPy = $("hint-py");

let busy = false;
// The script currently in the editor came from a question (auto-fix applies) or from the user (it never does).
let generated = null; // { query, attempt }
let settingDoc = false;

function savedScript() {
  try { return localStorage.getItem(STORAGE_KEY) || SAMPLE; } catch { return SAMPLE; }
}
function persist(text) {
  try { localStorage.setItem(STORAGE_KEY, text); } catch { /* storage unavailable */ }
}

const runKeymap = keymap.of([
  { key: "Mod-Enter", run: () => { generate(); return true; } },
  indentWithTab,
]);

const editor = new EditorView({
  state: EditorState.create({
    doc: savedScript(),
    extensions: [
      runKeymap,
      basicSetup,
      python(),
      theme,
      syntaxHighlighting(highlight),
      EditorView.lineWrapping,
      EditorView.updateListener.of((update) => {
        if (!update.docChanged) return;
        persist(update.state.doc.toString());
        if (!settingDoc && generated) markManual();
      }),
    ],
  }),
  parent: $("editor"),
});

function setDoc(text) {
  settingDoc = true;
  editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: text } });
  settingDoc = false;
}

function markManual() { generated = null; }

// ----- mode -----
function setMode(mode, { silent = false } = {}) {
  currentMode = mode;
  modeOptions.forEach((b) => b.setAttribute("aria-pressed", b.dataset.mode === mode ? "true" : "false"));
  const nl = mode === "nl";
  askCard.hidden = !nl;
  editorCard.hidden = nl;
  hintNl.hidden = !nl;
  hintPy.hidden = nl;
  resetButton.hidden = nl;
  buttonLabel.textContent = nl ? "Write script and generate report" : "Generate report";
  if (!silent) (nl ? askInput : editor).focus();
}
modeOptions.forEach((b) => b.addEventListener("click", () => { if (!busy && !b.disabled) setMode(b.dataset.mode); }));

// ----- result card -----
function setState(state, status) {
  resultCard.dataset.state = state;
  resultStatus.textContent = status;
  if (state === "running" || state === "writing") {
    resultCard.scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "start" });
  }
}

function setBusy(value, label) {
  busy = value;
  generateButton.disabled = value;
  resetButton.disabled = value;
  $("mode").setAttribute("aria-busy", value ? "true" : "false");
  if (label) buttonLabel.textContent = label;
  else setMode(currentMode, { silent: true });
  generateButton.setAttribute("aria-busy", value ? "true" : "false");
}

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function errorLine(stderr) {
  const matches = [...stderr.matchAll(/File "(?:script\.py|<string>|[^"]*\.py)", line (\d+)/g)];
  return matches.length ? Number(matches[matches.length - 1][1]) : null;
}

function lastErrorMessage(stderr) {
  const lines = stderr.trim().split("\n").filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (/^\w+(Error|Exception|Warning|Exit|Interrupt|Expired|Missing|NotFound|Limited|Exceeded)\b/.test(lines[i].trim())) return lines[i].trim();
  }
  return lines[lines.length - 1] || "The script stopped.";
}

function renderRunError(run, { attemptsNote = "" } = {}) {
  const stderr = run.stderr || "";
  const line = errorLine(stderr);
  const message = run.timedOut
    ? `The script ran past the ${Math.round(run.timeoutMs / 1000)} second limit and was stopped.`
    : lastErrorMessage(stderr);
  const title = run.timedOut ? "Python ran out of time" : run.feedDown ? "The market feed is unavailable" : (line ? `Python stopped at line ${line}` : "Python stopped");
  const tracebackHtml = stderr
    ? `<pre tabindex="0">${stderr.trim().split("\n").map((l) => {
        const hit = line && new RegExp(`line ${line}\\b`).test(l);
        return `<span class="${hit ? "error-line" : ""}">${escapeHtml(l)}</span>`;
      }).join("\n")}</pre>`
    : "";
  const stdoutHtml = run.stdout ? `<details class="report-raw"><summary>Printed before it stopped</summary><pre>${escapeHtml(run.stdout)}</pre></details>` : "";
  const note = attemptsNote ? `<p class="attempts-note">${escapeHtml(attemptsNote)}</p>` : "";
  resultBody.innerHTML = `<div class="run-error"><h3>${escapeHtml(title)}</h3>${note}<p>${run.feedDown ? "Try again in a few minutes." : "Fix the script and generate again. The interpreter said:"}</p>${tracebackHtml}<div class="error-summary"><strong>${escapeHtml(message)}</strong></div>${stdoutHtml}</div>`;
  if (line && !editorCard.hidden) {
    const pos = editor.state.doc.line(Math.min(line, editor.state.doc.lines)).from;
    editor.dispatch({ selection: { anchor: pos }, scrollIntoView: true });
  }
  setState("error", line ? `Error on line ${line}` : "Error");
}

function renderReport(markdown, run, meta, { question = "", attempts = 0 } = {}) {
  const html = DOMPurify.sanitize(marked.parse(markdown, { gfm: true, breaks: false }));
  const seconds = (run.durationMs / 1000).toFixed(1);
  const origin = question ? `Answering: “${escapeHtml(question)}” with script ${attempts} of ${MAX_ATTEMPTS}. ` : "";
  resultBody.innerHTML = `<article class="report">${html}</article>
    <p class="report-meta">${origin}Written from ${run.stdout.length.toLocaleString()} characters your script printed in ${seconds}s${meta?.model ? ` · ${escapeHtml(meta.model)}` : ""}. Reports can be wrong; check the numbers against the raw output.</p>
    <details class="report-raw"><summary>Raw output</summary><pre>${escapeHtml(run.stdout)}</pre></details>`;
  setState("done", "Report ready");
}

function renderNote(text, state = "error", status = "Nothing to report") {
  resultBody.innerHTML = `<div class="run-note">${escapeHtml(text)}</div>`;
  setState(state, status);
}

function renderProgress(text) {
  resultBody.innerHTML = `<div class="run-note">${escapeHtml(text)}</div>`;
}

async function postJson(url, body) {
  const response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || `${url} failed (${response.status}).`);
  return payload;
}

// ----- the flows -----
// Runs the editor's script once, then writes the report. Returns the run so callers can decide what next.
async function runAndReport(code, { question = "", attempts = 0, attemptLabel = "" } = {}) {
  setBusy(true, "Running script…");
  setState("running", attemptLabel ? `Running ${attemptLabel}` : "Running script.py");
  renderProgress(attemptLabel ? `Running ${attemptLabel} on the /markets server…` : "Running your script on the /markets server…");

  let run;
  try {
    run = await postJson("/api/run", { code });
  } catch (error) {
    return { failed: true, run: { exitCode: 1, stderr: error.message, stdout: "", durationMs: 0, timeoutMs: 0 } };
  }
  if (run.exitCode !== 0 || run.timedOut) return { failed: true, run };
  if (!run.stdout.trim()) {
    renderNote("The script finished without printing anything, so there is nothing to write about. Add print() calls for the figures you want in the report.", "error", "No output");
    return { failed: false, run, empty: true };
  }

  setBusy(true, "Writing report…");
  setState("writing", "Writing the report");
  renderProgress(`Script finished in ${(run.durationMs / 1000).toFixed(1)}s. Turning the output into a report…`);
  try {
    const explained = await postJson("/api/explain", { output: run.stdout });
    renderReport(explained.markdown, run, explained, { question, attempts });
  } catch (error) {
    resultBody.innerHTML = `<div class="run-error"><h3>Script ran, report failed</h3><p>${escapeHtml(error.message)}</p><details class="report-raw" open><summary>Raw output</summary><pre>${escapeHtml(run.stdout)}</pre></details></div>`;
    setState("error", "Report failed");
  }
  return { failed: false, run };
}

// Python mode: one run, no auto-fix, whoever wrote the script.
async function pythonFlow() {
  const code = editor.state.doc.toString();
  if (!code.trim()) { renderNote("The editor is empty. Write a script that prints something, then generate.", "error", "Empty script"); return; }
  const result = await runAndReport(code);
  if (result.failed) renderRunError(result.run);
  setBusy(false);
}

// Natural-language mode: compose -> run -> (compose again with the error, up to MAX_ATTEMPTS scripts) -> report.
async function questionFlow() {
  const query = askInput.value.trim();
  if (!query) { renderNote("Type a market question first, for example “Is RELIANCE above its 50-day average?”", "error", "No question"); askInput.focus(); return; }

  let previous = null;
  let code = "";
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    setBusy(true, attempt === 1 ? "Writing script…" : "Fixing script…");
    setState("writing", attempt === 1 ? "Writing a script from your question" : `Rewriting after the error, script ${attempt} of ${MAX_ATTEMPTS}`);
    renderProgress(attempt === 1 ? "Reading your question and generating a script…" : `Script ${attempt - 1} failed. Sending the traceback back and writing script ${attempt} of ${MAX_ATTEMPTS}…`);
    try {
      const composed = await postJson("/api/compose", { query, attempt, previous });
      code = composed.code;
      MAX_ATTEMPTS = composed.maxAttempts || MAX_ATTEMPTS;
    } catch (error) {
      renderNote(`Could not write the script: ${error.message}`, "error", "Script writer failed");
      setBusy(false);
      return;
    }

    generated = { query, attempt };
    setDoc(code);
    setMode("py", { silent: true });

    const result = await runAndReport(code, { question: query, attempts: attempt, attemptLabel: `script ${attempt} of ${MAX_ATTEMPTS}` });
    if (!result.failed) { setBusy(false); return; }

    // Stop retrying if the user edited the script meanwhile, the feed is down, or this was the last attempt.
    const stillGenerated = generated && generated.attempt === attempt;
    if (!stillGenerated || result.run.feedDown || attempt === MAX_ATTEMPTS) {
      const note = !stillGenerated ? "" : result.run.feedDown ? "" : `All ${MAX_ATTEMPTS} scripts failed. The last one is in the editor; fix it by hand and generate again.`;
      renderRunError(result.run, { attemptsNote: note });
      setBusy(false);
      return;
    }
    previous = { code, stderr: result.run.stderr, stdout: result.run.stdout };
    renderRunError(result.run, { attemptsNote: `Script ${attempt} of ${MAX_ATTEMPTS} failed. Writing a fix…` });
  }
  setBusy(false);
}

async function generate() {
  if (busy) return;
  if (currentMode === "nl") await questionFlow();
  else await pythonFlow();
}

generateButton.addEventListener("click", generate);
resetButton.addEventListener("click", () => {
  markManual();
  setDoc(SAMPLE);
  editor.focus();
});
askInput.addEventListener("keydown", (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key === "Enter") { event.preventDefault(); generate(); }
});

// Server capabilities decide whether natural-language mode is offered at all.
fetch("/api/config").then((r) => r.json()).then((config) => {
  MAX_ATTEMPTS = config.maxAttempts || MAX_ATTEMPTS;
  if (!config.naturalLanguage) {
    modeOptions.find((b) => b.dataset.mode === "nl").disabled = true;
    setMode("py", { silent: true });
  }
}).catch(() => {});

// ----- login gate (dummy): fixed email + code, nothing sent anywhere, a flag in localStorage -----
const SESSION_KEY = "slash-python.session";
const DEMO_EMAIL = "test@slash.markets";
const DEMO_OTP = "123456";
const loginView = $("login");
const appView = $("app");
const signoutButton = $("signout");
const emailForm = $("login-email-form");
const otpForm = $("login-otp-form");
const emailInput = $("login-email");
const otpInput = $("login-otp");
const emailEcho = $("login-email-echo");
const loginError = $("login-error");
const sendButton = $("login-send");
const verifyButton = $("login-verify");

function hasSession() {
  try { return Boolean(localStorage.getItem(SESSION_KEY)); } catch { return false; }
}
function showLoginError(text) { loginError.textContent = text; loginError.hidden = !text; }
function showApp(signedIn) {
  loginView.hidden = signedIn;
  appView.hidden = !signedIn;
  signoutButton.hidden = !signedIn;
  document.body.classList.toggle("signed-out", !signedIn);
  if (!signedIn) { emailForm.hidden = false; otpForm.hidden = true; otpInput.value = ""; showLoginError(""); emailInput.focus(); }
}
emailInput.addEventListener("input", () => { sendButton.disabled = !emailInput.value.trim(); });
otpInput.addEventListener("input", () => { otpInput.value = otpInput.value.replace(/\D/g, "").slice(0, 6); verifyButton.disabled = otpInput.value.length !== 6; });
sendButton.disabled = true;
verifyButton.disabled = true;
emailForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const email = emailInput.value.trim().toLowerCase();
  if (!email) return;
  showLoginError("");
  sendButton.disabled = true; sendButton.textContent = "Sending…";
  await new Promise((r) => setTimeout(r, 450));
  sendButton.textContent = "Send code"; sendButton.disabled = false;
  if (email !== DEMO_EMAIL) { showLoginError("No account for that email."); return; }
  emailEcho.textContent = email;
  emailForm.hidden = true; otpForm.hidden = false; otpInput.focus();
});
otpForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (otpInput.value.length !== 6) return;
  showLoginError("");
  verifyButton.disabled = true; verifyButton.textContent = "Checking…";
  await new Promise((r) => setTimeout(r, 450));
  verifyButton.textContent = "Sign in"; verifyButton.disabled = false;
  if (otpInput.value !== DEMO_OTP) { showLoginError("That code is not right."); return; }
  try { localStorage.setItem(SESSION_KEY, JSON.stringify({ email: DEMO_EMAIL, at: new Date().toISOString() })); } catch { /* storage unavailable: session lasts this page view */ }
  showApp(true);
  askInput.focus();
});
$("login-back").addEventListener("click", () => { otpForm.hidden = true; emailForm.hidden = false; otpInput.value = ""; showLoginError(""); emailInput.focus(); });
signoutButton.addEventListener("click", () => {
  try { localStorage.removeItem(SESSION_KEY); } catch { /* ignore */ }
  showApp(false);
});
showApp(hasSession());

setMode("nl", { silent: true });

// Entrance: hero parts, then the panels, staggered once.
const risers = [".hero-title", ".hero-quote", ".hero-description", ".mode-row", ".stage", ".result-column"].map((s) => document.querySelector(s)).filter(Boolean);
risers.forEach((el, i) => { el.classList.add("rise"); el.style.setProperty("--rise-delay", `${i * 80}ms`); });
requestAnimationFrame(() => requestAnimationFrame(() => risers.forEach((el) => el.classList.add("is-in"))));
