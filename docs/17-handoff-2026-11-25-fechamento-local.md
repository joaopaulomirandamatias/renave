# Handoff do RenavEstoque — Fechamento das Fatias Locais (25/11/2026)

## Estado executivo

- Progresso estimado: **86% implementado / 14% restante** (+17% sobre o handoff `a4a8b26` de 69%).
- **0% implementável localmente pendente** no escopo do MVP de Usados + prontidão pré-POST; os **14% restantes são exclusivamente bloqueios externos** (credenciais/certificado ICP-Brasil mTLS real, Credencia/SENATRAN, catálogo municipal oficial, homologação real SERPRO/DETRAN, infraestrutura em nuvem BR com HSM/WORM/NTP e certificação ISO 27001).
- Branch: `claude/tender-newton-m50z1w` (alterações mantidas localmente sem `git push` até autorização explícita).
- Produção continua bloqueada no conector e nenhuma chamada real ou mutação ao SERPRO foi executada.

## Entregue neste ciclo (6 fatias verticais)

1. **Fatia 1 — Saída de Veículo Usado `HELD_LOCAL` (UI + cliente estrito) [+4%]**
   - Feature flag fail-closed `VITE_RENAVE_STOCK_EXIT_LOCAL_ENABLED` (`apps/web/src/config.ts`).
   - Rota canônica `/estoque/saida` (`apps/web/src/workspace-routes.ts`), `StockExitPage.tsx` e `UsedStockExitPanel.tsx` com validação local estrita, confirmação reforçada (alvos ≥ 44 px), preservação de `Idempotency-Key` em retry de desfecho incerto e botão contextual `"Registrar saída"` em `StockDetailPage.tsx` (sem expor placa na URL).
2. **Fatia 2 — Resumo Operacional real no Painel (`DashboardHomePage`) [+3%]**
   - Substituído o placeholder `"Indisponível nesta etapa"` por 3 cards operacionais reais (Pendências abertas com quebra entre verificação automática e revisão humana, Vínculo RENAVE e Prontidão de consultas) com atalhos diretos para `/pendencias`, `/compliance` e `/estoque`.
3. **Fatia 3 — Trilha de Auditoria do Tenant (API Read-Only + `/auditoria`) [+3%]**
   - `listTenantAuditEvents` em `packages/db/src/audit-events.ts` sob `FORCE RLS` (sem nova migration; projeção sanitizada sem `actor_subject`, `actor_ip`, `payload_reference` ou hashes completos).
   - Rota `GET /api/tenants/:tenantId/audit-events` protegida por RBAC `"audit.read"` e `Cache-Control: no-store`.
   - Tela `/auditoria` (`AuditPage.tsx`) + cliente com parser allowlist estrito (`apps/web/src/features/audit/client.ts`), filtros por resultado/escopo e paginação cursor-based (`beforeSequence`).
4. **Fatia 4 — Fechamento dos Runbooks Operacionais Pré-POST (`docs/ops/`) [+2%]**
   - Criados `docs/ops/certificate-lifecycle.md`, `docs/ops/reconciliation-worker.md` e `docs/ops/observability-and-incidents.md`.
   - Atualizado `docs/ops/api-homologation.md` com a cerimônia formal do canário somente leitura (`GET`).
5. **Fatia 5 — Reconciliador de Saída Usada + Pendências Multi-Tipo Read-Only [+3%]**
   - Implementada `reconcileStockExit` determinística em `packages/renave-connector/src/reconciliation.ts` aderente à ADR 0002 (394/394 testes passando no conector).
   - Ampliada a allowlist somente leitura para `USED_STOCK_ENTRY | USED_STOCK_EXIT` em `operation-pending-reader.ts`, `operation-pending-routes.ts`, `apps/web/src/features/pending-operations/client.ts`, `PendingOperationsPage.tsx` e `PendingOperationDetailPage.tsx`, preservando a saída sem outbox/dispatch e a fila 100% read-only sem retry manual.
6. **Fatia 6 — Abas na Ficha do Veículo + Usuários & Perfis (`/configuracoes/usuarios`) [+2%]**
   - `StockDetailPage.tsx` organizada em 3 abas WAI-ARIA (`Visão geral`, `Restrições (N)`, `Movimentações`) com navegação por teclado e alvos ≥ 44 px.
   - `listTenantMembers` em `packages/db/src/authorization.ts` sob `FORCE RLS` com `memberId` derivado no SQL sem selecionar/expor `subject` ou `subject_hash`; rota `GET /api/tenants/:tenantId/users` protegida por MFA e RBAC `"tenant.user.manage"`.
   - Tela `/configuracoes/usuarios` (`UsersPage.tsx`) + cliente estrito (`apps/web/src/features/tenant-users/client.ts`), fail-closed quando sem permissão ou MFA pendente.

## Revisões independentes e verificações

- **Auditoria independente (`arquiteto-auditor`)**:
  - Runbooks (`docs/ops/`): aprovados sem achados altos ou médios.
  - Backend (auditoria, usuários, `reconcileStockExit`, pendências multi-tipo): aprovado sem achados altos ou médios.
  - Frontend: todos os achados médios encontrados durante o ciclo (placa na URL ao iniciar saída; `parseDetailOperation` restrito a `USED_STOCK_ENTRY`) foram corrigidos e cobertos por testes.
- **Validação automatizada**:
  - `pnpm check` (security guards, release guards da API/worker/promoter, typecheck, testes unitários de todos os pacotes, contratos SERPRO, smoke tests, pré-homologação H-04..H-07 e build completo): **verde**.
  - `@seu-renave/renave-connector`: **394 testes passando**.
  - `@seu-renave/web`: **29 arquivos, 391 testes passando**.

## Pendências estritamente externas (14% restantes)

1. **Credenciamento SENATRAN/Credencia, Certificado ICP-Brasil mTLS e Canário GET real [4%]**: emissão/cofre do e-CNPJ de homologação, liberação de egress FQDN para `hom.renave.estaleiro.serpro.gov.br:443` e execução real de `pnpm smoke:serpro:hml` e `HomologationCanaryPanel`.
2. **Publicação do Catálogo Municipal Oficial + Homologação Ponta a Ponta H-01..H-19 [4%]**: captura e aprovação por canal independente do manifesto SHA-256 (`pnpm municipality:catalog:publish`) e execução dos mocks oficiais SERPRO/DETRAN.
3. **Infraestrutura em Região Brasil, HSM/KMS, Âncora WORM (5 anos) e NTP do ON [3%]**: provisionamento produtivo em nuvem BR, chaves não exportáveis, WORM externo da cadeia de auditoria (ADR 0003) e game day de DR (RTO ≤ 4 h).
4. **Compliance Regulatório (ISO 27001 / Jurídico), Desbloqueio de Produção SERPRO e Piloto [3%]**: certificação ISO 27001, parecer societário (Res. 1.027/1.032), autorização formal de produção e piloto com revendas (SUS ≥ 80).
