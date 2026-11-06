# Remote - SSH (Microsoft) — Abstracted Design Notes for Kasugai

Status: research notes, compiled 2026-11-06. Target reference: `ms-vscode-remote.remote-ssh` 0.129.x (pre-release, manifest requires VS Code `^1.133.0`).

## Scope and legal boundary

This document describes **observable behavior and published configuration** of Microsoft's proprietary "Remote - SSH" extension so that Kasugai (MIT, fork of `jeanp413/open-remote-ssh`) can adopt its *ideas*. It was written **only** from public sources:

- Official docs on code.visualstudio.com (`/docs/remote/ssh`, `/troubleshooting`, `/faq`, `/linux`).
- The Marketplace listing and the **published extension manifest** (`package.json` served by the Marketplace as the `Microsoft.VisualStudio.Code.Manifest` asset). Only the declared `contributes` metadata (setting names, types, defaults, command IDs, menus) was used. The `.vsix` was **not** downloaded or unpacked and no JavaScript was read.
- Remote release notes in the public `microsoft/vscode-docs` repo (`remote-release-notes/v1_*.md`).
- Public issues and the wiki in `microsoft/vscode-remote-release` and `microsoft/vscode`.

Everything below is paraphrased. Log markers quoted in backticks are short identifiers that appear in user-posted logs in public issues; they are cited only so we can recognize equivalent phases. Where something is inferred rather than documented it is marked **(uncertain)** or **(inferred)**.

Abbreviations used for sources:

| Key | URL |
|---|---|
| DOC-SSH | https://code.visualstudio.com/docs/remote/ssh |
| DOC-TS | https://code.visualstudio.com/docs/remote/troubleshooting |
| DOC-FAQ | https://code.visualstudio.com/docs/remote/faq |
| DOC-LINUX | https://code.visualstudio.com/docs/remote/linux |
| WIKI-TS | https://github.com/microsoft/vscode-remote-release/wiki/Remote-SSH-troubleshooting |
| MKT | https://marketplace.visualstudio.com/items?itemName=ms-vscode-remote.remote-ssh |
| MANIFEST | Marketplace asset `Microsoft.VisualStudio.Code.Manifest` for `ms-vscode-remote.remote-ssh` (latest, 0.129.2026100915) |
| RN-x | https://github.com/microsoft/vscode-docs/blob/main/remote-release-notes/v1_x.md |
| I-n | https://github.com/microsoft/vscode-remote-release/issues/n |

---

## 0. Architecture at a glance

```
 Local machine (VS Code UI process)                         Remote host
 ┌──────────────────────────────────────────┐              ┌───────────────────────────────────────┐
 │ Remote-SSH extension (extensionKind: ui) │              │ ~/.vscode-server/                      │
 │  - resolver for authority "ssh-remote+X" │   ssh -T -D  │   code-<commit>   (VS Code CLI,        │
 │  - "local server" (one per host):        │──────────────│    = "exec server" / control server)   │
 │      owns the single ssh child process,  │  (SOCKS via  │   cli/servers/Stable-<commit>/server/  │
 │      shared by all windows               │   -D, or     │     (full VS Code Server, Node)        │
 │  - local TCP forwarder → SOCKS → remote  │  -L/-R)      │   lock files, *.log, *.pid / pid.txt   │
 │  - exec-server cache (per host)          │              │   extensions/                          │
 └──────────────────────────────────────────┘              └───────────────────────────────────────┘
        ▲ VS Code core: PersistentProtocol, reconnection tokens, grace time, extension-host restart
```

Key design points (each detailed below):

1. The extension is a **remote authority resolver** (`onResolveRemoteAuthority:ssh-remote` activation, `resolvers` API proposal). It returns a host/port (or managed socket) that VS Code core then speaks its own protocol over. [MANIFEST]
2. **One SSH connection per host, shared by all windows**, held by a long-lived local helper process ("local server mode", default on). [WIKI-TS, RN-39, RN-43]
3. A small bootstrap ("**exec server**", the VS Code CLI binary) is started first; it then installs/starts/locates the real server. Default since VS Code 1.88. [RN-88, WIKI-TS]
4. Traffic to the server is tunneled through SSH, normally via **dynamic (SOCKS) forwarding** on the existing SSH process, so no extra SSH sessions or password prompts are needed for new ports. [RN-37, RN-38]
5. VS Code core owns **reconnection** (token-based session resume with a server-side grace period, default 3 h). [RN-107, I-11805]

---

## 1. Connection lifecycle end to end

### 1.1 Phases (as reconstructed from public logs)

Sources: I-9553, I-9898, I-11367, I-11463, I-9599, I-10261, I-11946, WIKI-TS, DOC-TS.

1. **Resolve authority.** VS Code asks the resolver for `ssh-remote+<host>`. The log records the attempt number and whether it is a reconnection (`attempt 1` vs `attempt 2, (Reconnection)`). [I-8910]
2. **Settings dump.** All effective `remote.SSH.*` values are logged up front (very useful for support). [I-9553, I-11367]
3. **Host config lookup.** The SSH config (default `~/.ssh/config`, or `remote.SSH.configFile`) is parsed to find the host entry; parsing of large configs with many `Match` blocks was optimized in 0.117. [I-11367, RN-97]
4. **Pre-connect hook (optional).** `remote.SSH.preconnect` runs a user script before SSH (cert renewal, bastion auth, etc.). Output goes to the Remote-SSH output channel; the user must re-approve whenever the script content changes. [RN-101]
5. **Pick server build.** Commit + quality (stable/insider) of the local VS Code determine which server to install. [I-9553]
6. **Probe local ssh.** Runs `ssh -V` to identify the client (OpenSSH version, Windows OpenSSH quirks). [I-9553, I-11463]
7. **SSH connect.** Typical command line seen in logs: `ssh -v -T -D <localport> -o ConnectTimeout=15 <host> bash` (or `sh` with an inline script when bash is not required). `-T` disables PTY (can be re-enabled with `remote.SSH.permitPtyAllocation`), `-D` opens the SOCKS port used for all later forwards. [I-9553, I-11463, RN-92]
   - Authentication prompts are surfaced in VS Code via `SSH_ASKPASS` pointing back at VS Code (local server mode). `remote.SSH.externalSSH_ASKPASS` keeps the user's own askpass. [RN-68]
   - The connect timer is cleared as soon as any output arrives from the remote. [I-9553]
8. **Bootstrap script piped over stdin.** The extension writes an install/start script into the SSH session's stdin (troubleshooting step: prepend `echo "echo hello" |` to the logged ssh command to verify script piping works). [WIKI-TS]
9. **Platform/arch detection.** The script reports OS id, arch (x86_64/aarch64/armv7l), platform (linux/darwin/windows), tmp dir, and the download path for the CLI build (e.g. a static `cli-alpine-x64` CLI build is used on Linux), plus whether a download is needed. Remote OS is auto-detected (Windows/macOS/Linux) since 1.42/1.43; `remote.SSH.remotePlatform` caches/overrides the result per host. [I-9898, I-10261, RN-42, RN-43, DOC-TS]
10. **Lock.** Install is serialized per user+commit by a lock file in the install directory (`vscode-remote-lock.<user>.<commit>`), using `flock` when `remote.SSH.useFlock` (default true), with the lock optionally moved to `/tmp` (`remote.SSH.lockfilesInTmp`) for NFS/AFS homes. A second window seeing the lock logs "installation already in progress" and retries. [RN-37, I-9553, I-11946, I-8161]
11. **Reuse check.** If an installation exists ("Found existing installation"), check for a running server via its log + pid files (`.<commit>.log` / `.<commit>.pid` in legacy mode; `cli/servers/Stable-<commit>/log.txt` + `pid.txt` with exec server). If running → skip install/start. [I-9553, I-9917, WIKI-TS]
12. **Download/install (only if missing).**
    - Default (`remote.SSH.localServerDownload: "auto"`): the remote downloads the server itself with `wget`/`curl` (ignoring `~/.curlrc` / `~/.wgetrc` unless `remote.SSH.useCurlAndWgetConfigurationFiles`), optionally through `remote.SSH.httpProxy`/`httpsProxy`. [DOC-FAQ, RN-92, RN-98]
    - If that fails, the script asks the client to download the tarball locally and **push it over the existing connection**; the remote waits for the archive plus a `.done` marker, then unpacks. `"always"` skips the remote attempt; `"off"` never falls back. [DOC-FAQ, I-11946]
    - Old installs are garbage-collected: unused versions are deleted, keeping the newest few (5 at the time of RN-36). [RN-36]
13. **Start.** In exec-server mode the CLI is launched (`code-<commit> command-shell ... --on-port`), prints a `listeningOn==<addr>==` marker plus a token; an empty value means the CLI could not run (wrong arch, missing libs, noexec). The CLI then starts the full server with a connection token and socket path. In legacy mode the script starts the server directly and parses the port from its output (`Failed to parse remote port from server output` is the generic failure). [I-9599, I-9898, I-8342, I-8249]
    - Listen on random localhost TCP port by default; `remote.SSH.serverPickPortsFromRange` constrains it; `remote.SSH.remoteServerListenOnSocket` uses a per-user Unix socket instead (more secure on multi-user hosts, but disables connection multiplexing and needs `AllowStreamLocalForwarding`). [RN-63, RN-47, DOC-TS]
    - The server is protected by a random connection token readable only by the user; `/version` is unauthenticated. [DOC-TS]
14. **Tunnel.** A local forwarding server binds a local port (range: `remote.SSH.preferredLocalPortRange`, bind address: `remote.SSH.bindHost`) and relays through the SSH `-D` SOCKS port to the remote port/socket. [I-11463, I-9898, RN-92]
15. **Cache.** The exec-server handle is cached per host ("created and cached"; later windows log "Verified and reusing"). [I-11463, I-9898]
16. **Handshake.** VS Code core opens the **management** connection and the **extension host** connection over the tunnel (each with its own reconnection token), the server spawns the remote extension host, and default extensions (`remote.SSH.defaultExtensions`, `defaultExtensionsIfInstalledLocally`) are installed — by the client if the remote has no Marketplace access. [I-9898, RN-97, RN-98]

### 1.2 Two-SSH-connection legacy model vs. one-connection model

- Docs still describe the classic model: **one SSH connection to install/start the server, a second one for the port tunnel**. Load-balanced hosts that route the second connection to a different node break this; documented fix is `ControlMaster`. [DOC-TS]
- With **dynamic forwarding** (`-D`, on by default since 1.38) every later forward rides the first SSH process: fewer password prompts and slightly faster connect. [RN-37, RN-38]

### 1.3 What is cached / reused

| Thing | Reuse mechanism | Source |
|---|---|---|
| SSH transport | **Local server mode**: one ssh child per host owned by a local helper, shared by all windows and across window reloads (`remote.SSH.useLocalServer`, default true). Terminal mode (false) = one hidden-terminal ssh per window. | WIKI-TS, RN-39, RN-43 |
| SSH auth | Optional OpenSSH `ControlMaster auto` / `ControlPath` / `ControlPersist` (macOS/Linux) to multiplex across all ssh invocations. Not enabled by the extension itself — user config. | DOC-TS |
| Exec server | Cached per host with a liveness ping (reported ~3 s) before reuse. | I-11463 |
| VS Code Server process | Kept alive after windows close so the next window attaches instantly; self-shutdown after idle (10 min in RN-36; ~5 min auto-shutdown reported in I-11648 — **uncertain**, varies by version). Reconnection grace up to 3 h (configurable). | RN-36, I-11648, RN-107 |
| Server install | Per-commit directory; existing install detected and reused; old ones pruned. | RN-36, I-9553 |
| Remote platform | Remembered per host in `remote.SSH.remotePlatform`. | DOC-SSH |
| Terminals | Remote terminals survive window close/reconnect for a while and reattach (with UI split layout). | RN-51 (terminal reconnection), RN-53 (UI state restore) |
| Forwarded ports | `remote.restoreForwardedPorts` restores them; public/private state restored. | DOC-SSH |

---

## 2. Stability mechanisms

### 2.1 Reconnection model (VS Code core + resolver)

- Every connection (management + extension host) carries a **reconnection token**; on drop, core keeps the window alive, shows a subtle "reconnecting" indicator first and a modal only after a longer outage. [RN-53 ("Brief disconnect state"), I-11648]
- Core re-invokes the resolver (log: `attempt N, (Reconnection)`), then tries to resume the old session with the token. [I-8910, I-11926]
- **Grace time:** the server keeps the disconnected session (and its extension host) for a grace period, default **3 h** (`10800000ms`), then disposes it. A **short grace (5 min)** applies in some cases (e.g. when the client signalled an orderly close). `remote.SSH.reconnectionGraceTime` (seconds, per host) passes `--reconnection-grace-time` to the server; it only takes effect on a freshly started server (kill the server to apply). [RN-107, I-3477, I-11550]
- **Error classification decides whether to keep retrying.** Retryable: resolver errors flagged "temporarily not available", Node connect errors (`ETIMEDOUT`, `ENETUNREACH`, `ECONNREFUSED`, `ECONNRESET` with `syscall=connect`), cancellations. Everything else is treated as permanent → "Cannot reconnect. Please reload the window." Public bugs show this is the #1 reconnection weakness: a mid-connect socket close with a plain error, or Windows OpenSSH printing "Unknown error", ends the 3 h grace on the first attempt. The resolver classifies ssh failures by matching the last output line against a list of offline phrases ("Network is unreachable", "No route to host", "Connection timed out"...). [I-11805, I-11926]
- **"Reconnect Now"** command skips the countdown between attempts. [RN-38]
- **`remote.SSH.maxReconnectionAttempts`** (`number|null`, default `null` = unlimited; older builds logged `Number.MAX_SAFE_INTEGER`). A maintainer noted it is only checked after the first reconnection, so `0` does not disable reconnection. [MANIFEST, I-4206, I-8910]
- **Extension host crashes** are no longer shown as connection errors; the remote extension host is restarted automatically and the user is notified only after 3 crashes in 5 minutes. [RN-66]
- "Connection resilience" release: fewer reconnections under high latency/packet loss. [RN-63]
- **Unknown reconnection token**: "(never seen)" = a different server process is now running (server restarted, idle auto-shutdown fired while laptop slept, or setup script launched a fresh one); "(seen before)" = same server already disposed the session (grace expired, ext host died). Only remedy today is Reload Window; an issue asks for a "reset connection state" command. [I-11648, I-3477, I-6515]
- **Sleep/wake:** cached exec-server ping (~3 s) and a ~5 s local-server dead-man switch are too aggressive while the network recovers after wake, causing a brand-new SSH connection instead of waiting for the old one (which often would recover). [I-11463 — reporter analysis, no maintainer confirmation]
- **SSH agent after reconnect:** terminals opened before a reconnect keep a stale `SSH_AUTH_SOCK`; the extension writes the current socket path to a file referenced by `$SSH_AUTH_SOCK_LOCATION`. [RN-37, I-8170]

### 2.2 Keepalive and timeouts

- **Connect timeout:** `remote.SSH.connectTimeout` default **15 s**, passed as `-o ConnectTimeout`; a per-host `ConnectTimeout` in ssh_config takes precedence (since 1.94); `0` means maximum. [MANIFEST, RN-94, I-11667]
- **ServerAliveInterval:** No public evidence that Remote-SSH injects a default `ServerAliveInterval`; keepalive is left to the user's ssh_config **(uncertain)**. Third-party wrappers (Coder) set `ServerAliveInterval 10` / `ServerAliveCountMax 3`. [https://coder.com/docs/user-guides/workspace-access/vscode]
- Workaround documented by users for flaky links: `ConnectionAttempts` + short `ConnectTimeout` in ssh_config so ssh itself retries quickly. [I-11926]
- VS Code core has its own protocol-level keepalive between client and server independent of SSH (referenced as `_keepAliveTimeoutCheck` in I-11648) **(details uncertain)**.

### 2.3 Install/locking robustness

- Lock per user+commit; `useFlock` (default true) uses kernel `flock` so the lock is released automatically if the holder dies; `lockfilesInTmp` for network filesystems. [MANIFEST, RN-37]
- Known hole: if local download fails, the remote script can wait forever for the `.done` marker while holding the lock; every later connect says "installation already in progress". Proposed hardening: client writes `.done` without archive on failure / closes the session; remote wait loop gets a timeout and exits when its parent sshd/stdin disappears; lock takeover if the holder is waiting on a dead client. [I-11946, I-5822, I-7162, I-8161]
- Legacy remedies: delete `~/.vscode-server/bin/<commit>/vscode-remote-lock.*`, or kill the process holding it (`fuser`). [I-6869, I-11946]

### 2.4 Server lifecycle management

- **Kill VS Code Server on Host...** stops server processes for the current user (and per the wiki also removes server files); **Uninstall VS Code Server from Host...** stops and deletes the install folder. Manifest commands: `cleanCurrentRemoteServer`, `cleanRemoteServer`, `cleanDevBox`, `cleanLocalServer` (the last one kills the local connection helper; exact title mapping **inferred**). [DOC-TS, WIKI-TS, MANIFEST]
- Server never installs itself into login/startup scripts; VS Code starts and stops it. [DOC-FAQ]
- `remote.SSH.serverInstallPath`: per-host install root (e.g. avoid full/slow `$HOME`). [RN-63]
- Server runs as the logged-in user; no extra ports opened beyond SSH. [DOC-FAQ]

---

## 3. Speed mechanisms

| Mechanism | Effect | Source |
|---|---|---|
| Local server mode (connection sharing) | One ssh per host for all windows/reloads → no re-auth, faster new windows. Default on (Windows default historically off; check). | RN-39, RN-43, WIKI-TS |
| Dynamic forwarding (`-D` SOCKS) | Extra forwards (server tunnel, user ports) reuse the same SSH session → no new handshakes; noted as "a little faster connecting". | RN-37, RN-38 |
| Exec server / CLI bootstrap | Small static CLI started first; it handles install/start/reuse, also enables Dev Containers/WSL over SSH; cached per host. | RN-88, WIKI-TS, I-11463 |
| Reuse running server | Detected via pid/log files → skip download and start entirely on reconnect/new window. | I-9553, I-9898 |
| Remote-first download, local fallback | Remote usually has the faster/closer network; local download only when needed (`"always"` for air-gapped hosts). | DOC-FAQ |
| Keep server warm | Server idles after last window closes so the next connect is instant. | RN-36 |
| SSH config parsing optimization | Faster for configs with many `Match` blocks. | RN-97 |
| ControlMaster (user-side) | Multiplex every ssh invocation including ones outside the local server. | DOC-TS |
| Remembered platform | Skip OS detection prompt next time. | DOC-SSH |
| Client-side install of default extensions | Avoids slow/failing marketplace access from remote. | RN-98 |

Notes: `remote.SSH.enableDynamicForwarding` default **true**; `remote.SSH.useLocalServer` default **true**; `remote.SSH.useExecServer` default **true** (all from MANIFEST). No public evidence of explicit parallel download of server + extensions **(uncertain)**.

---

## 4. Full list of `remote.SSH.*` settings

Defaults are from MANIFEST (0.129.x) unless noted. Purpose lines are paraphrased from docs/release notes/issues because the manifest's descriptions are localized keys not included in the manifest asset.

### 4.1 Connection & transport
| Setting | Default | Purpose |
|---|---|---|
| `remote.SSH.path` | `""` | Path to the ssh binary if not on PATH (Git for Windows ssh is also auto-discovered). [RN-36] |
| `remote.SSH.configFile` | `""` | Use a specific ssh config file instead of the default ones. [DOC-SSH] |
| `remote.SSH.connectTimeout` | `15` | Seconds for SSH connect; per-host `ConnectTimeout` wins. [RN-94] |
| `remote.SSH.useLocalServer` | `true` | Share one ssh process per host across windows (vs per-window hidden terminal). [WIKI-TS] |
| `remote.SSH.useExecServer` | `true` | Bootstrap via minimal exec/control server (CLI) before the full server. [WIKI-TS, RN-88] |
| `remote.SSH.enableDynamicForwarding` | `true` | Use `ssh -D` SOCKS on the main connection for tunnels. [RN-37/38] |
| `remote.SSH.enableAgentForwarding` | `true` | Honor `ForwardAgent` and keep agent usable in remote terminals. [RN-37/38] |
| `remote.SSH.enableX11Forwarding` | `true` | Honor `ForwardX11` for programs started from terminals/tasks/debuggers. [RN-54] |
| `remote.SSH.enableRemoteCommand` | `false` | Allow `RemoteCommand` from ssh_config (needs local server mode). [RN-64] |
| `remote.SSH.permitPtyAllocation` | `false` | Drop `-T` from the ssh command (workaround for some hosts). [RN-92, I-7558] |
| `remote.SSH.showLoginTerminal` | `false` | Show the terminal running ssh (for interactive auth/debug). [DOC-TS] |
| `remote.SSH.externalSSH_ASKPASS` | `false` | Keep the user's own `SSH_ASKPASS` rather than VS Code's. [RN-68] |
| `remote.SSH.preconnect` | `""` | Script (global or per-host map) run before connecting. [RN-101] |
| `remote.SSH.bindHost` | `null` | Per-host local bind address for the forwarding listener **(purpose inferred from name)**. [MANIFEST] |
| `remote.SSH.preferredLocalPortRange` | `""` | Local port range for forwarding; tried sequentially, fail if none free. [RN-92] |
| `remote.SSH.defaultForwardedPorts` | `[]` | Ports to forward automatically on connect **(inferred from name)**. [MANIFEST] |
| `remote.SSH.suppressWindowsSshWarning` | `false` | Hide warning about problematic Windows ssh client **(inferred)**. [MANIFEST] |

### 4.2 Server install & runtime
| Setting | Default | Purpose |
|---|---|---|
| `remote.SSH.serverInstallPath` | `null` (`{}`) | Map host → absolute install root. [RN-63] |
| `remote.SSH.serverPickPortsFromRange` | `null` | Map host → remote port range for the server. [RN-63] |
| `remote.SSH.remoteServerListenOnSocket` | `false` | Server listens on per-user Unix socket instead of TCP port. [RN-47, DOC-TS] |
| `remote.SSH.localServerDownload` | `"auto"` (`auto`/`always`/`off`) | Where the server tarball is downloaded. [DOC-FAQ] |
| `remote.SSH.allowLocalServerDownload` | `true` | Older boolean predecessor of `localServerDownload` **(inferred, likely deprecated)**. [MANIFEST] |
| `remote.SSH.useCurlAndWgetConfigurationFiles` | `false` | Let remote curl/wget read rc files (e.g., proxy). [RN-92] |
| `remote.SSH.httpProxy` / `httpsProxy` | `""` | Proxy (global string or per-host map) exported during install/launch. [RN-98] |
| `remote.SSH.useFlock` | `true` | Use `flock` for install lock. [MANIFEST, I-9553] |
| `remote.SSH.lockfilesInTmp` | `false` | Put lock files in `/tmp` (NFS/AFS homes). [RN-37] |
| `remote.SSH.reconnectionGraceTime` | `null` (server default 3 h) | Per-host seconds the server keeps a disconnected session. [RN-107] |
| `remote.SSH.maxReconnectionAttempts` | `null` (unlimited) | Cap on reconnection attempts (buggy semantics, see 2.1). [I-8910] |
| `remote.SSH.defaultExtensions` | `null` | Extensions always installed on any SSH host. [DOC-SSH] |
| `remote.SSH.defaultExtensionsIfInstalledLocally` | (not in current manifest list; seen in logs as `[]`) | Install on remote only if installed locally. [RN-97, I-11367] |

### 4.3 Platform
| Setting | Default | Purpose |
|---|---|---|
| `remote.SSH.remotePlatform` | `null` | Map host → `linux`/`windows`/`macOS`; remembered after detection or manual pick. [DOC-SSH, DOC-TS] |
| `remote.SSH.windowsRemotes` | `[]` | Legacy list of Windows hosts (superseded by auto-detect). [RN-39, RN-42] |

### 4.4 Diagnostics & misc
| Setting | Default | Purpose |
|---|---|---|
| `remote.SSH.logLevel` | `"debug"` (`debug`/`trace`) | Output channel verbosity. [MANIFEST] |
| `remote.SSH.experimental.enhancedSessionLogs` | `true` | Detect known issue classes and show summary + suggested fixes. [RN-96] |
| `remote.SSH.experimental.chat` | `true` | `@remote-ssh` chat participant for troubleshooting. [RN-96] |
| `remote.SSH.foldersSortOrder` | — | Sort SSH targets alphabetically or by recency (likely moved to Remote Explorer ext; **uncertain**). [RN-62] |
| `remote.SSH.enableWebAccess` | — | Referenced only in a menu `when` clause (gates "open web UI"); not declared **(uncertain)**. [MANIFEST] |

Related non-`remote.SSH` settings: `remote.restoreForwardedPorts`, `remote.autoForwardPortsSource` (default `output` for SSH), `remote.extensionKind`, `remote-explorer.collapseRecentFolders`. [DOC-SSH, RN-54, RN-56, RN-101]

---

## 5. Reliability UX

- **Progress notification** during connect with a "details" link that opens the Remote-SSH output channel (standard VS Code remote UX; phases visible in the log). [DOC-TS, WIKI-TS]
- **Output channel "Remote - SSH"** structure (from public logs): header (log level, VS Code & extension versions, local platform) → resolver call with attempt number → full settings dump → host config lookup → ssh version → exact ssh command line (`Running ssh connection command`) → remote script output with structured markers (platform, arch, `listeningOn`, tokens) → forwarding setup → exec server cached → timings. Users are told to copy the logged ssh command and run it in a terminal. [WIKI-TS, I-9553, I-11367]
- **Server-side logs**: legacy `~/.vscode-server/.<hash>.log`; exec server `~/.vscode-server/cli/servers/*/log.txt`; path is printed in the client log. [WIKI-TS]
- **Enhanced session logs**: automatic diagnosis of known failure classes with suggested remedies; `clearAllSessionHints` command. [RN-96, MANIFEST]
- **Commands** (manifest IDs): `showLog`, `openConfigFile`, `addNewSshHost`, `openEmptyWindow` (Connect to Host), `openEmptyWindowInCurrentWindow`, `openEmptyWindowOnCurrentHost`, `cleanCurrentRemoteServer` / `cleanRemoteServer` / `cleanDevBox` (kill/uninstall server), `cleanLocalServer` (only visible when local server mode on), `reportIssue`, `getHelp`, `getStarted`, `settings`, `provideFeedback`. Commands are context-gated on `remoteConnectionState == connected/disconnected`. [MANIFEST]
- **Status bar remote indicator** (bottom-left): shows host, opens the remote command menu; Remote-SSH contributes connect/open-window items. [DOC-SSH, MANIFEST]
- **Remote Explorer** (separate `ms-vscode.remote-explorer` extension in the pack): SSH targets from config, recent folders per host, add host, open in current/new window, welcome view when no hosts; Ports view for forwarded ports. [DOC-SSH, RN-49, RN-101, MANIFEST]
- **Remote help** contributions (get started / docs / feedback / issues links) for the "Help and feedback" view. [MANIFEST]
- **Prerequisite warning popup** when glibc/libstdc++ too old, instead of a cryptic failure. [RN-39]
- **Password prompts in-editor** via askpass; fewer prompts thanks to shared connection. [RN-36, RN-37]

---

## 6. Top failure modes and documented remedies

| # | Symptom | Cause / remedy | Source |
|---|---|---|---|
| 1 | "Cannot reconnect. Please reload the window." after short outage/VPN drop | Transient error misclassified as permanent → grace abandoned. Harden classifier; ssh_config `ConnectionAttempts` + low `ConnectTimeout` as workaround. | I-11805, I-11926, I-3477, I-6515 |
| 2 | "Unknown reconnection token" | Server restarted/idle-shutdown while client asleep, or session grace expired. Reload window; raise grace time; a reset-state command requested. | I-11648, I-8943, I-3477 |
| 3 | Disconnect after laptop sleep/wake | Over-eager liveness checks (3 s ping, 5 s dead-man) → new connection which times out. | I-11463 |
| 4 | Stuck at "Acquiring lock" / "installation already in progress" | Stale/orphaned lock holder (esp. after failed local download); NFS. Kill holder, delete lock, `lockfilesInTmp`, `useFlock`. | I-11946, I-5822, I-7162, I-8161, I-6869, RN-37 |
| 5 | Hang at "Checking for a running server" / "Looking for server with pid" | Process probing hangs (e.g. `ps` reading `/proc`), firewall. Uninstall server, toggle exec server. | I-9553 |
| 6 | "Connecting with SSH timed out" while terminal ssh works | Auth prompts not answered, slow MFA, ProxyCommand; raise `connectTimeout`, `showLoginTerminal`, toggle `useLocalServer`/`useExecServer`. | I-7423, I-5611, I-10651, I-11667, WIKI-TS |
| 7 | "Failed to parse remote port from server output" / empty `listeningOn` | Server/CLI failed to start: wrong arch, missing libs, `/tmp` noexec, old tar, disk full. Read server log; kill/uninstall server; toggle exec server. | I-8249, I-5111, I-7673, I-9599, I-8342, I-8926, DOC-TS |
| 8 | "The process tried to write to a nonexistent pipe" (Windows) | Generic symptom of ssh already dead; look at preceding lines; try another ssh client via `remote.SSH.path`. | I-977, I-845, I-5723 |
| 9 | "open failed: administratively prohibited" | `AllowTcpForwarding no` on sshd (or `AllowStreamLocalForwarding` for socket mode). | DOC-TS |
| 10 | Server download fails (no internet / proxy) | Use `localServerDownload: always`, `httpProxy`/`httpsProxy`, `useCurlAndWgetConfigurationFiles`. | DOC-FAQ, RN-92, RN-98 |
| 11 | Unsupported host (old glibc/libstdc++, Alpine, 32-bit ARM after 1.122) | Prereq check + friendly message; unsupported sysroot/patchelf workaround via `VSCODE_SERVER_CUSTOM_GLIBC_*`. | DOC-LINUX, DOC-FAQ, RN-97, RN-98, RN-122 |
| 12 | Shell startup files break install (output in rc files, exec'ing another shell, zsh) | Don't print/exec in non-interactive rc; use `chsh`; zsh fix in 0.76. | DOC-TS, RN-65 |
| 13 | Load-balanced host: second connection lands elsewhere | Use ControlMaster (or single-connection mode). | DOC-TS |
| 14 | Repeated password/2FA prompts | Local server mode; dynamic forwarding; key auth; ControlMaster. | WIKI-TS, RN-37, DOC-TS |
| 15 | Exec-server-specific regressions (localhost-only bind behind proxy, wrong distro detection, missing icons, agent differences) | Toggle `useExecServer`; keep legacy path as fallback. | I-9713, I-10772, I-11839, I-10939 |
| 16 | Disconnects at fixed interval (~20 s) | Unresolved; some fixed by disabling exec server; check middleboxes/keepalive. | I-10987 |
| 17 | Wrong platform detected (Windows OpenSSH) | `remotePlatform` override, `useLocalServer: false`; fixed in newer Win32-OpenSSH. | DOC-TS |
| 18 | Agent missing in terminals after reconnect | Stale `SSH_AUTH_SOCK`; refresh from `$SSH_AUTH_SOCK_LOCATION`. | RN-37, I-8170 |

---

## 7. Implications for Kasugai (inferred recommendations)

1. **Single shared SSH transport per host** (local helper process) with SOCKS `-D` forwarding; keep a terminal-mode fallback.
2. **Bootstrap with a small exec/control process**, cache it per host, but make liveness checks tolerant (backoff, longer timeouts after resume from sleep; don't kill a recovering connection after 3–5 s).
3. **Reconnection: treat everything as retryable while the grace window lasts**, except clear auth failures (`Permission denied`, host-key mismatch). Expose `reconnectionGraceTime` (pass `--reconnection-grace-time` to the server — this is exactly open-remote-ssh issue #396) and a working `maxReconnectionAttempts` (0 = off).
4. **Detect "Unknown reconnection token" and offer a one-click reset** (re-resolve with fresh tokens) instead of forcing a window reload.
5. **Install locking**: `flock` + lock in `/tmp` option; every remote wait loop must have a timeout and exit when stdin/parent sshd dies; client must signal failure (`.done` without archive); allow lock takeover from a dead holder.
6. **Fast path on reconnect**: check running server (pid + log + port) first; skip download/unpack.
7. **Remote-first download with local fallback**, proxy settings, ignore rc files by default.
8. **Logging**: settings dump, exact ssh command, structured markers, attempt numbers, timings, server log path; plus a rules-based "known issue" hint layer.
9. **Commands**: Kill server on host, Uninstall server, Kill local connection helper, Show log, Reconnect now.
10. **Honor ssh_config** (`ConnectTimeout`, `ConnectionAttempts`, `ServerAliveInterval`, `ControlMaster`) rather than overriding; document recommended keepalive values.
