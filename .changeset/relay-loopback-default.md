---
"codex-relay": minor
---

Listen on 127.0.0.1 by default instead of every network interface. Tailscale (userspace networking) and the public tunnel still reach the relay; set `HOST=0.0.0.0` to pair phones over the same Wi-Fi.
