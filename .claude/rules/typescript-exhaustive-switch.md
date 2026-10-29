---
paths:
  - "frontend/**/*.ts"
  - "frontend/**/*.tsx"
---

typescript-exhaustive-switch: In switch statements over discriminated unions or enums, use a `never` check in the default case so newly added variants cause compile-time failures until handled.

<!-- From cursor/plugins cursor-team-kit/rules/typescript-exhaustive-switch.mdc (MIT, commit 1ba91fc); scoped to the TypeScript frontend. -->
