# Ciclo de vida do certificado mTLS ICP-Brasil

Este runbook define a operação completa do certificado cliente mTLS ICP-Brasil
usado na integração com o RENAVE-WS. Em homologação, a autenticação usa material
PEM provisionado pelo cofre em arquivos imutáveis; em produção, material PEM é
bloqueado por código (`PEM_MTLS_PRODUCTION_BLOCKED`) e exige chave não
exportável em HSM.

## Carregamento por arquivos de segredo

Os processos nunca leem certificado, CA, chave privada ou passphrase de
variáveis de ambiente, repositório, imagem, ConfigMap ou argumentos de linha de
comando.

| Workload | Diretório fixo de leitura | Arquivos mTLS esperados |
| --- | --- | --- |
| API (`@seu-renave/api`) | `/run/secrets/seu-renave/api/` | `mtls-ca.pem`, `mtls-cert.pem`, `mtls-key.pem`, `mtls-passphrase` (opcional) |
| Worker de reconciliação (`@seu-renave/reconciliation-worker-app`) | `/run/secrets/seu-renave/reconciliation-worker` | `mtls-ca.pem`, `mtls-cert.pem`, `mtls-key.pem`, `mtls-passphrase` (opcional) |

Regras de integridade do mount:

- os arquivos devem ser regulares, somente leitura, com permissão `0400` ou
  `0440` e acessíveis apenas ao UID/GID do processo (`10001:10001` nos
  manifests hardened);
- projeções atômicas do Kubernetes são aceitas apenas por meio de um único
  symlink `..data`, resolvido uma vez por carga para impedir mistura entre
  versões de Secret;
- fora de desenvolvimento, a API recusa variáveis de ambiente equivalentes aos
  arquivos de segredo antes mesmo de abrir o mount;
- o worker recusa incondicionalmente qualquer variável de ambiente legada
  (`RENAVE_MTLS_CA_FILE`, `RENAVE_MTLS_CERT_FILE`, `RENAVE_MTLS_KEY_FILE`,
  `RENAVE_MTLS_KEY_PASSPHRASE`) com `ReconciliationWorkerAppConfigError`;
- nunca monte os volumes mTLS em sidecars, init containers de depuração ou
  shells interativos;
- não registre conteúdo PEM, caminho completo de segredo ou impressão digital
  bruta em tickets, logs ou relatórios de mudança — registre apenas a versão
  lógica do Secret.

## Validação no startup

Ao construir o cliente mTLS de homologação (`createHomologationPemMtlsClient`),
o conector executa validação estrita antes de criar o `https.Agent`. Qualquer
falha aborta o startup em modo fail-closed com código fechado:

| Validação executada | Código de falha (`InvalidPemMtlsMaterialError`) |
| --- | --- |
| Parsing X.509 de cada certificado da cadeia CA (`mtls-ca.pem`) | `RENAVE_MTLS_CA_INVALID` |
| Parsing X.509 do certificado cliente (`mtls-cert.pem`) | `RENAVE_MTLS_CERT_INVALID` |
| Parsing da chave privada (`mtls-key.pem`) com `mtls-passphrase` se presente | `RENAVE_MTLS_KEY_INVALID` |
| Correspondência criptográfica certificado/chave (`checkPrivateKey`) | `RENAVE_MTLS_KEY_MISMATCH` |
| Relógio atual anterior a `validFromDate` | `RENAVE_MTLS_CERT_NOT_YET_VALID` |
| Relógio atual igual ou posterior a `validToDate` | `RENAVE_MTLS_CERT_EXPIRED` |
| Certificado marcado como CA (`certificate.ca === true`) ou EKU sem `id-kp-clientAuth` (`1.3.6.1.5.5.7.3.2`) | `RENAVE_MTLS_CERT_USAGE_INVALID` |
| Construção de `tls.createSecureContext` com `minVersion: "TLSv1.2"` | `RENAVE_MTLS_CERT_INVALID` |

## Monitoramento nas faixas 90/60/30/15/7/1 dia

O cliente mTLS expõe `getCertificateTemporalStatus(now)` com os estados:

- `healthy`: mais de 90 dias restantes;
- `expiring_90d`: até 90 dias restantes;
- `expiring_60d`: até 60 dias restantes;
- `expiring_30d`: até 30 dias restantes;
- `expiring_15d`: até 15 dias restantes;
- `expiring_7d`: até 7 dias restantes;
- `expiring_1d`: até 24 horas restantes;
- `expired`: validade encerrada (`remainingMilliseconds <= 0`);
- `not_yet_valid`: data atual anterior ao início de vigência;
- `invalid_clock`: relógio não finito.

Na API (`apps/api/src/server.ts`), `createCertificateExpiryMonitor` avalia o
status no startup e periodicamente (intervalo padrão de 1 hora —
`60 * 60 * 1_000` ms) usando `CertificateExpiryTracker` e emite apenas eventos
estruturados e sanitizados:

| Evento | Nível | Campos permitidos | Comportamento |
| --- | --- | --- | --- |
| `renave.mtls_certificate_expiring` | `warn` | `expiryBand` (`expiring_90d`..`expiring_1d`) | Emitido uma vez por faixa crescente (`WARNING_RANK` 1..6) na instância |
| `renave.mtls_certificate_invalid` | `error` | `certificateStatus` (`expired`, `not_yet_valid`, `invalid_clock`, `status_unavailable`) | Emitido na entrada em estado inválido; suprime duplicatas consecutivas do mesmo status na instância |
| `renave.mtls_certificate_recovered` | `info` | nenhum campo sensível | Emitido ao sair de estado inválido ou de aviso para `healthy` (ou de inválido para faixa de aviso) |

Se o logger falhar ao emitir um evento, o monitor preserva os eventos pendentes
em fila local e tenta reemiti-los na verificação seguinte, sem descartar a
transição.

### Deduplicação multi-réplica no agregador

O `CertificateExpiryTracker` mantém estado exclusivamente em memória por
processo — não há tabela compartilhada de supressão no banco. Em deploys com
múltiplas réplicas da API (ou após reinícios durante uma faixa de aviso), cada
réplica emitirá o mesmo evento `renave.mtls_certificate_expiring` ou
`renave.mtls_certificate_invalid`.

Configure o agregador de logs/alertas da plataforma para deduplicar alertas pela
chave composta:

- `(service, environment, event, expiryBand)` para avisos de vencimento;
- `(service, environment, event, certificateStatus)` para falhas de validade.

Regras de roteamento no agregador:

- **90 / 60 / 30 dias:** abrir ou atualizar tarefa planejada de renovação com
  deduplicação diária;
- **15 / 7 dias:** escalar para alerta operacional (SEV-3) com janela de
  relembrete controlada;
- **1 dia (`expiring_1d`):** alerta urgente (SEV-2) com acionamento imediato do
  owner;
- **`expired` / `not_yet_valid` / `invalid_clock` / `status_unavailable`:**
  alerta crítico imediato (SEV-2) vinculado ao fechamento do readiness.

## Fechamento do readiness na expiração

A expiração ou invalidade temporal do certificado fecha o readiness de forma
automática e fail-closed, sem exigir restart nem intervenção manual:

- **API:** `areRuntimeDependenciesReady` exige
  `databasesReady && (mtls?.isCertificateValidAt(now) ?? true)`. Assim que o
  certificado expira (ou se o relógio sair da janela de validade), a probe
  pública `/readiness` retorna não pronta (mantendo resposta mínima sem revelar
  qual dependência falhou) e o relatório autenticado de prontidão deixa de
  indicar estado pronto. Fluxos que dependem do certificado (como
  `stock-exit-runtime`) também verificam `isCertificateValidAt(now)` antes de
  operar.
- **Worker de reconciliação:** `runReconciliationLoop` executa `preflight` antes
  de cada ciclo serial. O `preflight` chama `isCertificateValidAt(new Date())`;
  quando falso, `readiness.ready` passa imediatamente para `false` na probe
  loopback `/ready` e nenhum ciclo `worker.runCycle` é executado. A liveness
  (`/health`) permanece de pé para evitar restart storm.

## Procedimento controlado de rotação com reinício

Atualizar apenas o volume montado **não** substitui o `https.Agent` nem o
`X509Certificate` já carregados em memória. Toda rotação exige nova versão
imutável de Secret e reinício controlado dos workloads.

Inicie a rotação preferencialmente ao entrar na faixa `expiring_30d` (nunca
depois de `expiring_7d`):

1. Emita o novo certificado ICP-Brasil com a Autoridade Certificadora e valide
   fora do cluster: cadeia CA de homologação, correspondência certificado/chave,
   EKU de autenticação de cliente (`1.3.6.1.5.5.7.3.2`) e vigência ativa.
2. Confirme no cadastro RENAVE/SERPRO de homologação que o novo certificado está
   habilitado para o CNPJ da integradora.
3. Publique uma **nova versão imutável** dos Secrets no cofre/CSI (sem
   sobrescrever a versão em uso caso seja necessário rollback imediato).
4. **Rotação na API:**
   - atualize a referência do Secret para a nova versão e execute reinício
     controlado;
   - confirme no relatório autenticado de prontidão que o certificado está
     `ready`, que `/readiness` voltou a responder pronto e que o evento
     `renave.mtls_certificate_recovered` (ou ausência de aviso) foi registrado;
   - valide uma consulta read-only em janela aprovada (ver
     [`api-homologation.md`](./api-homologation.md)).
5. **Rotação no worker de reconciliação:**
   - execute primeiro o overlay `dry-run` (`Job` com `backoffLimit: 0`) usando o
     mesmo digest de imagem e a nova versão do Secret, mantendo egress SERPRO
     negado;
   - aceite apenas conclusão `Complete` com evento sanitizado `dry_run_ready`;
   - atualize o overlay `canary` (1 réplica, estratégia `Recreate`) para a nova
     versão do Secret e confirme `/ready` pela probe loopback `exec`.
6. Após estabilização e confirmação de ausência de erros TLS/mTLS, revogue ou
   aposente o certificado anterior conforme política da AC e retenção de
   auditoria.

## Revogação emergencial

Em suspeita ou confirmação de comprometimento da chave privada, uso indevido ou
emissão incorreta, execute nesta ordem:

1. **Contenção de rede (kill switch):** revogue imediatamente o egress FQDN para
   `hom.renave.estaleiro.serpro.gov.br:443` na API e no worker.
2. **Interrupção dos workloads RENAVE:**
   - no worker, escale o Deployment para zero réplicas e aguarde expiração de
     leases ativos;
   - na API, remova a configuração RENAVE da revisão seguinte e reinicie de
     forma controlada para retornar a integração ao estado `disabled` mantendo o
     acesso SaaS disponível.
3. **Revogação criptográfica:** solicite revogação imediata do certificado junto
   à Autoridade Certificadora ICP-Brasil (publicação em LCR/OCSP) e notifique o
   SERPRO/RENAVE para bloqueio do vínculo do certificado comprometido.
4. **Preservação forense:** preserve banco, `renave.audit_event` (que registra o
   thumbprint lógico do certificado por operação), evidências cifradas e logs
   sanitizados. Nunca copie o PEM comprometido em tickets ou chats.
5. **Reemissão controlada:** gere nova chave privada em ambiente seguro, emita
   novo certificado, valide todo o procedimento de rotação acima (incluindo
   `dry-run` do worker) e só reabra o egress após aprovação do incidente.

## Validação TLS/CA e proibição de `--insecure` / trust-all

O transporte mTLS impõe controles não negociáveis em código:

- `rejectUnauthorized: true` e `minVersion: "TLSv1.2"` no `https.Agent` e no
  `SecureContext`;
- CA explícita e dedicada do endpoint de homologação (`mtls-ca.pem`);
- allowlist estrita de origem (`https://hom.renave.estaleiro.serpro.gov.br`) e
  rotas canônicas (`RenaveMtlsOriginError`), com `redirect: "error"` e corpo
  limitado a 2 MiB (`RENAVE_MTLS_RESPONSE_TOO_LARGE`);
- mTLS ponta a ponta entre o processo e o RENAVE-WS, sem terminação TLS em proxy
  intermediário.

É **expressamente proibido** (ADR 0002):

- usar `--insecure`, `curl -k`, `NODE_TLS_REJECT_UNAUTHORIZED=0`, desabilitar
  verificação de hostname ou aplicar trust-all para contornar falha TLS/CA;
- adicionar CAs genéricas ou de desenvolvimento ao bundle `mtls-ca.pem`;
- apontar o cliente de homologação para host de produção ou `0.0.0.0/0:443`.

Qualquer erro de handshake TLS ou cadeia CA deve ser tratado atualizando o
bundle oficial da CA por meio de nova versão imutável de Secret após validação
da cadeia ICP-Brasil/SERPRO.

## Sincronismo NTP

O relógio do sistema influencia diretamente a validação de `validFromDate` e
`validToDate`, a classificação das faixas de expiração, o fechamento do
readiness, as janelas da reconciliação (ADR 0002) e o TTL de promoções.

Requisitos obrigatórios nos nós que executam API, worker e PostgreSQL:

- serviço NTP/Chrony ativo, autenticado/redundante e monitorado pela plataforma;
- containers sem `CAP_SYS_TIME` (nenhum workload pode alterar o relógio do nó);
- alerta de drift de relógio antes de atingir desvios que afetem TTLs curtos ou
  bordas de janela (recomenda-se alerta de plataforma acima de 1 segundo e
  investigação imediata se houver divergência entre nó da aplicação e banco);
- se o monitor emitir `certificateStatus: "invalid_clock"` ou
  `certificateStatus: "not_yet_valid"` em certificado já vigente, trate primeiro
  o sincronismo NTP do nó antes de rotacionar qualquer material criptográfico.
