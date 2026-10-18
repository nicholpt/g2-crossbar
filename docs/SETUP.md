# Setting up Crossbar

About 10 minutes. You'll install a small bridge on the Mac your agents run on, connect
your phone to it, and install the glasses app.

**Two ways to connect.** Pick one:

| | Tailscale (recommended) | Home Wi-Fi |
| --- | --- | --- |
| Works | anywhere: home, office, cellular | only when the phone is on the same network as the Mac |
| Needs | a free Tailscale account, on the Mac and the phone | nothing extra |
| Security | encrypted; only your own devices | a pairing code; traffic on the Wi-Fi isn't encrypted |
| Setup | `bin/setup` | `bin/setup --home` |

- [1. Install the prerequisites on your Mac](#1-install-the-prerequisites-on-your-mac)
- [2. Connect your phone to the same tailnet](#2-connect-your-phone-to-the-same-tailnet)
- [3. Run bin/setup](#3-run-binsetup)
- [4. Install the glasses app](#4-install-the-glasses-app)
- [5. Run your agents in tmux](#5-run-your-agents-in-tmux)
- [6. Optional extras](#6-optional-extras)
- [Updating and uninstalling](#updating-and-uninstalling)
- [Troubleshooting](#troubleshooting)

## 1. Install the prerequisites on your Mac

You need [Homebrew](https://brew.sh). Then:

```sh
brew install node tmux
brew install whisper-cpp        # optional: voice "Ask"
```

**Tailscale only:** install it from [tailscale.com/download](https://tailscale.com/download)
(the Mac App Store version works too) and sign in. Tailscale gives your Mac a private
name (`my-mac.tailnet-1234.ts.net`) and address (`100.x.y.z`) that only your own devices
can reach, from anywhere. Turn on MagicDNS in the Tailscale admin console for the name.

## 2. Connect your phone to the same tailnet

**Tailscale:** install Tailscale on the phone that runs the Even app and sign in with
the **same account** as your Mac. Keep it connected while you use Crossbar. (The bridge only
serves devices owned by the same Tailscale user as the Mac.)

**Home Wi-Fi:** just keep the phone on the same Wi-Fi as the Mac.

## 3. Run bin/setup

```sh
git clone https://github.com/nicholpt/g2-crossbar.git ~/g2-crossbar
cd ~/g2-crossbar
bin/setup            # Tailscale
bin/setup --home     # or: home Wi-Fi only
```

It checks the prerequisites, builds the app, creates your settings file (`crossbar.json`),
installs the bridge as a login item (it starts at login and restarts if it stops),
offers to download the Whisper model for voice Ask (466 MB), and builds a personal
glasses app, `crossbar.ehpk`, that already knows your Mac's address.

At the end it prints your Mac's address, and in home mode a pairing code:

```
  • On the phone's setup screen (⚙), the address is:  my-mac.tailnet-1234.ts.net
```
```
  • On the phone's setup screen (⚙), the address is:  My-Mac.local
    and the pairing code is:  k3v9x2m7q8ra
```

Note them down. Re-running `bin/setup` keeps the same pairing code.

> **Is it running?** `curl -s -o /dev/null -w '%{http_code}\n' http://localhost:8787/`
> prints `200`. The log is `.run/crossbar.log`.

## 4. Install the glasses app

**Personal build (recommended).** `bin/setup` made `crossbar.ehpk` with your Mac's address in
it.

1. Open the [Even Hub developer portal](https://evenhub.evenrealities.com), create a
   project, and under **Private builds** upload `crossbar.ehpk`.
2. On your phone: Even app → **Even Hub** tab → **Me → Apps → Private builds** → Install.
3. Launch **Crossbar** from the glasses' home menu.

**From the store.** If you installed Crossbar from Even Hub instead, it opens on the **Set up
Crossbar** screen on your phone the first time (and the glasses say *Finish Setup on Your
Phone*). Enter your Mac's address from step 3 (and, for a `.local` address, the pairing
code) and tap **Connect**. You can come back to this screen any time with the ⚙ button in
the top-right of the phone app.

The setup screen accepts only addresses that can be your Mac: a `*.ts.net` name, a
Tailscale IP (`100.64.0.0` to `100.127.255.255`, or `fd7a:115c:a1e0:…`), a `*.local`
name, or `localhost`. Add `:port` if you changed the port.

A home-mode personal build already knows the address but never the pairing code, so it
asks for the code once.

**Just trying it.** Without installing anything, show a QR code and scan it from the Even
app's developer mode:

```sh
npx evenhub qr -u "http://$(tailscale ip -4):8787/"
```

A QR session stops when the phone locks; an installed build keeps running.

## 5. Run your agents in tmux

Crossbar finds agents by looking for tmux panes running one of the commands in `agents` (see
[Settings](../README.md#settings)). Start them in tmux:

```sh
tmux new -s agents
claude            # or codex, gemini, kimi…
```

Or pick **Agents → New Claude** on the glasses, which starts one in a tmux session called
`agents` for you. Each agent gets its own tmux window; any session name works.

When an agent asks something (approve a command, pick an option), the bell gets a badge
and a toast appears. Open **Needs You**, or the agent itself, and pick the answer.

## 6. Optional extras

| For | Do |
| --- | --- |
| Voice **Ask** | `brew install whisper-cpp`, then re-run `bin/setup --yes` to download the model. On the glasses: an agent → **Ask** → speak. |
| **Music** | Have Spotify open. The first time, macOS asks whether "node" may control Spotify: click **OK** (or System Settings → Privacy & Security → Automation → node → Spotify). |
| **Notes** | Point `vaults` in `crossbar.json` at your notes folder(s). |
| **Network** | Docker Desktop (or any `docker` CLI) for the container list. |
| **Top-line feed** | Phone → ⚙ → *Top-line feed*: add any RSS/Atom URL (presets for arXiv AI, Hacker News, The Verge, BBC News), or clear it to turn the feed off. |

## Updating and uninstalling

```sh
cd ~/g2-crossbar && git pull && bin/setup     # update: rebuilds and restarts the bridge
bin/setup --uninstall                     # stop the bridge and remove its login item
```

If `bin/setup` rebuilt `crossbar.ehpk` with a new version, upload it again as in step 4.

## Troubleshooting

**The glasses say "Mac Offline" / the phone says it can't reach the Mac.**
- Tailscale: is it connected on *both* the Mac and the phone, with the same account?
- Home Wi-Fi: is the phone on the same network as the Mac (not cellular, not a guest
  network)? Is the pairing code right? Some routers block devices from seeing each other
  ("client isolation"); Tailscale avoids that.
- Is the bridge up? `curl http://localhost:8787/` on the Mac should answer. If not, look at
  `.run/crossbar.log`, then `launchctl kickstart -k gui/$(id -u)/com.g2crossbar.bridge`.
- Did the Mac's address change (a new Mac, or Tailscale reinstalled)? Re-run
  `bin/setup` and reinstall `crossbar.ehpk`, or enter the new address under ⚙ Setup.

**"forbidden" in a browser.** Tailscale mode only serves devices owned by the same
Tailscale user as the Mac: sign the phone/computer in to that account. Home mode needs the
pairing code: open `http://my-mac.local:8787/?key=<code>` once.

**An agent doesn't show up.** It has to run inside tmux, and its command has to be in
`agents` in `crossbar.json` (restart the bridge after changing that).

**A prompt doesn't appear in Needs You, or a non-prompt does.** Prompt detection reads
the bottom of the agent's screen. Open the agent's view on the phone while the prompt is
up and file an issue with what it shows; each agent CLI draws its menus a little
differently.

**Voice Ask says "speech: …".** `whisper-server` isn't installed or the model is missing:
`brew install whisper-cpp && bin/setup --yes`.

**Spotify says it needs permission.** See *Music* above; the approval prompt appears on
the Mac's screen.

**Port 8787 is taken.** Run setup with another port, e.g. `CROSSBAR_PORT=8797 bin/setup`, and
enter the address with the port (`my-mac.ts.net:8797`) on the setup screen.
