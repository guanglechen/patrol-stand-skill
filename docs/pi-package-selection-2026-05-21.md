# Pi Package Selection Notes

Date: 2026-05-21

This project keeps Pi as the execution kernel and uses project-scoped packages only when they improve the generic agent base without bypassing the WebChat, bridge, and harness contracts.

## Current Decision

- Upgrade Pi core to `@earendil-works/pi-coding-agent@0.75.4`.
- Enable agent-team support through project-local `pi-subagents@0.24.3`.
- Disable `pi-subagents` builtin agents and expose only the project `patrol-*` agents.
- Keep `ask_user_web` as the production ask tool.
- Do not install todo or browser/search packages into the production task path yet.

Pi package docs warn that packages run with full system access; extensions can execute arbitrary code and skills can instruct the model to run programs. Every package should go through source review, project-scoped installation, and harness validation before production use.

Source: https://pi.dev/docs/latest/packages

## Agent Team

Selected: `pi-subagents@0.24.3`

Reason:

- It adds parent-controlled delegation to child Pi sessions.
- It supports single, chain, parallel, and async delegation.
- Its docs explicitly describe child-safety boundaries: children do not receive the parent subagent tool/skill and are instructed not to run subagents.
- It is narrower than `pi-crew`, which brings its own durable state, workflows, worktrees, metrics, and dashboards that overlap with our Web task table and harness.

Control applied in this repo:

- `.pi/settings.json` installs `npm:pi-subagents` project-locally.
- `.pi/settings.json` sets `subagents.disableBuiltins=true`.
- `.pi/agents/patrol-*.md` defines five project agents:
  - `patrol-runtime-agent`
  - `patrol-tooling-agent`
  - `patrol-harness-agent`
  - `patrol-security-agent`
  - `patrol-domain-qa-agent`
- These agents use only bridge tool names and do not get Pi builtin `bash`, `read`, `edit`, or `write`.
- The parent prompt requires `agentScope: "project"` on subagent calls. User-level agents may still exist in a developer's Pi environment, but production patrol tasks should not select them.

Sources:

- https://pi.dev/packages/pi-subagents
- https://pi.dev/packages/pi-crew

## Ask Tools

Keep: `ask_user_web`

Do not install for production path yet:

- `pi-ask-user@0.11.0`
- `@juicesharp/rpiv-ask-user-question@1.10.2`

Assessment:

- `pi-ask-user` has the best single-question terminal UX: searchable options, multi-select, freeform, inline/overlay mode, comments, and structured `details`.
- `@juicesharp/rpiv-ask-user-question` is stronger for multi-question questionnaires: tabs, previews, per-option notes, review-before-submit, and localization.
- Both are Pi TUI tools. They return answers inside the Pi tool result, not through this project server.
- Our `ask_user_web` is better for this product because it writes `waiting_user`, emits Web events, persists answers, appears in the task timeline, and resumes from the WebChat button.

Decision:

- Keep `ask_user_web` as the only production ask tool.
- Borrow ideas from third-party tools later: multi-question schema, option previews, notes/comments, and structured JSON answers.

Sources:

- https://pi.dev/packages/pi-ask-user
- https://pi.dev/packages/%40juicesharp/rpiv-ask-user-question

## Todo / Planning

Candidate: `@juicesharp/rpiv-todo@1.10.2`

Assessment:

- `rpiv-todo` is better than our current Web event stream for the model's live inner plan.
- It adds a `todo` tool, `/todos`, dependency tracking, state transitions, tombstones, and a live TUI overlay that survives `/reload` and compaction by replaying from the branch.
- Our Web event stream and harness scorecard are better for product-level audit: persisted task state, SSE timeline, artifacts, scoring, and regression reports.

Decision:

- Treat todo as complementary, not duplicate.
- Do not install it into the production run yet because the TUI overlay is not visible in the WebChat product and would split task state.
- Next implementation should add a native `task_plan_web` bridge tool with `pending/in_progress/completed/blocked/deleted`, dependencies, and harness assertions. If that proves insufficient, trial `rpiv-todo` in a project branch and mirror todo snapshots into Web events.

Source: https://pi.dev/packages/%40juicesharp/rpiv-todo

## Web Search / Browser

Need: external data retrieval for standards, references, package/source evaluation, and current web facts.

Recommended phased choice:

1. `pi-web-access@0.10.7` for the first retrieval trial.
2. `@juicesharp/rpiv-web-tools@1.10.2` as the safer narrow alternative when only `web_search` + `web_fetch` is required.
3. `pi-smart-fetch@0.3.5` only for difficult fetch/extraction after search already provides URLs.
4. `pi-chrome@0.15.27` only for authenticated Chrome-profile workflows after explicit user approval.
5. `pi-agent-browser-native@0.2.31` only for local app QA/browser automation, not general research.

Why `pi-web-access` first:

- Highest fit for research-heavy agent work: web search, URL fetch, GitHub repo cloning, PDF extraction, YouTube/local video analysis, and stored search content retrieval.
- It has a curator workflow and can return synthesized answers with source citations.
- It supports zero-config Exa MCP plus keyed Exa/Perplexity/Gemini options.

Risks:

- It is a broad package with web egress, GitHub cloning, PDF/video handling, and optional browser-cookie Gemini Web.
- Browser-cookie access must stay disabled by default.
- It should only be enabled in a separate `research` mode and measured in harness: source count, URLs fetched, external domains, and whether citations were saved.

Sources:

- https://pi.dev/packages/pi-web-access
- https://pi.dev/packages/%40juicesharp/rpiv-web-tools
- https://pi.dev/packages/%40ollama/pi-web-search
- https://pi.dev/packages/pi-smart-fetch
- https://pi.dev/packages/pi-chrome
- https://pi.dev/packages/pi-agent-browser-native

## Next Package Trial Order

1. Keep this branch focused on Pi core `0.75.4` + safe `pi-subagents`.
2. Add a native Web plan/todo bridge before installing `rpiv-todo`.
3. Trial `pi-web-access` in a separate branch with browser cookies disabled and a harness scenario that verifies citations, fetched domains, and no secret leakage.
4. Only consider `pi-chrome` or `pi-agent-browser-native` for authenticated browser or Web UI QA tasks, not general research.
