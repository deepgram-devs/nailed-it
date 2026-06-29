# Finish My Sentence 🎤→🤖

> Speak the **start** of a sentence, stop, and a voice agent snaps the ending in one funny
> line — with a live HUD showing the time-to-first-word latency budget being hit in real time.

[![CI](https://github.com/OWNER/finish-my-sentence/actions/workflows/ci.yml/badge.svg)](.github/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-1D9E75.svg)](LICENSE)
[![Node](https://img.shields.io/badge/Node-%E2%89%A520-7F77DD.svg)](.nvmrc)

A compact, real-time voice-agent sample. **Deepgram** owns speech-in (Flux), turn detection,
and speech-out (Aura-2). **Together AI** runs the LLM that finishes the sentence. A thin Node
proxy keeps both API keys server-side.

```
Browser (mic + playback + HUD)  <-WS->  Node proxy (localhost)  <-WS->  Deepgram Voice Agent  --HTTPS-->  Together AI
```

Deepgram calls Together **directly** via the Settings `think.endpoint` — the proxy is not in
the LLM path. It exists to keep keys off the browser and relay the audio socket.

> 📷 _Add a screenshot/GIF of the HUD here after a rehearsal: `docs/demo.gif`._

## What you'll learn

- Wiring Deepgram's **Voice Agent API** to a **bring-your-own LLM** over an OpenAI-compatible endpoint.
- Real-time mic capture → linear16, and streaming PCM playback in the browser (Web Audio).
- Turn detection + **barge-in** with Flux, and reading per-turn latency from `AgentStartedSpeaking`.

## Prerequisites

- **Node ≥ 20** — the repo pins **Node 24 LTS** via [`.nvmrc`](.nvmrc) (`nvm use`); CI runs 24.
- **Deepgram API key** — https://console.deepgram.com
- **Together AI API key** — https://api.together.ai
- A browser with mic access (Chrome/Edge/Safari). `localhost` counts as a secure context, so the mic works without HTTPS.

## Quickstart

```bash
nvm use                 # Node 20+
npm install
cp .env.example .env     # paste DEEPGRAM_API_KEY and TOGETHER_API_KEY
npm run check            # ✅ verify keys + the full loop, no mic or browser
npm run dev              # ▶ serves http://localhost:3000 (proxy on the same port)
```

Open http://localhost:3000, click **Start** (grants mic + unlocks audio), then speak a fragment
and trail off. Need lines that land? See [FRAGMENTS.md](FRAGMENTS.md).

### `npm run check` — run this first

A no-browser smoke test. It opens the agent socket with your real Settings, confirms
`Welcome → SettingsApplied`, injects a test fragment so the **full** Deepgram → Together →
Aura loop runs, and prints the completion + latency. Exit 0 means everything is wired:

```
  · SettingsApplied — agent accepted the config
  · injecting a test fragment…
  ↳ completion: "a snooze button and three regrets."
  ↳ latency: total 742ms  (Flux 121ms · LLM 360ms · Aura 261ms)
  ✓ Everything is wired. You're ready to rehearse.
```

## How it works

- [`src/server/agent.ts`](src/server/agent.ts) — shared config loader + `Settings` builder (the Together key is injected here, server-side).
- [`src/server/proxy.ts`](src/server/proxy.ts) — static server, `/config` endpoint (HUD settings only, no keys), and the browser↔Deepgram WebSocket relay.
- [`src/server/check.ts`](src/server/check.ts) — the connection/round-trip smoke test.
- [`public/recorder-worklet.js`](public/recorder-worklet.js) — mic capture, resampled to linear16 16 kHz.
- [`public/app.js`](public/app.js) — sends mic PCM, plays agent audio (24 kHz), handles barge-in, draws the HUD, persists stats.

Full protocol details (the Settings message, every server event, the latency fields, all config
knobs) live in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Tuning (no rebuild)

Everything tunable is in [`config/agent.config.json`](config/agent.config.json). The proxy
re-reads it on every connection, so edit, then press **R** in the browser to reconnect.

- **The game:** `think.prompt`.
- **Model:** `think.model` — `openai/gpt-oss-20b` (fastest) or `meta-llama/Llama-3.3-70B-Instruct-Turbo` (wittier). To run on a different provider (e.g. **Claude** via Anthropic's OpenAI-compatible endpoint), set `think.endpointUrl`, `think.model`, and `think.apiKeyEnv` — see [AGENTS.md](AGENTS.md#how-to-extend-common-asks). For voice, pick a fast model (Claude **Haiku 4.5**); the demo's latency budget rules out heavyweight/thinking models.
- **Turn-taking (the make-or-break knob):** `listen.eotThreshold` (0.5–0.9; lower fires sooner), `listen.eagerEotThreshold`, `listen.eotTimeoutMs` (hard cap + dead-air safety net). Tune by ear in rehearsal.
- **HUD:** `hud.feelsInstantThresholdMs` (default 800), `hud.axisMaxMs` (bar/timeline scale), `hud.rollingHistory`.

## The HUD

Reads `AgentStartedSpeaking` each turn (`total_latency`, `ttt_latency`, `tts_latency`, in
seconds). Three views: a **headline bar** sized as a % of `axisMaxMs` (so it never scrolls),
with Deepgram speech teal / Together reasoning purple and a green/red "feels instant" threshold;
a **metrics** row (turns, best, median, avg, Together-only avg, "felt instant" %); and a
scrolling **timeline** column chart across the whole bit. Session stats persist to
`localStorage` — **Shift+R** clears them.

## Stage controls

- **Start** — warm everything up _before_ the talk. Don't cold-open live.
- **Reset (R)** — tear down + re-open the agent socket (recover from a drop). The status pill is the source of truth for live state.
- **Mute (Space)** — mute/unmute the mic.
- **Shift+R** — clear stored stats / timeline.

## For AI agents

This repo is set up to be agent-legible so you (or a developer's coding agent) can extend or
recreate it safely:

- [AGENTS.md](AGENTS.md) — commands, architecture, file map, and the invariants not to break.
- [CLAUDE.md](CLAUDE.md) — Claude Code entry point (points to AGENTS.md).
- [llms.txt](llms.txt) — machine-readable index of the repo.
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — the Deepgram Settings/event contract, in detail.

## Troubleshooting

| Symptom                                          | Likely cause / fix                                                                                         |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------- |
| `npm run check` times out or socket closes early | Bad/empty `DEEPGRAM_API_KEY`, or the agent endpoint is unreachable from your network.                      |
| `Error … UNPARSABLE_CLIENT_MESSAGE`              | The `Settings` shape drifted. Check `agent.listen.provider` first (see docs/ARCHITECTURE.md).              |
| `SettingsApplied` never arrives with Flux        | Flux may be rejected on your account/region. Set `listen.model` to `nova-3` and remove the `eot_*` fields. |
| HUD bar never appears                            | `experimental: true` got removed from the Settings — it's required for the latency event.                  |
| No agent audio in the browser                    | Click **Start** first (browsers block audio until a user gesture); check the output device.                |
| Mic not captured                                 | Grant mic permission; use `localhost` or HTTPS (secure-context requirement).                               |
| Together errors / empty completions              | Check `TOGETHER_API_KEY` and that `think.model` is a valid Together model id.                              |

## Security

Both keys live only in the proxy `.env`. They are never sent to the browser and never appear in
the `/config` response. If you ever expose the Together key in browser-reachable config, rotate
it afterward. To connect a browser directly to Deepgram, mint a short-lived token rather than
shipping the raw key.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). CI runs typecheck + Prettier on every PR.

## License

[MIT](LICENSE) © 2026 Deepgram, Inc.
