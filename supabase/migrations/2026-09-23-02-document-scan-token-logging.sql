-- Real per-scan token usage, so "how much does a PDF scan cost vs a JPG"
-- can be answered with actual numbers instead of a formula-based
-- estimate -- this table previously only recorded a timestamp+tenant_id
-- for quota counting, never the Anthropic response's own usage figures.
alter table document_scan_usage add column mime_type text;
alter table document_scan_usage add column input_tokens integer;
alter table document_scan_usage add column output_tokens integer;
