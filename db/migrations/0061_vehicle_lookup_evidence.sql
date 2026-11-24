-- 0061 — Evidência protegida da consulta veicular pontual.
--
-- A ação usa a mesma tabela cifrada, FK composta, RLS e política das demais
-- consultas RENAVE. Somente a allowlist fechada é ampliada; nenhuma ACL,
-- papel, provider, segredo ou transição de estado é alterado.

alter table renave.protected_evidence
  drop constraint protected_evidence_action_valid;

alter table renave.protected_evidence
  add constraint protected_evidence_action_valid check (
    action in (
      'renave.identity.verify',
      'renave.stock.read',
      'renave.vehicle.eligibility.read',
      'renave.vehicle.read'
    )
  );
