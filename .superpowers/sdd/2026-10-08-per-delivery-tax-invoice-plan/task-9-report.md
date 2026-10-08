# Task 9 report
Status: DONE.
- SupplierTaxInvoices.jsx: saveDraft routes through draftSaveCall (explicit link_kind decides); refetchAllLinks; awaiting card per supplier oldest first (absent pre-migration); hand-off consumer (consumed once, not-ready / not-found alerts); list count "N ล็อต" via active links + invoiceMatchBase for red diff; view lists receipts for delivery kind; askPost passes receiptCount.
- TaxInvoicePreview.checkLine appends receipt_no.
- Harness: entry.jsx nav props; run.mjs section D2 incl 375px; Task 9 excuses removed; one D1 assertion scoped to modal (awaiting card shows PO-9 behind it).
- vitest 1064 pass, build OK, run.mjs ALL PASS, runPo.mjs ALL PASS.
