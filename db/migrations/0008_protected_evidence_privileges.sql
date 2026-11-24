-- 0008 — Reduz leitura direta da evidência cifrada pelo runtime.
--
-- O adapter só precisa localizar uma linha pelo binding e estado para finalizar.
-- Leitura de ciphertext será uma porta privilegiada separada para auditoria.

revoke select on renave.protected_evidence from renave_app;
grant select (
  id,
  tenant_id,
  establishment_id,
  action,
  status
) on renave.protected_evidence to renave_app;
