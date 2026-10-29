# No inline imports

Always place imports at the top of the module. Avoid inline imports in function bodies, type annotations, or interface fields unless there is a strict circular-dependency reason and it is documented.

**Exception in this repo.** Some dynamic `import()` calls are deliberate and documented, and they stay:
- `src/jobs/runner.js`: a broken job must not take the other scheduled jobs down with it.
- `src/triggers/runtime.js`: keeps trigger load time small.
- `@forge/llm`: it throws at load time outside the Forge runtime, which would break `npm run smoke`. See the comment in `test/smoke.mjs`.

Don't hoist imports like these. New code should still import at the top unless it has the same kind of documented load-time or isolation reason.

<!-- From cursor/plugins cursor-team-kit/rules/no-inline-imports.mdc (MIT, commit 1ba91fc); repo exception added. -->
