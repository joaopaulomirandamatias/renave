# 02 — Análise de reuso dos projetos existentes

> **Objetivo:** reduzir tempo de construção reaproveitando código e padrões já validados nos projetos do time.
> **Repositórios analisados (leitura integral, sem alteração):** `detran_gateway`, `despachante`, `backend_patio`, `frontend_patio`, `kitara-desmontagem-backend`, `plataforma-harmonizacao-normativa`.
> **Legenda:** 🟢 **COPIAR** (quase como está) · 🟡 **ADAPTAR** (reaproveitar com mudanças) · 🔵 **IDEIA** (só inspiração) · ⚪ **NÃO SERVE**.

---

## 2.1 Visão geral — o que cada projeto oferece

| Projeto | Stack | Melhor contribuição para o RENAVE |
|---|---|---|
| **detran_gateway** | Node 22, Express, TS, Jest | **Conector com órgão de trânsito**: taxonomia de falhas, *desfecho conhecido × desconhecido*, Idempotency-Key obrigatória, capacidades por consumidor, testes de "não reenviou" |
| **despachante** | Fastify 5, Prisma 6, Postgres 16, Redis, S3/MinIO, Next 16 | **Camada SaaS**: multi-tenant por organização, sessões com refresh e 2FA TOTP, RBAC com auditoria de permissão, webhooks com HMAC, upload presignado, cifra at-rest, máscaras de PII |
| **backend_patio** | Express, Prisma 5, Postgres, React-PDF | **Domínio veicular**: modelo de veículo e catálogos CONTRAN, validação de placa e CPF/CNPJ, feriados e dias úteis, pendências, vistoria com fotos geolocalizadas, outbox com retry, comprovante verificável por QR |
| **frontend_patio** | React 19, Vite, Tailwind 3, recharts | Referência funcional de telas: sidebar por permissão, timeline, upload com compressão |
| **kitara-desmontagem-backend** | NestJS 11 + Fastify, Prisma 6 | **Credenciamento** como máquina de estados, empresa com CNAE e situação cadastral, linha do tempo de fiscalização |
| **plataforma-harmonizacao-normativa** | Fastify 5, Postgres 17 SQL puro, Keycloak OIDC, React 19 + Tailwind 4 | **Fundação de compliance**: RLS multi-tenant, triggers append-only, **cadeia de hash** de auditoria, **motor de regras AST** trivalente versionado com vigência, **dossiê SHA-256 + PDF determinístico assinado**, validação de CNPJ alfanumérico 2026, matriz matriz/filial, outbox transacional, **design system acessível** |

### Lacunas: o que **nenhum** projeto tem (construir do zero)

1. **Cliente mTLS com certificado e-CNPJ ICP-Brasil**, um por estabelecimento, com chave em KMS/HSM.
2. **Idempotência durável**: hoje ela é só em memória.
3. **Fila durável** para envio e reconciliação (BullMQ ou pg-boss com `SKIP LOCKED`).
4. **SHA-256 de documentos** no upload (NF-e XML, ATPV-e PDF, termos).
5. **OpenTelemetry**: traces, métricas e correlation-id ponta a ponta.
6. **Sincronismo de horário com a Hora Legal Brasileira** e carimbo na trilha de auditoria.
7. **Assinatura ICP-Brasil (PAdES/CAdES)**, se o dossiê precisar de valor jurídico pleno.
8. **Catálogo de operações e erros do RENAVE-WS**, construído a partir do manual SERPRO.

---

## 2.2 Matriz de reuso por camada

### A) Conector RENAVE (integração SERPRO)

| Item | Origem | Classe | Como usar |
|---|---|---|---|
| Taxonomia `FalhaCodigo` (REJECTED, AUTH, RATE_LIMITED, UNAVAILABLE, TIMEOUT, NETWORK, INVALID_RESPONSE, INTERNAL) + erro com `desfechoDesconhecido`, `retryAfterMs` e detalhe do órgão | `detran_gateway/src/types.ts` | 🟢 | É o contrato central para decidir entre **repetir** e **reconciliar** |
| Recusa local sempre com `desfechoDesconhecido:false` | `detran_gateway/src/types.ts` (`erroDoGateway`) | 🟢 | Não manda para reconciliação o que nunca saiu do sistema |
| Despacho que classifica status/código (renova token uma vez em 401/403; 429 com Retry-After; 503 = não aplicado, 504 = indeterminado) | `detran_gateway/src/services/cartorio.service.ts` | 🟡 | Mantém a estrutura e troca o catálogo de códigos pelo do RENAVE-WS |
| Timeout por operação derivado do manual do órgão + `retries: 0` obrigatório em mutações | `detran_gateway/src/services/detran.service.ts`, `cartorio.service.ts` | 🟢 (padrão) | Timeout explícito em cada endpoint RENAVE |
| Transporte `fetch` com AbortController | `detran_gateway` | 🟡 | Trocar por `undici.Agent({ connect: { cert, key, ca } })` com mTLS ICP-Brasil |
| Idempotency-Key obrigatória e validada; dedupe que guarda a **resposta** e não memoriza falha ambígua; `consultarDesfecho` → applied / not_applied / unknown | `detran_gateway/src/services/cartorio.service.ts`, `routes/cartorio.routes.ts` | 🟡 | Semântica correta. Migrar do Map em memória para a **tabela `operation`** no Postgres |
| Padrão "chamada externa nunca lança: grava status, mensagem e data; job reprocessa" | `backend_patio/src/services/detranPatio.service.ts` + `jobs/resincronizarDetran.job.ts` | 🟡 | Somar a chave de idempotência e o outbox transacional |
| Cache de token com single-flight e invalidação em 401 | `detran_gateway/src/services/detran.service.ts` | 🟡 | Usar só se o RENAVE-WS exigir token além do mTLS; mover para Redis |
| Normalização de veículo: placa, RENAVAM com zeros à esquerda, chassi, restrições, `splitMarcaModelo`, `corrigirMarcaImportado` | `detran_gateway`, `backend_patio/src/services/detranAp.service.ts`, `utils/restricoesVeiculo.ts` | 🟢 | Os dados do Renavam têm as mesmas peculiaridades |
| Testes com `fetch` mockado que contam despachos ("não duplicou", "não reenviou") | `detran_gateway/src/__tests__/cartorio.test.ts` | 🟢 | Base da suíte de resiliência do conector |
| Experiência de hospedar o conector em **servidor no Brasil** | `detran_gateway` (arquitetura) | 🔵 | Alinhado à exigência de processamento primário no país (Anexo da Res. 1.026) |

### B) Plataforma SaaS (tenancy, identidade, RBAC)

| Item | Origem | Classe | Como usar |
|---|---|---|---|
| `withTenantTransaction` (`set_config('app.tenant_id', …, true)`) + `current_tenant_id()` + **FORCE RLS** | `plataforma-harmonizacao-normativa/apps/api/src/tenant-transaction.ts`, `migrations/0001_initial.sql` | 🟢 | Núcleo do isolamento. Com Prisma: `$transaction` + `$executeRaw` |
| Lint de migrations com DML sob RLS | `harmonizacao/apps/api/src/migrate-rls-lint-core.ts` | 🟡 | Evita backfill que roda vazio em silêncio |
| Matriz de teste de isolamento rota × papel × tenant | `harmonizacao/apps/api/src/tenant-isolation-matrix.integration.test.ts`, `despachante/apps/api/test/integration` | 🟡 | Teste obrigatório no CI (SEC-005), em versão enxuta |
| Gate de tenant suspenso (preHandler global) | `harmonizacao/apps/api/src/tenant-suspension-gate.ts` | 🟢 | Adesão suspensa ou cancelada bloqueia as operações |
| Estabelecimento matriz/filial com trigger de DV, raiz de CNPJ e UF × IBGE | `harmonizacao/migrations/0150_organization_establishment.sql` | 🟡 | Modelo de `establishment` |
| Validação de **CNPJ alfanumérico (2026)** em código e no banco | `harmonizacao/apps/api/src/company-identification.ts` | 🟢 | Obrigatório; já testado |
| Consulta de CNPJ com proveniência (hash do registro, autoridade, timeout) | `harmonizacao/apps/api/src/company-identification.ts` | 🟡 | Onboarding com sugestão confirmada pelo usuário |
| OIDC por JWKS (jose) com logs que não vazam claims | `harmonizacao/apps/api/src/auth.ts` | 🟢 | Keycloak com MFA obrigatório (`acr`) para perfis privilegiados |
| JWT que confere organização e papel atuais no banco + refresh opaco com hash e revogação + 2FA TOTP | `despachante/apps/api/src/middleware/authenticate.ts`, `lib/refresh-token.ts` | 🟡 | Alternativa ao Keycloak no MVP. Em ambos os casos, tokens em cookie httpOnly via BFF |
| RBAC com matriz e override por usuário + `PermissionAuditLog` (antes/depois) | `despachante/apps/api/src/lib/permissions-service.ts`, `schema.prisma` | 🟡 | Trocar a granularidade de rota por **ação de domínio** (`estoque.entrada.solicitar`) |
| Escopos concedidos por organização (`requireOrgScope`) | `despachante/apps/api/src/lib/org-detran-scopes.ts` | 🟡 | Habilitar módulos (0 km, ITE, consignação) por tenant |
| API key com hash SHA-256, expiração, rotação sem janela e capacidades | `detran_gateway/src/middleware/apiKey.middleware.ts`, `capabilities.ts` | 🟡 | Tabela `integration_client` com escopos para ERP/DMS |
| Cifra AES-256-GCM at-rest | `despachante/apps/api/src/lib/at-rest-cipher.ts` | 🟢 | Segredos de tenant (o certificado em si fica em KMS/HSM) |
| Filtro de PII e máscaras para log | `despachante/apps/api/src/lib/pii-filter.ts`, `consultation-log-mask.ts` | 🟢 | LGPD (SEC-010) |
| `/health` + `/ready` (db, redis, storage) | `despachante/apps/api/src/app.ts` | 🟢 | Probes de orquestração |
| Logging pino com redaction e `x-request-id` | `harmonizacao/apps/api/src/app.ts` | 🟢 | Somar OpenTelemetry |

### C) Domínio de veículos, estoque e documentos

| Item | Origem | Classe | Como usar |
|---|---|---|---|
| `Veiculo` + catálogos CONTRAN (tipo, espécie, carroceria, combustível, categoria) + marcas/modelos | `backend_patio/prisma/schema.prisma` | 🟡 | Somar `tenant_id`, usar `jsonb` em vez de texto JSON e acrescentar campos RENAVE (CRV, código de segurança, hodômetro, NF-e) |
| `Proprietario` / pessoa PF/PJ com endereço | `backend_patio`, `despachante` (`Client`) | 🟡 | Entidade `party` (vendedor, comprador, consignante, credora) |
| Utilitários de placa (antiga e Mercosul), CPF/CNPJ, máscaras | `backend_patio/src/utils/placa.ts`, `documentoBr.ts`; `despachante/apps/web/src/lib/br-masks.ts`, `tax-id-validation.ts` | 🟢 | Pacote `@renave/br-utils` |
| zod com transform/refine para placa, RENAVAM e CPF/CNPJ em `.strict()` | `despachante/apps/api/src/routes/v1/detran-ap.ts` | 🟢 | Schemas de entrada da API |
| Dias úteis, feriados e fuso BR | `backend_patio/src/utils/diasUteis.ts`, `dataBrasil.ts` | 🟢 | Prazos (30 dias de consignação, SLAs de pendência) |
| Numeração sequencial atômica (UPSERT) | `backend_patio/src/utils/numeracaoSequencial.ts` | 🟢 | Protocolos internos sem colisão (evita `count()+1`) |
| Pendências ABERTA / RESOLVIDA / DESCARTADA | `backend_patio` (`PendenciaCorrecaoApreensao`) | 🟡 | Base da **fila de pendências** |
| Vistoria + fotos com geolocalização e horário de captura; conferência de placa por OCR | `backend_patio` (`Vistoria`, `FotoVistoria`, `ConferenciaPlaca`) | 🟡 | Evidências da **identificação prévia / vistoria** |
| Comprovante com token hash, QR e verificação pública auditada | `backend_patio` (`ComprovanteQuitacao`, `AcessoComprovante`) | 🟡 | Comprovante verificável de entrada e saída |
| Máquina de estados com transições permitidas + histórico | `despachante/apps/api/src/lib/process-transitions.ts`; `kitara/.../movimentacoes.service.ts` | 🟡 | State machine da operação RENAVE, sempre com transação |
| Credenciamento como máquina de estados (protocolado → análise → aprovado/reprovado/suspenso; vigência) | `kitara-desmontagem-backend/src/modules/credenciamentos/credenciamentos.service.ts` | 🟡 | **Onboarding / adesão Credencia**, com transação e protocolo atômico |
| Upload presignado (`org/{tenant}/{subject}/{uuid}`), allowlist de MIME, limite de tamanho | `despachante/apps/api/src/lib/presign-upload.ts`, `lib/s3.ts` | 🟡 | Somar **SHA-256** e verificação de tamanho no confirm |
| Content addressing `sha256/aa/bb/<digest>` com estados STAGED / PUBLISHED / QUARANTINED | `harmonizacao` (ADR-0006) | 🟡 | Guarda de XML de NF-e, ATPV-e e respostas SERPRO |
| Retenção com descarte lógico de 5 anos | `backend_patio/src/utils/retencao.ts`, `Anexo` | 🟢 | Retenção mínima de 5 anos (Anexo da Res. 1.026) |
| Geração de PDF (React-PDF, pdfkit) | `backend_patio/src/pdf`, `kitara` | 🔵 | Termos e recibos; para dossiês, usar o pdf-lib determinístico (seção D) |

### D) Compliance, auditoria e regras

| Item | Origem | Classe | Como usar |
|---|---|---|---|
| Triggers **append-only / imutável** com `ENABLE ALWAYS` | `harmonizacao/migrations/0021`, `0024`, `0063` | 🟢 | Tabela `audit_event` e documentos |
| **Cadeia de hash** de eventos (`previous_hash` → `event_hash`) com lock por série | `harmonizacao/services/audit-pipeline-monitor/src/server/hash.ts`, `postgres-store.ts` | 🟡 | Trilha imutável exigida pelo Anexo. Canonicalizar com **JCS (RFC 8785)** |
| **Motor de regras AST trivalente** (TRUE/FALSE/UNKNOWN, all/any/not/eq/in/exists, trace) | `harmonizacao/packages/rule-engine` | 🟢 | Pré-condições e pendências ("apto a vender?") com explicação |
| Regras versionadas com hash, aprovação, vínculo ao dispositivo normativo e vigência | `harmonizacao/migrations/0005`, `0023`, `0065` | 🟡 | **Regulatory Watch** (RF-101 a RF-108), em versão reduzida |
| `rule_evaluations` com snapshot dos fatos e trace | `harmonizacao/migrations/0004` | 🟢 | Reproduz por que uma operação foi bloqueada |
| **Dossiê SHA-256 + PDF determinístico (pdf-lib) + assinatura destacada Ed25519 + verificação pública** | `harmonizacao/apps/api/src/dossier-pdf.ts`, `dossier-signing.ts`, `verify-dossier.ts` | 🟢 | **Dossiê de evidências da operação** (RF-062). Avaliar assinatura ICP para valor jurídico |
| Outbox transacional + dispatcher com backoff | `harmonizacao/migrations/0022`, `dossier-audit.ts`; `backend_patio/src/integracao/avisos.ts` | 🟡 | Webhooks e chamadas ao SERPRO; trocar `setInterval` por worker de fila |
| Webhooks: modelo de endpoint e entrega + assinatura HMAC estilo `t=,sig=` + catálogo de eventos | `despachante/apps/api/src/lib/webhook-dispatcher.ts`, `schema.prisma` | 🟡 | RF-086 a RF-088, com retry durável |
| Assinatura de requisição entre sistemas (método, caminho, data, nonce, sha256 do corpo) + anti-replay | `backend_patio/src/integracao/cripto.ts`, `NonceIntegracao` | 🟡 | Assinatura de webhooks e API externa |
| Bitemporalidade (`valid_*` / `recorded_*`) | `harmonizacao` ADR-0005 | 🔵 | Histórico do veículo e reconciliação |
| OpenAPI gerado e checado no CI | `harmonizacao/apps/api` (`openapi:check`) | 🔵 | API pública para ERP/DMS |

### E) Frontend e design system

| Item | Origem | Classe | Como usar |
|---|---|---|---|
| Tokens Tailwind 4 (`@theme`) com contraste WCAG anotado, escala tipográfica por papel, Inter | `harmonizacao/services/harmonization-console/src/client/index.css` | 🟡 | **Base do design system**, com paleta do RENAVE (ver `08-ux-e-prototipo.md`) |
| `TabelaResponsiva` (vira cards via container query, ARIA), Button com `min-h-11`, badges, AppShell, painel lateral, paleta de comandos, ExportBar | `harmonizacao/services/harmonization-console/src/client/components` | 🟡 | Componentes principais |
| Scripts de contraste a11y e orçamento de bundle | `harmonizacao/services/harmonization-console/scripts/a11y-contraste.mjs` | 🟢 | Gate de qualidade no CI (RNF de acessibilidade) |
| Ledger, StageFlow, IntegrityRules do audit monitor | `harmonizacao/services/audit-pipeline-monitor/src/client/components` | 🟡 | Tela de **operação** (máquina de estados) e **auditoria** |
| Kit UI (Card, PageHeader, Stat, EmptyState, Tabs, Dialog), timeline de status, matriz de permissões, AppShell recolhível | `despachante/apps/web/src/components/ui/index.tsx`, `process-status-timeline.tsx`, `permissions-matrix.tsx` | 🟡 | Complementos |
| Sidebar por grupos com menu filtrado por permissão | `frontend_patio/src/components/Layout/Sidebar.tsx` | 🟡 | Estrutura; visual refeito |
| Upload de foto com compressão (canvas, 1280px, q=0.7) | `frontend_patio/src/components/FotoUpload.tsx`, `utils/fotoUtils.ts` | 🟡 | Fotos da vistoria e identificação prévia no mobile |
| Timeline de eventos | `frontend_patio/src/components/TimelineApreensao.tsx` | 🟡 | Linha do tempo do veículo |
| OIDC Authorization Code + PKCE + BFF com proxy e redaction | `harmonizacao/services/harmonization-console` (`UserManager.ts`, `server/app.ts`) | 🟡 | Mantém o BFF; sessão em **cookie httpOnly**, nunca token em localStorage |
| Telas de lista e formulários atuais | `frontend_patio/src/pages`, `despachante/apps/web` | ⚪ | Monolíticas; refazer com TanStack Query + React Hook Form + zod |

### F) Fora do escopo (não reutilizar no produto RENAVE)

⚪ Cobrança BB/PIX, leilão, guincho e diárias de pátio (`backend_patio`); ingestão Python, IA, grafo e CNAE↔ISIC (`harmonizacao`); integrações Asaas e Assinafy (`despachante`).

> Assinatura eletrônica e transferência eletrônica são atividades de **operadoras homologadas** que a Res. 1.026 **impede** de ser integradoras. Integrar-se a elas como cliente é permitido; **ser** uma delas, não.

---

## 2.3 Stack recomendada (consolidação)

A recomendação abaixo foi escolhida para **maximizar reuso** e minimizar divergência entre bases:

| Camada | Escolha | Justificativa de reuso |
|---|---|---|
| Runtime | Node 24 LTS + TypeScript **strict** | Comum a todos os projetos |
| API | **Fastify 5** em monólito modular por *bounded context* | `despachante` e `harmonizacao` já usam |
| Banco | **PostgreSQL 17** com **RLS** + triggers de imutabilidade em SQL | Padrões de `harmonizacao` |
| Acesso a dados | **Prisma 6** para CRUD + SQL cru para RLS, triggers e relatórios | Schemas de `despachante`, `backend_patio` e `kitara` |
| Validação / contratos | zod + OpenAPI gerado | `despachante` |
| Fila / jobs | **BullMQ (Redis)** ou **pg-boss**, com **outbox transacional** | Substitui `setInterval`/`setTimeout` de todos os projetos |
| Identidade | **Keycloak (OIDC)** com MFA; BFF com cookie httpOnly | `harmonizacao` |
| Segredos / certificados | **KMS/HSM** (AWS KMS + CloudHSM ou equivalente nacional) | Novo |
| Arquivos | S3 compatível em região Brasil, endereçado por SHA-256 | `despachante` + `harmonizacao` |
| Observabilidade | pino + **OpenTelemetry** (traces, métricas) + Grafana/Loki/Tempo | Novo |
| Frontend | React 19 + Vite + **Tailwind 4** + TanStack Query/Table + Radix/shadcn + React Hook Form | Tokens e componentes do console de `harmonizacao` |
| Mobile | PWA responsiva para pátio (câmera, offline leve) | `frontend_patio` (FotoUpload) |
| CI/CD | GitHub Actions ou Woodpecker **enxuto**: lint, typecheck, unit, contrato, isolamento de tenant, SAST, secrets scan, a11y | Ideias de `harmonizacao`, sem a complexidade |
| Hospedagem | **Região Brasil** (AWS `sa-east-1`, GCP `southamerica-east1`, Azure Brazil South ou nuvem nacional) | Exigência do Anexo. **Não** usar provedores sem região no Brasil para o processamento primário |

### Estrutura sugerida do monorepo

```text
renave/
├─ apps/
│  ├─ api/                 # Fastify — bounded contexts em src/modules/*
│  ├─ worker/              # filas: envio RENAVE, reconciliação, webhooks, alertas
│  ├─ web/                 # React (portal do estabelecimento)
│  ├─ console/             # backoffice da integradora (pode ser rota de web/)
│  └─ bff/                 # sessão OIDC + proxy
├─ packages/
│  ├─ renave-connector/    # cliente mTLS + catálogo de operações/erros (portado do detran_gateway)
│  ├─ rule-engine/         # copiado da harmonização
│  ├─ br-utils/            # placa, CPF/CNPJ alfanumérico, RENAVAM, chassi, datas BR
│  ├─ audit/               # cadeia de hash + JCS
│  ├─ dossier/             # PDF determinístico + assinatura
│  └─ ui/                  # design system
├─ db/migrations/          # SQL (RLS, triggers) + Prisma
├─ contracts/              # OpenAPI público, JSON Schemas de webhooks
└─ docs/                   # esta especificação
```

## 2.4 Estimativa de ganho

| Bloco | Sem reuso | Com reuso | Observação |
|---|---|---|---|
| Fundação SaaS (tenancy, auth, RBAC, auditoria, webhooks, storage) | 8–10 sem. | **4–5 sem.** | Padrões maduros em `despachante` + `harmonizacao` |
| Conector RENAVE (resiliência, idempotência) | 6 sem. | **3–4 sem.** | Taxonomia e testes do `detran_gateway`; mTLS e catálogo são novos |
| Domínio veicular e utilitários BR | 3 sem. | **1 sem.** | `backend_patio` |
| Regras, dossiê e trilha imutável | 6 sem. | **2–3 sem.** | `rule-engine` e dossiê copiáveis |
| Design system | 4 sem. | **2 sem.** | Tokens e componentes do console |
| **Total estimado** | **27–29 sem.** | **12–15 sem.** | Esforço de engenharia; não inclui ISO 27001 nem homologação SERPRO |

> Estimativas de ordem de grandeza para planejamento. Precisam ser refinadas no *discovery* (Fase 0).

## 2.5 Padrões a **não** replicar

Os projetos de origem passaram por evoluções rápidas. Ao portar código, **não** trazer:

- estado crítico em memória (idempotência, rate limit, jobs com `setInterval`), que quebra com mais de uma réplica ou num restart;
- isolamento de tenant só por filtro na aplicação, sem RLS;
- auditoria implícita por middleware que deduz a entidade pela URL;
- JSON gravado como texto em vez de `jsonb`;
- TypeScript sem `strict`, rotas com milhares de linhas, regra de negócio dentro do controller;
- tokens de sessão no `localStorage`;
- verificação TLS relaxada, CORS permissivo, segredos de *fallback* ou arquivos de ambiente versionados;
- protocolo sequencial por `count()+1`;
- escritas multi-tabela fora de transação.

Cada item portado passa por **code review de segurança** antes de entrar no repositório `renave`.
