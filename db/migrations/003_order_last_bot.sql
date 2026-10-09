-- 003: remember which bot last held a re-queued order
--
-- When an attempt ends badly (bot failure, lost heartbeat, processing timeout) the order goes back
-- to QUEUED with assigned_bot_id = NULL. Without this column the very bot that just failed or hung
-- could claim it again straight away. Dispatch uses last_bot_id to give other bots the first chance.
ALTER TABLE orders ADD COLUMN last_bot_id TEXT REFERENCES oxide_bot_agents(id);
