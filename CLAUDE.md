# CLAUDE.md

This project's agent guidance lives in [AGENTS.md](AGENTS.md) — read it first. It covers the
commands, architecture, the file map, and the invariants you must preserve when editing.

Ground-truth Deepgram Settings/event details: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

Quick reminders specific to working here:

- Verify changes with `npm run check` (no mic needed) and `npm run typecheck` before finishing.
- Never write either API key into client code or the `/config` response — both stay server-side.
- `experimental: true` in the Settings is load-bearing: it's what surfaces the latency event the HUD reads.
- Latency fields from `AgentStartedSpeaking` are in seconds, not milliseconds.
