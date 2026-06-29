# Opener jingles

The bit is now **"finish the jingle."** Speak the **start** of a famous jingle or tagline and
trail off — the agent completes it with the real line, and the HUD stamps **NAILED IT** or
**MISSED IT** depending on whether the spoken completion lands the answer.

Format per line: `- <jingle opener>… | accept, keywords`

Everything left of the `|` is the chip shown on screen and read aloud. Everything right is the
hidden **accept keywords** — if the agent's spoken completion contains any of them
(case-insensitive substring), it's a HIT. Lines with no `|` still rotate as openers but can't be
scored (use these for audience freestyle). The answer keywords never reach the browser as a
visible chip — only the matcher uses them.

The prompt that drives the completion lives in
[`config/agent.config.json`](config/agent.config.json).

- The best part of waking up is… | folgers
- Gimme a break, gimme a break… | kit kat, kitkat
- Nationwide is on… | your side
- The few, the proud, the… | marines
- Plop plop, fizz fizz, oh what a… | relief
- My bologna has a first name, it's… | oscar, o-s-c-a-r
- Nobody doesn't like… | sara lee
- Once you pop, you just can't… | stop
- The snack that smiles back,… | goldfish
- Red Bull gives you… | wings, wiiings
- Melts in your mouth, not in your… | hand
- Subway, eat… | fresh
- Meow meow meow meow,… | meow mix
- Two all-beef patties, special sauce, lettuce,… | sesame, big mac

**Stage tips:**

- Keep the accept keyword distinctive — the matcher does a plain substring check, so a generic
  word ("good", "it") will false-positive. Pick the unmistakable payoff word.
- A slightly mis-heard opener is often funnier than a clean one — the on-screen text makes the
  mishear obvious. Lean in, laugh, move on.
- Bigger model (Llama 3.3 70B Turbo) means recognition is reliable, but watch the latency HUD.
