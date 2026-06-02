# implement-worker — T64 (M14) TUI batch-answer overlay — PASS

Agent adcfee0cb1a1a1ecc. resultCommit b15b234307fbb1d7daa72e214c66c6a3dc58b677, branch implement/T64. check green 560 pass / 0 fail.

Full-screen batchAnswer Overlay variant entered with 'b'; steps a ledger's open answerable items one at a time. Reuses answer write-path (status→answered + answer field) + AS_RECOMMENDED_ANSWER (Ctrl+R); Enter saves + auto-advances, Left/Right prev/next, Esc exits. Scopes via canAnswer, defaults to questions ledger (fetched on demand). Documented 'b batch-answer' hint. 5 ink-testing-library tests. Note: test key constants embed literal control bytes (DOWN="<ESC>[B"); new constants matched raw-byte convention. Files: app.tsx, test/app.test.tsx.
