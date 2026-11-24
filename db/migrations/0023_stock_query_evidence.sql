-- 0023 — Evidência protegida da consulta pontual de estoque por placa.
--
-- A resposta integral permanece cifrada. A projeção pública minimizada é
-- produzida pela aplicação e nunca persiste dados documentais em texto claro.

alter table renave.protected_evidence
  drop constraint protected_evidence_action_valid;

alter table renave.protected_evidence
  add constraint protected_evidence_action_valid check (
    action in (
      'renave.identity.verify',
      'renave.stock.read',
      'renave.vehicle.eligibility.read'
    )
  );
