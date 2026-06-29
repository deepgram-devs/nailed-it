/**
 * Connection smoke test — run before you ever touch a mic.
 *
 *   npm run check
 *
 * It opens the Deepgram Voice Agent socket with your real Settings, confirms
 * Welcome -> SettingsApplied, then injects a text fragment so the FULL loop
 * (Deepgram turn-taking -> Together completion -> Deepgram TTS) runs and prints
 * the per-turn latency. No microphone, no browser. Exit 0 = everything is wired.
 */
import "dotenv/config";
import { WebSocket } from "ws";
import { DG_AGENT_URL, buildSettings, loadConfig, resolveThinkApiKey } from "./agent";

const DEEPGRAM_API_KEY = process.env.DEEPGRAM_API_KEY;
const TEST_FRAGMENT = process.env.CHECK_FRAGMENT ?? "The best part of waking up is";
const OVERALL_TIMEOUT_MS = 20000;

function die(msg: string): never {
  console.error(`\n  ✗ ${msg}\n`);
  process.exit(1);
}

const cfg = loadConfig();
const thinkKey = resolveThinkApiKey(cfg);

if (!DEEPGRAM_API_KEY) die("DEEPGRAM_API_KEY is missing. Copy .env.example to .env and fill it in.");
if (!thinkKey.value)
  die(`${thinkKey.envName} is missing (think provider key). Copy .env.example to .env and fill it in.`);

const settings = buildSettings(cfg, thinkKey.value);

console.log(`\n  Finish My Sentence — connection check`);
console.log(`  listen ${cfg.listen.model}   think ${cfg.think.model}   speak ${cfg.speak.model}`);
console.log(`  fragment: "${TEST_FRAGMENT}"\n`);

const ws = new WebSocket(DG_AGENT_URL, { headers: { Authorization: `Token ${DEEPGRAM_API_KEY}` } });

let completion = "";
const timer = setTimeout(
  () => die(`Timed out after ${OVERALL_TIMEOUT_MS / 1000}s without a reply.`),
  OVERALL_TIMEOUT_MS,
);

const finish = (latency?: { total: number; ttt: number; tts: number }) => {
  clearTimeout(timer);
  if (completion) console.log(`  ↳ completion: "${completion}"`);
  if (latency) {
    const flux = Math.max(0, latency.total - latency.ttt - latency.tts);
    console.log(
      `  ↳ latency: total ${latency.total}ms  (Flux ${flux}ms · LLM ${latency.ttt}ms · Aura ${latency.tts}ms)`,
    );
  }
  console.log(`\n  ✓ Everything is wired. You're ready to rehearse.\n`);
  try {
    ws.close();
  } catch {
    /* ignore */
  }
  process.exit(0);
};

ws.on("open", () => {
  console.log("  · socket open, sending Settings…");
  ws.send(JSON.stringify(settings));
});

ws.on("message", (data: Buffer, isBinary: boolean) => {
  if (isBinary) return; // TTS audio frames — ignore in the check
  let evt: any;
  try {
    evt = JSON.parse(data.toString());
  } catch {
    return;
  }
  switch (evt.type) {
    case "Welcome":
      console.log(`  · Welcome (request_id=${evt.request_id})`);
      break;
    case "SettingsApplied":
      console.log("  · SettingsApplied — agent accepted the config");
      console.log("  · injecting a test fragment…");
      ws.send(JSON.stringify({ type: "InjectUserMessage", content: TEST_FRAGMENT }));
      break;
    case "ConversationText":
      if (evt.role === "assistant") completion = evt.content ?? "";
      break;
    case "AgentStartedSpeaking":
      // Latencies arrive in SECONDS; convert to ms. Give the assistant text a beat to land.
      setTimeout(
        () =>
          finish({
            total: Math.round(evt.total_latency * 1000),
            ttt: Math.round(evt.ttt_latency * 1000),
            tts: Math.round(evt.tts_latency * 1000),
          }),
        400,
      );
      break;
    case "Error":
      die(`Agent error ${evt.code}: ${evt.description}`);
      break;
  }
});

ws.on("error", (err: Error) => die(`Socket error: ${err.message}`));
ws.on("close", (code) => {
  if (code !== 1000) die(`Socket closed early (code ${code}) before the loop completed.`);
});
