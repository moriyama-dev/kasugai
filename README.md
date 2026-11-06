# Kasugai — Remote SSH

<img src="resources/icon.png" width="96" align="right" alt="Kasugai icon">

**Stable, fast SSH remote development for VSCodium and VS Code.**

A *kasugai* (鎹) is the iron staple Japanese carpenters drive across two timbers so they never come apart. Kasugai does the same for your editor and your server: it keeps the connection together through Wi-Fi changes, sleeping laptops and flaky VPNs. When the network comes back, your session picks up where it left off.

[日本語の説明はこちら](README.ja.md)

## Why Kasugai

### Stability first

- **Reconnects by itself.** When the SSH connection drops, Kasugai keeps re-establishing it in the background, waiting longer between tries (from 0.5 s up to 15 s), for up to an hour. Your remote session survives: open editors, terminals and the extension host carry on.
- **Notices a dead link quickly.** SSH keepalives every 15 s, so a silently broken connection is detected within about 45 s instead of hanging. `ServerAliveInterval` / `ServerAliveCountMax` from your SSH config are honoured.
- **Works through jump hosts.** When it reconnects, it rebuilds `ProxyJump` chains and `ProxyCommand` processes hop by hop.
- **Asks once.** Private keys you unlocked with a passphrase stay unlocked in memory for the window, so a reconnect doesn't prompt again. A forwarded SSH agent is re-attached after a reconnect.
- **Never takes the editor down.** Network errors on forwarded connections and a failing `ProxyCommand` are handled instead of crashing the extension host.
- **Shows what's happening.** The status bar shows *reconnecting…*, *reconnected* or *disconnected*. The log records every drop, every retry and the duration of each step.
- **Hosts without internet access.** If the host cannot download the server, Kasugai downloads it on your machine and uploads it over SSH (`kasugai.localServerDownload`).
- **Unstick a host.** `Kasugai: Kill Server on Host...` stops a wedged remote server and starts a fresh one.

### Then speed

- **Instant reloads.** Reloading the window or reconnecting reuses the open SSH session. No new handshake or login, and the running server is found again in tens of milliseconds.
- **Fewer round trips.** Each host's platform is remembered and re-checked inside the install script instead of being detected again on every connection.
- **Low-latency forwarding.** `TCP_NODELAY` on the SSH socket and every forwarded connection, so keystrokes and language-server messages aren't held back by Nagle's algorithm.
- **Quicker start.** Server readiness is polled every 100 ms.

## Install

| Editor | How |
|---|---|
| **VSCodium** | Download `kasugai-ssh-<version>.vsix` from [GitHub Releases](https://github.com/moriyama-dev/kasugai/releases) and run `codium --install-extension kasugai-ssh-<version>.vsix`. (Publishing on Open VSX is in progress.) |
| **VS Code** | Download `kasugai-ssh-<version>.vsix` from [GitHub Releases](https://github.com/moriyama-dev/kasugai/releases) and run `code --install-extension kasugai-ssh-<version>.vsix`. (The VS Code Marketplace does not accept extensions that need the API described below.) |

### Updates

Editors only update extensions that come from their store, so Kasugai updates itself: once a day it checks [GitHub Releases](https://github.com/moriyama-dev/kasugai/releases) and offers a new version. Choose **Update**: it downloads the `.vsix`, verifies it against the release's `SHA256SUMS` and installs it. Then reload the window. You can also run **Kasugai: Check for Updates...**, or turn the check off with `"kasugai.updateCheck": "off"`.

### One-time setup

Remote windows depend on an editor API that VSCodium and VS Code only enable for extensions listed in `argv.json`. **On first start, Kasugai offers to add itself there for you.** Choose *Enable Kasugai*, then quit and restart the editor (reloading the window is not enough).

To do it by hand, run **Preferences: Configure Runtime Arguments**, add the following and restart:

```jsonc
{
    "enable-proposed-api": ["moriyama-dev.kasugai-ssh"]
}
```

## Use

- **Kasugai: Connect to Host...** (also in the remote indicator at the bottom left) opens a remote window. Hosts come from your `~/.ssh/config`.
- The **Remote Explorer** lists your SSH hosts and recently opened folders under *SSH Targets (Kasugai)*.
- **Kasugai: Show Log** shows the connection log.
- **Kasugai: Kill Server on Host...** restarts a stuck remote server.
- **Kasugai: Check for Updates...** looks for a new release on GitHub.
- **Kasugai: Report an Issue** / **Kasugai: Open on GitHub**: send feedback (also in the *SSH Targets* view menu).

Kasugai uses its own remote type (`kasugai-ssh`), so it can be installed next to other SSH remote extensions without conflict.

## SSH host requirements

- Linux (x86_64, ARMv7l, ARMv8l/AArch64, ppc64le, riscv64, s390x, loong64), macOS, FreeBSD, Windows 10+
- `AllowTcpForwarding yes` in the server's `sshd_config`
- Alpine Linux needs `bash` and `libstdc++` (`apk add bash libstdc++`)

## Settings

| Setting | Default | Purpose |
|---|---|---|
| `kasugai.keepAliveInterval` | `15` | Seconds between keepalives. `0` disables them. `ServerAliveInterval` in your SSH config wins. |
| `kasugai.keepAliveCountMax` | `3` | Unanswered keepalives before reconnecting. `ServerAliveCountMax` wins. |
| `kasugai.reconnectTimeout` | `3600` | Seconds to keep trying to reconnect. `0` disables automatic reconnection. |
| `kasugai.connectTimeout` | `60` | Seconds allowed for connecting and logging in. |
| `kasugai.updateCheck` | `notify` | Check GitHub Releases once a day and offer updates. `off` disables it. |
| `kasugai.localServerDownload` | `auto` | `auto`: download on the host, fall back to this machine. `always`: always download here and upload. `off`: host only. |
| `kasugai.configFile` | | Custom SSH config file. |
| `kasugai.verifyUnknownHosts` / `kasugai.verifyKnownHosts` | `ask` / `reject` | Host key checking policy. |
| `kasugai.enableAgentForwarding` | `true` | Honour `ForwardAgent` from the SSH config. |
| `kasugai.enableDynamicForwarding` | `true` | Use SSH dynamic forwarding for port tunnels. |
| `kasugai.remoteServerListenOnSocket` | `false` | Server listens on a Unix socket instead of a port. |
| `kasugai.serverInstallPath` | `{}` | Per-host server install directory (wildcards allowed). |
| `kasugai.defaultExtensions` | `[]` | Extensions to install on every host. |
| `kasugai.remotePlatform` | `{}` | Force the platform of a host (`linux`, `macos`, `windows`). |
| `kasugai.serverDownloadUrlTemplate`, `kasugai.serverVersion`, `kasugai.serverValidation`, `kasugai.serverBinaryName` | | Which server release to install. See below. |

**Coming from another SSH remote extension?** Any of these you already set as `remote.SSH.<name>` are picked up automatically as long as the `kasugai.<name>` counterpart is not set.

### Which server is installed

Kasugai always runs the open-source VSCodium remote server.

- In **VSCodium** it installs the release that matches your editor, in `~/.vscodium-server`.
- In **VS Code** and other builds it installs the closest VSCodium release for your editor version and aligns its commit (`serverVersion: closest`, `serverValidation: force`). It keeps that install in **`~/.kasugai-server`**, so it never mixes with servers that other extensions keep in `~/.vscode-server`.

## Troubleshooting

1. Run **Kasugai: Show Log**. Each connection logs how long each step took, and every drop and reconnect is listed.
2. If the window says the server cannot be reached after a long outage, run **Kasugai: Kill Server on Host...**.
3. Behind a firewall without internet on the host, set `kasugai.localServerDownload` to `always`.
4. Make sure `AllowTcpForwarding` is enabled on the server.

Guides: [jump hosts](docs/jump-hosts.md), [GSSAPI / Kerberos](docs/gssapi-kerberos-authentication.md).

## Feedback

Found a problem or have an idea? Use **Kasugai: Report an Issue** or open an issue on [GitHub](https://github.com/moriyama-dev/kasugai/issues). Please remove host names and user names from logs before posting.

## Credits and license

Kasugai is based on [open-remote-ssh](https://github.com/jeanp413/open-remote-ssh) by jeanp413 and its contributors, and is released under the same [MIT License](LICENSE.txt). The design notes behind the stability work are in [docs/design](docs/design).

Kasugai is an independent project and is not affiliated with Microsoft or the VSCodium project.
