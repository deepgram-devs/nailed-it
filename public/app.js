// Finish My Sentence — browser client.
// Mic -> proxy (linear16 16k). Agent audio (linear16 24k) -> playback.
// Reads AgentStartedSpeaking latency fields to draw the HUD + timeline.

const STORE_KEY = "fms:v1";

const els = {
  status: document.getElementById("status"),
  userText: document.getElementById("userText"),
  agentText: document.getElementById("agentText"),
  bars: document.getElementById("bars"),
  stats: document.getElementById("stats"),
  columns: document.getElementById("columns"),
  timeline: document.getElementById("timeline"),
  thresholdLine: document.getElementById("thresholdLine"),
  axisMax: document.getElementById("axisMax"),
  startBtn: document.getElementById("startBtn"),
  resetBtn: document.getElementById("resetBtn"),
  muteBtn: document.getElementById("muteBtn"),
  bestEver: document.getElementById("bestEver"),
};

let cfg = {
  hud: { feelsInstantThresholdMs: 800, axisMaxMs: 1600, rollingHistory: 40 },
  outputSampleRate: 24000,
  inputSampleRate: 16000,
};

let ws = null;
let micStream = null;
let captureCtx = null;
let workletNode = null;
let playCtx = null;
let playHead = 0;
let liveSources = new Set();
let micMuted = false;
let started = false;

let turns = []; // session + restored: { total, listen, ttt, tts, under, ts }
let store = { bestEverMs: null, lifetimeTurns: 0, recent: [] };

// ── Lightweight storage ──────────────────────────────────────────────────────
function loadStore() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) store = { bestEverMs: null, lifetimeTurns: 0, recent: [], ...JSON.parse(raw) };
  } catch {
    /* ignore */
  }
}
function saveStore() {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(store));
  } catch {
    /* ignore quota / private mode */
  }
}
function clearStore() {
  store = { bestEverMs: null, lifetimeTurns: 0, recent: [] };
  turns = [];
  saveStore();
  els.columns.replaceChildren();
  renderStats();
  renderBestEver();
}

function setStatus(state, text) {
  els.status.className = `status ${state}`;
  els.status.textContent = text ?? state;
}

function setRunning(on) {
  started = on;
  els.startBtn.disabled = on;
  els.startBtn.textContent = on ? "running ●" : "Start (warm up before the talk)";
  els.resetBtn.disabled = !on;
  els.muteBtn.disabled = !on;
}

async function loadConfig() {
  try {
    cfg = await (await fetch("/config")).json();
  } catch {
    /* keep defaults */
  }
  els.axisMax.textContent = `${cfg.hud.axisMaxMs} ms`;
  const tPct = clampPct((cfg.hud.feelsInstantThresholdMs / cfg.hud.axisMaxMs) * 100);
  els.thresholdLine.style.bottom = `${tPct}%`;
  els.thresholdLine.querySelector(".tl-label").textContent = `${cfg.hud.feelsInstantThresholdMs} ms`;
}

const clampPct = (n) => Math.max(0, Math.min(100, n));

// ── Playback (agent TTS audio) ──────────────────────────────────────────────
function ensurePlayback() {
  if (!playCtx) {
    playCtx = new AudioContext({ sampleRate: cfg.outputSampleRate });
    playHead = playCtx.currentTime;
  }
}
function enqueuePcm(arrayBuffer) {
  ensurePlayback();
  const pcm = new Int16Array(arrayBuffer);
  if (pcm.length === 0) return;
  const f32 = new Float32Array(pcm.length);
  for (let i = 0; i < pcm.length; i++) f32[i] = pcm[i] / 32768;
  const buf = playCtx.createBuffer(1, f32.length, cfg.outputSampleRate);
  buf.copyToChannel(f32, 0);
  const src = playCtx.createBufferSource();
  src.buffer = buf;
  src.connect(playCtx.destination);
  const now = playCtx.currentTime;
  if (playHead < now) playHead = now + 0.03;
  src.start(playHead);
  playHead += buf.duration;
  liveSources.add(src);
  src.onended = () => liveSources.delete(src);
}
function flushPlayback() {
  for (const s of liveSources) {
    try {
      s.stop();
    } catch {}
  }
  liveSources.clear();
  if (playCtx) playHead = playCtx.currentTime;
}

// ── Mic capture ───────────────────────────────────────────────────────────────
async function startMic() {
  micStream = await navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  });
  captureCtx = new AudioContext();
  await captureCtx.audioWorklet.addModule("/recorder-worklet.js");
  const src = captureCtx.createMediaStreamSource(micStream);
  workletNode = new AudioWorkletNode(captureCtx, "recorder", { processorOptions: { targetRate: cfg.inputSampleRate } });
  workletNode.port.onmessage = (e) => {
    if (micMuted) return;
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(e.data);
  };
  src.connect(workletNode);
  const sink = captureCtx.createGain();
  sink.gain.value = 0;
  workletNode.connect(sink);
  sink.connect(captureCtx.destination);
}
function stopMic() {
  if (workletNode) {
    try {
      workletNode.disconnect();
    } catch {}
    workletNode = null;
  }
  if (captureCtx) {
    try {
      captureCtx.close();
    } catch {}
    captureCtx = null;
  }
  if (micStream) {
    for (const t of micStream.getTracks()) t.stop();
    micStream = null;
  }
}

// ── WebSocket to the proxy ──────────────────────────────────────────────────
function connect() {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  ws = new WebSocket(`${proto}://${location.host}/agent`);
  ws.binaryType = "arraybuffer";
  setStatus("connecting", "connecting");

  ws.onmessage = (ev) => {
    if (typeof ev.data !== "string") return enqueuePcm(ev.data);
    let msg;
    try {
      msg = JSON.parse(ev.data);
    } catch {
      return;
    }
    handleEvent(msg);
  };
  ws.onclose = () => {
    if (started) setStatus("error", "socket closed — press R");
  };
  ws.onerror = () => setStatus("error", "socket error — press R");
}

function handleEvent(msg) {
  switch (msg.type) {
    case "SettingsApplied":
      setStatus("ready", "ready — speak a fragment");
      break;
    case "UserStartedSpeaking":
      flushPlayback(); // barge-in
      setStatus("listening", "listening");
      break;
    case "ConversationText":
      if (msg.role === "user") {
        els.userText.textContent = msg.content || "—";
        els.agentText.textContent = "…";
      } else if (msg.role === "assistant") {
        els.agentText.textContent = msg.content || "—";
      }
      break;
    case "AgentStartedSpeaking":
      setStatus("speaking", "speaking");
      recordTurn(msg);
      break;
    case "AgentAudioDone":
      setStatus("ready", "ready — speak a fragment");
      break;
    case "Error":
      setStatus("error", `error: ${msg.code}`);
      console.error("Agent error:", msg);
      break;
    case "Warning":
      console.warn("Agent warning:", msg);
      break;
  }
}

// ── Metrics + HUD ─────────────────────────────────────────────────────────────
function recordTurn(evt) {
  const total = Math.round(evt.total_latency * 1000);
  const ttt = Math.round(evt.ttt_latency * 1000);
  const tts = Math.round(evt.tts_latency * 1000);
  const listen = Math.max(0, total - ttt - tts);
  const under = total <= cfg.hud.feelsInstantThresholdMs;
  const turn = { total, listen, ttt, tts, under, ts: Date.now() };

  turns.push(turn);
  store.lifetimeTurns += 1;
  if (store.bestEverMs == null || total < store.bestEverMs) store.bestEverMs = total;
  store.recent.push(turn);
  if (store.recent.length > 200) store.recent = store.recent.slice(-200);
  saveStore();

  renderCurrentBar(turn);
  appendColumn(turn);
  renderStats();
  renderBestEver();
}

function renderCurrentBar(turn) {
  const axis = cfg.hud.axisMaxMs;
  const segs = [
    { ms: turn.listen, cls: "teal" },
    { ms: turn.ttt, cls: "purple" },
    { ms: turn.tts, cls: "teal" },
  ];
  const row = document.createElement("div");
  row.className = "bar-row";

  const track = document.createElement("div");
  track.className = "bar-track";

  const bar = document.createElement("div");
  bar.className = "bar";
  bar.style.width = `${clampPct((turn.total / axis) * 100)}%`;
  for (const s of segs) {
    const seg = document.createElement("div");
    seg.className = `seg ${s.cls}`;
    seg.style.width = `${(s.ms / turn.total) * 100}%`;
    seg.title = `${s.ms} ms`;
    bar.appendChild(seg);
  }
  track.appendChild(bar);

  const line = document.createElement("div");
  line.className = "threshold";
  line.style.left = `${clampPct((cfg.hud.feelsInstantThresholdMs / axis) * 100)}%`;
  line.style.borderColor = turn.under ? "var(--good)" : "var(--bad)";
  track.appendChild(line);

  const total = document.createElement("div");
  total.className = `bar-total ${turn.under ? "good" : "bad"}`;
  total.textContent = `${turn.total} ms`;

  row.appendChild(track);
  row.appendChild(total);
  els.bars.replaceChildren(row);
}

function appendColumn(turn) {
  const axis = cfg.hud.axisMaxMs;
  const col = document.createElement("div");
  col.className = `col ${turn.under ? "good" : "bad"}`;
  col.title = `${turn.total} ms (Flux ${turn.listen} · Together ${turn.ttt} · Aura ${turn.tts})`;

  const stack = document.createElement("div");
  stack.className = "col-stack";
  stack.style.height = `${clampPct((turn.total / axis) * 100)}%`;
  for (const s of [
    { ms: turn.tts, cls: "teal" },
    { ms: turn.ttt, cls: "purple" },
    { ms: turn.listen, cls: "teal" },
  ]) {
    const seg = document.createElement("div");
    seg.className = `cseg ${s.cls}`;
    seg.style.flex = `${Math.max(0.0001, s.ms)} 0 0`;
    stack.appendChild(seg);
  }
  col.appendChild(stack);
  els.columns.appendChild(col);

  // Cap rendered columns; keep newest.
  while (els.columns.children.length > cfg.hud.rollingHistory) els.columns.removeChild(els.columns.firstChild);
  els.timeline.scrollLeft = els.timeline.scrollWidth;
}

function median(arr) {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
}

function renderStats() {
  const totals = turns.map((t) => t.total);
  const n = totals.length;
  const best = n ? Math.min(...totals) : 0;
  const avg = n ? Math.round(totals.reduce((a, b) => a + b, 0) / n) : 0;
  const p50 = median(totals);
  const instant = n ? Math.round((turns.filter((t) => t.under).length / n) * 100) : 0;
  const avgTtt = n ? Math.round(turns.reduce((a, t) => a + t.ttt, 0) / n) : 0;

  const cards = [
    { k: "turns", v: n },
    { k: "best", v: `${best} ms`, good: best && best <= cfg.hud.feelsInstantThresholdMs },
    { k: "median", v: `${p50} ms`, good: p50 && p50 <= cfg.hud.feelsInstantThresholdMs },
    { k: "avg", v: `${avg} ms` },
    { k: "Together avg", v: `${avgTtt} ms` },
    { k: "felt instant", v: `${instant}%`, good: instant >= 80 },
  ];
  els.stats.replaceChildren(
    ...cards.map((c) => {
      const el = document.createElement("div");
      el.className = "stat";
      el.innerHTML = `<div class="stat-v ${c.good ? "good" : ""}"></div><div class="stat-k"></div>`;
      el.querySelector(".stat-v").textContent = c.v;
      el.querySelector(".stat-k").textContent = c.k;
      return el;
    }),
  );
}

function renderBestEver() {
  els.bestEver.textContent =
    store.bestEverMs != null ? `best ever ${store.bestEverMs} ms · ${store.lifetimeTurns} turns all-time` : "";
}

// ── Lifecycle ─────────────────────────────────────────────────────────────────
async function start() {
  if (started) return;
  setRunning(true);
  await loadConfig();
  ensurePlayback();
  await playCtx.resume();
  await startMic();
  connect();
}

function reset() {
  flushPlayback();
  micMuted = false;
  els.muteBtn.textContent = "Mute (Space)";
  if (ws) {
    try {
      ws.close();
    } catch {}
  }
  connect();
  setStatus("connecting", "reconnecting");
}

function toggleMute() {
  if (!started) return;
  micMuted = !micMuted;
  els.muteBtn.textContent = micMuted ? "Unmute (Space)" : "Mute (Space)";
  setStatus(micMuted ? "idle" : "ready", micMuted ? "mic muted" : "mic live");
}

els.startBtn.addEventListener("click", () => start());
els.resetBtn.addEventListener("click", () => started && reset());
els.muteBtn.addEventListener("click", () => toggleMute());

document.addEventListener("keydown", (e) => {
  if (e.repeat) return;
  if (e.key === "r" || e.key === "R") {
    if (e.shiftKey) {
      clearStore();
      setStatus(started ? "ready" : "idle", "stats cleared");
      return;
    }
    if (started) reset();
  } else if (e.code === "Space" && started) {
    e.preventDefault();
    toggleMute();
  }
});

// ── Boot ────────────────────────────────────────────────────────────────────
loadStore();
loadConfig().then(() => {
  // Restore the timeline + stats from the last session so a reload keeps the picture.
  turns = store.recent.slice(-cfg.hud.rollingHistory);
  for (const t of turns) appendColumn(t);
  renderStats();
  renderBestEver();
});
setRunning(false);
setStatus("idle", "press Start");
