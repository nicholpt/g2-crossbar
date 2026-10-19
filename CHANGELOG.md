# Changelog

The Release workflow publishes the section for the tagged version as the release notes.

## Unreleased

- **Fixed:** an agent's subject was dropped from its header when the name, model, folder and state left under 80 px (often, with a long model or folder), and squeezed to a few characters otherwise. The two parts now share the room, each up to about half, and whichever doesn't fit its part slides sideways in it.

## 1.0.3

- **Read the papers while minimized.** Long press now shrinks Crossbar to the bottom-left corner. The feed's titles slide by over a bottom line with the time, agents needing you, the paper's number and the battery. Swipe for the previous or next title, or double-tap for the previous one. Tap one to read it: the corner (a quarter of the screen) fills with its title, authors, category and abstract, and swiping scrolls it. Double-tap goes back to the titles. Only long press restores the full view now (double-tap used to as well). The bridge now reads each item's abstract (RSS description), authors and category, with arXiv's TeX turned into plain text.
- **What the agent is working on, in its header.** The terminal title an agent sets (Claude's "✳ tidy the release notes", Codex's "Enable YOLO mode | Documents") shows after the folder: "Claude - Opus 5.5 high · ~/Documents · tidy the release notes". When it doesn't fit, only it slides sideways; the header is now its own display area, so that only resends one line.
- **Claude's screen drops its footer noise.** The token count and update notices ("current: 2.1.302 · latest: 2.1.303 ✔ Update installed · Restart to update", "Update available") are hidden when you open Claude, which frees a line for its output.
- **The model, effort and folder moved to the agent's screen.** Open an agent and its header reads `codex - GPT-6.1-Sol ultra · ~/Documents` next to its state. The agent's own footer line with the same details is hidden, so you get one more line of its output. The Agents list is back to plain agent names.
- **You can tell which level you're on.** Choosing a category, its icon has a rounded ring and the list has no selection box; inside the list, the box is back and the ring is gone.
- **Tab moved next to Enter** in the glasses key strip: ↑ ↓ Tab Enter Esc 1 2 3 y n Space Bksp ^C.
- **Fixed:** right after the list changed (say, once you answered an agent), the selected row could briefly show one item's title over the previous item's subtitle. They're now drawn as one, so they always change together.
- CI/CD:
  - actions pinned to commits, Node 22 tested, `npm audit`, CodeQL and Dependabot;
  - releases get a checksum, signed build provenance, and notes from this changelog;
  - `npm test` now fails on personal details in tracked files and on mismatched versions.
  - TypeScript 7 for type checking; Even's packaging tool (`@evenrealities/evenhub-cli` 0.1.14) declares TypeScript 5 as a peer but never loads it, so `package.json` overrides that peer.

## 1.0.2

- **Model, effort and folder next to each agent** in Agents, e.g. `codex - GPT-6.1-Sol ultra · ~/Documents`.
  - codex, agy and kimi: read from their own footers. The model is remembered while codex hides its footer to ask for approval.
  - Claude Code: the model of its latest reply, plus your effort setting.
- **New menu order:** Needs You, Agents (still where it opens), Projects, Notes, Running, Apps, Music, Network, and System last.
- **Cleaner subtitles:**
  - Claude's "How is Claude doing this session?" survey is no longer shown as its latest message.
  - Status lines with accented verbs ("Sautéed for 11s") are skipped.
- **README:** screenshots and GIF retaken with the new order and labels.

## 1.0.1

**Prompts are read correctly across harnesses.** These are tested against screens captured from real Claude Code, Codex, Antigravity, Gemini and Kimi sessions:
- Trust-folder prompts are detected (claude, agy, kimi).
- Codex approvals show the full question and command ("Would you like to run the following command? $ …").
- Claude's multiple-choice questions list clean options, including the one below the divider ("Chat about this").
- Kimi's option descriptions and on-screen key hints are no longer read as options.
- Codex questions waiting behind "⇧← to answer" appear in Needs You, with a **Show Question** action.

**Fewer false alerts and better subtitles.**
- agy counts as working while it reads or edits files, so no more "finished" alerts mid-task.
- Subtitles show what the agent said, not tool output, status lines or footers.
- An agent that's asking shows its question in Agents.

**Also**
- Antigravity (`agy`) replaces the deprecated Gemini CLI in the default agents.
- Tests and CI (Ubuntu and macOS), plus `npm run capture` for turning a misread prompt into a test case.
- Screenshots and a GIF in the README.

## 1.0.0

First public version.
