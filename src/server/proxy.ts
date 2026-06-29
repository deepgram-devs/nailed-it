/**
 * Finish My Sentence — thin localhost proxy.
 *
 * Browser  <->  this proxy  <->  Deepgram Voice Agent WS  ->  Together AI
 *
 * The proxy holds BOTH api keys server-side:
 *   - DEEPGRAM_API_KEY authenticates the agent WebSocket.
 *   - TOGETHER_API_KEY is injected into the Settings `think.endpoint.headers`
 *     so it never reaches the browser. Deepgram calls Together directly over
 *     public HTTPS, so the proxy is NOT in the LLM request path — it only
 *     relays the audio socket and forwards JSON events to the HUD.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { WebSocket, WebSocketServer } from "ws";
import "dotenv/config";
import { DG_AGENT_URL, PUBLIC_DIR, buildSettings, loadConfig, resolveThinkApiKey } from "./agent";

const PORT = Number(process.env.PORT ?? 3000);
const DEEPGRAM_API_KEY = process.env.DEEPGRAM_API_KEY;

// Resolve the think provider's key from config (Together by default; ANTHROPIC_API_KEY etc.
// when swapped). Keep both keys server-side — they never reach the browser or /config.
const THINK_API_KEY = resolveThinkApiKey(loadConfig());

if (!DEEPGRAM_API_KEY) fail("DEEPGRAM_API_KEY is missing. Copy .env.example to .env and fill it in.");
if (!THINK_API_KEY.value)
  fail(`${THINK_API_KEY.envName} is missing (think provider key). Copy .env.example to .env and fill it in.`);

function fail(msg: string): never {
  console.error(`\n[fatal] ${msg}\n`);
  process.exit(1);
}

// ── Static file server ────────────────────────────────────────────────────
const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".ico": "image/x-icon",
  ".svg": "image/svg+xml",
};

async function serveStatic(req: IncomingMessage, res: ServerResponse) {
  const urlPath = (req.url ?? "/").split("?")[0];

  // Expose only the HUD-relevant config to the browser (no keys, no prompt).
  if (urlPath === "/config") {
    const cfg = loadConfig();
    res.writeHead(200, { "content-type": MIME[".json"] });
    res.end(
      JSON.stringify({
        hud: cfg.hud,
        outputSampleRate: cfg.audio.outputSampleRate,
        inputSampleRate: cfg.audio.inputSampleRate,
      }),
    );
    return;
  }

  const rel = urlPath === "/" ? "/index.html" : urlPath;
  // Prevent path traversal.
  const filePath = normalize(join(PUBLIC_DIR, rel));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403).end("forbidden");
    return;
  }
  try {
    const body = await readFile(filePath);
    res.writeHead(200, { "content-type": MIME[extname(filePath)] ?? "application/octet-stream" });
    res.end(body);
  } catch {
    res.writeHead(404).end("not found");
  }
}

const httpServer = createServer((req, res) => void serveStatic(req, res));

// ── WebSocket relay ─────────────────────────────────────────────────────────
const wss = new WebSocketServer({ server: httpServer });
let clientSeq = 0;

wss.on("connection", (client) => {
  const id = ++clientSeq;
  const tag = `[client ${id}]`;
  console.log(`${tag} connected`);

  const cfg = loadConfig();
  // Re-resolve per connection so a config-driven provider swap (edit, press R) picks up
  // the matching key without a restart.
  const thinkKey = resolveThinkApiKey(cfg);
  if (!thinkKey.value) {
    console.error(`${tag} ${thinkKey.envName} is missing (think provider key); closing.`);
    client.close();
    return;
  }
  const settings = buildSettings(cfg, thinkKey.value);

  const upstream = new WebSocket(DG_AGENT_URL, {
    headers: { Authorization: `Token ${DEEPGRAM_API_KEY}` },
  });
  upstream.binaryType = "nodebuffer";

  let upstreamReady = false;
  const preReadyAudio: Buffer[] = [];
  let keepAlive: NodeJS.Timeout | undefined;

  upstream.on("open", () => {
    console.log(`${tag} upstream open -> sending Settings (think=${cfg.think.model}, listen=${cfg.listen.model})`);
    upstream.send(JSON.stringify(settings));
    keepAlive = setInterval(() => {
      if (upstream.readyState === WebSocket.OPEN) upstream.send(JSON.stringify({ type: "KeepAlive" }));
    }, 8000);
  });

  // Deepgram -> browser
  upstream.on("message", (data: Buffer, isBinary: boolean) => {
    if (isBinary) {
      if (client.readyState === WebSocket.OPEN) client.send(data, { binary: true });
      return;
    }
    const text = data.toString();
    try {
      const evt = JSON.parse(text);
      logEvent(tag, evt);
      if (evt.type === "SettingsApplied") {
        upstreamReady = true;
        for (const chunk of preReadyAudio) upstream.send(chunk, { binary: true });
        preReadyAudio.length = 0;
      }
    } catch {
      /* non-JSON text frame, forward as-is */
    }
    if (client.readyState === WebSocket.OPEN) client.send(text);
  });

  // browser -> Deepgram
  client.on("message", (data: Buffer, isBinary: boolean) => {
    if (isBinary) {
      if (!upstreamReady) {
        preReadyAudio.push(Buffer.from(data));
        return;
      }
      if (upstream.readyState === WebSocket.OPEN) upstream.send(data, { binary: true });
      return;
    }
    // Forward client JSON control frames (e.g. InjectUserMessage) straight through.
    if (upstream.readyState === WebSocket.OPEN) upstream.send(data.toString());
  });

  const closeBoth = (why: string) => {
    if (keepAlive) clearInterval(keepAlive);
    if (upstream.readyState === WebSocket.OPEN) upstream.close();
    if (client.readyState === WebSocket.OPEN) client.close();
    console.log(`${tag} closed (${why})`);
  };

  upstream.on("close", () => closeBoth("upstream closed"));
  upstream.on("error", (err) => {
    console.error(`${tag} upstream error:`, err.message);
    closeBoth("upstream error");
  });
  client.on("close", () => closeBoth("client closed"));
  client.on("error", (err) => console.error(`${tag} client error:`, err.message));
});

function logEvent(tag: string, evt: any) {
  switch (evt.type) {
    case "Welcome":
      console.log(`${tag} <- Welcome (request_id=${evt.request_id})`);
      break;
    case "SettingsApplied":
      console.log(`${tag} <- SettingsApplied — agent ready`);
      break;
    case "ConversationText":
      console.log(`${tag} <- [${evt.role}] ${evt.content}`);
      break;
    case "UserStartedSpeaking":
      console.log(`${tag} <- UserStartedSpeaking`);
      break;
    case "AgentStartedSpeaking":
      console.log(
        `${tag} <- AgentStartedSpeaking total=${(evt.total_latency * 1000) | 0}ms ttt=${(evt.ttt_latency * 1000) | 0}ms tts=${(evt.tts_latency * 1000) | 0}ms`,
      );
      break;
    case "Error":
      console.error(`${tag} <- ERROR ${evt.code}: ${evt.description}`);
      break;
    case "Warning":
      console.warn(`${tag} <- WARNING ${evt.code}: ${evt.description}`);
      break;
    default:
      break;
  }
}

httpServer.listen(PORT, () => {
  const cfg = loadConfig();
  console.log(`\n  Finish My Sentence`);
  console.log(`  open  http://localhost:${PORT}`);
  console.log(`  think ${cfg.think.model}  via  ${cfg.think.endpointUrl}`);
  console.log(`  listen ${cfg.listen.model}  speak ${cfg.speak.model}\n`);
});
