CREATE TYPE "public"."audit_actor" AS ENUM('user', 'admin', 'system', 'link');--> statement-breakpoint
CREATE TYPE "public"."blocklist_reason" AS ENUM('malware', 'csam', 'dmca', 'admin');--> statement-breakpoint
CREATE TYPE "public"."dmca_received_via" AS ENUM('email', 'form', 'post');--> statement-breakpoint
CREATE TYPE "public"."dmca_status" AS ENUM('received', 'incomplete', 'rejected', 'actioned', 'counter_received', 'restored', 'upheld', 'withdrawn', 'closed');--> statement-breakpoint
CREATE TYPE "public"."email_window_kind" AS ENUM('hour', 'day');--> statement-breakpoint
CREATE TYPE "public"."ledger_subject" AS ENUM('user', 'link', 'ip', 'upload_user', 'upload_editor', 'transform_user', 'share_user', 'link_user', 'signup_ip', 'signup_ip24', 'signup_asn', 'signup_domain', 'ip24', 'asn', 'email');--> statement-breakpoint
CREATE TYPE "public"."link_outcome" AS ENUM('ok', 'denied_password', 'denied_expired', 'denied_cap', 'denied_paused', 'denied_scan', 'denied_owner');--> statement-breakpoint
CREATE TYPE "public"."node_kind" AS ENUM('file', 'folder');--> statement-breakpoint
CREATE TYPE "public"."pref_density" AS ENUM('compact', 'comfortable');--> statement-breakpoint
CREATE TYPE "public"."pref_theme" AS ENUM('system', 'light', 'dark');--> statement-breakpoint
CREATE TYPE "public"."pref_view_mode" AS ENUM('list', 'grid');--> statement-breakpoint
CREATE TYPE "public"."report_category" AS ENUM('malware', 'csam', 'copyright', 'phishing', 'spam', 'other');--> statement-breakpoint
CREATE TYPE "public"."report_source" AS ENUM('user', 'system', 'admin', 'photodna');--> statement-breakpoint
CREATE TYPE "public"."report_status" AS ENUM('open', 'reviewing', 'actioned', 'dismissed');--> statement-breakpoint
CREATE TYPE "public"."scan_job_status" AS ENUM('running', 'done', 'failed');--> statement-breakpoint
CREATE TYPE "public"."scan_status" AS ENUM('pending', 'clean', 'infected', 'suspected_csam', 'under_review', 'skipped', 'error');--> statement-breakpoint
CREATE TYPE "public"."share_role" AS ENUM('viewer', 'editor');--> statement-breakpoint
CREATE TYPE "public"."strike_kind" AS ENUM('dmca', 'malware', 'abuse');--> statement-breakpoint
CREATE TYPE "public"."takedown_reason" AS ENUM('dmca', 'abuse', 'csam', 'admin');--> statement-breakpoint
CREATE TYPE "public"."upload_purpose" AS ENUM('file', 'avatar');--> statement-breakpoint
CREATE TYPE "public"."upload_status" AS ENUM('open', 'completing', 'done', 'aborted');--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" uuid PRIMARY KEY NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"actor_user_id" text,
	"actor_type" "audit_actor" NOT NULL,
	"action" text NOT NULL,
	"target_type" text,
	"target_id" text,
	"ip_hash_daily" text,
	"ua" text,
	"country" text,
	"request_id" text,
	"meta" jsonb
);
--> statement-breakpoint
CREATE TABLE "dmca_notice_nodes" (
	"notice_id" uuid NOT NULL,
	"node_id" uuid NOT NULL,
	"node_name" text,
	"sha256" text,
	CONSTRAINT "dmca_notice_nodes_notice_id_node_id_pk" PRIMARY KEY("notice_id","node_id")
);
--> statement-breakpoint
CREATE TABLE "dmca_notices" (
	"id" uuid PRIMARY KEY NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"received_via" "dmca_received_via" NOT NULL,
	"complainant_name" text,
	"complainant_org" text,
	"complainant_address" text,
	"complainant_phone" text,
	"complainant_email" "citext",
	"work_description" text,
	"infringing_description" text,
	"statement_good_faith" boolean DEFAULT false NOT NULL,
	"statement_accuracy" boolean DEFAULT false NOT NULL,
	"signature" text,
	"raw_text" text,
	"checklist" jsonb,
	"status" "dmca_status" DEFAULT 'received' NOT NULL,
	"handled_by" text,
	"takedown_at" timestamp with time zone,
	"owner_notified_at" timestamp with time zone,
	"strike_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"counter_received_at" timestamp with time zone,
	"counter_name" text,
	"counter_address" text,
	"counter_phone" text,
	"counter_email" "citext",
	"counter_statement" text,
	"counter_consent_jurisdiction" boolean,
	"counter_signature" text,
	"counter_forwarded_at" timestamp with time zone,
	"restore_not_before" timestamp with time zone,
	"restore_not_after" timestamp with time zone,
	"lawsuit_notice_at" timestamp with time zone,
	"restored_at" timestamp with time zone,
	"restored_by" text
);
--> statement-breakpoint
CREATE TABLE "download_ledger" (
	"day" date NOT NULL,
	"subject_type" "ledger_subject" NOT NULL,
	"subject_id" text NOT NULL,
	"bytes" bigint DEFAULT 0 NOT NULL,
	"count" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "download_ledger_day_subject_type_subject_id_pk" PRIMARY KEY("day","subject_type","subject_id")
);
--> statement-breakpoint
CREATE TABLE "email_ledger" (
	"window_kind" "email_window_kind" NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"recipient_hash" text NOT NULL,
	"count" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "email_ledger_window_kind_window_start_recipient_hash_pk" PRIMARY KEY("window_kind","window_start","recipient_hash")
);
--> statement-breakpoint
CREATE TABLE "hash_blocklist" (
	"sha256" text PRIMARY KEY NOT NULL,
	"reason" "blocklist_reason" NOT NULL,
	"source_node_id" uuid,
	"added_by" text,
	"added_at" timestamp with time zone DEFAULT now() NOT NULL,
	"note" text
);
--> statement-breakpoint
CREATE TABLE "invites" (
	"code" text PRIMARY KEY NOT NULL,
	"created_by" text,
	"max_uses" integer DEFAULT 1 NOT NULL,
	"uses" integer DEFAULT 0 NOT NULL,
	"expires_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "link_access_log" (
	"id" uuid PRIMARY KEY NOT NULL,
	"link_id" uuid NOT NULL,
	"node_id" uuid,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"ip_hash_daily" text,
	"country" text,
	"ua_hash" text,
	"bytes" bigint DEFAULT 0 NOT NULL,
	"outcome" "link_outcome" NOT NULL
);
--> statement-breakpoint
CREATE TABLE "link_password_attempts" (
	"link_id" uuid NOT NULL,
	"ip_hash_stable" text NOT NULL,
	"failures" integer DEFAULT 0 NOT NULL,
	"last_failure_at" timestamp with time zone DEFAULT now() NOT NULL,
	"locked_until" timestamp with time zone,
	CONSTRAINT "link_password_attempts_link_id_ip_hash_stable_pk" PRIMARY KEY("link_id","ip_hash_stable")
);
--> statement-breakpoint
CREATE TABLE "node_versions" (
	"node_id" uuid NOT NULL,
	"version_id" text NOT NULL,
	"r2_key" text NOT NULL,
	"size" bigint NOT NULL,
	"sha256" text,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"purge_after" timestamp with time zone NOT NULL,
	CONSTRAINT "node_versions_node_id_version_id_pk" PRIMARY KEY("node_id","version_id")
);
--> statement-breakpoint
CREATE TABLE "nodes" (
	"id" uuid PRIMARY KEY NOT NULL,
	"owner_id" text NOT NULL,
	"created_by" text,
	"parent_id" uuid,
	"kind" "node_kind" NOT NULL,
	"name" text NOT NULL,
	"name_key" text NOT NULL,
	"ext" text DEFAULT '' NOT NULL,
	"system" text,
	"size" bigint DEFAULT 0 NOT NULL,
	"mime_declared" text,
	"mime_sniffed" text,
	"r2_key" text,
	"version_id" text,
	"sha256" text,
	"scan_status" "scan_status" DEFAULT 'pending' NOT NULL,
	"scan_status_prev" "scan_status",
	"scan_reason" text,
	"scan_detail" jsonb,
	"scanned_at" timestamp with time zone,
	"rescan_requested_at" timestamp with time zone,
	"deleted_at" timestamp with time zone,
	"trashed_root" boolean DEFAULT false NOT NULL,
	"trashed_by" text,
	"purge_after" timestamp with time zone,
	"purge_requested_at" timestamp with time zone,
	"legal_hold" boolean DEFAULT false NOT NULL,
	"takedown_at" timestamp with time zone,
	"takedown_reason" "takedown_reason",
	"takedown_by" text,
	"starred" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_accessed_at" timestamp with time zone,
	CONSTRAINT "nodes_scan_reason_known" CHECK (scan_reason IS NULL OR scan_reason IN ('size', 'encrypted', 'limits', 'timeout', 'engine', 'hash_mismatch'))
);
--> statement-breakpoint
CREATE TABLE "pending_user_purges" (
	"user_id" text PRIMARY KEY NOT NULL,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"scheduled_for" timestamp with time zone NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"attempts" integer DEFAULT 0 NOT NULL,
	"error" text
);
--> statement-breakpoint
CREATE TABLE "reports" (
	"id" uuid PRIMARY KEY NOT NULL,
	"node_id" uuid,
	"link_id" uuid,
	"owner_id" text,
	"category" "report_category" NOT NULL,
	"source" "report_source" NOT NULL,
	"reporter_email" "citext",
	"reporter_user_id" text,
	"reporter_ip_hash_stable" text,
	"details" text,
	"status" "report_status" DEFAULT 'open' NOT NULL,
	"assigned_to" text,
	"resolution" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone,
	"ncmec_started_at" timestamp with time zone,
	"ncmec_filed_at" timestamp with time zone,
	"ncmec_report_id" text
);
--> statement-breakpoint
CREATE TABLE "scan_jobs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"node_id" uuid NOT NULL,
	"r2_key" text NOT NULL,
	"etag" text,
	"attempt" integer DEFAULT 1 NOT NULL,
	"status" "scan_job_status" DEFAULT 'running' NOT NULL,
	"engine" text,
	"verdict" jsonb,
	"last_error" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	CONSTRAINT "scan_jobs_r2_key_uq" UNIQUE("r2_key")
);
--> statement-breakpoint
CREATE TABLE "settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"updated_by" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "share_links" (
	"id" uuid PRIMARY KEY NOT NULL,
	"node_id" uuid NOT NULL,
	"created_by" text NOT NULL,
	"token_hash" text NOT NULL,
	"token_enc" "bytea" NOT NULL,
	"token_iv" "bytea" NOT NULL,
	"token_key_version" smallint DEFAULT 1 NOT NULL,
	"password_hash" text,
	"expires_at" timestamp with time zone,
	"max_downloads" integer,
	"download_count" integer DEFAULT 0 NOT NULL,
	"bytes_served" bigint DEFAULT 0 NOT NULL,
	"allow_preview" boolean DEFAULT true NOT NULL,
	"revoked_at" timestamp with time zone,
	"paused_at" timestamp with time zone,
	"pause_reasons" text[] DEFAULT '{}'::text[] NOT NULL,
	"locked_by_admin" boolean DEFAULT false NOT NULL,
	"last_pause_email_at" timestamp with time zone,
	"last_access_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "share_links_token_hash_uq" UNIQUE("token_hash"),
	CONSTRAINT "share_links_pause_reasons_known" CHECK (pause_reasons <@ ARRAY['ceiling', 'anomaly', 'owner', 'owner_deletion', 'owner_suspended', 'report', 'moderation']::text[]),
	CONSTRAINT "share_links_paused_at_matches" CHECK ((paused_at IS NULL) = (cardinality(pause_reasons) = 0))
);
--> statement-breakpoint
CREATE TABLE "shares" (
	"id" uuid PRIMARY KEY NOT NULL,
	"node_id" uuid NOT NULL,
	"granted_by" text,
	"grantee_email" "citext" NOT NULL,
	"grantee_user_id" text,
	"activated_at" timestamp with time zone,
	"role" "share_role" NOT NULL,
	"can_upload" boolean DEFAULT true NOT NULL,
	"muted_by_grantee" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "strikes" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"kind" "strike_kind" NOT NULL,
	"report_id" uuid,
	"node_id" uuid,
	"issued_by" text,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"note" text,
	"lifted_at" timestamp with time zone,
	"lifted_by" text
);
--> statement-breakpoint
CREATE TABLE "upload_ips" (
	"id" uuid PRIMARY KEY NOT NULL,
	"node_id" uuid NOT NULL,
	"version_id" text NOT NULL,
	"uploader_id" text NOT NULL,
	"ip_encrypted" "bytea" NOT NULL,
	"iv" "bytea" NOT NULL,
	"key_version" smallint NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"legal_hold" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "upload_parts" (
	"upload_id" uuid NOT NULL,
	"part_number" integer NOT NULL,
	"etag" text NOT NULL,
	"size" bigint NOT NULL,
	CONSTRAINT "upload_parts_upload_id_part_number_pk" PRIMARY KEY("upload_id","part_number")
);
--> statement-breakpoint
CREATE TABLE "uploads" (
	"id" uuid PRIMARY KEY NOT NULL,
	"owner_id" text NOT NULL,
	"uploader_id" text NOT NULL,
	"parent_id" uuid,
	"node_id" uuid NOT NULL,
	"version_id" text NOT NULL,
	"replace_node_id" uuid,
	"name" text NOT NULL,
	"name_key" text NOT NULL,
	"size" bigint NOT NULL,
	"mime_declared" text,
	"r2_key" text NOT NULL,
	"r2_upload_id" text,
	"part_bytes" integer,
	"part_count" integer,
	"expected_sha256" text,
	"status" "upload_status" DEFAULT 'open' NOT NULL,
	"purpose" "upload_purpose" DEFAULT 'file' NOT NULL,
	"file_last_modified" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"completing_at" timestamp with time zone,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "user_prefs" (
	"user_id" text PRIMARY KEY NOT NULL,
	"density" "pref_density" DEFAULT 'compact' NOT NULL,
	"theme" "pref_theme" DEFAULT 'system' NOT NULL,
	"view_mode" "pref_view_mode" DEFAULT 'list' NOT NULL,
	"email_shares" boolean DEFAULT true NOT NULL,
	"email_link_digest" boolean DEFAULT true NOT NULL,
	"email_security" boolean DEFAULT true NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "account" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"user_id" text NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"id_token" text,
	"access_token_expires_at" timestamp,
	"refresh_token_expires_at" timestamp,
	"scope" text,
	"password" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE "passkey" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text,
	"public_key" text NOT NULL,
	"user_id" text NOT NULL,
	"credential_id" text NOT NULL,
	"counter" integer NOT NULL,
	"device_type" text NOT NULL,
	"backed_up" boolean NOT NULL,
	"transports" text,
	"created_at" timestamp,
	"aaguid" text
);
--> statement-breakpoint
CREATE TABLE "rate_limit" (
	"id" text PRIMARY KEY NOT NULL,
	"key" text NOT NULL,
	"count" integer NOT NULL,
	"last_request" bigint NOT NULL,
	CONSTRAINT "rate_limit_key_unique" UNIQUE("key")
);
--> statement-breakpoint
CREATE TABLE "session" (
	"id" text PRIMARY KEY NOT NULL,
	"expires_at" timestamp NOT NULL,
	"token" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"user_id" text NOT NULL,
	"impersonated_by" text,
	"country" text,
	"ua_family" text,
	CONSTRAINT "session_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "two_factor" (
	"id" text PRIMARY KEY NOT NULL,
	"secret" text NOT NULL,
	"backup_codes" text NOT NULL,
	"user_id" text NOT NULL,
	"verified" boolean DEFAULT true,
	"failed_verification_count" integer DEFAULT 0,
	"locked_until" timestamp
);
--> statement-breakpoint
CREATE TABLE "user" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"email_verified" boolean DEFAULT false NOT NULL,
	"image" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"two_factor_enabled" boolean DEFAULT false,
	"role" text,
	"banned" boolean DEFAULT false,
	"ban_reason" text,
	"ban_expires" timestamp,
	"quota_bytes" bigint DEFAULT 5368709120 NOT NULL,
	"used_bytes" bigint DEFAULT 0 NOT NULL,
	"age_verified_at" timestamp,
	"terms_accepted_at" timestamp,
	"terms_version" text,
	"invited_by" text,
	"suspended_at" timestamp,
	"suspended_reason" text,
	"legal_hold" boolean DEFAULT false NOT NULL,
	"delete_scheduled_at" timestamp,
	"display_name_key" text,
	"timezone" text,
	"locale" text DEFAULT 'en' NOT NULL,
	"avatar_node_id" text,
	CONSTRAINT "user_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "verification" (
	"id" text PRIMARY KEY NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "dmca_notice_nodes" ADD CONSTRAINT "dmca_notice_nodes_notice_id_dmca_notices_id_fk" FOREIGN KEY ("notice_id") REFERENCES "public"."dmca_notices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dmca_notices" ADD CONSTRAINT "dmca_notices_handled_by_user_id_fk" FOREIGN KEY ("handled_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dmca_notices" ADD CONSTRAINT "dmca_notices_strike_id_strikes_id_fk" FOREIGN KEY ("strike_id") REFERENCES "public"."strikes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dmca_notices" ADD CONSTRAINT "dmca_notices_restored_by_user_id_fk" FOREIGN KEY ("restored_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hash_blocklist" ADD CONSTRAINT "hash_blocklist_added_by_user_id_fk" FOREIGN KEY ("added_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invites" ADD CONSTRAINT "invites_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "link_access_log" ADD CONSTRAINT "link_access_log_link_id_share_links_id_fk" FOREIGN KEY ("link_id") REFERENCES "public"."share_links"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "link_password_attempts" ADD CONSTRAINT "link_password_attempts_link_id_share_links_id_fk" FOREIGN KEY ("link_id") REFERENCES "public"."share_links"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "node_versions" ADD CONSTRAINT "node_versions_node_id_nodes_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."nodes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "node_versions" ADD CONSTRAINT "node_versions_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "nodes" ADD CONSTRAINT "nodes_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "nodes" ADD CONSTRAINT "nodes_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "nodes" ADD CONSTRAINT "nodes_parent_id_nodes_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."nodes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "nodes" ADD CONSTRAINT "nodes_trashed_by_user_id_fk" FOREIGN KEY ("trashed_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "nodes" ADD CONSTRAINT "nodes_takedown_by_user_id_fk" FOREIGN KEY ("takedown_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reports" ADD CONSTRAINT "reports_node_id_nodes_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."nodes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reports" ADD CONSTRAINT "reports_link_id_share_links_id_fk" FOREIGN KEY ("link_id") REFERENCES "public"."share_links"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reports" ADD CONSTRAINT "reports_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reports" ADD CONSTRAINT "reports_reporter_user_id_user_id_fk" FOREIGN KEY ("reporter_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reports" ADD CONSTRAINT "reports_assigned_to_user_id_fk" FOREIGN KEY ("assigned_to") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scan_jobs" ADD CONSTRAINT "scan_jobs_node_id_nodes_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."nodes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settings" ADD CONSTRAINT "settings_updated_by_user_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "share_links" ADD CONSTRAINT "share_links_node_id_nodes_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."nodes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "share_links" ADD CONSTRAINT "share_links_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shares" ADD CONSTRAINT "shares_node_id_nodes_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."nodes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shares" ADD CONSTRAINT "shares_granted_by_user_id_fk" FOREIGN KEY ("granted_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shares" ADD CONSTRAINT "shares_grantee_user_id_user_id_fk" FOREIGN KEY ("grantee_user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "strikes" ADD CONSTRAINT "strikes_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "strikes" ADD CONSTRAINT "strikes_report_id_reports_id_fk" FOREIGN KEY ("report_id") REFERENCES "public"."reports"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "strikes" ADD CONSTRAINT "strikes_issued_by_user_id_fk" FOREIGN KEY ("issued_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "strikes" ADD CONSTRAINT "strikes_lifted_by_user_id_fk" FOREIGN KEY ("lifted_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "upload_parts" ADD CONSTRAINT "upload_parts_upload_id_uploads_id_fk" FOREIGN KEY ("upload_id") REFERENCES "public"."uploads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "uploads" ADD CONSTRAINT "uploads_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "uploads" ADD CONSTRAINT "uploads_uploader_id_user_id_fk" FOREIGN KEY ("uploader_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "uploads" ADD CONSTRAINT "uploads_parent_id_nodes_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."nodes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "uploads" ADD CONSTRAINT "uploads_replace_node_id_nodes_id_fk" FOREIGN KEY ("replace_node_id") REFERENCES "public"."nodes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_prefs" ADD CONSTRAINT "user_prefs_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account" ADD CONSTRAINT "account_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "passkey" ADD CONSTRAINT "passkey_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session" ADD CONSTRAINT "session_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "two_factor" ADD CONSTRAINT "two_factor_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_log_at_idx" ON "audit_log" USING btree ("at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "audit_log_actor_idx" ON "audit_log" USING btree ("actor_user_id","at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "audit_log_target_idx" ON "audit_log" USING btree ("target_type","target_id","at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "dmca_notice_nodes_node_idx" ON "dmca_notice_nodes" USING btree ("node_id");--> statement-breakpoint
CREATE INDEX "dmca_notices_status_idx" ON "dmca_notices" USING btree ("status","received_at");--> statement-breakpoint
CREATE INDEX "email_ledger_window_start_idx" ON "email_ledger" USING btree ("window_start");--> statement-breakpoint
CREATE INDEX "link_access_log_link_at_idx" ON "link_access_log" USING btree ("link_id","at");--> statement-breakpoint
CREATE INDEX "link_access_log_at_idx" ON "link_access_log" USING btree ("at");--> statement-breakpoint
CREATE INDEX "link_password_attempts_last_failure_idx" ON "link_password_attempts" USING btree ("last_failure_at");--> statement-breakpoint
CREATE INDEX "node_versions_purge_after_idx" ON "node_versions" USING btree ("purge_after");--> statement-breakpoint
CREATE INDEX "node_versions_r2_key_idx" ON "node_versions" USING btree ("r2_key");--> statement-breakpoint
CREATE UNIQUE INDEX "nodes_live_name_root_uq" ON "nodes" USING btree ("owner_id","name_key") WHERE parent_id IS NULL AND deleted_at IS NULL AND system IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "nodes_live_name_child_uq" ON "nodes" USING btree ("owner_id","parent_id","name_key") WHERE parent_id IS NOT NULL AND deleted_at IS NULL AND system IS NULL;--> statement-breakpoint
CREATE INDEX "nodes_children_name_idx" ON "nodes" USING btree ("parent_id","kind","name_key","id");--> statement-breakpoint
CREATE INDEX "nodes_children_size_idx" ON "nodes" USING btree ("parent_id","kind","size","id");--> statement-breakpoint
CREATE INDEX "nodes_children_updated_idx" ON "nodes" USING btree ("parent_id","kind","updated_at","id");--> statement-breakpoint
CREATE INDEX "nodes_children_ext_idx" ON "nodes" USING btree ("parent_id","kind","ext","name_key","id");--> statement-breakpoint
CREATE INDEX "nodes_root_name_idx" ON "nodes" USING btree ("owner_id","kind","name_key","id") WHERE parent_id IS NULL;--> statement-breakpoint
CREATE INDEX "nodes_owner_parent_idx" ON "nodes" USING btree ("owner_id","parent_id");--> statement-breakpoint
CREATE INDEX "nodes_owner_deleted_idx" ON "nodes" USING btree ("owner_id","deleted_at");--> statement-breakpoint
CREATE INDEX "nodes_owner_accessed_idx" ON "nodes" USING btree ("owner_id","last_accessed_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "nodes_owner_starred_idx" ON "nodes" USING btree ("owner_id") WHERE starred;--> statement-breakpoint
CREATE INDEX "nodes_purge_after_idx" ON "nodes" USING btree ("purge_after") WHERE trashed_root;--> statement-breakpoint
CREATE INDEX "nodes_purge_requested_idx" ON "nodes" USING btree ("purge_requested_at") WHERE purge_requested_at IS NOT NULL;--> statement-breakpoint
CREATE INDEX "nodes_sha256_idx" ON "nodes" USING btree ("sha256");--> statement-breakpoint
CREATE UNIQUE INDEX "nodes_r2_key_uq" ON "nodes" USING btree ("r2_key") WHERE r2_key IS NOT NULL;--> statement-breakpoint
CREATE INDEX "nodes_created_by_idx" ON "nodes" USING btree ("created_by","created_at");--> statement-breakpoint
CREATE INDEX "nodes_scan_status_idx" ON "nodes" USING btree ("scan_status") WHERE scan_status <> 'clean';--> statement-breakpoint
CREATE INDEX "nodes_takedown_idx" ON "nodes" USING btree ("takedown_at") WHERE takedown_at IS NOT NULL;--> statement-breakpoint
CREATE INDEX "nodes_name_trgm_idx" ON "nodes" USING gin ("name" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "pending_user_purges_due_idx" ON "pending_user_purges" USING btree ("scheduled_for");--> statement-breakpoint
CREATE UNIQUE INDEX "reports_open_dedupe_uq" ON "reports" USING btree ("node_id","reporter_ip_hash_stable","category") WHERE status IN ('open', 'reviewing');--> statement-breakpoint
CREATE INDEX "reports_status_created_idx" ON "reports" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "reports_node_idx" ON "reports" USING btree ("node_id");--> statement-breakpoint
CREATE INDEX "scan_jobs_node_idx" ON "scan_jobs" USING btree ("node_id");--> statement-breakpoint
CREATE INDEX "scan_jobs_status_started_idx" ON "scan_jobs" USING btree ("status","started_at");--> statement-breakpoint
CREATE INDEX "share_links_node_idx" ON "share_links" USING btree ("node_id");--> statement-breakpoint
CREATE INDEX "share_links_creator_idx" ON "share_links" USING btree ("created_by","created_at");--> statement-breakpoint
CREATE INDEX "share_links_paused_idx" ON "share_links" USING btree ("paused_at") WHERE paused_at IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "shares_node_email_uq" ON "shares" USING btree ("node_id","grantee_email");--> statement-breakpoint
CREATE UNIQUE INDEX "shares_node_user_uq" ON "shares" USING btree ("node_id","grantee_user_id");--> statement-breakpoint
CREATE INDEX "shares_grantee_user_idx" ON "shares" USING btree ("grantee_user_id");--> statement-breakpoint
CREATE INDEX "shares_pending_email_idx" ON "shares" USING btree ("grantee_email") WHERE grantee_user_id IS NULL;--> statement-breakpoint
CREATE INDEX "strikes_user_at_idx" ON "strikes" USING btree ("user_id","at");--> statement-breakpoint
CREATE INDEX "upload_ips_node_idx" ON "upload_ips" USING btree ("node_id");--> statement-breakpoint
CREATE INDEX "upload_ips_at_idx" ON "upload_ips" USING btree ("at");--> statement-breakpoint
CREATE INDEX "uploads_resume_idx" ON "uploads" USING btree ("uploader_id","parent_id","name_key","size","file_last_modified") WHERE status = 'open';--> statement-breakpoint
CREATE INDEX "uploads_uploader_status_idx" ON "uploads" USING btree ("uploader_id","status");--> statement-breakpoint
CREATE INDEX "uploads_owner_status_idx" ON "uploads" USING btree ("owner_id","status");--> statement-breakpoint
CREATE INDEX "uploads_status_expires_idx" ON "uploads" USING btree ("status","expires_at");--> statement-breakpoint
CREATE INDEX "uploads_parent_idx" ON "uploads" USING btree ("parent_id");--> statement-breakpoint
CREATE INDEX "uploads_r2_key_idx" ON "uploads" USING btree ("r2_key");--> statement-breakpoint
CREATE INDEX "account_userId_idx" ON "account" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "passkey_userId_idx" ON "passkey" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "passkey_credentialID_idx" ON "passkey" USING btree ("credential_id");--> statement-breakpoint
CREATE INDEX "session_userId_idx" ON "session" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "twoFactor_secret_idx" ON "two_factor" USING btree ("secret");--> statement-breakpoint
CREATE INDEX "twoFactor_userId_idx" ON "two_factor" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "verification_identifier_idx" ON "verification" USING btree ("identifier");