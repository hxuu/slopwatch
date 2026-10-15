# Domain Docs

How the engineering skills should consume this repo's domain documentation when exploring the codebase.

## Before exploring, read these

- **`CONTEXT.md`** at the repo root. This repo's glossary. It plays the role `GLOSSARY.md` plays in other repos: a glossary and nothing else. Do not create a separate `GLOSSARY.md`; extend `CONTEXT.md` instead.
- **`docs/adr/`**: read ADRs that touch the area you're about to work in.

There is no `GLOSSARY-MAP.md`, so this is a single-context repo.

## File structure

Single-context repo:

```
/
├── CONTEXT.md          ← the glossary
├── docs/
│   ├── adr/
│   │   └── 0001-bun-everywhere.md
│   └── agents/         ← this skill's output
├── apps/
├── packages/
├── listeners/
└── spikes/             ← throwaway validation spikes
```

## Use the glossary's vocabulary

When your output names a domain concept (in an issue title, a refactor proposal, a hypothesis, a test name), use the term as defined in `CONTEXT.md`. Don't drift to synonyms the glossary explicitly avoids. `CONTEXT.md` lists those avoided synonyms per term (for example, a **Listener** is never a "sidecar", "adapter", or "collector").

If the concept you need isn't in the glossary yet, that's a signal: either you're inventing language the project doesn't use (reconsider) or there's a real gap (note it for `/domain-modeling`).

## The research documents are not the glossary

`research/v1-architecture-decisions.md`, `research/coding-agent-ingestion.md`, and `research/developer-leaderboard-design.md` carry design context and open questions. They are inputs to reasoning, not terminology to be relied on. Where they disagree with `CONTEXT.md`, `CONTEXT.md` wins, which it states about itself.

These documents also contain decisions that were later reversed. Treat them as historical.

## Flag ADR conflicts

If your output contradicts an existing ADR, surface it explicitly rather than silently overriding:

> _Contradicts ADR-0001 (Bun as the sole runtime and toolchain), but worth reopening because…_
