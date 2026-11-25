# 18 — O que falta para integrar ao SERPRO (Homologação e Produção)

Este documento consolida, em ordem executável, tudo o que falta fazer fora do código local para ativar a integração real do **RenavEstoque** com o **RENAVE / SERPRO**, primeiro em **homologação** (`hom.renave.estaleiro.serpro.gov.br`) e, depois, em **produção**.

Estado atual do repositório: **86% implementado** (todas as fatias locais do MVP de Usados, RLS, auditoria, usuários, saída local `HELD_LOCAL`, reconciliador de entrada/saída, canário GET e runbooks pré-POST concluídos e testados). Os **14% restantes** dependem exclusivamente das etapas externas abaixo.

---

## Fase A — Credenciamento, Contrato e Pré-requisitos Regulatórios

Antes de conectar qualquer ambiente real ao SERPRO:

1. **Definir o modelo de atuação (Decisão D1 do doc. 09):**
   - **Rota A (integradora própria autorizada pela SENATRAN):** exige autorização formal, capital/patrimônio líquido mínimo (R$ 1 milhão), parecer societário sobre vedações cruzadas (Res. 1.026, 1.027 e 1.032 — não operar DMS, assinatura eletrônica ou vistoria no mesmo grupo sem respaldo jurídico) e certificação **ISO 27001** (prazo regulatório: **27/03/2027**).
   - **Rota B (parceria com integradora já autorizada):** formalizar contrato operacional e fluxo de credenciamento/chaveamento.
2. **Credenciamento no Credencia / SENATRAN e contratação SERPRO:**
   - Habilitar o CNPJ da integradora e obter acesso ao ambiente de homologação (`hom.renave.estaleiro.serpro.gov.br`).
   - Confirmar no Credencia o vínculo do(s) estabelecimento(s) piloto à integradora.
3. **Emissão do certificado digital ICP-Brasil (e-CNPJ) de homologação:**
   - Emitir certificado e-CNPJ válido com EKU `id-kp-clientAuth` (`1.3.6.1.5.5.7.3.2`) para autenticação mTLS.
   - **Nunca** versionar `.pfx`, `.p12`, `.key`, `.pem` ou senhas no repositório.

---

## Fase B — Provisionamento de Infraestrutura e Segredos (Homologação)

Referência obrigatória: [`docs/ops/api-homologation.md`](ops/api-homologation.md) e [`docs/ops/certificate-lifecycle.md`](ops/certificate-lifecycle.md).

1. **Infraestrutura em região Brasil (`sa-east-1` / `southamerica-east1` / nuvem nacional):**
   - PostgreSQL 17.12 com TLS autenticado e CA explícita (o runtime recusa conexões remotas sem CA).
   - Provedor OIDC corporativo (Keycloak ou equivalente) com PKCE S256 e MFA obrigatório para operações sensíveis (`/ops`, cadastro de estabelecimentos, saída/entrada local, usuários).
   - Sincronismo **NTP** confiável no cluster (sem `CAP_SYS_TIME` nos containers) para respeitar a janela de 60 min da ADR 0002 e os timestamps de auditoria.
2. **Cofre / Secrets nos mounts fixos (permissão `0400`/`0440`):**
   - Montar certificado mTLS, chave privada e CA do SERPRO em `/run/secrets/seu-renave/api/` e `/run/secrets/seu-renave/reconciliation-worker/`.
   - Provisionar chave de cifragem de evidências AES-256-GCM (`protected-evidence`) e par de chaves Ed25519 para o `operation-promoter` ([`docs/ops/operation-promoter.md`](ops/operation-promoter.md)).
   - Provisionar segredo do `stock-entry-provisioning` (`pnpm stock-entry:bundle:generate` e `pnpm stock-entry:profile-admin-key:generate`) via cofre.
3. **Rede e Egress controlado:**
   - Liberar saída estritamente por FQDN para `hom.renave.estaleiro.serpro.gov.br:443` (HTTPS/mTLS).
   - Proibido usar `--insecure`, `NODE_TLS_REJECT_UNAUTHORIZED=0` ou desabilitar verificação de hostname.

---

## Fase C — Ativação Somente Leitura (Canário GET em Homologação)

**Regra de segurança:** nenhuma mutação (`POST`) deve ser habilitada antes de concluir integralmente esta fase.

1. **Validar matriz negativa offline:**
   ```bash
   pnpm prehomologation:serpro
   ```
   Confirma H-04 a H-07 no normalizador compilado de produção.
2. **Executar smoke mTLS real contra `hom.renave`:**
   ```bash
   pnpm smoke:serpro:hml
   ```
   Chama somente `GET /api/cliente-autenticado` e valida identidade (`cnpj` + `cnpjIntegradora`).
3. **Executar a cerimônia do Canário GET na interface (`/compliance`):**
   - Com `VITE_APP_ENVIRONMENT=homologation` e papel administrativo com MFA, executar o `HomologationCanaryPanel` (6 etapas seriais sem mutação: `initial_readiness` → `preflight` → `confirmed_readiness` → `eligibility` → `stocks` → `vehicle`).
   - Confirmar que a evidência cifrada foi gravada, que a auditoria encadeada permanece íntegra e que `pnpm db:scan-evidence` / `pnpm db:status-evidence` reportam ambiente saudável ([`docs/ops/monitor-de-evidencias.md`](ops/monitor-de-evidencias.md)).
4. **Configurar observabilidade e alertas sanitizados:**
   - Ativar agregação e deduplicação multi-réplica dos eventos de expiração de certificado (`90/60/30/15/7/1` dia) e alertas `SEV-1..SEV-4` conforme [`docs/ops/observability-and-incidents.md`](ops/observability-and-incidents.md).

---

## Fase D — Catálogo Oficial de Municípios e Perfis Verificados

Pré-requisitos obrigatórios antes de habilitar `POST` de entrada ou saída:

1. **Capturar, aprovar e publicar o catálogo oficial de municípios RENAVE:**
   - Capturar o snapshot autenticado via mTLS em homologação e receber o SHA-256 do manifesto por canal de aprovação independente.
   - Validar offline sem rede/banco:
     ```bash
     pnpm municipality:catalog:verify
     ```
   - Publicar atomicamente via papel migrator:
     ```bash
     pnpm municipality:catalog:publish
     ```
2. **Provisionar perfis verificados de operador e estabelecimento:**
   - Utilizar a CLI `stock-entry-provisioning` (`pnpm stock-entry:profile:stage-operator`, `pnpm stock-entry:profile:stage-establishment`, `pnpm stock-entry:pin:provision`) conforme [`docs/ops/renave-profile-administration.md`](ops/renave-profile-administration.md).
3. **Validar a composição do worker de reconciliação:**
   - Executar o overlay `dry-run` (`deploy/reconciliation-worker/overlays/dry-run/`) e conferir aderência integral à agenda `1 / 5 / 15 / 60 min` + tolerância de 5 min (ADR 0002) conforme [`docs/ops/reconciliation-worker.md`](ops/reconciliation-worker.md) e [`docs/ops/reconciliation-worker-homologation.md`](ops/reconciliation-worker-homologation.md).

---

## Fase E — Homologação Ponta a Ponta (Mocks SERPRO + DETRAN)

1. **Executar matriz oficial H-01 a H-19 em homologação:**
   - **H-01 / H-02:** Entrada de usado comprado de PF e veículo próprio (`SOLICITADO` → `TRANSFERIDO` → `CONFIRMADO`).
   - **H-03:** Saída de veículo usado → ATPV-e → `FINALIZADO` (incluindo composição futura de outbox/promoção/worker de saída após aprovação do fluxo local).
   - **H-04 a H-09:** Cenários negativos reais nos mocks SERPRO (roubo/furto, PGFN, CRV pendente, já baixado, vendedor divergente, NF-e inválida).
   - **H-10 / H-11:** Cancelamentos de entrada (`SOLICITADO`) e saída antes da transferência no DETRAN.
   - **H-18 / H-19:** Injeção de timeout e HTTP `500` com `logIdRastreabilidade` → confirmar transição para `PENDING_RECONCILIATION`, reconciliação sem duplicar e encaminhamento conservador para `MANUAL_REVIEW` quando ambíguo/expirado.
   - **H-20 / H-21 / H-23:** Certificado expirado fechando readiness, isolamento multi-tenant (`404`) e detecção de adulteração na cadeia de auditoria.
2. **Coletar evidências oficiais de homologação** (protocolos, `traceId`, relatórios sanitizados sem PII) para aprovação junto ao SERPRO/SENATRAN.

---

## Fase F — Prontidão e Liberação de Produção

Atualmente o conector **bloqueia produção por código** (incluindo `PEM_MTLS_PRODUCTION_BLOCKED`). Para remover esse bloqueio com segurança:

1. **HSM / KMS gerenciado em região Brasil:**
   - Substituir arquivos PEM locais por chave privada não exportável em HSM/KMS (mTLS, cifragem de evidências e assinatura Ed25519).
2. **Âncora externa WORM (retenção mínima de 5 anos):**
   - Implementar publicação periódica e imutável da cabeça da cadeia de auditoria por tenant em armazenamento WORM externo (ADR 0003).
3. **Continuidade e Segurança Externa:**
   - Game day de Disaster Recovery (restore + failover dentro do **RTO ≤ 4 h**).
   - Pentest independente sem achados críticos/altos.
   - Monitor diário do Swagger SERPRO (`.github/workflows/serpro-contract.yml`) ativo em produção.
4. **Compliance e Go-Live:**
   - Aprovação formal da SENATRAN / SERPRO para produção + certificação ISO 27001 (se Rota A) + parecer jurídico/DPA/LGPD publicados.
   - Remoção controlada da trava de produção no conector via PR auditado + piloto assistido com 3–5 revendas (meta SUS ≥ 80).

---

## Checklist Resumido de Desbloqueio

- [ ] Modelo regulatório definido (Rota A / B) e acesso a `hom.renave` liberado
- [ ] Certificado e-CNPJ de homologação montado via cofre (`/run/secrets/...`)
- [ ] Banco PostgreSQL + OIDC/MFA + NTP provisionados em região Brasil
- [ ] `pnpm prehomologation:serpro` e `pnpm smoke:serpro:hml` verdes contra `hom.renave`
- [ ] Canário GET (6 etapas) executado com sucesso em `/compliance`
- [ ] Catálogo oficial de municípios verificado (`municipality:catalog:verify`) e publicado (`municipality:catalog:publish`)
- [ ] Perfis verificados provisionados e worker de reconciliação validado em `dry-run`
- [ ] Matriz oficial H-01..H-19 executada e evidenciada com SERPRO/DETRAN
- [ ] HSM/KMS + âncora WORM (5 anos) + DR (RTO ≤ 4 h) + pentest concluídos
- [ ] Autorização formal de produção obtida para remover o bloqueio de produção no conector
