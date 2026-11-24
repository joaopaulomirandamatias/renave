-- 0018 — Evidência protegida do preflight de identidade RENAVE.
--
-- A estrutura criptográfica permanece a mesma; apenas a ação read-only de
-- verificação de vínculo passa a ser aceita pelo domínio da prova.

alter table renave.protected_evidence
  drop constraint protected_evidence_action_valid;

alter table renave.protected_evidence
  add constraint protected_evidence_action_valid check (
    action in (
      'renave.identity.verify',
      'renave.vehicle.eligibility.read'
    )
  );
