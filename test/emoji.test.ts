import { describe, expect, it } from "vitest";
import { buildAssistantMessages } from "../src/assistant/assistantPrompt.js";
import { FOOD_EMOJI_RULE, firstEmoji } from "../src/emoji.js";
import { buildExtractMessages } from "../src/extract/extractPrompt.js";
import { buildScanMessages, buildVideoScanMessages } from "../src/scan/scanPrompt.js";
import { buildSuggestMessages } from "../src/suggest/suggestPrompt.js";

const system = (messages: { content: unknown }[]) => JSON.stringify(messages[0]!.content);

describe("a food's emoji", () => {
  it("is chosen by the same rule in every prompt that names foods", () => {
    const prompts = {
      suggest: system(buildSuggestMessages("pap", "es", "CO")),
      photo: system(buildScanMessages("AAAA", "image/jpeg", "2026-10-21", "es", "CO")),
      video: system(buildVideoScanMessages([{ image: "AAAA", mimeType: "image/jpeg" }], "2026-10-21", "es", "CO")),
      dictation: system(buildExtractMessages("una papaya y cebolla larga", "2026-10-21", "es", "CO")),
      mero: system(buildAssistantMessages("añade una papaya", "2026-10-21", "es", "CO")),
    };

    for (const [name, text] of Object.entries(prompts)) {
      expect(text, name).toContain(JSON.stringify(FOOD_EMOJI_RULE).slice(1, -1));
      expect(text, name).not.toContain("exactly one emoji that pictures");
    }
  });

  it("is empty rather than a look-alike: no mango for a papaya, no bulb onion for a green onion", () => {
    expect(FOOD_EMOJI_RULE).toContain('or "" when no emoji does');
    expect(FOOD_EMOJI_RULE).toContain("papaya");
    expect(FOOD_EMOJI_RULE).toContain("green onion or scallion");
    expect(FOOD_EMOJI_RULE).toContain("🥭 is only a mango");
    expect(FOOD_EMOJI_RULE).toContain("🧅 only a bulb onion");
  });

  it("keeps only the first emoji of whatever the model wrote, and nothing when it wrote none", () => {
    expect(firstEmoji("🥭")).toBe("🥭");
    expect(firstEmoji("🌶️ hot")).toBe("🌶️");
    expect(firstEmoji("🍎🍐")).toBe("🍎");
    expect(firstEmoji("")).toBe("");
    expect(firstEmoji("papaya")).toBe("");
    expect(firstEmoji(undefined)).toBe("");
  });
});
