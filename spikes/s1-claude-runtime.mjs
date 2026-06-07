// S1 — Claude Code runtime spike (IMPLEMENTATION-PLAN §3 / D-002).
// Verifies the AgentRuntime can drive Claude Code: streaming transcript events,
// session resume, concurrency-safe parallel runs (no v1 hang), + the Agent SDK path.
// Uses the logged-in `claude` CLI (no API key needed) for the CLI path.
import { spawn } from "node:child_process";

const results = [];
const ok = (name, pass, detail = "") => { results.push({ name, pass, detail }); console.log(`${pass ? "✓ PASS" : "✗ FAIL"}  ${name}${detail ? "  — " + detail : ""}`); };
const MODEL = process.env.SPIKE_MODEL || "haiku"; // cheap/fast for the spike

// Drive `claude -p` with stream-json; collect events. Resolves with {events, session_id, text, ok}.
function runCli(prompt, { resume } = {}) {
  return new Promise((resolve) => {
    const args = ["-p", prompt, "--output-format", "stream-json", "--verbose", "--model", MODEL, "--max-turns", "1"];
    if (resume) args.push("--resume", resume);
    const child = spawn("claude", args, { shell: true });
    let buf = "", stderr = "";
    const events = [];
    let session_id = null, text = "", success = false;
    child.stdout.on("data", (d) => {
      buf += d.toString();
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
        if (!line) continue;
        try {
          const ev = JSON.parse(line);
          events.push(ev.type);
          if (ev.session_id) session_id = ev.session_id;
          if (ev.type === "assistant" && ev.message?.content) {
            for (const c of ev.message.content) if (c.type === "text") text += c.text;
          }
          if (ev.type === "result") { success = ev.subtype === "success"; if (ev.result) text = ev.result; }
        } catch { /* non-json line */ }
      }
    });
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("close", () => resolve({ events, session_id, text: text.trim(), ok: success, stderr }));
    child.on("error", (e) => resolve({ events, session_id, text: "", ok: false, stderr: String(e) }));
  });
}

const t0 = Date.now();
try {
  // 1. CLI headless run + STREAMING events
  const r1 = await runCli("Reply with exactly the single word: PONG");
  const streamed = r1.events.includes("assistant") && r1.events.includes("result");
  ok("CLI headless run streams events (assistant + result)", streamed && r1.ok, `events=[${[...new Set(r1.events)].join(",")}] text="${r1.text.slice(0,40)}"`);
  ok("CLI run yields a session_id (for resume)", !!r1.session_id, r1.session_id || r1.stderr.slice(0, 120));

  // 2. RESUME the session — continuity
  if (r1.session_id) {
    const r2 = await runCli("In one word, what did you just reply?", { resume: r1.session_id });
    ok("CLI --resume continues the session", r2.ok && /pong/i.test(r2.text), `text="${r2.text.slice(0,40)}"`);
  } else ok("CLI --resume continues the session", false, "no session_id to resume");

  // 3. CONCURRENCY — two parallel runs both complete (no v1 hang)
  const cc0 = Date.now();
  const [c1, c2] = await Promise.all([
    runCli("Reply with exactly: ALPHA"),
    runCli("Reply with exactly: BETA"),
  ]);
  ok("two CONCURRENT runs both complete (no hang)", c1.ok && c2.ok, `${Math.round((Date.now()-cc0)/1000)}s, A="${c1.text.slice(0,12)}" B="${c2.text.slice(0,12)}"`);

  // 4. Agent SDK path — does it import + run headlessly?
  try {
    const sdk = await import("@anthropic-ai/claude-agent-sdk");
    const q = sdk.query({ prompt: "Reply with exactly: SDKOK", options: { model: MODEL, maxTurns: 1 } });
    let sdkText = "", sawResult = false;
    for await (const msg of q) {
      if (msg.type === "assistant" && msg.message?.content) for (const c of msg.message.content) if (c.type === "text") sdkText += c.text;
      if (msg.type === "result") sawResult = true;
    }
    ok("Agent SDK query() runs headlessly + streams", sawResult, `text="${sdkText.trim().slice(0,40)}"`);
  } catch (e) {
    ok("Agent SDK query() runs headlessly + streams", false, `SDK path: ${String(e?.message || e).slice(0,140)} (CLI path already proven — SDK may need ANTHROPIC_API_KEY)`);
  }
} catch (e) {
  ok("S1 spike completed without throw", false, String(e?.message || e));
}

const failed = results.filter(r => !r.pass);
console.log(`\nS1 RESULT: ${results.length - failed.length}/${results.length} passed  (${Math.round((Date.now()-t0)/1000)}s).`);
if (failed.length) console.log("FAILED:", failed.map(f => f.name).join("; "));
