/**
 * Shared Deepgram Voice Agent wiring used by both the proxy and the smoke test.
 * Keeping the Settings builder in one place means the connection check (`npm run
 * check`) validates the exact payload the proxy ships.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const ROOT = join(__dirname, "..", "..");
export const PUBLIC_DIR = join(ROOT, "public");
export const CONFIG_PATH = join(ROOT, "config", "agent.config.json");
/** Curated opener lines — the single source of truth for both the doc and the on-screen chips. */
export const FRAGMENTS_PATH = join(ROOT, "FRAGMENTS.md");

/** Deepgram Voice Agent WebSocket. Auth via `Authorization: Token <DEEPGRAM_API_KEY>`. */
export const DG_AGENT_URL = "wss://agent.deepgram.com/v1/agent/converse";

export type AgentConfig = {
  audio: { inputSampleRate: number; outputSampleRate: number };
  listen: { model: string; version: string; eotThreshold: number; eagerEotThreshold: number; eotTimeoutMs: number };
  think: {
    providerType: string;
    model: string;
    endpointUrl: string;
    temperature: number;
    prompt: string;
    // Which env var holds the Bearer key for `endpointUrl`. Defaults to TOGETHER_API_KEY.
    // Point it at ANTHROPIC_API_KEY (etc.) to swap in another OpenAI-compatible provider.
    apiKeyEnv?: string;
  };
  speak: { model: string };
  greeting: string;
  hud: { feelsInstantThresholdMs: number; axisMaxMs: number; rollingHistory: number };
};

/** Default env var for the think provider's key. Together is the demo's default LLM. */
export const DEFAULT_THINK_API_KEY_ENV = "TOGETHER_API_KEY";

/** Re-read on every connection so rehearsal tweaks land on the next reconnect, no restart. */
export function loadConfig(): AgentConfig {
  return JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as AgentConfig;
}

/**
 * The opener fragments shown on screen, parsed from FRAGMENTS.md so the doc and the page never
 * drift. Picks the bullet lines that trail off with an ellipsis. Returns [] if the file is gone
 * (the page just hides the chip row). Re-read per request so edits show on reload.
 */
export function loadOpeners(): string[] {
  try {
    return readFileSync(FRAGMENTS_PATH, "utf8")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.startsWith("- "))
      .map((line) => line.slice(2).trim())
      .filter((line) => line.endsWith("…"));
  } catch {
    return [];
  }
}

/**
 * Resolve the Bearer key for the think provider, server-side. Reads the env var named by
 * `think.apiKeyEnv` (default TOGETHER_API_KEY) so swapping providers is config + key only,
 * never a code change. The returned key is injected into the Settings here and never reaches
 * the browser or `/config`.
 */
export function resolveThinkApiKey(cfg: AgentConfig): { envName: string; value: string | undefined } {
  const envName = cfg.think.apiKeyEnv ?? DEFAULT_THINK_API_KEY_ENV;
  return { envName, value: process.env[envName] };
}

/**
 * Friendly provider name derived from the (non-secret) think endpoint host. Used only for
 * the HUD's pipeline strip so the audience can see which LLM is wired in. Falls back to the
 * raw host, never throws.
 */
export function thinkProviderLabel(endpointUrl: string): string {
  try {
    const host = new URL(endpointUrl).host;
    if (/together/i.test(host)) return "Together AI";
    if (/anthropic/i.test(host)) return "Anthropic";
    if (/openai/i.test(host)) return "OpenAI";
    return host;
  } catch {
    return "custom";
  }
}

/**
 * Non-secret summary of what's actually wired in, for the browser HUD. Real model ids, the
 * STT version, the Flux turn-detection knobs, and a provider label derived from the endpoint
 * host. Deliberately omits the prompt, the endpoint auth header, and every API key — those
 * stay server-side and must never appear in `/config`.
 */
export function describeAgent(cfg: AgentConfig) {
  return {
    listen: {
      model: cfg.listen.model,
      version: cfg.listen.version,
      eotThreshold: cfg.listen.eotThreshold,
      eagerEotThreshold: cfg.listen.eagerEotThreshold,
      eotTimeoutMs: cfg.listen.eotTimeoutMs,
    },
    think: { model: cfg.think.model, provider: thinkProviderLabel(cfg.think.endpointUrl) },
    speak: { model: cfg.speak.model },
  };
}

/**
 * Build the Deepgram `Settings` message from config. The think provider's key (Together
 * by default; see `resolveThinkApiKey`) is injected here, server-side only — it must never
 * reach the browser or `/config`.
 */
export function buildSettings(cfg: AgentConfig, thinkApiKey: string) {
  return {
    type: "Settings",
    // experimental:true is REQUIRED for the AgentStartedSpeaking latency event the HUD reads.
    experimental: true,
    audio: {
      input: { encoding: "linear16", sample_rate: cfg.audio.inputSampleRate },
      output: { encoding: "linear16", sample_rate: cfg.audio.outputSampleRate, container: "none" },
    },
    agent: {
      language: "en",
      listen: {
        provider: {
          type: "deepgram",
          model: cfg.listen.model,
          version: cfg.listen.version,
          // Flux-only turn-detection knobs. If you fall back to nova-3, drop these three.
          eot_threshold: cfg.listen.eotThreshold,
          eager_eot_threshold: cfg.listen.eagerEotThreshold,
          eot_timeout_ms: cfg.listen.eotTimeoutMs,
        },
      },
      think: {
        provider: { type: cfg.think.providerType, model: cfg.think.model, temperature: cfg.think.temperature },
        // Sibling of `provider`. Deepgram calls this endpoint directly over public HTTPS.
        endpoint: {
          url: cfg.think.endpointUrl,
          headers: { Authorization: `Bearer ${thinkApiKey}` },
        },
        prompt: cfg.think.prompt,
      },
      speak: { provider: { type: "deepgram", model: cfg.speak.model } },
      greeting: cfg.greeting,
    },
  };
}
