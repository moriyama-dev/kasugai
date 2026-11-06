# Kasugai（鎹）— Remote SSH

<img src="resources/icon.png" width="96" align="right" alt="Kasugai のアイコン">

**VSCodium と VS Code のための、切れにくく速い SSH リモート開発の拡張機能です。**

鎹（かすがい）は、2本の木材をまたいで打ち込み、離れないようにする金具です。Kasugai は、エディターとサーバーのつながりを同じように保ちます。Wi-Fi が切り替わっても、ノートパソコンがスリープしても、VPN が不安定でも、ネットワークが戻れば作業の続きから再開できます。

[English README](README.md)

## 特徴

### 一番は安定性

- **切れても自分でつなぎ直す**：SSH の接続が切れると、裏で自動的に再接続を続けます。待ち時間を 0.5 秒から 15 秒まで少しずつ延ばしながら、最大 1 時間試します。開いているエディター、ターミナル、リモートの拡張機能はそのまま続きから使えます。
- **切断にすばやく気づく**：15 秒ごとに定期通信（KeepAlive）を送るので、黙って切れた接続にも約 45 秒で気づきます。SSH の設定ファイルにある `ServerAliveInterval` と `ServerAliveCountMax` も使います。
- **踏み台サーバー越しでも同じ**：`ProxyJump` や `ProxyCommand` を使っていても、つなぎ直すときに経路を1段ずつ作り直します。
- **パスワードを何度も聞かない**：パスフレーズで開いた秘密鍵は、ウィンドウを開いているあいだメモリーに保ちます。再接続のたびに聞き直しません。SSH エージェントの転送もつなぎ直します。
- **エディターを落とさない**：転送中の通信エラーや `ProxyCommand` の失敗が起きても、拡張機能を動かす処理（拡張ホスト）が止まらないようにしています。
- **状態が見える**：ステータスバーに「再接続中」「再接続しました」「切断」を表示します。ログには、切断と再接続の試行のすべてと、各手順にかかった時間を記録します。
- **インターネットにつながらないサーバーでも使える**：サーバー側でダウンロードできないときは、手元でダウンロードして SSH で送り込みます（`kasugai.localServerDownload`）。
- **固まったサーバーを直せる**：`Kasugai: Kill Server on Host...` で、リモートのサーバーを止めて新しく起動し直します。

### 次に速さ

- **再読み込みが一瞬**：ウィンドウを再読み込みしたときや再接続のときは、開いている SSH の接続を使い回します。ログインし直さず、動いているサーバーを数十ミリ秒で見つけます。
- **通信の往復を減らす**：ホストごとに OS と CPU の種類を覚えておき、毎回の調査を省きます（違っていればその場で調べ直します）。
- **入力の遅れを減らす**：SSH と転送のすべての通信で `TCP_NODELAY` を有効にし、キー入力などの小さなデータを待たせずに送ります。
- **起動の確認を早く**：サーバーが起動したかを 0.1 秒ごとに確認します。

## インストール

| エディター | 方法 |
|---|---|
| **VSCodium** | [GitHub Releases](https://github.com/moriyama-dev/kasugai/releases) から `kasugai-ssh-<版>.vsix` をダウンロードし、`codium --install-extension kasugai-ssh-<版>.vsix` を実行します。（Open VSX への公開は準備中です） |
| **VS Code** | [GitHub Releases](https://github.com/moriyama-dev/kasugai/releases) から `kasugai-ssh-<版>.vsix` をダウンロードし、`code --install-extension kasugai-ssh-<版>.vsix` を実行します。（下で説明する特別な API を使う拡張機能は、VS Code Marketplace には載せられないためです） |

Windows・macOS・Linux（Ubuntu を含む）のどれでも、同じように使えます。SSH の接続には OS に入っている `ssh` コマンドを使います。macOS と Windows 10/11 には最初から入っています。Ubuntu では `openssh-client` パッケージに入っています（`ssh` が無いときは `sudo apt install openssh-client`）。

**一番簡単な方法（どの OS でも同じ）**：[最新のリリース](https://github.com/moriyama-dev/kasugai/releases/latest)から `kasugai-ssh-<版>.vsix` をダウンロードします。エディターで拡張機能ビューを開き（<kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>X</kbd>、macOS は <kbd>Cmd</kbd>+<kbd>Shift</kbd>+<kbd>X</kbd>）、上の「…」メニューから **Install from VSIX...**（VSIX からのインストール）を選んで、ダウンロードしたファイルを指定します。そのあと下の「[最初に一度だけ必要な設定](#最初に一度だけ必要な設定)」をします。以後の更新は Kasugai が自分で知らせます（「[更新](#更新)」）。

**コマンド1行で入れる方法**：VSCodium は `codium`、VS Code は `code` を使います。

macOS と Ubuntu（ターミナル）：

```sh
url=$(curl -fsSL https://api.github.com/repos/moriyama-dev/kasugai/releases/latest | grep -o 'https://[^"]*\.vsix' | head -n 1) && curl -fsSL -o /tmp/kasugai-ssh.vsix "$url" && codium --install-extension /tmp/kasugai-ssh.vsix --force
```

Windows（PowerShell）：

```powershell
$u = (Invoke-RestMethod https://api.github.com/repos/moriyama-dev/kasugai/releases/latest).assets | Where-Object name -like '*.vsix' | Select-Object -First 1 -ExpandProperty browser_download_url; Invoke-WebRequest $u -OutFile "$env:TEMP\kasugai-ssh.vsix"; codium --install-extension "$env:TEMP\kasugai-ssh.vsix" --force
```

`codium` や `code` が見つからないとき：macOS では、エディターで <kbd>Cmd</kbd>+<kbd>Shift</kbd>+<kbd>P</kbd> を押して **Shell Command: Install 'codium' command in PATH**（VS Code は **'code'**）を実行し、ターミナルを開き直します。Windows では、エディターを入れたあとに PowerShell を開き直します。Ubuntu では .deb・Snap・apt で入れた場合はコマンドも入ります。.tar.gz 版の場合は、フォルダー内の `bin/codium` か `bin/code` を使います。

### 更新

エディターが自動で更新するのは、ストアから入れた拡張機能だけです。そこで Kasugai は、自分で更新を確認します。1日に1回 [GitHub Releases](https://github.com/moriyama-dev/kasugai/releases) を確認し、新しい版があれば通知します。「Update」を押すと、.vsix をダウンロードし、リリースに付いている `SHA256SUMS` と照らし合わせて壊れていないことを確かめてから、インストールします。そのあとウィンドウを再読み込みしてください。**Kasugai: Check for Updates...** で手動でも確認できます。確認を止めるには `"kasugai.updateCheck": "off"` にします。

### 最初に一度だけ必要な設定

リモートのウィンドウを開くには、エディターの特別な API が必要です。VSCodium と VS Code は、`argv.json` に書かれた拡張機能にだけこの API を許可します。**Kasugai を初めて起動すると、この設定を自動で書き込むかどうかを聞いてきます。**「Enable Kasugai」を選んだら、エディターを一度終了して起動し直してください（ウィンドウの再読み込みでは足りません）。

手作業で設定する場合は、**Preferences: Configure Runtime Arguments** を実行し、次を追加してから再起動します。

```jsonc
{
    "enable-proposed-api": ["moriyama-dev.kasugai-ssh"]
}
```

## 使い方

- **Kasugai: Connect to Host...**（左下のリモートボタンからも選べます）で、リモートのウィンドウを開きます。ホストの一覧は `~/.ssh/config` から読み込みます。
- **リモート エクスプローラー**の「SSH Targets (Kasugai)」に、ホストと最近開いたフォルダーが並びます。
- **Kasugai: Show Log**：接続のログを表示します。
- **Kasugai: Kill Server on Host...**：固まったリモートのサーバーを起動し直します。
- **Kasugai: Check for Updates...**：GitHub に新しい版がないか確認します。
- **Kasugai: Report an Issue** / **Kasugai: Open on GitHub**：問題の報告と GitHub のページです（「SSH Targets」ビューのメニューにもあります）。

Kasugai は独自のリモートの種類（`kasugai-ssh`）を使います。ほかの SSH リモート拡張機能と一緒に入れても、ぶつかりません。

## 設定

主な設定は次のとおりです。すべての設定は [README.md](README.md#settings) にあります。

| 設定 | 既定値 | 内容 |
|---|---|---|
| `kasugai.keepAliveInterval` | `15` | 定期通信の間隔（秒）。`0` で送りません。 |
| `kasugai.keepAliveCountMax` | `3` | 何回応答がなければ切断とみなして再接続するか。 |
| `kasugai.reconnectTimeout` | `3600` | 再接続を試し続ける時間（秒）。`0` で自動再接続をしません。 |
| `kasugai.localServerDownload` | `auto` | `auto`：まずサーバー側でダウンロードし、だめなら手元から送る。`always`：いつも手元から送る。`off`：サーバー側だけ。 |

**ほかの SSH リモート拡張機能から乗り換える場合**：`remote.SSH.<名前>` に設定済みの値は、対応する `kasugai.<名前>` を設定していなければ、そのまま使います。

### VS Code で使う場合

Kasugai は、オープンソースの VSCodium のリモートサーバーを使います。VS Code では、エディターの版に一番近い VSCodium のサーバーを入れ、コミットを合わせて動かします。インストール先は **`~/.kasugai-server`** で、ほかの拡張機能が使う `~/.vscode-server` とは混ざりません。

## 困ったとき

1. **Kasugai: Show Log** でログを確認します。
2. 長く切れていたあとに「サーバーにつながらない」と出たら、**Kasugai: Kill Server on Host...** を実行します。
3. サーバーがインターネットにつながらない環境では、`kasugai.localServerDownload` を `always` にします。
4. サーバーの `sshd_config` で `AllowTcpForwarding yes` になっているか確認します。

## 問題の報告

不具合や要望は **Kasugai: Report an Issue** か [GitHub の Issues](https://github.com/moriyama-dev/kasugai/issues) からお知らせください。ログを貼るときは、ホスト名やユーザー名を消してください。

## クレジットとライセンス

Kasugai は、jeanp413 さんと協力者による [open-remote-ssh](https://github.com/jeanp413/open-remote-ssh) をもとにしています。ライセンスは同じ [MIT License](LICENSE.txt) です。

Kasugai は個人のプロジェクトで、Microsoft や VSCodium のプロジェクトとは関係ありません。
