# Banco de dados do Seu Renave

PostgreSQL 17 com isolamento multi-tenant por _row level security_ (RLS).
SQL versionado em `db/migrations/`; runner, helpers e testes em `packages/db`
(`@seu-renave/db`).

## Comandos

| Comando                                           | O que faz                                                                                                                  |
| ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `pnpm db:up` / `pnpm db:down`                     | Sobe/derruba o Postgres 17 do `compose.yaml` (`127.0.0.1:54317`, banco `renave`).                                          |
| `pnpm db:setup:local`                             | `bootstrap` + `migrate` no Postgres local, com valores de dev **não secretos**. Recusa host fora de loopback.              |
| `pnpm db:reset`                                   | Apaga o volume, sobe de novo e roda `db:setup:local`.                                                                      |
| `pnpm db:bootstrap`                               | Cria/atualiza os papéis (idempotente; rotaciona senhas). Requer `DATABASE_ADMIN_URL` e `RENAVE_DB_*_PASSWORD`, inclusive os segredos separados de perfis e do console global (`RENAVE_DB_PLATFORM_PROVISIONER_PASSWORD` e `RENAVE_DB_PLATFORM_READER_PASSWORD`).       |
| `pnpm db:migrate`                                 | Aplica migrations pendentes como migrator. Requer `DATABASE_MIGRATOR_URL`.                                                 |
| `pnpm db:purge-identity`                          | Remove tentativas e sessões OIDC expiradas em um lote. Requer `IDENTITY_DATABASE_URL`; indicado para agendamento periódico. |
| `pnpm db:scan-evidence`                           | Detecta evidências pendentes acima do SLA em lote, sem alterar a prova. Requer `MAINTENANCE_DATABASE_URL`.                   |
| `pnpm db:status-evidence`                         | Consulta heartbeat e backlog agregados, sem iniciar varredura. Requer `MAINTENANCE_DATABASE_URL`.                           |
| `pnpm db:test`                                    | Sobe o Postgres e roda os testes de **integração** (banco descartável por execução).                                       |
| `pnpm --filter @seu-renave/db test`               | Testes unitários (sem banco). Entram no `pnpm test` / `pnpm check`.                                                        |
| `pnpm stock-entry:bundle:generate -- --generation-id <id> --output-dir <dir>` | Gera um bundle HELD_LOCAL novo, fora do repositório, sem sobrescrever arquivo existente. |
| `pnpm stock-entry:pin:status`                     | Confere, como `renave_migrator`, se o pin write-once está ausente, compatível ou divergente.                               |
| `pnpm stock-entry:pin:provision -- --confirm-generation <id> --confirm-fingerprint <hex>` | Faz o único `INSERT` do pin após backup/restauração e confirmação explícita. |

A aplicação usa `DATABASE_URL` (papel `renave_app`) para os dados de negócio e
`IDENTITY_DATABASE_URL` (papel `renave_identity_app`) para sessões. Nenhum segredo é versionado:
a senha do superusuário no `compose.yaml` é um padrão local descartável
(sobrescreva com `RENAVE_DB_SUPERUSER_PASSWORD`), e os papéis de aplicação só
existem depois do `bootstrap`.

O setup local também imprime `DATABASE_PROFILE_PROVISIONER_URL` e
`DATABASE_PROFILE_READER_URL` com credenciais locais descartáveis. Em ambientes
reais, forneça URLs distintas pelo cofre: a primeira serve somente aos comandos
mutantes de perfis e a segunda somente ao `profile-status`. Não existe fallback
entre elas.

Para o console global, o setup também imprime
`DATABASE_PLATFORM_PROVISIONER_URL` e `DATABASE_PLATFORM_READER_URL`. Em
produção, use secrets e workloads separados: o provisionador concede ou revoga
operadores por cerimônia offline e não lê a fila; o leitor consulta somente a
projeção sanitizada e não concede acesso. Nenhum deles substitui
`DATABASE_URL` ou pode assumir o papel do outro.

As rotinas do console recebem somente digests HMAC-SHA-256 de 32 bytes, nunca
o subject OIDC, o ticket ou a justificativa em claro. `grant_operator` aceita
início no máximo 5 minutos à frente e expiração posterior ao início, limitada
a 366 dias; toda concessão, revogação e reconcessão válida entra em histórico
append-only. A leitura global exige um `reason_ticket_digest` de 32 bytes em
cada chamada, limita a página a 500 itens e registra resultado e truncamento na
auditoria encadeada. Entrada malformada falha antes de qualquer ação e, por não
constituir uma decisão autorizativa, não gera evento; decisões válidas,
autorizadas ou negadas, são auditadas.

O pin do bundle de entrada de estoque é deliberadamente **write-once**. O
provisionador não aplica migrations, não ativa flags e não aceita `--force`.
Perder o bundle depois do pin torna a retenção local indisponível; siga a
cerimônia de backup e restauração em
[`docs/ops/stock-entry-held-local-homologation.md`](../docs/ops/stock-entry-held-local-homologation.md).

## Papéis

| Papel             | Função                                                                              | Restrições                                                                                                                  |
| ----------------- | ----------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `renave_migrator` | Dono dos objetos; executa migrations e provisiona tenants.                          | `LOGIN`, sem superuser/CREATEROLE/BYPASSRLS. Fica **sujeito a FORCE RLS**.                                                  |
| `renave_app`      | Runtime da API.                                                                     | `NOSUPERUSER`, `NOBYPASSRLS`, `NOINHERIT`, não é dono nem membro do migrator, sem `CREATE`. DML mínimo; sem `DELETE`/`TRUNCATE`. |
| `renave_identity_app` | Runtime isolado do armazenamento OIDC.                                          | Sem acesso às tabelas de negócio ou às tabelas OIDC; possui somente `EXECUTE` nas rotinas `SECURITY DEFINER` de identidade. |
| `renave_maintenance_app` | Job operacional de lote.                                                    | `NOSUPERUSER`, `NOBYPASSRLS`, `NOINHERIT`; sem leitura de tabelas, possui somente `EXECUTE` em rotinas fechadas de manutenção. |
| `renave_operation_worker` | Worker fenced de operações RENAVE.                                         | `NOSUPERUSER`, `NOBYPASSRLS`, `NOINHERIT`; zero ACL de tabela, somente `EXECUTE` nas rotinas fechadas de claim, lease, begin e completion. |
| `renave_profile_provisioner` | Job administrativo de staging e suspensão de perfis RENAVE.             | Sem acesso direto a tabelas; somente `EXECUTE` nas quatro mutações fechadas. Não consulta status. |
| `renave_profile_reader` | Job operacional global de consulta sanitizada de perfis RENAVE.               | Sem acesso direto a tabelas; somente `EXECUTE` nas duas funções de status. Não cria nem suspende perfis. |
| `renave_platform_provisioner` | Job administrativo offline do console global.                         | Sem acesso direto a tabelas nem à fila; somente `EXECUTE` nas funções fechadas de grant/revoke. |
| `renave_platform_reader` | Runtime isolado do console global.                                         | Sem acesso direto a tabelas; somente `EXECUTE` na consulta sanitizada e auditada. Não concede nem revoga operadores. |

## Evidência protegida e monitor operacional

`renave.protected_evidence` aceita `INSERT` do runtime somente nas colunas
funcionais. Estado, campos terminais e timestamps são impostos pelo banco; o
chamador não consegue escolher `created_at` futuro para escapar do SLA.

O schema fechado `renave_operations` mantém, por trigger e na mesma transação,
uma projeção contendo apenas ID da evidência, tenant, estado e timestamps. Não
contém ciphertext, CNPJ, placa, estabelecimento ou subject. O job externo roda
`pnpm db:scan-evidence`: pendência acima do SLA cria um único incidente; uma
finalização tardia resolve o incidente. O monitor nunca marca evidência como
falha, nunca apaga prova e não recebe acesso direto às tabelas. A migration
`0015` persiste somente o heartbeat agregado da última execução bem-sucedida.
O contrato para schedulers, códigos de saída e alertas está em
[`docs/ops/monitor-de-evidencias.md`](../docs/ops/monitor-de-evidencias.md).

## Sessões OIDC

Tentativas de login e sessões opacas vivem no schema global `renave_identity`,
porque o tenant ainda não é conhecido durante o callback. Cookies, `state` e
IDs de sessão são persistidos somente como SHA-256/base64url. O `code_verifier`
PKCE é armazenado pelo menor tempo necessário ao callback.

`PostgresIdentitySessionStore.purgeExpiredRecords()` remove tentativas e
sessões expiradas em lotes de até 10.000, usando `FOR UPDATE SKIP LOCKED` para
permitir execução concorrente. O runtime deve agendar a limpeza, publicar só os
contadores removidos e nunca claims, nome ou e-mail. A separação de papel evita
que uma falha SQL na camada multi-tenant fabrique uma sessão autenticada.

## Isolamento (como funciona)

1. Toda requisição abre uma transação e chama
   `set_config('renave.tenant_id', <uuid>, true)` — `is_local = true`, o valor
   morre no `COMMIT`/`ROLLBACK`. Use sempre `withTenant(pool, tenantId, fn)`.
2. `renave.current_tenant_id()` devolve `NULL` sem tenant (ou vazio). As
   políticas fazem `tenant_id = current_tenant_id()`, que com `NULL` nunca é
   verdadeiro: **sem tenant → zero linhas, escrita recusada** (fail closed). UUID
   malformado no GUC gera erro. `withTenant` rejeita não-UUID antes de abrir
   conexão.
3. `ENABLE` + `FORCE ROW LEVEL SECURITY` em `tenant` e `establishment`: vale até
   para o dono das tabelas.
4. Tabelas filhas futuras devem: ter `tenant_id uuid not null`, FK composta
   `(tenant_id, establishment_id) → establishment (tenant_id, id)`, as mesmas
   políticas e FORCE RLS, e `grant` explícito (nunca `ALL`).

Limite conhecido: o GUC não é protegido contra SQL arbitrário executado pela
própria aplicação (`set_config` é permitido a qualquer papel). A defesa é
usar apenas `withTenant` e nunca montar SQL com entrada do usuário; a RLS
protege contra esquecimento de filtro, não contra código malicioso no runtime.

A RLS desta fundação isola tenants. O escopo entre estabelecimentos do mesmo
tenant será aplicado pelo RBAC da identidade e por repositórios que recebem o
`establishment_id` autorizado da sessão, nunca do navegador. Até esse vínculo
estar integrado e testado, endpoints de operação RENAVE permanecem bloqueados.

## CNPJ

Armazenado **normalizado** (maiúsculas, sem `.`, `/`, `-`, espaços) em 14
posições: 12 alfanuméricas (`A-Z`, `0-9`; o formato numérico é subconjunto) + 2
dígitos verificadores numéricos (módulo 11, valor = código ASCII − 48; sequência
repetida de dígitos é rejeitada). O gatilho `establishment_guard` normaliza o
INSERT e a `CHECK` valida o resultado, de modo que nenhum caminho grava CNPJ
com máscara. Mesma regra em SQL (`renave.cnpj_is_valid`) e TypeScript
(`packages/db/src/cnpj.ts`), com testes de paridade. Único por tenant; o mesmo
CNPJ pode existir em tenants diferentes. `cnpj_root` e `cnpj_branch` são colunas geradas.

## Auditoria append-only

`renave.audit_event` é isolada por tenant, tem RLS forçada e não concede
`UPDATE` ou `DELETE` ao papel da aplicação. Cada evento recebe o hash do evento
anterior do mesmo tenant; um advisory lock transacional serializa inserções
concorrentes e evita bifurcação da cadeia.

O banco define `sequence`, `occurred_at`, `previous_hash` e `event_hash`. A API
fornece ator, IP, ação, resultado, identidades RENAVE confirmadas, hashes da
requisição/resposta, thumbprint lógico do certificado e uma referência para o
payload cifrado/WORM. O payload sensível não fica aberto nessa tabela.

Use `appendAuditEvent()` dentro de `withTenant()`. `verifyAuditChain()` recalcula
a cadeia visível ao tenant e detecta alteração de conteúdo ou encadeamento. O
teste de integração também adultera um evento como administrador e prova que o
verificador retorna `false`.

## Migrations

`NNNN_descricao.sql`, sem lacunas. Cada uma roda em transação com o registro em
`renave.schema_migrations` (versão + SHA-256). Arquivo já aplicado que muda ou
some interrompe o runner; não há migration "down" (rollback documentado no
cabeçalho de cada arquivo). Um advisory lock serializa runners concorrentes.

## Proveniência

Padrões genéricos (tenant corrente via `set_config` transacional, FORCE RLS,
validação de CNPJ alfanumérico no banco, runner com ledger/checksum)
adaptados, sem cópia de código, dados, credenciais ou configuração, do projeto
`plataforma-harmonizacao-normativa` do mesmo proprietário. Nenhum código de
cliente foi usado.
