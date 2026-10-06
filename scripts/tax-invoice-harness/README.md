# Tax invoice page harness

Headless-Chromium check of `src/pages/SupplierTaxInvoices.jsx` with mocked hooks and supabase, the REAL `src/index.css`,
and all network blocked. No live database is touched. It covers notReady, empty/mixed lists, draft edit, preview
(blocking / warnings), stale-preview guard, confirm overlay, post success/failure, view, void, delete, the layout
(post button and preview reachable at 1280x800 with 1 and 8 lines and at 375x740) and the back-button/history behaviour.

Run from the repo root (uses the repo's existing `esbuild` and `playwright`; add no dependencies):

    node scripts/tax-invoice-harness/build.mjs   # bundles into <tmpdir>/tax-invoice-harness-out.js
    node scripts/tax-invoice-harness/run.mjs     # prints PASS/FAIL lines, ends with ALL PASS, exit code 1 on failure

Run it alone: parallel runs make the Playwright waits slow. Mocks: `mockHooks.js` (hooks + RPC wrappers, `window.__rpc`,
`window.__rpcDelay`), `mockSupabaseLib.js`, `useRoleMock.js` (`window.__role`), `MockQuickAdd.jsx`.
