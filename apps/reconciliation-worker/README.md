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

## Segredos

Quando habilitado, o processo lê exclusivamente o diretório fixo
`/run/secrets/seu-renave/reconciliation-worker`. URL com credencial, chaves e
material mTLS não são aceitos em variáveis de ambiente. O mount deve conter:

| Arquivo | Obrigatório | Limite |
| --- | --- | ---: |
| `database-url` | sim | 4 KiB |
| `database-ca.pem` | para banco remoto | 256 KiB |
| `projection-keys.json` | sim | 64 KiB |
| `limiter-hmac-key` | sim | 256 B |
| `mtls-ca.pem` | sim | 256 KiB |
| `mtls-cert.pem` | sim | 64 KiB |
| `mtls-key.pem` | sim | 64 KiB |
| `mtls-passphrase` | não | 4 KiB |

Arquivos regulares e symlinks atômicos de Kubernetes/Vault são aceitos. O alvo
final do symlink precisa ser um arquivo regular dentro do mesmo mount. Escape
para outro diretório, symlink quebrado, conteúdo vazio, limite excedido, NUL,
whitespace periférico ou mais de uma quebra de linha final falham fechado.
URL do banco, keyring, HMAC, chave mTLS e passphrase devem usar `0400` ou `0440`;
certificados e CAs podem usar também `0444`. Permissões de escrita, execução ou
leitura pública de material sensível são recusadas após a abertura do arquivo.

As variáveis não secretas continuam sendo:

- `APP_ENVIRONMENT=homologation`;
- `RENAVE_INTEGRATOR_CNPJ`;
- `RENAVE_RECONCILIATION_ACTIVE_PROJECTION_KEY_ID`;
- `RENAVE_RECONCILIATION_TENANT_ALLOWLIST`;
- `RENAVE_RECONCILIATION_LEASE_OWNER`;
- intervalos de heartbeat, poll e porta de health;
- as duas flags de ativação.

Durante rotação, `projection-keys.json` precisa manter as chaves históricas
referenciadas pelo backlog e indicar a chave nova pela variável de key ID. A
rotação é aplicada por restart controlado; não há hot reload.

## Imagem

O Dockerfile usa Node 26.13.1 pinado por digest no builder e uma imagem oficial
distroless Node 26 pinada por digest no runtime. A imagem final roda como
UID/GID `10001`; o código é propriedade de root, com diretórios `0555` e
arquivos `0444`. Ela não contém testes, fontes TypeScript do workspace, source
maps ou arquivos de segredo e aceita filesystem read-only.

Build a partir da raiz do monorepo:

```bash
docker build -f apps/reconciliation-worker/Dockerfile \
  -t seu-renave/reconciliation-worker:local .
```

O modo padrão não lê secrets nem abre banco, arquivo ou socket e encerra com
sucesso:

```bash
docker run --rm --network=none --read-only --cap-drop=ALL \
  --security-opt=no-new-privileges \
  seu-renave/reconciliation-worker:local
```

O dry-run deve ser executado como job one-shot, com o mount secreto read-only,
`ENABLED=true`, `DRY_RUN=true` e as variáveis não secretas. Ele precisa emitir
`dry_run_ready` e encerrar em zero antes de qualquer ativação real. Não configure
política de restart para o dry-run.

Somente depois dessa aprovação manual, um serviço de homologação pode usar
`DRY_RUN=false`. O serviço não publica porta: Docker usa o healthcheck interno e
orquestradores devem executar
`/nodejs/bin/node dist/health-probe.js health|ready` dentro do container. Envie
`SIGTERM` e aguarde o grace period antes de trocar imagem ou keyring. Rollback
escala o serviço para zero e volta ao digest anterior; nunca edita outbox
manualmente nem remove chave ainda referenciada.
