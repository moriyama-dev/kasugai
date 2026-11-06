# Kasugai — gap analysis against the abstracted Remote - SSH design

Baseline: open-remote-ssh v0.5.1 (63b406e). Reference: [remote-ssh-abstraction.md](remote-ssh-abstraction.md).
Priority order: **1. stability of startup and long-running sessions, 2. connection speed.**

Status legend: ✅ done in Kasugai · 🔜 planned for 0.1.0 · ⏭ later

## Stability

| # | Gap in the baseline | Why it matters | Kasugai | Status |
|---|---|---|---|---|
| S1 | No SSH keepalive at all | NAT/firewall idle timeouts silently kill the session; the editor only notices much later | ssh2 keepalive, 15 s × 3 by default; `ServerAliveInterval` / `ServerAliveCountMax` from ssh_config win | ✅ |
| S2 | A dropped session is never re-established: the cached connect promise keeps pointing at the dead client, so every later tunnel connection fails until a full window reload | The editor's own reconnection (which keeps the remote extension host for up to 3 h) cannot work | Self-healing connection: on drop, background reconnect with exponential backoff (0.5 s → 15 s) for up to `kasugai.reconnectTimeout` (1 h); tunnels wait for the new session | ✅ |
| S3 | ProxyJump / ProxyCommand streams are created once and cannot be reused | Reconnect through a jump host is impossible | Every hop gets a transport *factory*; each reconnect rebuilds the chain hop by hop | ✅ |
| S4 | Auth handler state (identity list) is consumed by the first login | A reconnect would skip keys and fail auth | Fresh auth handler per attempt; keys unlocked with a passphrase are kept in memory for the window | ✅ |
| S5 | Re-resolve creates a new connection and leaks the old one with its tunnels and proxy processes | Port/process leaks; duplicate sessions | Re-resolve reuses a live session to the same host, otherwise tears the old one down first | ✅ |
| S6 | Tunnel sockets have no `error` listeners; `ProxyCommand` child has no `error` listener | A reset socket or a missing proxy binary throws an uncaught exception in the extension host | Every piped pair tears down both sides on error/close; ProxyCommand errors are logged | ✅ |
| S7 | Auth / host-key errors and transient network errors are retried the same way | Endless prompts or giving up too early | Reconnect loop stops on `client-authentication` errors only; everything else keeps retrying within the time budget | ✅ |
| S8 | No visible connection state | Users can't tell "reconnecting" from "hung" | Status bar item: reconnecting / reconnected / disconnected (click → reload) | ✅ |
| S9 | Forwarded agent socket goes stale after a reconnect | `git push` from terminals breaks after a network blip | Agent channel reopened after reconnect and terminal env updated | ✅ |
| S10 | Remote cannot download the server (air-gapped hosts) → hard failure | Common in corporate networks | Fallback: client downloads the server archive (cached locally) and uploads it over the existing SSH session | 🔜 |
| S11 | `ConnectTimeout` from ssh_config is ignored | Users can't tune per host | Per-host `ConnectTimeout` wins over `kasugai.connectTimeout` | 🔜 |
| S12 | No command to stop a stuck remote server | "Unknown reconnection token" or a wedged server needs manual `kill` | `Kasugai: Kill Server on Host` | 🔜 |
| S13 | Thin diagnostics | Hard to support users | Log the effective settings, timings of each phase, reconnect attempts | 🔜 (partly ✅) |

## Speed

| # | Gap | Kasugai | Status |
|---|---|---|---|
| P1 | Nagle's algorithm left on for the SSH socket and tunnel sockets | `setNoDelay(true)` everywhere; TCP keepalive on the transport | ✅ |
| P2 | Window reload / editor-side reconnect re-runs handshake + auth | Reuse the open session (see S5) | ✅ |
| P3 | Platform detection costs 2–3 extra SSH round trips on every connect | Remember the detected platform per host; the install script verifies it and Kasugai falls back to detection only on mismatch | 🔜 |
| P4 | Server start is polled every 0.5 s | Poll every 0.1 s | 🔜 |
| P5 | One SSH process per window (no cross-window sharing helper) | A local helper shared by windows (like the reference design) | ⏭ (larger change; after 0.1.0) |
| P6 | Exec-server bootstrap | Not applicable to VSCodium's REH server today | ⏭ |

## Product

| # | Item | Status |
|---|---|---|
| R1 | Own remote authority `kasugai-ssh`, settings `kasugai.*` (falls back to `remote.SSH.*`), commands `kasugai.*` — coexists with other SSH extensions | ✅ |
| R2 | "Report an issue" and "GitHub" commands | 🔜 |
| R3 | README (EN/JA), CHANGELOG, MIT attribution to open-remote-ssh | 🔜 |
| R4 | CI: Linux integration tests in Docker, macOS start-up test on `macos-15` (no secrets, read-only, tag/manual only) | 🔜 |
| R5 | Reconnect integration test (drop the SSH session mid-use, verify the same server is reached again) | 🔜 |
