# QMA authority source integration review — 2026-11-02

Serves: 3xmr#M1. Existing coordination issue: awc-09t (deferred).

This continuation incorporates the already independently reviewed falsy-authority repair into the existing zero-selected cutover PR. Source and test files are byte-identical to code commit 81e973f5f4c00926726c1e5d8d2c0dd3e1e7cb1c. Only normalized null means an absent authority; false, zero and empty strings must fail closed.

Independent source review on October 28: 144 focused tests passed, with 35 separately recorded probes. Continuing ChatGPT review on November 2 verified the exact source delta and ran the complete repository source suite: **2244 tests passed, zero failed or skipped**, using two workers in an isolated network namespace without live engine or native Beads access. These counts describe separate, overlapping runs and are not additive.

The first full-suite run passed 2243 tests and failed one CLI header test because localhost name resolution was missing inside the temporary sandbox. The corrected run supplied only local hosts/nsswitch fixtures. Product source and test assertions were unchanged; the failed run is retained with the successful run in the owner's evidence store. Local evidence commit: e6f3ad15eca2b6d90ac21dbf1941f15e5f16ec18.

This accepts source integration only. Installed-runtime parity, native persistence/custody qualification, backup/recovery, a fresh reviewed import plan, QMA authority cutover, WorkProvider selection and Gas City admission remain separate. No task creation, dispatch, service activation, data disclosure, external endpoint or trading is claimed or authorized by this PR.
