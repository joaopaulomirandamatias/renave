# Observabilidade, alertas sanitizados e resposta a incidentes

Este runbook estabelece o catálogo de sinais sanitizados, a matriz de severidade
(SEV-1 a SEV-4) e os procedimentos de resposta a incidentes para indisponibilidade
externa (SERPRO/DETRAN), pendências do monitor de evidências e adulteração da
cadeia de hash de auditoria (ADR 0003).

## Política inviolável de sanitização (zero PII e zero segredo)

Nenhum log, métrica, trace, alerta, dashboard ou ticket operacional pode conter:

- **PII e identificadores regulatórios:** CPF, CNPJ, placa, RENAVAM, chassi,
  número ou código de segurança de CRV, endereço ou nome de operador/cliente;
- **Identificadores sensíveis de tenant/operação em logs abertos:** UUID de
  tenant, estabelecimento ou operação fora dos canais autenticados de auditoria;
- **Material criptográfico e credenciais:** PEM de certificado/chave/CA,
  passphrase, `evidence-keyring.json`, `projection-keys.json`, chaves HMAC,
  paths completos de Secret, DSN/usuário/senha de banco, tokens ou cookies;
- **Payloads externos:** respostas brutas ou mensagens livres retornadas pelo
  SERPRO/DETRAN (o conteúdo integral existe apenas na evidência cifrada AES-GCM
  referenciada por `pev1_<uuid>`).

Todo alerta deve apontar para o runbook correspondente e para um owner definido,
sem copiar o payload que disparou o evento.

## Catálogo de sinais e alertas sanitizados

### API (`@seu-renave/api`)

| Sinal / Fonte | Valores / Campos sanitizados | Significado operacional |
| --- | --- | --- |
| `renave.mtls_certificate_expiring` (`warn`) | `expiryBand`: `expiring_90d`, `expiring_60d`, `expiring_30d`, `expiring_15d`, `expiring_7d`, `expiring_1d` | Certificado mTLS entrou em faixa de vencimento; deduplicar no agregador por `(service, environment, event, expiryBand)` |
| `renave.mtls_certificate_invalid` (`error`) | `certificateStatus`: `expired`, `not_yet_valid`, `invalid_clock`, `status_unavailable` | Certificado mTLS inválido ou ilegível; readiness da API fecha automaticamente |
| `renave.mtls_certificate_recovered` (`info`) | nenhum campo adicional | Recuperação do estado temporal do certificado após rotação ou ajuste de relógio |
| Probes `/health` e `/readiness` | resposta mínima sem detalhar dependência | Liveness e readiness fail-closed da instância |
| Relatório autenticado de prontidão | `environment`, `integration`, `certificate`, `link`, `queries`, `mutations`, `operatorIdentity`, `establishmentContact` | Diagnóstico local autenticado sem chamada externa ao SERPRO |
| Limitadores (`429` com `Retry-After` / `503`) | código HTTP e rota | `429` indica saturação de cota (SERPRO ou console global); `503` indica falha fail-closed do limitador |

### Worker de reconciliação (`component: "renave-reconciliation-worker"`)

| Sinal / Fonte | Valores / Campos sanitizados | Significado operacional |
| --- | --- | --- |
| Eventos de lifecycle (`SanitizedWorkerLogger`) | `disabled`, `dry_run_ready`, `started`, `stopped`, `preflight_failed`, `failed` | Estado do processo; `preflight_failed` fecha `/ready` |
| Eventos de ciclo (`SanitizedWorkerLogger`) | `event`: `confirmed`, `manual_review`, `released`, `lease_lost`, `aborted`, `key_unavailable`; `attemptCount` | Desfecho sanitizado de cada iteração (sem tenantId/operationId) |
| Probes loopback `/health` e `/ready` (`127.0.0.1`) | exit code da probe `exec` via `/nodejs/bin/node` | Saúde do loop e prontidão do preflight/keyring/certificado |

### Monitor de evidências (`pnpm db:scan-evidence` / `pnpm db:status-evidence`)

| Sinal / Fonte | Valores / Campos sanitizados | Significado operacional |
| --- | --- | --- |
| Código de saída `0` | JSON `schemaVersion: 1` | Varredura/status concluído sem pendência acima do SLA |
| Código de saída `2` | `openIncidentCount`, `oldestPendingAgeSeconds`, `heartbeatStale` | Atenção operacional (incidente aberto, backlog ou heartbeat vencido); **não** tratar como queda do banco nem reiniciar em loop |
| Código de saída `1` | erro sanitizado de execução | Falha técnica ou de configuração do job/banco |

### Integridade da auditoria encadeada (ADR 0003)

| Sinal / Fonte | Verificação | Significado operacional |
| --- | --- | --- |
| `renave.verify_current_tenant_audit_chain()` (`verifyAuditChain`) | retorno booleano `valid` por tenant | `false` indica divergência entre `renave.audit_event` e `renave.audit_chain_head` (alteração, exclusão intermediária ou truncamento final) |

### Pré-validação e contrato SERPRO (offline)

| Sinal / Fonte | Verificação | Significado operacional |
| --- | --- | --- |
| `pnpm prehomologation:serpro` | códigos `0` (passou), `1` (falha de cenário/relatório), `2` (uso inválido) | Regressão no normalizador de impedimentos H-04..H-07 |
| `pnpm contract:serpro` | exit code | Mudança não reconciliada nos artefatos/contrato SERPRO |

## Matriz de severidade (SEV-1 a SEV-4)

| Severidade | Critérios de classificação | Tempo-alvo de resposta | Ações imediatas obrigatórias |
| --- | --- | --- | --- |
| **SEV-1 (Crítico / Segurança e Integridade)** | Adulteração detectada na cadeia de hash de auditoria (`valid = false`); exposição de PII ou segredo em log/alerta/repositório; comprometimento de chave privada mTLS, keyring ou chave Ed25519; qualquer tentativa/evidência de tráfego ou desbloqueio de produção | Imediato (`<= 15 min`), acionamento 24x7 de Segurança + Plataforma + Owner | Acionar kill switch (negar egress SERPRO, escalar worker a zero, congelar promoções), preservar evidências forenses, revogar credenciais/chaves afetadas |
| **SEV-2 (Alto / Indisponibilidade ou Risco Iminente)** | `renave.mtls_certificate_invalid` (`expired`, `not_yet_valid`, `invalid_clock`, `status_unavailable`); `expiring_1d`; `/readiness` fechado em homologação; `key_unavailable` ou `preflight_failed` persistente no worker; indisponibilidade generalizada SERPRO/DETRAN ou PostgreSQL; `503` contínuo no limitador | `<= 30 min` em janela operacional | Conter novas chamadas, iniciar diagnóstico no runbook específico (`certificate-lifecycle.md` ou `reconciliation-worker.md`) e registrar prova de causa externa se aplicável |
| **SEV-3 (Médio / Degradação ou Backlog)** | `expiring_15d` ou `expiring_7d`; monitor de evidências retornando código `2` persistente (`openIncidentCount > 0`, `heartbeatStale: true` ou crescimento de `oldestPendingAgeSeconds`); fila crescente de `MANUAL_REVIEW`; `lease_lost` recorrente | Próximo bloco útil (`<= 4 h`) | Executar triagem controlada, planejar rotação/ajuste e acompanhar drenagem do backlog |
| **SEV-4 (Baixo / Preventivo)** | `expiring_90d`, `expiring_60d` ou `expiring_30d`; saturação pontual `429` absorvida por `Retry-After`; falha isolada em checagem offline (`pnpm prehomologation:serpro` / `pnpm contract:serpro`) | Planejado (`<= 2 dias úteis`) | Abrir tarefa rastreada de manutenção/rotação preventiva |

## Registro de prova de causa externa (indisponibilidade SERPRO/DETRAN)

Quando falhas forem atribuíveis a instabilidade externa (HTTP 5xx, timeouts de
transporte, `DETRAN_UNAVAILABLE` ou onda de `RENAVE_MUTATION_OUTCOME_UNKNOWN`),
monte um registro probatório sanitizado para auditoria e gestão de SLA:

1. **Delimite a janela temporal em UTC:** registre `inicio_utc`, `fim_utc` e o
   ambiente (`homologation`).
2. **Classifique os sintomas por código fechado:** registre os códigos
   observados (ex.: `DETRAN_UNAVAILABLE`, `RENAVE_MUTATION_OUTCOME_UNKNOWN`,
   `RENAVE_RECONCILIATION_WINDOW_EXPIRED`, HTTP 5xx ou timeout), a família de
   endpoint afetada e a contagem agregada de ocorrências.
3. **Vincule apenas referências opacas:** liste as referências `pev1_<uuid>` das
   evidências protegidas e os IDs internos de incidentes abertos pelo monitor,
   **sem** copiar payloads brutos, CPF, CNPJ, placa ou RENAVAM.
4. **Anexe comprovação externa:** registre o número de chamado/protocolo aberto
   junto ao SERPRO ou comunicado oficial de indisponibilidade do DETRAN/SERPRO,
   junto com a confirmação de que a saúde local da API, do banco, do relógio NTP
   e do certificado mTLS permanecia normal na mesma janela.
5. **Conclua a reconciliação:** acompanhe todas as operações que entraram em
   `PENDING_RECONCILIATION` durante a janela até confirmação ou triagem formal
   em `MANUAL_REVIEW` (ver
   [`reconciliation-worker.md`](./reconciliation-worker.md)).

## Resposta a incidentes do monitor de evidências pendentes

O monitor de evidências (ver
[`monitor-de-evidencias.md`](./monitor-de-evidencias.md))
sinaliza evidências que permaneceram em `pending` além do SLA sem alterá-las nem
removê-las (ADR 0005).

1. **Classifique o código de saída:**
   - **Código `1`:** falha técnica ou de configuração do job (`pnpm db:scan-evidence`
     ou `pnpm db:status-evidence`). Verifique conectividade TLS, credencial do
     papel `renave_maintenance_app`, limites `EVIDENCE_MONITOR_BATCH_SIZE`
     (máx. `1000`) e `EVIDENCE_MONITOR_MAX_SILENCE_SECONDS` (máx. `86400`).
   - **Código `2`:** condição operacional legítima — **não** configure restart em
     loop no scheduler.
2. **Se `heartbeatStale: true`:** verifique se o scheduler externo parou, está
   preso em timeout menor que a janela de execução ou falhou com código `1` nas
   últimas rodadas.
3. **Se `openIncidentCount > 0` ou `oldestPendingAgeSeconds` crescente:**
   - correlacione a janela das pendências com quedas de processo, timeouts de rede
     ao SERPRO ou erros de escrita no PostgreSQL entre o início da consulta e a
     finalização `pending -> completed | failed`;
   - verifique se o incidente continua gerando novas pendências (problema ativo)
     ou se representa apenas tentativas interrompidas de uma janela passada;
   - **nunca** execute `DELETE`, `TRUNCATE` ou alteração direta na tabela de
     evidências (bloqueado por trigger e proibido pela ADR 0005), pois uma linha
     `pending` é prova de tentativa iniciada.
4. **Encerramento:** trate a causa raiz técnica ou externa, confirme a
   estabilização de `oldestPendingAgeSeconds` e valide que `pnpm db:status-evidence`
   retorna `0` após a resolução dos incidentes abertos.

## Resposta à detecção de adulteração da cadeia de hash de auditoria (ADR 0003)

Qualquer retorno `valid = false` em `renave.verify_current_tenant_audit_chain()`
(`verifyAuditChain`) caracteriza **SEV-1 imediato**. O verificador detecta
alteração de evento, exclusão intermediária e truncamento final comparando
`renave.audit_event` com `renave.audit_chain_head`.

Execute rigorosamente nesta ordem:

1. **Contenção imediata (kill switch):**
   - revogue o egress FQDN para `hom.renave.estaleiro.serpro.gov.br:443`;
   - escale o worker de reconciliação para zero réplicas;
   - suspenda qualquer cerimônia de promoção de operações
     ([`operation-promoter.md`](./operation-promoter.md));
   - desabilite a integração RENAVE na API mantendo a disponibilidade de
     diagnóstico controlado, se autorizado pela liderança de segurança.
2. **Preservação forense (somente leitura):**
   - gere snapshot imutável do banco de dados (incluindo `renave.audit_event`,
     `renave.audit_chain_head` e logs de WAL/auditoria do PostgreSQL) antes de
     qualquer ação de manutenção;
   - colete logs de acesso privilegiado (DBA, superuser, `migrator`, sessões
     administrativas do provedor de nuvem/cluster) referentes ao intervalo
     suspeito.
3. **Proibições durante investigação:**
   - **nunca** tente "consertar" a cadeia recalculando hashes ou editando
     `renave.audit_event` / `renave.audit_chain_head`;
   - **nunca** apague registros, faça reset de banco ou execute rollback
     destrutivo antes da liberação formal da investigação.
4. **Isolamento e revogação de acessos:** revogue credenciais administrativas
   ou de manutenção potencialmente comprometidas e rotacione segredos de banco e
   chaves HMAC/evidência após a contenção.
5. **Escopo da limitação de homologação (ADR 0003):** em homologação, a cabeça
   da cadeia (`renave.audit_chain_head`) reside no mesmo banco de dados; um
   administrador com privilégio suficiente para alterar simultaneamente eventos
   e cabeça poderia reescrever o histórico. A ancoragem periódica do último hash
   fora do banco em armazenamento WORM com relógio confiável permanece **gate
   obrigatório antes de produção**.
6. **Retomada:** o retorno à operação exige relatório formal de causa raiz,
   validação independente de integridade da base restaurada/saneada e nova
   execução completa dos gates pré-liberação.
