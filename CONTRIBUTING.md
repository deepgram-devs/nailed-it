# Contributing

Thanks for taking a look. This is a demo / code sample, so the bar is "clear and runnable,"
not "production framework." Small, focused improvements are very welcome.

## Setup

```bash
nvm use            # Node 20+ (see .nvmrc)
npm install
cp .env.example .env   # add DEEPGRAM_API_KEY and TOGETHER_API_KEY
npm run check          # verify your keys + the full loop, no mic needed
npm run dev            # http://localhost:3000
```

## Before you open a PR

- `npm run typecheck` passes.
- `npm run format` (Prettier) applied.
- `npm run check` still reaches `SettingsApplied` and prints a completion.
- If you changed the `Settings` shape, update [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).
- If you changed conventions or invariants, update [AGENTS.md](AGENTS.md).

## Style

- TypeScript on the server, plain ES modules in the browser (no bundler — keep it that way unless there's a strong reason).
- Prettier config is in `.prettierrc.json` (`printWidth` 120). CI checks formatting and types.
- Prefer editing `config/agent.config.json` over hardcoding values; that file is the tuning surface.

## Reporting issues

Include: what you ran, the server log around `Welcome` / `SettingsApplied`, any `Error` event
(`code` + `description`), your Node version, and browser. Redact your API keys.
