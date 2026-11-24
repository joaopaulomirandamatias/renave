# Deployment do worker de reconciliação

Estes manifests são uma referência fail-closed para homologação. Eles não criam
`Service`, `Ingress`, credenciais ou uma liberação ampla de Internet.

- `base/` mantém o `Deployment` em zero réplicas, desabilitado e em dry-run.
- `overlays/dry-run/` adiciona um `Job` de preflight offline em relação ao SERPRO.
- `overlays/canary/` ativa exatamente uma réplica, com estratégia `Recreate`.

O digest da imagem, o CIDR do PostgreSQL, o tenant, o CNPJ da integradora e o ID
da chave são sentinelas deliberadas. A validação descrita no runbook deve falhar
enquanto qualquer sentinela permanecer.

O material secreto é projetado em um único diretório fixo,
`/run/secrets/seu-renave/reconciliation-worker`. Nenhum valor secreto entra em
`env`. Não substitua esse contrato por `secretKeyRef`, wrapper shell ou caminho de
secret controlado por variável de ambiente.

O procedimento completo está em
[`docs/ops/reconciliation-worker-homologation.md`](../../docs/ops/reconciliation-worker-homologation.md).
