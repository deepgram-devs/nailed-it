# AGENTS.md

Guidance for AI coding agents (Claude Code, Cursor, Copilot, and others) working in this
repo. Humans: see [README.md](README.md). Ground-truth API/protocol details:
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## What this is

A lightning-talk voice demo, "Nailed It." You speak the start of a famous jingle and stop;
a voice agent completes it in one funny line, and the HUD stamps **NAILED IT / MISSED IT** on
whether the spoken completion landed the real ending (scored client-side against the accept
keywords in [FRAGMENTS.md](FRAGMENTS.md)) — alongside an on-screen latency HUD. **Deepgram** does
speech-to-text (Flux), turn detection, and text-to-speech (Aura-2). **Together AI** runs the
LLM that finishes the jingle. A thin Node proxy holds both API keys and relays the audio
WebSocket between the browser and Deepgram's Voice Agent API.

## Commands

| Task                           | Command                                   |
| ------------------------------ | ----------------------------------------- |
| Install                        | `npm install`                             |
| Run (proxy + page)             | `npm run dev` → http://localhost:3000     |
| Connection smoke test (no mic) | `npm run check`                           |
| Typecheck                      | `npm run typecheck`                       |
| Format / check format          | `npm run format` / `npm run format:check` |

Requires Node ≥ 20 and a `.env` with `DEEPGRAM_API_KEY` and `TOGETHER_API_KEY` (copy
`.env.example`). `npm run check` is the fastest way to verify your changes still connect.

## Architecture in one breath

```
Browser (mic + playback + HUD)  <--WS-->  Node proxy (holds keys, relays)  <--WS-->  Deepgram Voice Agent  --HTTPS-->  Together AI
```

The proxy is **not** in the LLM request path. Deepgram calls Together directly using the
`think.endpoint` in the Settings message. The proxy's jobs: hold both keys, build + send the
`Settings` message, and pipe audio/JSON both ways.

## File map

- `src/server/agent.ts` — shared config loader + `Settings` builder. **Edit the Settings shape here**, not in the proxy.
- `src/server/proxy.ts` — static file server + WebSocket relay.
- `src/server/check.ts` — standalone connection/round-trip test.
- `config/agent.config.json` — all tunables: model, prompt, turn-detection thresholds, HUD scale. No code change needed to tune.
- `public/index.html` / `app.js` / `styles.css` — the page and HUD.
- `public/recorder-worklet.js` — mic capture + resample to linear16 16 kHz.
- `docs/ARCHITECTURE.md` — the Deepgram Settings/event contract, in detail.

## Invariants — do not break these when editing

1. **`experimental: true` must stay in the Settings** (`agent.ts`). It is what makes Deepgram emit the `AgentStartedSpeaking` latency event the entire HUD depends on. Remove it and the HUD goes blank.
2. **Latency fields are in SECONDS.** `total_latency`, `ttt_latency`, `tts_latency` arrive as floats like `0.85`. The HUD and check multiply by 1000. Don't assume milliseconds.
3. **Keys are server-side only.** Never put `TOGETHER_API_KEY` (or the Deepgram key) into client code, the HTML, or the `/config` response. `/config` exposes HUD settings only.
4. **`think.endpoint` is a sibling of `think.provider`**, shape `{ url, headers }`. The provider key goes in `headers.Authorization` as `Bearer …`. Which env var holds that key is set by `think.apiKeyEnv` in config (default `TOGETHER_API_KEY`); `agent.ts` `resolveThinkApiKey()` reads it and injects it server-side. Keep all keys out of client code and `/config`.
5. **Audio formats are fixed by the Settings:** input linear16 @ 16 kHz, output linear16 @ 24 kHz. The recorder worklet resamples mic audio to 16 kHz; playback uses a 24 kHz `AudioContext`. Change one side → change both + the config.
6. **Flux turn-detection knobs** (`eot_threshold`, `eager_eot_threshold`, `eot_timeout_ms`) live in `agent.listen.provider` and are Flux-specific. If you fall back to `nova-3`, remove them.
7. **Barge-in** is wired to the `UserStartedSpeaking` event → `flushPlayback()` in `app.js`. Keep that path intact.

## How to extend (common asks)

- **Change the model / prompt / thresholds:** edit `config/agent.config.json`, then reconnect (press **R** in the browser; the proxy re-reads config per connection). No rebuild.
- **Swap the LLM provider:** point `think.endpointUrl` at any OpenAI-compatible `/v1/chat/completions`, set `think.model`, and set `think.apiKeyEnv` to the env var holding that provider's key. Keep `providerType: "open_ai"`. No code change — the proxy re-reads config and resolves the key per connection.
  - **Use Claude (Anthropic):** Anthropic ships an OpenAI-compatible endpoint, so it drops in here. In `config/agent.config.json` set `"endpointUrl": "https://api.anthropic.com/v1/chat/completions"`, `"model": "claude-haiku-4-5"`, `"apiKeyEnv": "ANTHROPIC_API_KEY"`, then put `ANTHROPIC_API_KEY` in `.env`. Use **Haiku 4.5** (not Opus) — this is a sub-second latency demo; Opus / adaptive thinking would blow the HUD's "feels instant" budget. The endpoint is Anthropic's OpenAI-compat surface (fine for chat completions; not all OpenAI params pass through). Verify with `npm run check`.
- **Add a server event to the HUD:** handle it in `app.js` `handleEvent()`; the proxy already forwards all JSON frames.

## Verify before claiming done

Run `npm run check` (full Deepgram→Together→Aura round trip, no mic) and `npm run typecheck`.
For UI changes, `npm run dev` and confirm the server logs `Welcome` then `SettingsApplied`.
If you see `UNPARSABLE_CLIENT_MESSAGE`, the `Settings` shape drifted — check
`agent.listen.provider` first (see [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)).

## External references

- Deepgram Voice Agent: https://developers.deepgram.com/docs/voice-agent
- Settings message: https://developers.deepgram.com/docs/voice-agent-settings
- Server events: https://developers.deepgram.com/docs/voice-agent-outputs
- BYO LLM endpoint: https://developers.deepgram.com/docs/voice-agent-llm-models
- Together inference: https://docs.together.ai (base URL `https://api.together.xyz/v1`)
