# Architecture & protocol reference

Ground truth for how this demo wires Deepgram's Voice Agent API to Together AI. Written so a
developer — or an AI agent — can understand, modify, or recreate it without guessing at the
API. For working conventions see [AGENTS.md](../AGENTS.md); for setup see [README](../README.md).

## Data flow

```
┌─────────────────────────────┐         ┌──────────────────────────┐         ┌────────────────────────┐
│ Browser                     │   WS    │ Node proxy (localhost)   │   WS    │ Deepgram Voice Agent   │
│  • mic capture → 16k PCM    │ ──────▶ │  • holds DEEPGRAM + TOGETHER keys │ ──────▶ │  • Flux STT + turn det.│
│  • plays 24k PCM            │ ◀────── │  • sends Settings        │ ◀────── │  • Aura-2 TTS          │
│  • draws HUD from events    │ (audio  │  • relays audio + JSON   │ (audio  │  • orchestrates loop   │
└─────────────────────────────┘  + JSON)└──────────────────────────┘  + JSON)└───────────┬────────────┘
                                                                                          │ HTTPS
                                                                                          ▼
                                                                          ┌────────────────────────┐
                                                                          │ Together AI            │
                                                                          │  /v1/chat/completions  │
                                                                          │  (the "think" step)    │
                                                                          └────────────────────────┘
```

**Key point:** the proxy is not in the LLM request path. Deepgram makes the HTTPS call to
Together itself, using the `think.endpoint` declared in the Settings message. The proxy exists
to (a) keep both API keys off the browser and (b) give the HUD a clean relay of the JSON events.

## Per-turn sequence

1. Browser streams mic audio (linear16, 16 kHz) → proxy → Deepgram.
2. Flux detects end-of-turn and emits the user transcript.
3. Deepgram POSTs an OpenAI-format chat completion to Together's `/v1/chat/completions`.
4. Together returns the completion; Deepgram synthesizes it with Aura-2.
5. Deepgram streams TTS audio (linear16, 24 kHz) back → proxy → browser playback.
6. Deepgram emits `AgentStartedSpeaking` with the latency breakdown → HUD draws the bar.

## The Settings message

Sent once by the proxy on connect (built in [`src/server/agent.ts`](../src/server/agent.ts)):

```jsonc
{
  "type": "Settings",
  "experimental": true, // REQUIRED for the AgentStartedSpeaking latency event
  "audio": {
    "input": { "encoding": "linear16", "sample_rate": 16000 },
    "output": { "encoding": "linear16", "sample_rate": 24000, "container": "none" },
  },
  "agent": {
    "language": "en",
    "listen": {
      "provider": {
        "type": "deepgram",
        "model": "flux-general-en",
        "version": "v2",
        "eot_threshold": 0.5, // Flux-only turn detection (drop if using nova-3)
        "eager_eot_threshold": 0.3,
        "eot_timeout_ms": 2500,
      },
    },
    "think": {
      "provider": { "type": "open_ai", "model": "openai/gpt-oss-20b", "temperature": 0.9 },
      "endpoint": {
        // sibling of provider; Deepgram calls this directly
        "url": "https://api.together.xyz/v1/chat/completions",
        "headers": { "Authorization": "Bearer <TOGETHER_API_KEY>" },
      },
      "prompt": "…the finish-my-sentence system prompt…",
    },
    "speak": { "provider": { "type": "deepgram", "model": "aura-2-thalia-en" } },
    "greeting": "",
  },
}
```

Auth for the WebSocket itself is the `Authorization: Token <DEEPGRAM_API_KEY>` header on the
upstream connection to `wss://agent.deepgram.com/v1/agent/converse`.

## Server events the client cares about

| Event                  | Meaning / use                                                                              |
| ---------------------- | ------------------------------------------------------------------------------------------ |
| `Welcome`              | Connection accepted (carries `request_id`).                                                |
| `SettingsApplied`      | Settings accepted — agent is ready. If this never arrives, the Settings shape is wrong.    |
| `ConversationText`     | A turn's text. `role: "user"` = the spoken fragment; `role: "assistant"` = the completion. |
| `UserStartedSpeaking`  | Drives barge-in: stop + flush playback so the next fragment is heard immediately.          |
| `AgentStartedSpeaking` | The HUD's data source. Fields below. **Only emitted when `experimental: true`.**           |
| `AgentAudioDone`       | TTS finished for this turn.                                                                |
| `Error` / `Warning`    | `{ code, description }`.                                                                   |
| binary frames          | Aura-2 TTS audio (linear16, 24 kHz).                                                       |

### `AgentStartedSpeaking` fields (all in SECONDS, floats)

| Field           | Meaning                                        | HUD use                                    |
| --------------- | ---------------------------------------------- | ------------------------------------------ |
| `total_latency` | User utterance → agent reply.                  | Headline "time to first word"; bar length. |
| `ttt_latency`   | Text-to-text (the Together/LLM slice).         | Purple segment.                            |
| `tts_latency`   | Text-to-speech (the Aura slice).               | Teal segment.                              |
| _derived_       | `max(0, total − ttt − tts)` = Flux/turn slice. | Teal segment.                              |

The client multiplies by 1000 to display milliseconds.

## Config knobs (`config/agent.config.json`)

| Path                                 | Effect                                                                                                                                      |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `listen.model` / `listen.version`    | STT model. `flux-general-en` / `v2` here; `nova-3` is the fallback.                                                                         |
| `listen.eotThreshold`                | End-of-turn confidence (0.5–0.9). Lower = fires sooner, riskier on false stops.                                                             |
| `listen.eagerEotThreshold`           | Speculative early end-of-turn.                                                                                                              |
| `listen.eotTimeoutMs`                | Hard cap on turn length; also the dead-air safety net.                                                                                      |
| `think.model`                        | Together model id (e.g. `openai/gpt-oss-20b`, `meta-llama/Llama-3.3-70B-Instruct-Turbo`).                                                   |
| `think.endpointUrl`                  | OpenAI-compatible completions endpoint.                                                                                                     |
| `think.apiKeyEnv`                    | Env var holding the provider's Bearer key (default `TOGETHER_API_KEY`). Set to `ANTHROPIC_API_KEY` etc. to swap providers — no code change. |
| `think.temperature` / `think.prompt` | LLM sampling and the game's system prompt.                                                                                                  |
| `speak.model`                        | Aura-2 voice.                                                                                                                               |
| `hud.feelsInstantThresholdMs`        | The "feels instant" line (default 800). Green under, red over.                                                                              |
| `hud.axisMaxMs`                      | Full-width of the HUD bar/timeline in ms (scaling).                                                                                         |
| `hud.rollingHistory`                 | How many turn columns the timeline keeps.                                                                                                   |

The proxy re-reads this file on every WebSocket connection, so a reconnect (press **R** in the
browser) picks up edits with no restart.

## Why a proxy at all

Browser WebSockets cannot set a custom `Authorization` header, and putting the Together key in
browser-visible Settings would leak it. The proxy keeps both keys server-side and relays the
socket. If you ever must connect the browser directly, mint a short-lived Deepgram token rather
than shipping the raw key — and never expose the Together key client-side.

## Recreating this from scratch

Minimum viable version: a Node process that (1) opens `wss://agent.deepgram.com/v1/agent/converse`
with the Deepgram token header, (2) sends the Settings above with your Together key injected,
(3) relays binary audio both ways and forwards JSON to a browser that captures mic → linear16
16 kHz and plays linear16 24 kHz. Everything else (HUD, metrics, timeline, storage) is
presentation on top of the `AgentStartedSpeaking` and `ConversationText` events.
