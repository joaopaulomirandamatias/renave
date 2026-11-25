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
| `pnpm db:platform:grant`                          | Concede acesso global a partir de uma decisão JSON no `stdin`; requer a URL do provisionador e a HMAC compartilhada.         |
| `pnpm db:platform:revoke`                         | Revoga acesso global pelo mesmo canal offline; não aceita identidade, ticket nem chave na linha de comando.                  |
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
`DATABASE_PROFILE_READER_URL` com credenciais locais descartáveis. Também
imprime `DATABASE_CREDENTIAL_SCOPE_PROVISIONER_URL`, exclusiva da cerimônia
offline que verifica a UF regulatória e concede natureza de serviço. Em
ambientes reais, forneça URLs distintas pelo cofre: nenhuma delas tem fallback
para `DATABASE_URL`, e o runtime não pode conceder escopo.

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
cada chamada, limita a página a 100 itens e registra resultado e truncamento na
auditoria encadeada. Entrada malformada falha antes de qualquer ação e, por não
constituir uma decisão autorizativa, não gera evento; decisões válidas,
autorizadas ou negadas, são auditadas.

A sessão OIDC persiste o issuer validado e o `auth_time` real separadamente do
horário de criação e do toque da sessão. Sessões legadas sem issuer ou sem a
prova temporal não atravessam a rota global. A API compõe um pool exclusivo
com `renave_platform_reader` e comprova o contrato por uma probe dedicada que
não lê a fila nem cria evento de auditoria. A credencial do provisionador nunca
entra no runtime HTTP.

O provisionamento usa a mesma codificação HMAC versionada da API. A decisão JSON
contém `target` e `changedBy` com `issuer`/`subject`, `decisionTicket`, `actorIp`,
`traceId` e, para concessão, `validFrom`/`expiresAt` em ISO 8601 UTC canônico. O
corpo entra somente por `stdin`; o comando imprime apenas o resultado estável.
A leitura passa primeiro por um gate local de duas consultas concorrentes (uma
por ator) e depois por buckets PostgreSQL de 60 segundos: 30 tentativas por ator
e 120 globais. A negação retorna `Retry-After` e não chega à função auditada.

A rotação de `PLATFORM_OPERATOR_HMAC_KEY_BASE64` invalida imediatamente grants e
cursores assinados existentes. Ela exige cerimônia coordenada: bloquear a rota,
publicar a nova chave no provisionador e na API, recriar os grants necessários e
somente então reabrir o console.

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
| `renave_operation_worker` | Worker de reconciliação RENAVE.                                           | `NOSUPERUSER`, `NOBYPASSRLS`, `NOINHERIT`; zero ACL de tabela e, no limite atual, sem `begin SEND` nem acesso ao ciphertext da solicitação. |
| `renave_operation_promoter` | Cerimônia de liberação de operações `HELD_LOCAL`.                         | Sem ACL direta de tabela; somente `EXECUTE` na promoção que revalida o selo regulatório. Deve rodar em job offline e sem egress — o banco limita capacidades, mas não controla a rede do processo. |
| `renave_profile_provisioner` | Job administrativo de staging e suspensão de perfis RENAVE.             | Sem acesso direto a tabelas; somente `EXECUTE` nas quatro mutações fechadas. Não consulta status. |
| `renave_credential_scope_provisioner` | Cerimônia offline de jurisdição e natureza Credencia.            | Sem acesso direto às tabelas RENAVE; somente `EXECUTE` nas duas transições fechadas do schema `renave_admin`. Não entra no runtime HTTP. |
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

## Catálogo municipal RENAVE — verificação offline

Uma captura autorizada do `GET /api/municipios` pode ser verificada sem rede e
sem acesso ao PostgreSQL:

```bash
pnpm municipality:catalog:verify -- \
  --manifest /caminho/manifest.json \
  --source /caminho/source.json \
  --expected-manifest-sha256 <sha256-aprovado-por-canal-independente>
```

O verificador aceita somente arquivos regulares dentro dos limites definidos,
UTF-8 e JSON estritos, o endpoint exato de homologação, timestamp UTC canônico,
campos exatos, IDs/UF válidos, códigos únicos, sentinelas nacionais, contagem e
os hashes do corpo bruto e do artefato canônico. O hash esperado do manifesto
deve chegar por um canal de aprovação revisado e independente dos dois arquivos;
um hash guardado ao lado da própria captura não autentica sua procedência.

Essa etapa prova integridade e consistência, não vigência nem publicação. A
captura mTLS e sua aprovação/WORM pertencem à cerimônia externa.

Depois da aprovação, a publicação transacional é explícita:

```bash
DATABASE_MIGRATOR_URL='postgresql://...' \
DATABASE_MIGRATOR_TLS_CA_FILE=/run/secrets/database-ca.pem \
pnpm municipality:catalog:publish -- \
  --manifest /caminho/manifest.json \
  --source /caminho/source.json \
  --expected-manifest-sha256 <sha256-aprovado-por-canal-independente> \
  --maximum-age-hours 24
```

O limite de frescor é obrigatório, inteiro e no máximo 24 horas; o relógio do
PostgreSQL decide dentro da transação. O publicador repete toda a verificação,
recusa regressão temporal, serializa concorrentes antes de ler o ativo, confere
o contrato de migrations, compartilha o advisory lock do runner e relê origem,
metadados, hashes, contagem e integridade antes do commit. A mesma versão ativa
e idêntica é replay seguro; versão histórica ou divergente é recusada. Banco
remoto exige CA explícita, e parâmetros TLS na URL são recusados.

O processo conecta diretamente como `renave_migrator`, sem `SET ROLE`, e rejeita
atributos elevados ou memberships. Limite residual: esse papel é dono dos
objetos por desenho e também executa migrations; a separação é operacional, não
uma fronteira de credencial. O comando não captura dados nem chama o SERPRO. Não
existe snapshot ativo versionado no repositório; a execução depende da captura
oficial aprovada fora dele.

### Barreiras da saída de estoque

A saída `HELD_LOCAL` usa um lookup fechado próprio. Em cada consulta, o banco
repete a vigência da release ativa: origem `RENAVE_MUNICIPIOS`, URL oficial
exata, integridade, quatro sentinelas, 5.000 a 10.000 linhas e `observed_at`
entre o relógio PostgreSQL atual e as 24 horas anteriores. Release ausente,
futura, vencida ou ativa inválida torna o catálogo indisponível; não existe
fallback para uma release histórica. `renave_app` recebe somente `EXECUTE` nas
funções fechadas e não lê as tabelas do catálogo.

O limitador de mutação da saída é independente do limitador de entrada. Ele
serializa os escopos global, tenant e sujeito nessa ordem, armazena apenas
digests HMAC-SHA-256 de 32 bytes e falha fechado diante de entrada ou decisão
inválida. O consumo deve ocorrer em uma transação curta/autocommit, antes da
futura transação de negócio, para que um rollback da operação não devolva
quota. A futura composição de runtime deverá usar segredo exclusivo da saída e
vincular sua identidade ao fingerprint/pin do bundle aprovado; rotação não pode
reiniciar quota silenciosamente.

As migrations `0082` e `0083` não criam outbox, despacho, worker, promoter nem
chamada HTTP. A capacidade permanece pré-runtime e inativa até uma entrega
posterior compor explicitamente essas dependências e seus testes de segurança.

## Proveniência

Padrões genéricos (tenant corrente via `set_config` transacional, FORCE RLS,
validação de CNPJ alfanumérico no banco, runner com ledger/checksum)
adaptados, sem cópia de código, dados, credenciais ou configuração, do projeto
`plataforma-harmonizacao-normativa` do mesmo proprietário. Nenhum código de
cliente foi usado.
