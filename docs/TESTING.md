# Testing

```sh
npm test            # builds the app, then runs every test (Node 22.18+, tmux)
npm run typecheck
```

CI runs the same on every push and pull request (see [CI](#ci)).

## What the tests cover

| File | Covers |
| --- | --- |
| `test/screens.test.mjs` | Prompt detection and "what the agent said" on real-layout screens from each harness |
| `test/bridge.test.mjs` | The real bridge with a fake agent in a private tmux server: alert → view → answer moves the agent's own cursor and presses Enter; stale prompts refused; keys only to the viewed pane; unknown keys refused |
| `test/address.test.mjs` | Which addresses the phone app will connect to |
| `test/auth.test.mjs` | Home mode's pairing code; this Mac always allowed |
| `test/feed.test.mjs` | RSS, Atom and arXiv headline parsing |
| `test/model.test.mjs` | The model and effort shown next to each agent |
| `test/repo.test.mjs` | No emails, home folders or tailnet addresses in tracked files; versions and changelog in sync |

The bridge test uses `tmux -L crossbar-test` (see `test/bin/tmux-test`), so it never
touches your own tmux sessions.

## When an agent's prompt is misread

Every coding CLI draws its menus differently, and they change between versions, so
prompt detection is driven by captured screens.

1. While the prompt is on screen, capture the pane:

   ```sh
   npm run capture -- agents:1.0 agy-plan-menu
   ```

   It saves the visible screen to `.run/captures/agy-plan-menu.txt` (ignored by git) and
   prints how Crossbar reads it, as a draft entry for `test/fixtures/screens.json`.
2. Correct the entry to what it *should* be: the question, every option in order, which
   one the cursor is on, or `"decision": null` if it isn't a prompt.
3. Replace anything private in the screen and the entry (project names, paths, URLs)
   with made-up text of the same shape. Keep the layout exactly: indentation, borders,
   cursor symbols, wrapped lines and footers are what the parser reads.
4. Move the screen to `test/fixtures/screens/<harness>-<case>.txt`, add the entry, and run
   `npm test`. It fails until the parser handles the new case, and from then on it keeps
   working.

Name fixtures after the harness (`claude-`, `codex-`, `gemini-`, `agy-`, `kimi-`).
The fixtures cover trust-folder prompts, command and file-edit approvals, multiple-choice
questions (with option descriptions, wrapped options and a cursor part-way down), working
and idle screens. **kimi** only has its trust prompt so far: captures of its approvals and
questions are especially welcome.

To make an agent show a prompt without touching your own sessions, run it in a scratch
folder on a separate tmux server (`tmux -L scratch new -s demo -c /tmp/demo claude`),
ask it to run a command or ask you a question, and capture with
`CROSSBAR_TMUX="tmux -L scratch" npm run capture -- demo <name>`.

## Manual checks before a release

CI can't wear the glasses. Before tagging a release, on real hardware:

- [ ] Install the package from `bin/setup` (Tailscale) and from `bin/setup --home`; both
      connect, and the setup screen accepts the printed address (and pairing code).
- [ ] Gestures: swipe, tap, double-tap back, long press minimizes and restores.
- [ ] Minimized: titles slide by; swipe changes title, tap opens the paper, swipe scrolls it,
      double-tap returns to the titles, and only long press restores.
- [ ] An agent's prompt shows in Needs You; answering from the glasses picks the right
      option, for each harness you use.
- [ ] Ask by voice: listening, the 3-second cancel window, the text arrives in the agent.
- [ ] Snap a photo and send one from the library.
- [ ] Taking the glasses off and on gives the "While away" summary.
- [ ] The top-line feed scrolls; a feed changed on the setup screen shows up.
- [ ] Spotify controls (first use asks for macOS Automation permission).
- [ ] After a Mac restart, the bridge comes back on its own.

## Releasing

1. Bump `version` in `app.json` and run `npm version <x.y.z> --no-git-tag-version` (package.json and the lockfile).
2. Add a `## <x.y.z>` section at the top of `CHANGELOG.md`.
3. Commit, then tag it:

   ```sh
   git tag -a v1.0.3 -m "Crossbar 1.0.3" && git push origin v1.0.3
   ```

`npm test` fails if the versions or the changelog don't line up, so step 1 and 2 can't be
half done. The Release workflow re-runs the tests, builds `crossbar.ehpk`, and publishes it
with a SHA-256 checksum, a signed build-provenance attestation and the changelog section as
the notes. Check a download with `gh attestation verify crossbar.ehpk --repo nicholpt/g2-crossbar`.

## CI

Every push and pull request runs, on GitHub Actions:

- **Test**: typecheck, the whole suite and a package build, on macOS (Node 24) and Ubuntu
  (Node 24 and 22).
- **Dependency audit**: `npm audit` (high or worse fails) and registry signatures.
- **ShellCheck** on the shell scripts.
- **CodeQL** static analysis (also weekly).

Dependabot opens grouped update PRs weekly for npm packages and the pinned actions.
