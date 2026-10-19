# Software bill of materials

Everything Crossbar ships, installs, runs and talks to. The machine-readable version
is CycloneDX JSON:

```sh
npm run sbom      # writes crossbar.sbom.cdx.json
```

It has every npm package in `package-lock.json` (build-only ones scoped `optional`)
plus the system pieces below. Each release attaches it as `crossbar.sbom.cdx.json`,
with a signed SBOM attestation for `crossbar.ehpk`:

```sh
gh attestation verify crossbar.ehpk --repo nicholpt/g2-crossbar \
  --predicate-type https://cyclonedx.org/bom
```

`npm test` fails if a package in `package.json` is missing here or listed at another
version than the lockfile's, so a dependency update (Dependabot's too) updates this page.

## In the glasses app (`crossbar.ehpk`)

Bundled into the app's JavaScript by Vite; nothing else is in the package.

| Package | Version | License | What for |
| --- | --- | --- | --- |
| `@evenrealities/even_hub_sdk` | 0.0.16 | MIT | Talking to the glasses through the Even app |
| `@evenrealities/pretext` | 0.1.4 | MIT | Measuring text in the glasses' font |

## The bridge on the Mac

| Package | Version | License | What for |
| --- | --- | --- | --- |
| `ws` | 8.22.0 | MIT | The WebSocket the phone connects to |

`ws`'s optional native add-ons (`bufferutil`, `utf-8-validate`) aren't installed.

## Installed by you

Crossbar doesn't install these; `bin/setup` checks for them and says what's missing.

| Component | Needed for | License | Source |
| --- | --- | --- | --- |
| Node.js 20+ | Required: runs the bridge | MIT | https://nodejs.org (`brew install node`) |
| tmux | Required: where agents run; the bridge reads and types into panes | ISC | https://github.com/tmux/tmux (`brew install tmux`) |
| Tailscale | Tailscale mode (not home mode) | BSD-3-Clause | https://tailscale.com |
| whisper.cpp | Optional: voice Ask (`whisper-server`) | MIT | https://github.com/ggml-org/whisper.cpp (`brew install whisper.cpp`) |
| Whisper `ggml-small.en.bin` | Optional: the model voice Ask uses (466 MB, English) | MIT | https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.en.bin, SHA-256 `c6138d6d58ecc8322097e0f987c32f1be8bb0a18532a3f88f734d1bbf9c41e5d` (downloaded by `bin/setup` into `models/`) |

### Used if present

| Integration | How |
| --- | --- |
| Docker | `docker` CLI: list, start, stop and restart containers |
| Spotify | AppleScript (`osascript`): now playing and controls; macOS asks for Automation permission once |
| Obsidian | Reads Markdown notes from the vaults in `crossbar.json`; Obsidian itself isn't run |
| git | `git` CLI (Xcode Command Line Tools): project status and pull |

### macOS built-ins the bridge runs

`osascript`, `lsappinfo`, `open`, `pmset` (sleep displays), `pbcopy` / `pbpaste`,
`ps`, `sysctl`, `vm_stat`, `ioreg` (GPU), `df`, `netstat`, `route`, `find`. `bin/setup`
also uses `curl` (the model download and a health check) and `launchctl` (the login item).

## Network

| Where | When |
| --- | --- |
| The bridge on your Mac (Tailscale or home Wi-Fi), port 8787 | The glasses app, always; nothing else |
| `export.arxiv.org` | The bridge, for the default top-line feed (every 30 min; set in `crossbar.json`) |
| Feeds you add | The bridge; the setup screen suggests Hacker News (`hnrss.org`), The Verge and BBC News |
| `huggingface.co` | `bin/setup`, once, if you agree to download the Whisper model |

Voice and photos stay on the Mac: speech is transcribed by `whisper-server` on
`127.0.0.1`, and photos are saved in `.run/snaps/`.

## Build and test only

Not shipped. Their dependencies are in the CycloneDX file, licensed MIT, Apache-2.0,
ISC, MPL-2.0 (`lightningcss`, used by Vite), BSD-3-Clause, 0BSD and Python-2.0
(`argparse`); `@evenrealities/evenhub-cli` and `qrcode-terminal` don't declare one.

| Package | Version | License | What for |
| --- | --- | --- | --- |
| `@evenrealities/evenhub-cli` | 0.1.14 | not declared | `npm run pack`: builds `crossbar.ehpk` |
| `@evenrealities/evenhub-simulator` | 0.9.5 | MIT | `npm run sim` and the screenshots |
| `typescript` | 7.0.2 | Apache-2.0 | `npm run typecheck` (also the CLI's, via `overrides`) |
| `vite` | 8.3.4 | MIT | Builds the app |

### CI (GitHub Actions)

Pinned to commit SHAs; Dependabot proposes updates weekly.

| Action | Version |
| --- | --- |
| `actions/checkout` | v7.0.1 |
| `actions/setup-node` | v7.1.0 |
| `actions/upload-artifact` | v7.0.2 |
| `actions/attest-build-provenance` | v4.2.2 |
| `actions/attest-sbom` | v4.1.0 |
| `github/codeql-action` (init, analyze) | v4.39.0 |

CI also installs tmux (Homebrew on macOS, apt on Ubuntu) for the bridge test, and uses
the runner's ShellCheck.
