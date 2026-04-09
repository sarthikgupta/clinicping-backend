-- ClinicPing Database Schema
-- Run this in your Supabase SQL editor

-- Enable UUID extension
create extension if not exists "uuid-ossp";

-- ── CLINICS ──────────────────────────────────────────────────────────────────
create table clinics (
  id uuid primary key default uuid_generate_v4(),
  name text not null,
  doctor_name text not null,
  phone text not null unique,
  email text not null unique,
  password_hash text not null,
  city text default '',
  whatsapp_number text default '',
  plan text default 'starter' check (plan in ('starter','growth','multi')),
  is_active boolean default true,
  created_at timestamptz default now()
);

-- ── PATIENTS ─────────────────────────────────────────────────────────────────
create table patients (
  id uuid primary key default uuid_generate_v4(),
  clinic_id uuid references clinics(id) on delete cascade,
  name text not null,
  phone text not null,
  reason text default '',
  visit_count integer default 1,
  last_visit timestamptz default now(),
  created_at timestamptz default now()
);

create index idx_patients_clinic on patients(clinic_id);
create index idx_patients_phone on patients(phone);

-- ── QUEUE TOKENS ─────────────────────────────────────────────────────────────
create table queue_tokens (
  id uuid primary key default uuid_generate_v4(),
  clinic_id uuid references clinics(id) on delete cascade,
  patient_id uuid references patients(id) on delete cascade,
  token_number integer not null,
  status text default 'waiting' check (status in ('waiting','next','consulting','done','cancelled')),
  reason text default '',
  whatsapp_sent boolean default false,
  called_in_sent boolean default false,
  queue_date date default current_date,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create index idx_queue_clinic_date on queue_tokens(clinic_id, queue_date);
create index idx_queue_status on queue_tokens(status);

-- ── FOLLOW-UPS ────────────────────────────────────────────────────────────────
create table followups (
  id uuid primary key default uuid_generate_v4(),
  clinic_id uuid references clinics(id) on delete cascade,
  patient_id uuid references patients(id) on delete cascade,
  token_id uuid references queue_tokens(id) on delete set null,
  type text not null check (type in ('medicine','appointment','lab','wellness','custom')),
  message text not null,
  scheduled_at timestamptz not null,
  sent_at timestamptz,
  status text default 'pending' check (status in ('pending','sent','failed','cancelled')),
  patient_reply text,
  created_at timestamptz default now()
);

create index idx_followups_clinic on followups(clinic_id);
create index idx_followups_scheduled on followups(scheduled_at, status);

-- ── WHATSAPP MESSAGES LOG ────────────────────────────────────────────────────
create table whatsapp_logs (
  id uuid primary key default uuid_generate_v4(),
  clinic_id uuid references clinics(id) on delete cascade,
  patient_phone text not null,
  message_type text not null,
  message_body text not null,
  interakt_message_id text,
  status text default 'sent',
  created_at timestamptz default now()
);

-- ── ROW LEVEL SECURITY ───────────────────────────────────────────────────────
alter table clinics enable row level security;
alter table patients enable row level security;
alter table queue_tokens enable row level security;
alter table followups enable row level security;
alter table whatsapp_logs enable row level security;

-- Service role bypasses RLS (backend uses service key)
-- All data access is controlled via JWT in the backend

-- ── HELPER FUNCTION: next token number ───────────────────────────────────────
create or replace function get_next_token(p_clinic_id uuid)
returns integer as $$
  select coalesce(max(token_number), 0) + 1
  from queue_tokens
  where clinic_id = p_clinic_id
    and queue_date = current_date;
$$ language sql;
