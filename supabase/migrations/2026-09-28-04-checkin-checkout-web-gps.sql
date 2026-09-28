-- supabase/migrations/2026-09-28-04-checkin-checkout-web-gps.sql
--
-- Moves เช็คอิน/เช็คเอาท์ off LINE's own native location-share picker
-- (which lets the sender drag the pin to any point on the map before
-- sending -- confirmed exploitable live: user checked in from ~685m
-- away by moving the shared pin) onto the SAME one-time-link pattern
-- already used for เบิกของ/ขอลา, whose destination page reads the
-- phone browser's real GPS via navigator.geolocation instead -- no
-- manual-placement UI exists for that permission prompt. Widens
-- line_deep_link_tokens.action_type (previously only material_request/
-- leave) to also allow check_in/check_out.

ALTER TABLE line_deep_link_tokens DROP CONSTRAINT line_deep_link_tokens_action_type_check;

ALTER TABLE line_deep_link_tokens ADD CONSTRAINT line_deep_link_tokens_action_type_check
  CHECK (action_type IN ('material_request', 'leave', 'check_in', 'check_out'));
