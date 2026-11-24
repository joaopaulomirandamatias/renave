-- 0019 — Mantém o heartbeat do monitor barato com histórico crescente.

create index evidence_incident_open_detected_at_idx
  on renave_operations.evidence_incident (detected_at)
  where status = 'open';
