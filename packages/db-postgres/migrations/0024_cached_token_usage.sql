-- Persist provider-reported prompt-cache usage alongside ordinary token usage.
-- Existing sessions and invocations predate this accounting and safely start at
-- zero; runtime projections populate the fields for all subsequent turns.

ALTER TABLE oao.model_invocations
  ADD COLUMN cache_read_tokens bigint NOT NULL DEFAULT 0
    CHECK (cache_read_tokens >= 0),
  ADD COLUMN cache_write_tokens bigint NOT NULL DEFAULT 0
    CHECK (cache_write_tokens >= 0);

ALTER TABLE oao.session_summaries
  ADD COLUMN cache_read_tokens bigint NOT NULL DEFAULT 0
    CHECK (cache_read_tokens >= 0),
  ADD COLUMN cache_write_tokens bigint NOT NULL DEFAULT 0
    CHECK (cache_write_tokens >= 0);
