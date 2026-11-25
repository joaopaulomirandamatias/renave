# Operação do worker de reconciliação e resposta a resultado incerto

Este runbook cobre a operação em runtime do worker de reconciliação
(`@seu-renave/reconciliation-worker-app` /
`@seu-renave/renave-reconciliation-worker`) e a resposta operacional a operações
em estado incerto (`PENDING_RECONCILIATION`) e revisão humana (`MANUAL_REVIEW`).
Para preparação de imagem, manifests, Secrets, egress, `dry-run`, `canary`, kill
switch e rollback, consulte
[`reconciliation-worker-homologation.md`](./reconciliation-worker-homologation.md).

## Contexto operacional e ciclo serial

Quando uma mutação RENAVE termina com timeout, falha de transporte ou HTTP 5xx
após o envio, o transporte não executa retry e classifica o desfecho como
`RENAVE_MUTATION_OUTCOME_UNKNOWN` (ADR 0002). A operação entra em
`PENDING_RECONCILIATION` com o corpo original imutável e hash SHA-256
registrados.

O processo do worker opera em um loop estritamente serial sem overlap
(`runReconciliationLoop`):

1. **Preflight obrigatório antes de cada ciclo:** valida saúde do pool
   PostgreSQL, atesta o papel `renave_operation_worker` via
   `assertRuntimeDatabase`, verifica `isCertificateValidAt(new Date())` e
   confirma a disponibilidade e decifragem de uma amostra de projeção cifrada
   para cada `projection_key_id` pendente nos tenants da allowlist.
2. **Gate de readiness:** se o preflight falhar ou se `summary.keyUnavailable > 0`
   no ciclo, `readiness.ready` passa a `false` na probe loopback `/ready`,
   impedindo novos ciclos até recuperação sem provocar restart storm.
3. **Ciclo de reconciliação (`runCycle`):** reivindica no máximo `batchSize: 1`
   operação por vez, valida vínculo/identidade (`cnpj` e `cnpjIntegradora`) e
   consulta o RENAVE em modo estritamente somente leitura
   (`HomologationRenaveReadOnlyRequest`).
4. **Espera entre ciclos:** aguarda `RENAVE_RECONCILIATION_POLL_MS` (padrão
   `5000` ms; faixa permitida de `250` a `300000` ms) antes do próximo
   preflight.

## Agenda regulatória fixa (ADR 0002)

As leituras de reconciliação seguem uma agenda fixa e não configurável em
deslocamentos absolutos desde `sent_at`
(`RECONCILIATION_SCHEDULE_SECONDS = [60, 300, 900, 3_600]`):

| Janela | Deslocamento absoluto desde `sent_at` | Observação operacional |
| --- | --- | --- |
| 1ª leitura | `+1 min` (`60 s`) | Primeira verificação pós-envio |
| 2ª leitura | `+5 min` (`300 s`) | Segunda verificação |
| 3ª leitura | `+15 min` (`900 s`) | Terceira verificação |
| 4ª leitura (final) | `+60 min` (`3600 s`) | Última leitura permitida; limite do horizonte de candidatos |

Regras determinísticas de agendamento:

- `attempt_count` **não** seleciona a janela da agenda, porque também
  contabiliza retomadas de lease e falhas técnicas;
- quando uma execução ocorre atrasada, o worker agenda a primeira janela
  **estritamente futura** (por exemplo, uma observação `not_observed` aos 7
  minutos agenda diretamente a janela de 15 minutos);
- o adaptador envia o instante alvo absoluto e o SQL de liberação arredonda para
  cima em segundos, garantindo que `available_at` nunca anteceda o alvo;
- falhas do limitador (`limiterBackoff`: base `15 s`, máximo `300 s`) e falhas
  transitórias (`transientBackoff`: base `30 s`, máximo `600 s`) usam backoff
  exponencial determinístico **limitado ao teto absoluto `sent_at + 60 min`**
  (`boundedTechnicalRelease`), nunca ultrapassando o horizonte.

## Tolerância máxima de 5 minutos para iniciar a 4ª leitura

A 4ª leitura possui tolerância máxima de **5 minutos**
(`RECONCILIATION_FINAL_WINDOW_TOLERANCE_MS = 5 * 60 * 1_000`) para ser
**iniciada** após `sent_at + 60 min` (isto é, até `sent_at + 65 min`). Essa
margem existe apenas para absorver o maior intervalo operacional de polling
permitido (`300000` ms).

Restrições invioláveis:

- **a tolerância não amplia a janela de candidatos:** somente registros remotos
  com `dataHoraRegistro` (com fuso explícito `Z` ou `±hh:mm`) até
  `sent_at + 60 min` são elegíveis para confirmação automática;
- **sem rede após a tolerância:** se o worker reivindicar a operação após
  `sent_at + 65 min`, ele não realiza chamada ao RENAVE e encerra diretamente em
  `MANUAL_REVIEW` com motivo `RENAVE_RECONCILIATION_WINDOW_EXPIRED`.

## Proibição absoluta de 5ª leitura automática ou retry manual cego

- **Zero 5ª leitura automática:** se a tentativa final (em `sent_at + 60 min`,
  ou dentro da tolerância de início de 5 min) resultar em `not_observed`, erro
  transitório ou indisponibilidade do limitador, o worker encerra a operação em
  `MANUAL_REVIEW` com `RENAVE_RECONCILIATION_WINDOW_EXPIRED`. Não existe 5ª
  consulta automática ao RENAVE.
- **Zero retry manual cego:** é proibido reenviar uma mutação em
  `PENDING_RECONCILIATION` ou `MANUAL_REVIEW` sem antes confirmar o estado real
  no RENAVE por canal autorizado e concluir a triagem humana.
- **Zero adulteração direta no banco:** nunca execute `UPDATE` manual em tabelas
  de operação/outbox para resetar `attempt_count`, alterar `sent_at` ou reabrir
  uma operação já encerrada em `MANUAL_REVIEW`.

## Protocolo de triagem humana para `MANUAL_REVIEW`

Toda transição para `MANUAL_REVIEW` registra um código fechado
(`ReconciliationManualReviewReason`). Trate cada código de forma específica:

| Motivo (`reason`) | Causa típica | Ação de triagem |
| --- | --- | --- |
| `RENAVE_RECONCILIATION_WINDOW_EXPIRED` | Horizonte de 60 min (+ tolerância de início de 5 min) encerrado sem confirmação, ou falha transitória/limitador na janela final | Verificar se houve indisponibilidade externa (SERPRO/DETRAN) ou saturação do limitador; confirmar estado remoto por consulta autorizada antes de decidir por nova operação |
| `RENAVE_RECONCILIATION_AMBIGUOUS` | Múltiplos registros para a placa na janela, correspondência parcial, registro cancelado/finalizado/incompleto/divergente ou `dataHoraRegistro` sem fuso explícito | Auditar cada candidato comparando veículo, CPF do operador, tipo/segurança do CRV e `dataHoraRegistro`; nunca presumir ausência nem confirmar automaticamente |
| `RENAVE_RECONCILIATION_UNRECOVERABLE` | Projeção/contrato irrecuperável ou inconsistência permanente que impede reconciliação segura | Preservar evidências e escalar para engenharia/segurança antes de qualquer ação negocial |

Passo a passo obrigatório da triagem:

1. **Abrir ticket formal** referenciando apenas metadados não sensíveis
   (ambiente, motivo fechado, janela temporal e referência interna autorizada —
   nunca CPF, CNPJ, placa, RENAVAM ou segredo de CRV no texto do ticket).
2. **Consultar a trilha probatória** (`renave.audit_event` e referência de
   evidência protegida `pev1_<uuid>`) pelo canal autorizado para confirmar
   `sent_at`, hash da requisição e vínculo (`cnpj` / `cnpjIntegradora`).
3. **Conferir o estado oficial no RENAVE** em modo somente leitura para o
   estabelecimento e veículo envolvidos, verificando se a mutação foi efetivada
   ou rejeitada fora da janela.
4. **Concluir a decisão operacional:**
   - se a operação **foi efetivada** no RENAVE: registrar a conclusão da triagem
     com a comprovação remota e impedir qualquer reenvio duplicado;
   - se a operação **não foi efetivada** após o período de consistência:
     documentar a evidência de ausência e seguir o fluxo formal de nova
     solicitação/aprovação (com os mesmos requisitos de governança e sem
     contornar a promoção controlada).
5. **Registrar causa raiz externa**, quando aplicável, seguindo
   [`observability-and-incidents.md`](./observability-and-incidents.md).

## Checagem de leases, limitador e lock contention

O worker usa leasing com fencing no PostgreSQL e um único owner por Pod:

- **Owner único por Pod:** `RENAVE_RECONCILIATION_LEASE_OWNER` deve ser um UUID
  válido e exclusivo da instância (no Kubernetes, derivado do UID do Pod). Nunca
  compartilhe o mesmo UUID entre réplicas nem habilite HPA; mantenha 1 réplica
  com estratégia `Recreate`.
- **Renovação de lease:** `RENAVE_RECONCILIATION_HEARTBEAT_MS` (padrão `30000`
  ms; faixa `1000`–`60000` ms) renova a lease enquanto a operação está em curso.
- **Limitador sem retenção de lease:** `DistributedLimiterAdapter.tryAcquire`
  tenta adquirir permissão imediatamente e **nunca** mantém a lease aguardando
  capacidade. Em saturação, o worker libera a operação com `limiterBackoff`
  (limitado a `sent_at + 60 min`).
- **Timeouts defensivos do pool PostgreSQL:** `connectionTimeoutMillis: 5000`,
  `lock_timeout: 5000`, `statement_timeout: 15000`, `query_timeout: 17000`,
  `idle_in_transaction_session_timeout: 15000`, `max: 4`.

Sinais de diagnóstico nos logs JSON sanitizados
(`component: "renave-reconciliation-worker"`):

- **`lease_lost` recorrente:** verifique (a) se há mais de um Pod/Deployment
  ativo para o mesmo tenant, (b) se houve CPU throttling, pausa de GC ou queda
  de rede entre o worker e o PostgreSQL acima de `heartbeatIntervalMs`, e (c)
  sincronismo NTP entre o nó do worker e o servidor de banco.
- **Atraso em `available_at` ou timeouts de banco (`lock_timeout` /
  `statement_timeout`):** contenção de locks no PostgreSQL pode atrasar a
  disponibilidade efetiva da linha (ADR 0002 não promete igualdade subsegundo
  sob contenção). Inspecione sessões bloqueadoras e transações longas no banco
  sem matar o worker em loop; se o pool reportar erro (`poolHealthy = false`),
  o preflight fechará `/ready` automaticamente.
- **`key_unavailable` ou `preflight_failed`:** indica ausência de chave no
  keyring (`projection-keys.json`) para algum `projection_key_id` pendente,
  amostra cifrada corrompida, certificado expirado ou falha de role attestation.
  Não apague amostras nem remova chaves históricas; corrija o keyring/Secret e
  valide novamente via `dry-run`.
- **`released` persistente sem `confirmed`:** verifique saturação do limitador
  distribuído (`PostgresSerproQueryLimiter`) ou erros transitórios no SERPRO.
  Se a causa for externa, documente a janela de indisponibilidade e monitore o
  volume que atingirá `MANUAL_REVIEW`.
