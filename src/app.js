import { EditorView, basicSetup } from "codemirror";
import { EditorState, Compartment } from "@codemirror/state";
import { keymap } from "@codemirror/view";
import { indentWithTab } from "@codemirror/commands";
import { python } from "@codemirror/lang-python";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { tags } from "@lezer/highlight";
import { marked } from "marked";
import DOMPurify from "dompurify";

const SAMPLE = `# Sample: how did a Nifty-style index behave over one year?
# Illustrative monthly closes, not live data. Replace with your own numbers.

closes = {
    "Jan": 21_725, "Feb": 21_983, "Mar": 22_327, "Apr": 22_605,
    "May": 22_531, "Jun": 24_011, "Jul": 24_951, "Aug": 25_236,
    "Sep": 25_811, "Oct": 24_205, "Nov": 23_559, "Dec": 23_645,
}

months = list(closes)
values = list(closes.values())

total_return = (values[-1] / values[0] - 1) * 100

peak, max_drawdown, trough_month = values[0], 0.0, months[0]
for month, value in zip(months, values):
    peak = max(peak, value)
    drawdown = (value / peak - 1) * 100
    if drawdown < max_drawdown:
        max_drawdown, trough_month = drawdown, month

monthly = [(months[i], (values[i] / values[i - 1] - 1) * 100) for i in range(1, len(values))]
best = max(monthly, key=lambda m: m[1])
worst = min(monthly, key=lambda m: m[1])
up_months = sum(1 for _, r in monthly if r > 0)

print("Index: Nifty-style sample, monthly closes, one calendar year")
print(f"Start {values[0]:,}  End {values[-1]:,}  Total return {total_return:+.1f}%")
print(f"Max drawdown {max_drawdown:.1f}% (trough in {trough_month})")
print(f"Best month {best[0]} {best[1]:+.1f}%   Worst month {worst[0]} {worst[1]:+.1f}%")
print(f"Up months {up_months} of {len(monthly)}")
print()
print("Month  Close    Change")
for month, r in monthly:
    print(f"{month:<6} {closes[month]:>7,} {r:+6.1f}%")
`;

const STORAGE_KEY = "slash-python.script";

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
const generateButton = $("generate");
const resetButton = $("reset");
const resultCard = $("result");
const resultStatus = $("result-status");
const resultBody = $("result-body");
const buttonLabel = generateButton.querySelector(".button-label");

let busy = false;

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
      EditorView.updateListener.of((update) => { if (update.docChanged) persist(update.state.doc.toString()); }),
    ],
  }),
  parent: $("editor"),
});

function setState(state, status) {
  resultCard.dataset.state = state;
  resultStatus.textContent = status;
  if (state === "running") resultCard.scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "start" });
}

function setBusy(value, label) {
  busy = value;
  generateButton.disabled = value;
  resetButton.disabled = value;
  buttonLabel.textContent = label || "Generate report";
  generateButton.setAttribute("aria-busy", value ? "true" : "false");
}

function escapeHtml(text) {
  return text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function errorLine(stderr) {
  const matches = [...stderr.matchAll(/File "script\.py", line (\d+)/g)];
  return matches.length ? Number(matches[matches.length - 1][1]) : null;
}

function lastErrorMessage(stderr) {
  const lines = stderr.trim().split("\n").filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (/^\w+(Error|Exception|Warning|Exit|Interrupt)\b/.test(lines[i].trim())) return lines[i].trim();
  }
  return lines[lines.length - 1] || "The script stopped.";
}

function renderRunError(run) {
  const stderr = run.stderr || "";
  const line = errorLine(stderr);
  const message = run.timedOut
    ? `The script ran past the ${Math.round(run.timeoutMs / 1000)} second limit and was stopped.`
    : lastErrorMessage(stderr);
  const title = run.timedOut ? "Python ran out of time" : (line ? `Python stopped at line ${line}` : "Python stopped");
  const tracebackHtml = stderr
    ? `<pre tabindex="0">${stderr.trim().split("\n").map((l) => {
        const hit = line && new RegExp(`line ${line}\\b`).test(l);
        return `<span class="${hit ? "error-line" : ""}">${escapeHtml(l)}</span>`;
      }).join("\n")}</pre>`
    : "";
  const stdoutHtml = run.stdout ? `<details class="report-raw"><summary>Printed before it stopped</summary><pre>${escapeHtml(run.stdout)}</pre></details>` : "";
  resultBody.innerHTML = `<div class="run-error"><h3>${escapeHtml(title)}</h3><p>Fix the script and generate again. The compiler said:</p>${tracebackHtml}<div class="error-summary"><strong>${escapeHtml(message)}</strong></div>${stdoutHtml}</div>`;
  if (line) {
    const pos = editor.state.doc.line(Math.min(line, editor.state.doc.lines)).from;
    editor.dispatch({ selection: { anchor: pos }, scrollIntoView: true });
  }
  setState("error", line ? `Error on line ${line}` : "Error");
}

function renderReport(markdown, run, meta) {
  const html = DOMPurify.sanitize(marked.parse(markdown, { gfm: true, breaks: false }));
  const seconds = (run.durationMs / 1000).toFixed(1);
  resultBody.innerHTML = `<article class="report">${html}</article>
    <p class="report-meta">Written from ${run.stdout.length.toLocaleString()} characters your script printed in ${seconds}s${meta?.model ? ` · ${escapeHtml(meta.model)}` : ""}. Reports can be wrong; check the numbers against the raw output.</p>
    <details class="report-raw"><summary>Raw output</summary><pre>${escapeHtml(run.stdout)}</pre></details>`;
  setState("done", "Report ready");
}

function renderNote(text, state = "error", status = "Nothing to report") {
  resultBody.innerHTML = `<div class="run-note">${escapeHtml(text)}</div>`;
  setState(state, status);
}

async function postJson(url, body) {
  const response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || `${url} failed (${response.status}).`);
  return payload;
}

async function generate() {
  if (busy) return;
  const code = editor.state.doc.toString();
  if (!code.trim()) { renderNote("The editor is empty. Write a script that prints something, then generate.", "error", "Empty script"); return; }

  setBusy(true, "Running script…");
  setState("running", "Running script.py");
  resultBody.innerHTML = `<div class="run-note">Running your script on the server…</div>`;

  let run;
  try {
    run = await postJson("/api/run", { code });
  } catch (error) {
    renderNote(error.message, "error", "Could not run"); setBusy(false); return;
  }

  if (run.exitCode !== 0 || run.timedOut) { renderRunError(run); setBusy(false); return; }
  if (!run.stdout.trim()) {
    renderNote("The script finished without printing anything, so there is nothing to write about. Add print() calls for the figures you want in the report.", "error", "No output");
    setBusy(false); return;
  }

  setBusy(true, "Writing report…");
  setState("writing", "Writing the report");
  resultBody.innerHTML = `<div class="run-note">Script finished in ${(run.durationMs / 1000).toFixed(1)}s. Turning the output into a report…</div>`;
  try {
    const explained = await postJson("/api/explain", { output: run.stdout });
    renderReport(explained.markdown, run, explained);
  } catch (error) {
    resultBody.innerHTML = `<div class="run-error"><h3>Script ran, report failed</h3><p>${escapeHtml(error.message)}</p><details class="report-raw" open><summary>Raw output</summary><pre>${escapeHtml(run.stdout)}</pre></details></div>`;
    setState("error", "Report failed");
  }
  setBusy(false);
}

generateButton.addEventListener("click", generate);
resetButton.addEventListener("click", () => {
  editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: SAMPLE } });
  editor.focus();
});

// Entrance: hero parts, then the two panels, staggered once.
const risers = [".hero-title", ".hero-quote", ".hero-description", ".editor-column", ".result-column"].map((s) => document.querySelector(s)).filter(Boolean);
risers.forEach((el, i) => { el.classList.add("rise"); el.style.setProperty("--rise-delay", `${i * 80}ms`); });
requestAnimationFrame(() => requestAnimationFrame(() => risers.forEach((el) => el.classList.add("is-in"))));
