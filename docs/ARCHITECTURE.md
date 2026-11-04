# AXIOM — Architecture & Development Scope

> **Status:** design document. All planned capabilities remain unimplemented unless supported by code and tests.

## Vision

AXIOM is an autonomous research harness built on [Pi](https://github.com/earendil-works/pi). It connects research questions, experiment configurations, verified metrics and reproducible outputs. It is **not** intended to invent results or automate publication decisions.

## Reuse vs. build

| Capability | Decision |
| --- | --- |
| Agent loop, multi-model inference and tool calling | Reuse Pi SDK |
| Sessions, context compaction, extensions, Skills and MCP | Reuse / configure Pi |
| Research Context Engine | Build |
| Experiment Registry and provenance links | Build on common storage / optionally MLflow |
| Scientific Evidence Validator | Build |
| Experiment Orchestrator and approval policies | Build |
| GPU process management, checkpoints and recovery | Build separate Python Runner |
| Durable task graph and advanced collaboration | Evaluate after MVP, no current guarantee |
| UI and visual reports | Incremental |

## First MVP — offline, read-only

1. Import experiment configuration, logs and evaluation artifacts from a **private local workspace**.
2. Track `run_id`, code revision, dataset identifier, configuration hash, metric name, evaluation protocol and artifact path.
3. Every metric points to an original source; missing provenance remains explicitly unverified.
4. Compare runs only when evaluation protocols and relevant experimental settings are comparable.
5. Use narrow, read-only research tools exposed to a Pi session.
6. Produce Markdown, CSV and LaTeX tables with provenance.
7. Use **synthetic public fixtures** to test the open-source implementation. Keep unpublished work offline.

## Proposed task lifecycle

```text
Research question
  -> Context assembly + evidence retrieval
  -> Experimental plan
  -> Explicit approval (for paid or destructive actions)
  -> Idempotent GPU job submission
  -> Runner-state reconciliation and checkpoint inspection
  -> Evidence and comparability validation
  -> Reproducible report / paper-ready draft (human review)
```

## Boundaries

**Pi session state is not GPU job state.** The Runner must survive disconnections and use stable IDs to avoid duplicate submissions. Security gates must be enforced in executable code, not only prompts.

## Repository integration

The upstream Pi monorepo is tracked as Git submodule `vendor/pi`, pinned to a specific commit. This preserves its own Git history and makes upgrades explicit:

```bash
git clone --recurse-submodules https://github.com/luming9494/AXIOM.git
# In an existing checkout:
git submodule update --init --recursive
```

Pi's MIT license and attribution remain in the upstream submodule. AXIOM does not claim affiliation with upstream Pi maintainers.
