-- LINE payslip request: token type 'payslip' + command key 'payslip_request'.
-- The CHECK lists are the LIVE definitions on CHANG, extended only.

ALTER TABLE line_deep_link_tokens DROP CONSTRAINT IF EXISTS line_deep_link_tokens_action_type_check;
ALTER TABLE line_deep_link_tokens ADD CONSTRAINT line_deep_link_tokens_action_type_check
  CHECK (action_type = ANY (ARRAY['material_request','leave','check_in','check_out','advance','payslip']));

ALTER TABLE line_command_settings DROP CONSTRAINT IF EXISTS line_command_settings_command_key_check;
ALTER TABLE line_command_settings ADD CONSTRAINT line_command_settings_command_key_check
  CHECK (command_key = ANY (ARRAY['today_job','tomorrow_job','this_week_job','next_week_job','issue_report','material_request','leave','check_in','check_out','site_photo','job_done_start','advance_request','advance_status','request_menu','request_status','payslip_request']));
