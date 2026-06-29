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

/** Deepgram Voice Agent WebSocket. Auth via `Authorization: Token <DEEPGRAM_API_KEY>`. */
export const DG_AGENT_URL = "wss://agent.deepgram.com/v1/agent/converse";

export type AgentConfig = {
  audio: { inputSampleRate: number; outputSampleRate: number };
  listen: { model: string; version: string; eotThreshold: number; eagerEotThreshold: number; eotTimeoutMs: number };
  think: { providerType: string; model: string; endpointUrl: string; temperature: number; prompt: string };
  speak: { model: string };
  greeting: string;
  hud: { feelsInstantThresholdMs: number; axisMaxMs: number; rollingHistory: number };
};

/** Re-read on every connection so rehearsal tweaks land on the next reconnect, no restart. */
export function loadConfig(): AgentConfig {
  return JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as AgentConfig;
}

/**
 * Build the Deepgram `Settings` message from config. The Together key is injected
 * here, server-side only — it must never reach the browser or `/config`.
 */
export function buildSettings(cfg: AgentConfig, togetherApiKey: string) {
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
          headers: { Authorization: `Bearer ${togetherApiKey}` },
        },
        prompt: cfg.think.prompt,
      },
      speak: { provider: { type: "deepgram", model: cfg.speak.model } },
      greeting: cfg.greeting,
    },
  };
}
