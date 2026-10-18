# Changelog

The Release workflow publishes the section for the tagged version as the release notes.

## Unreleased

- **The model, effort and folder moved to the agent's screen.** Open an agent and its header reads `codex - GPT-6.1-Sol ultra · ~/Documents` next to its state. The agent's own footer line with the same details is hidden, so you get one more line of its output. The Agents list is back to plain agent names.
- CI/CD:
  - actions pinned to commits, Node 22 tested, `npm audit`, CodeQL and Dependabot;
  - releases get a checksum, signed build provenance, and notes from this changelog;
  - `npm test` now fails on personal details in tracked files and on mismatched versions.

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
