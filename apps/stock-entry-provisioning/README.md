# Provisionamento HELD_LOCAL

Aplicativo administrativo isolado para gerar o bundle criptográfico da entrada
de estoque, provisionar seu pin imutável e administrar candidatos a perfis
RENAVE. Não faz parte da imagem da API, não carrega certificado mTLS e não
conhece nenhum endpoint SERPRO.

Os comandos e a cerimônia obrigatória estão em
[`docs/ops/stock-entry-held-local-homologation.md`](../../docs/ops/stock-entry-held-local-homologation.md).

Staging, status e suspensão de perfis estão no runbook
[`docs/ops/renave-profile-administration.md`](../../docs/ops/renave-profile-administration.md).
Não existe comando de verificação ou promoção; o registro de provedores nasce
vazio e falha fechado. A consulta de status usa a role read-only
`renave_profile_reader`; staging e suspensão usam exclusivamente
`renave_profile_provisioner`.
