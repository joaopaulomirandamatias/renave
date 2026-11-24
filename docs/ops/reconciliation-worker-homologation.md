# Preparação do worker de reconciliação para homologação

Este runbook prepara o worker sem fazer deploy nem chamar o SERPRO. O objetivo é
manter a integração desabilitada até que imagem, segredos, banco, egress e
observabilidade tenham sido verificados de forma independente.

## Estado seguro e pré-condições

O estado-base em `deploy/reconciliation-worker/base` tem zero réplicas,
`RENAVE_RECONCILIATION_WORKER_ENABLED=false` e
`RENAVE_RECONCILIATION_WORKER_DRY_RUN=true`. O aplicativo exige ainda
`APP_ENVIRONMENT=homologation`. Não altere os três controles em uma única etapa.

O overlay de dry-run é um `Job`: ele atesta o papel do banco, a validade do
certificado e uma amostra cifrada por chave pendente, mas não reivindica outbox e
não chama o SERPRO. O overlay canary só pode ser usado depois desse Job terminar
com sucesso usando o mesmo digest de imagem e as mesmas versões de segredos.

O aplicativo lê o material secreto exclusivamente do diretório fixo
`/run/secrets/seu-renave/reconciliation-worker` e recusa os nomes antigos de
segredo em `env`. Não use `secretKeyRef`, wrapper shell, expansão de arquivo ou
caminho configurável para recolocar o valor secreto no ambiente do processo.

## Contrato da imagem

A imagem deve ser multi-stage e ter uma etapa de runtime mínima. São requisitos:

- Node compatível com a versão fixada pelo projeto e imagem-base presa por digest;
- instalação com lockfile congelado, sem scripts de instalação não autorizados;
- somente a closure de produção do worker, sem `.git`, `.env`, testes, fontes,
  mapas `.js.map`, compilador ou dependências de desenvolvimento;
- usuário numérico `10001:10001`, código root-owned e não gravável pelo worker;
- runtime distroless com Node em `/nodejs/bin/node`, usado por caminho absoluto
  nas probes `exec`;
- entrypoint exclusivo do worker, sem shell intermediário;
- nenhum segredo em layer, `ARG`, `ENV`, label, histórico, SBOM ou provenance;
- SBOM, scan de dependências e sistema operacional, assinatura e provenance
  verificados antes de liberar o digest.

O deploy sempre referencia `nome@sha256:<64-hex>`. Tags podem existir para
catálogo, mas não são autoridade de rollout ou rollback.

O CI já gera e valida um SBOM CycloneDX da imagem final do worker. A imagem é
exportada com `docker save` e lida por Syft non-root preso por digest, sem rede,
sem socket Docker, em filesystem read-only e sem capacidades. O SBOM temporário
é validado quanto a formato, raiz `container`, componentes e sentinelas e então
apagado. Scan de CVEs, assinatura e provenance permanecem obrigatórios antes de
qualquer publicação; este controle de inventário não os substitui.

## Contrato dos segredos montados

O cofre/CSI/operador externo cria os objetos abaixo. Os manifests não criam
`Secret` e não contêm valores de exemplo.

| Secret | Chaves esperadas | Uso |
| --- | --- | --- |
| `renave-reconciliation-worker-database` | `database-url` | DSN do papel `renave_operation_worker` |
| `renave-reconciliation-worker-postgres-ca` | `database-ca.pem` | CA exclusiva do PostgreSQL remoto |
| `renave-reconciliation-worker-crypto` | `projection-keys.json`, `limiter-hmac-key` | keyring das projeções e HMAC distinto |
| `renave-reconciliation-worker-mtls` | `mtls-ca.pem`, `mtls-cert.pem`, `mtls-key.pem` | mTLS de homologação |
| `renave-reconciliation-worker-mtls-passphrase` | `mtls-passphrase` | opcional; somente para chave PEM cifrada |

Os volumes são read-only e usam modo `0440`, UID/GID do processo e `fsGroup`
`10001`. Não monte esses volumes em sidecars. Quando a plataforma usa volumes
projetados com symlinks atômicos, o caminho resolvido deve continuar dentro do
mount autorizado e apontar para arquivo regular. Desabilite core dumps, inspector,
heap snapshots e diagnostic reports.

O Secret de passphrase é opcional. Quando ausente, o arquivo não é projetado;
quando presente, precisa conter `mtls-passphrase`. A passphrase nunca entra em
`env`.

## Renderização e validação offline

Os comandos seguintes apenas renderizam e validam arquivos locais. Eles não fazem
deploy:

```bash
base_render="$(mktemp)"
dry_render="$(mktemp)"
canary_render="$(mktemp)"

kubectl kustomize deploy/reconciliation-worker/base > "$base_render"
kubectl kustomize deploy/reconciliation-worker/overlays/dry-run > "$dry_render"
kubectl kustomize deploy/reconciliation-worker/overlays/canary > "$canary_render"
```

`kubectl apply --dry-run=client` não é usado neste gate: dependendo da versão e
do kubeconfig, ele ainda tenta fazer discovery no API server. Para validação de
schema sem rede, use `kubeconform -strict` (ou equivalente) com schemas
Kubernetes previamente vendorizados e registre a versão/digest desses schemas.

Antes de promover, a verificação abaixo deve terminar sem encontrar sentinelas:

```bash
if rg -n \
  'REPLACE_|sha256:0{64}|192\.0\.2\.10/32|11111111-1111-4111-8111-111111111111|00000000000000' \
  "$canary_render"; then
  echo "sentinela de deployment ainda presente" >&2
  exit 1
fi

if rg -n 'secretKeyRef|secretRef|0\.0\.0\.0/0|::/0' "$canary_render"; then
  echo "segredo em env ou egress amplo detectado" >&2
  exit 1
fi

rg -n 'image: .+@sha256:[0-9a-f]{64}$' "$canary_render"
rg -n 'readOnlyRootFilesystem: true|allowPrivilegeEscalation: false|type: RuntimeDefault' "$canary_render"
```

O gate de schema offline e, posteriormente, o admission controller devem recusar:
imagem por tag, comando/args sobrescritos, UID zero, filesystem gravável,
capabilities, sidecar, host namespaces, `hostPath`, token de ServiceAccount, mais
de uma réplica ou qualquer `Secret` exposto por env.

## Egress

A `NetworkPolicy` incluída é somente uma base de defesa:

- nega todo ingress e egress do worker;
- libera apenas DNS do cluster e um CIDR/porta exatos do PostgreSQL;
- usa `192.0.2.10/32` (TEST-NET-1) para falhar até a substituição explícita;
- não libera o SERPRO e não cria `Service` ou `Ingress`.

NetworkPolicy Kubernetes nativa não filtra FQDN. Antes do canary, a plataforma
precisa apresentar evidência de uma política externa fail-closed que permita
somente `hom.renave.estaleiro.serpro.gov.br:443`, mantendo TLS/mTLS ponta a ponta.
Não use `0.0.0.0/0:443`, não permita o host de produção e não termine mTLS em
proxy. Bloqueie também metadata service, API Kubernetes e demais redes internas.

Valide o controle em endpoints próprios da plataforma. A preparação não exige e
não autoriza uma chamada real ao SERPRO.

O seletor de DNS do exemplo pressupõe CoreDNS com `k8s-app=kube-dns`. Ajuste-o ao
cluster e teste UDP e TCP. Para NodeLocal DNS ou PostgreSQL com IP dinâmico, use
política suportada pela plataforma; não amplie o CIDR como atalho.

## Sequência dry-run, canary e expansão

1. Publique e verifique uma imagem imutável por digest.
2. Substitua todas as sentinelas por um único tenant real de homologação, CNPJ da
   integradora, key ID e CIDR/porta do banco. Lista vazia, `*`, CIDR amplo e tenant
   curinga são proibidos.
3. Materialize versões imutáveis dos quatro Secrets e confirme modo, owner e
   mounts. O DSN deve usar somente `renave_operation_worker`.
4. Mantenha o egress SERPRO negado e execute o overlay `dry-run`. O Job tem
   `backoffLimit: 0`; falha exige diagnóstico, não repetição automática.
5. Aceite apenas conclusão `Complete`, evento sanitizado `dry_run_ready`, role
   attestation válida, certificado dentro da validade e cobertura de todas as
   chaves pendentes.
6. Habilite o controle FQDN externo de homologação e aplique o overlay canary com
   o mesmo digest e segredos. Ele usa uma réplica e estratégia `Recreate`.
7. Confirme `/health` e `/ready` pelas probes `exec` em loopback. Não altere o
   listener para `0.0.0.0` apenas para atender probes.
8. Observe quota, latência, readiness e eventos sanitizados. Expanda somente
   acrescentando UUIDs exatos à allowlist, em mudança revisada.

Não configure HPA. O UID do Pod alimenta `RENAVE_RECONCILIATION_LEASE_OWNER`, o
que evita owner estático compartilhado. Admission policy deve impedir um segundo
Deployment para o mesmo conjunto de tenants.

## Kill switch e rollback

O kill switch operacional é, nesta ordem:

1. revogar o egress FQDN do SERPRO ou aplicar deny egress emergencial;
2. escalar o Deployment para zero;
3. confirmar ausência de Pods e aguardar/reconciliar leases expirados.

Trocar apenas ConfigMap não para um processo em execução. Manter um Deployment
desabilitado com réplica maior que zero também causa restart loop, pois o processo
desabilitado termina normalmente.

Rollback nunca usa tag móvel nem downgrade automático de banco:

1. mantenha egress negado e réplicas em zero;
2. confirme que o digest anterior é compatível com o schema/migrations atuais;
3. confirme que seu keyring cobre cada `projection_key_id` pendente;
4. execute o digest anterior como novo dry-run Job;
5. somente após sucesso, recrie o canary de uma réplica e reabra o egress.

## Falhas e rotações

- **Amostra cifrada corrompida ou chave ausente:** readiness permanece falsa;
  não apague a amostra, não pule a chave e não reclassifique a operação. Corrija o
  registro/keyring pelo fluxo autorizado e repita o dry-run.
- **Certificado mTLS:** crie uma nova versão imutável do Secret, valide em dry-run
  e faça `Recreate`. Atualização do volume não troca o Agent já construído.
- **Keyring:** mantenha chaves antigas enquanto existir qualquer projeção pendente;
  a chave ativa é alterada separadamente e nunca reutiliza a chave HMAC.
- **Credencial/CA do banco:** rotacione em Secret versionado, dry-run e Recreate.
- **Clock:** os nós precisam de NTP monitorado e sem `CAP_SYS_TIME`; skew afeta
  certificado, leases e janela de reconciliação.

## Saúde, recursos e logs

O endpoint de saúde escuta apenas em `127.0.0.1`. Por isso as probes são `exec`
e usam Node dentro do container; um `httpGet` do kubelet ao Pod IP não é
equivalente. Liveness verifica somente processo/loop, enquanto readiness incorpora
preflight. Falha de banco, certificado ou keyring deve retirar readiness, não
produzir restart storm.

O manifesto define CPU/memória e 120 segundos para encerramento. Kubernetes não
oferece limite de PIDs portável no Pod spec; configure `podPidsLimit` no
kubelet/runtime ou política equivalente e registre a evidência. O filesystem deve
permanecer read-only; se surgir necessidade comprovada de `/tmp`, use tmpfs
`noexec,nosuid` com limite explícito.

Logs são JSON em stdout/stderr e não podem incluir CNPJ, placa, UUID de tenant ou
operação, URL/usuário do banco, PEM, passphrase, keyring, HMAC, resposta SERPRO ou
texto livre de exceção. Antes do canary, injete sentinelas em um ambiente isolado,
force falhas de startup/preflight e confirme ausência nos logs e eventos da
plataforma. Restrinja leitura de logs e defina retenção compatível com LGPD.

## Critério de liberação

Homologação ativa é permitida somente quando houver evidência de todos os itens:

- renderização sem sentinelas e validação estrita do manifesto;
- leitura do diretório fixo de secrets testada e zero segredo em env/imagem/log;
- imagem assinada, SBOM/provenance verificados e scan aprovado;
- Pod restricted, non-root, read-only e sem privilégios/token/sidecar;
- mounts e permissões dos segredos conferidos;
- egress DB/DNS exato e FQDN SERPRO externo, sem produção ou Internet ampla;
- dry-run bem-sucedido com o mesmo digest/configuração criptográfica;
- uma única réplica, `Recreate`, probes loopback e recursos/clock monitorados;
- kill switch e rollback ensaiados sem chamada real ao SERPRO.
