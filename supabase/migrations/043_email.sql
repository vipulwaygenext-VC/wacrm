-- ============================================================
-- 043_email.sql — email sending (Brevo), per account
--
-- * email_configs       one row per account: provider key (AES-256-GCM
--                       encrypted, like ai_configs.api_key), sender.
-- * email_messages      send log, one row per recipient per send.
-- * email_unsubscribes  addresses that opted out, per account. Every
--                       send skips these.
--
-- Writes to email_messages / email_unsubscribes happen through the
-- service role (API routes); members can read their account's rows.
-- ============================================================

CREATE TABLE IF NOT EXISTS email_configs (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id  uuid NOT NULL UNIQUE REFERENCES accounts(id) ON DELETE CASCADE,
  created_by  uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  provider    text NOT NULL DEFAULT 'brevo' CHECK (provider IN ('brevo')),
  api_key     text NOT NULL,              -- AES-256-GCM-encrypted provider key
  from_email  text NOT NULL,
  from_name   text NOT NULL,
  reply_to    text,
  footer_text text,                       -- address / business line shown above the unsubscribe link
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE email_configs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS email_configs_select ON email_configs;
CREATE POLICY email_configs_select ON email_configs FOR SELECT
  USING (is_account_member(account_id));

DROP POLICY IF EXISTS email_configs_insert ON email_configs;
CREATE POLICY email_configs_insert ON email_configs FOR INSERT
  WITH CHECK (is_account_member(account_id, 'admin'));

DROP POLICY IF EXISTS email_configs_update ON email_configs;
CREATE POLICY email_configs_update ON email_configs FOR UPDATE
  USING (is_account_member(account_id, 'admin'));

DROP POLICY IF EXISTS email_configs_delete ON email_configs;
CREATE POLICY email_configs_delete ON email_configs FOR DELETE
  USING (is_account_member(account_id, 'admin'));

CREATE OR REPLACE FUNCTION public.update_email_configs_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS email_configs_updated_at ON email_configs;
CREATE TRIGGER email_configs_updated_at
  BEFORE UPDATE ON email_configs
  FOR EACH ROW
  EXECUTE FUNCTION public.update_email_configs_updated_at();

CREATE TABLE IF NOT EXISTS email_messages (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id          uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  contact_id          uuid REFERENCES contacts(id) ON DELETE SET NULL,
  batch_id            uuid NOT NULL,      -- groups the rows of one send
  to_email            text NOT NULL,
  subject             text NOT NULL,
  status              text NOT NULL CHECK (status IN ('sent', 'failed', 'skipped')),
  skip_reason         text,               -- 'unsubscribed' | 'no_email' | 'invalid_email'
  error               text,
  provider_message_id text,
  sent_by             uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_email_messages_account_created
  ON email_messages(account_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_email_messages_contact
  ON email_messages(contact_id);

ALTER TABLE email_messages ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS email_messages_select ON email_messages;
CREATE POLICY email_messages_select ON email_messages FOR SELECT
  USING (is_account_member(account_id));

CREATE TABLE IF NOT EXISTS email_unsubscribes (
  account_id  uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  email       text NOT NULL,              -- stored lower-cased
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, email)
);

ALTER TABLE email_unsubscribes ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS email_unsubscribes_select ON email_unsubscribes;
CREATE POLICY email_unsubscribes_select ON email_unsubscribes FOR SELECT
  USING (is_account_member(account_id));
