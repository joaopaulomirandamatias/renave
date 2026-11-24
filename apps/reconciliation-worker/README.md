# Worker de reconciliação RENAVE

O processo é restrito à homologação e nasce desabilitado. A execução exige
`RENAVE_RECONCILIATION_WORKER_ENABLED=true` e
`RENAVE_RECONCILIATION_WORKER_DRY_RUN=false`. Sem a segunda opção, o processo
somente atesta papel/contrato do banco, certificado mTLS e uma amostra cifrada
determinística por ID de chave pendente; não reivindica outbox nem chama o
SERPRO.

O preflight é deliberadamente fail-closed e limitado. Ele não valida todo o
backlog: autentica somente uma amostra estável por `projection_key_id`. Se essa
amostra estiver corrompida, ausente no keyring ou incompatível, a readiness fica
indisponível e nenhum claim é feito. O caso exige intervenção para corrigir a
chave ou o registro; o worker não ignora a amostra e não reclassifica a operação.

Em execução, `/health` e `/ready` escutam apenas em `127.0.0.1`. A readiness é
revalidada antes de cada ciclo. Perda do contrato do papel, certificado inválido,
erro de pool ou falha na amostra bloqueiam novos claims.
