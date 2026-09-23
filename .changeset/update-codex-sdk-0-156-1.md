---
"codex-relay": minor
"@codex-relay/mobile": patch
---

Release codex-relay 1.6.0 with Codex SDK and bundled CLI 0.156.1, which adds GPT-6 Sol and GPT-6 Luna next to GPT-6 Astra. Codex 0.156 removed `thread/rollback`, so rewinding a chat saved in the legacy history format now explains that it can no longer be rewound instead of returning the raw app-server error. Load chat history whose images are referenced by uploaded file ID, and fall back to the GPT-6 lineup when the host model catalog is unavailable. Warn in the mobile app when the connected relay is older than 1.6.0 and show each model's Fast tier description from the Codex catalog. Deliver the mobile changes through the existing OTA release workflow for the current App Store 1.5.0 binary.
