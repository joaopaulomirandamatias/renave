# 06 — Requisitos não funcionais, segurança e LGPD

> **Convenções:** `RNF-<categoria>-<nº>`. Cada requisito tem uma **métrica verificável** e a **forma de verificação**. Os itens marcados **[ANEXO]** são exigências da Res. CONTRAN 1.026/2026 para integradoras e **não são negociáveis**.

---

## 6.1 Disponibilidade, continuidade e desempenho

| ID | Requisito | Métrica / meta | Verificação |
|---|---|---|---|
| RNF-DIS-01 | Disponibilidade da plataforma (UI + API) | ≥ **99,9%** ao mês (sem contar indisponibilidade do SERPRO/DETRAN, que é medida à parte) | SLO + status page |
| RNF-DIS-02 | Disponibilidade do conector RENAVE (componente próprio) | ≥ **99,9%**; disponibilidade fim a fim reportada separadamente | Probes sintéticos a cada 1 min (`GET /api/cliente-autenticado` em homologação) |
| RNF-DIS-03 **[ANEXO]** | Infraestrutura **redundante** | Multi-AZ para app, banco (réplica síncrona), fila e storage; sem ponto único de falha | Revisão de arquitetura + game day |
| RNF-DIS-04 **[ANEXO]** | **RTO ≤ 4 horas** | RTO-alvo de **2 h**; RPO ≤ **5 min** | Teste de DR **semestral** documentado |
| RNF-DIS-05 | Backups criptografados com restore testado | Diário completo + PITR (WAL) 14 dias; teste de restore **mensal** | Relatório de restore |
| RNF-DIS-06 | Degradação graciosa | Com o RENAVE indisponível, a UI continua funcionando: rascunhos, consultas locais e fila de envio com circuit breaker | Teste de caos |
| RNF-DES-01 | Latência da UI independente da latência externa | p95 < **300 ms** em leituras da API própria; ações de envio retornam em < **500 ms** (assíncronas) | APM |
| RNF-DES-02 | Timeouts externos explícitos | POST 120 s, GET 60 s (manual); circuit breaker por endpoint e por estabelecimento | Teste de integração |
| RNF-DES-03 | Throughput | Suportar **50 operações/s** de pico sustentado no MVP; escalar horizontalmente gateway, API e workers (stateless) | Teste de carga (k6) |
| RNF-DES-04 | Front-end | LCP < **2,5 s** em 4G; bundle inicial < **250 KB** gz; orçamento de bundle no CI | Lighthouse CI |
| RNF-DES-05 | Lote de 0 km | 500 veículos processados em < **10 min**, com progresso visível | Teste de carga |

## 6.2 Segurança da informação

| ID | Requisito | Detalhe | Verificação |
|---|---|---|---|
| SEC-01 **[ANEXO]** | **SGSI ISO/IEC 27001** certificado | Até **27/03/2027**. Escopo: produto, infraestrutura, operação e suporte. Responsável técnico formal por segurança e continuidade. | Auditoria de certificação |
| SEC-02 | TLS forte | TLS 1.2+ (1.3 preferencial) em todo o tráfego; HSTS; cifras modernas | SSL Labs A+ |
| SEC-03 **[ANEXO]** | **mTLS ICP-Brasil** com o RENAVE | Certificado e-CNPJ por estabelecimento; truststore com a cadeia da AC SERPRO (produção e homologação, separadas); **verificação de hostname sempre ligada**, com tratamento explícito do CN `estaleiro.serpro.gov.br` | Teste de integração + revisão |
| SEC-04 | Chaves privadas em cofre | **KMS/HSM** (FIPS 140-2 nível 3 para produção) ou Vault com auto-unseal em HSM; a chave nunca chega ao disco da aplicação em claro; acesso por *workload identity* | Revisão + pentest |
| SEC-05 | Isolamento multi-tenant | RLS `FORCE` em todas as tabelas de tenant + filtro na aplicação + testes automatizados de vazamento (matriz rota × papel × tenant) no CI | Suíte de isolamento |
| SEC-06 | Autenticação | OIDC (Keycloak); **MFA obrigatório** para perfis privilegiados (WebAuthn/TOTP); bloqueio progressivo; senhas com mínimo de 12 caracteres e checagem contra vazamentos | Pentest |
| SEC-07 | Sessões | BFF com cookie `HttpOnly; Secure; SameSite=Strict`; **nenhum token no localStorage**; expiração por inatividade (30 min) e absoluta (12 h) | Revisão |
| SEC-08 | Autorização | RBAC/ABAC no backend por ação × escopo; negação por padrão; checagem em toda rota (teste que falha se uma rota não declarar a permissão) | Teste estático |
| SEC-09 | OWASP | Proteção contra OWASP Top 10 e **API Security Top 10** (BOLA, mass assignment, SSRF etc.); WAF gerenciado; rate limit por IP, usuário e cliente | DAST + pentest anual |
| SEC-10 | Segredos | Nenhum segredo no repositório; *secret scanning* (pre-commit + CI); rotação trimestral de segredos de serviço | gitleaks no CI |
| SEC-11 | Criptografia em repouso | Banco, backups, storage e filas cifrados (AES-256); payloads RENAVE e documentos sensíveis com **envelope encryption** por tenant | Revisão |
| SEC-12 | Mascaramento | CPF/CNPJ e dados pessoais mascarados em logs e UI conforme o perfil; *redaction* automático no logger | Teste de log |
| SEC-13 | Cadeia de suprimentos | SAST, SCA (dependências), imagem base mínima, SBOM, assinatura de imagens, Renovate/Dependabot | Pipeline |
| SEC-14 **[ANEXO]** | Prevenção a fraudes | Regras e detecção de anomalias: volume atípico por usuário/estabelecimento, operações fora do horário, alterações em massa, IP novo, CPF de operador inconsistente, reuso de NF-e, valor muito fora da média | Painel antifraude + alertas |
| SEC-15 **[ANEXO]** | Monitoramento contínuo | SIEM com alertas 24×7 para eventos de segurança; plano de resposta a incidentes com **revogação emergencial** de credenciais e certificados | Simulado semestral |
| SEC-16 | Revisão de acessos | Trimestral, com evidência | Relatório |
| SEC-17 | Hardening | Containers *non-root*, filesystem *read-only*, *network policies*, bastion com MFA, nenhum acesso SSH direto em produção | CIS benchmark |
| SEC-18 | Pentest | Anual e a cada mudança relevante, por terceiro independente | Relatório + plano de correção |

## 6.3 Auditoria e rastreabilidade

| ID | Requisito | Detalhe |
|---|---|---|
| AUD-NF-01 **[ANEXO]** | **Registro imutável** de todas as transações | Campos: usuário, **IP de origem**, **horário sincronizado com a Hora Legal Brasileira (NTP `ntp.on.br` / `a.ntp.br`)**, operação, **dados de entrada e saída**, **hash de integridade** |
| AUD-NF-02 **[ANEXO]** | Retenção ≥ **5 anos**, disponível para os órgãos de trânsito | Storage WORM (*object lock*, modo *compliance*) para a trilha e os payloads; exportação para fiscalização |
| AUD-NF-03 | Cadeia de hash verificável | `event_hash = SHA-256(previous_hash ‖ JCS(evento))`; âncora diária (hash do dia) publicada e assinada; verificador independente (CLI) |
| AUD-NF-04 | Monitoramento de drift do relógio | Alerta se o desvio for > 100 ms em relação ao NTP do Observatório Nacional |
| AUD-NF-05 | Auditoria do banco | Triggers append-only com `ENABLE ALWAYS`; o papel da aplicação não tem `UPDATE/DELETE` nas tabelas de auditoria |

## 6.4 Privacidade e LGPD

| ID | Requisito | Detalhe |
|---|---|---|
| LGPD-01 | Papéis | A SENATRAN é **controladora** dos dados do Renave (Res. art. 31). A integradora atua como **operadora** para esses dados e como controladora dos dados de cadastro e uso da plataforma. Isso fica em contrato e DPA. |
| LGPD-02 | Finalidade | Dados usados **exclusivamente** para escrituração e finalidades da Resolução; bloqueio técnico de exportações para outros fins |
| LGPD-03 | Minimização | Coletar só os campos exigidos pelo MAN/Resolução; nada de dados pessoais em analytics |
| LGPD-04 | Inventário (RoPA) | Registro das operações de tratamento, por categoria de dado, base legal e retenção |
| LGPD-05 | Direitos do titular | Processo de atendimento com SLA de 15 dias; trilha |
| LGPD-06 | Localização **[ANEXO]** | **Processamento primário em datacenter no Brasil**; backup no exterior só com salvaguardas da LGPD/ANPD e diretrizes da SENATRAN |
| LGPD-07 | Incidentes | Comunicação à ANPD e aos titulares conforme a Res. CD/ANPD 15/2024; comunicação à SENATRAN |
| LGPD-08 | Eliminação segura | Ao fim da retenção e na migração de integradora, com certificado de eliminação |
| LGPD-09 | Política de privacidade e termo de sigilo **[ANEXO]** | Publicados, versionados e com aceite registrado |

## 6.5 Observabilidade e operação

| ID | Requisito | Detalhe |
|---|---|---|
| OBS-01 | Logs estruturados (JSON) centralizados | pino → Loki/ELK, com `correlation_id`, `tenant_id`, `operation_id`; retenção quente de 30 dias e fria de 1 ano |
| OBS-02 | Tracing distribuído | OpenTelemetry da UI à chamada RENAVE; *span* por tentativa |
| OBS-03 | Métricas de negócio e técnicas | Disponibilidade do conector, sucesso por operação, erros por código RENAVE, latência p50/p95/p99, operações em "resultado incerto", pendências por tipo e idade, divergências, certificados a vencer, webhooks falhos |
| OBS-04 | Alertas com runbook | Cada alerta tem *owner* e runbook. Runbooks mínimos: RENAVE indisponível; certificado expirado ou revogado; timeout com resultado incerto; divergência de estoque; falha massiva de webhook; aumento de erros após mudança de API; incidente de segurança |
| OBS-05 | SLOs e error budget | SLO por jornada crítica (entrada, saída, transferência); revisão mensal |
| OBS-06 | Suporte **[ANEXO]** | Horário comercial ampliado (sugestão: 7h–22h em dias úteis, 8h–18h aos sábados) + plantão 24×7 para severidade 1 |

## 6.6 Arquitetura, manutenibilidade e qualidade

| ID | Requisito | Detalhe |
|---|---|---|
| ARQ-01 | Monólito modular com *bounded contexts* | Módulos com fronteiras e eventos internos; extração para serviço só quando houver necessidade medida |
| ARQ-02 | Idempotência em operações mutáveis | Chave persistida antes da chamada; tabela `operation` única por `(tenant, idempotency_key)` |
| ARQ-03 | Fila durável | Outbox transacional + workers; *dead letter* com reprocessamento controlado |
| ARQ-04 | Infraestrutura como código | Terraform/OpenTofu; ambientes DEV, HML, STG e PRD **segregados** (contas e projetos distintos) |
| ARQ-05 | Versionamento de API | SemVer; compatibilidade garantida dentro da *major*; *deprecation* com aviso de 6 meses |
| ARQ-06 | Adapters por capacidade RENAVE | Interface estável do domínio → adapters versionados; feature flags por vigência regulatória |
| QUA-01 | Testes | Unitários ≥ 80% no domínio; contrato (Swagger RENAVE → snapshot); integração com mocks de homologação; E2E das jornadas críticas; isolamento de tenant; resiliência (queda de rede, duplicidade, *replay*, timeout) |
| QUA-02 | CI/CD | Lint, typecheck (strict), testes, SAST, SCA, *secret scan*, a11y e bundle a cada PR; deploy com *canary* e *rollback* automático |
| QUA-03 | Documentação | OpenAPI público, ADRs, runbooks, guia de integração, manual do usuário; atualizada a cada release |

## 6.7 Usabilidade e acessibilidade

| ID | Requisito | Meta |
|---|---|---|
| UX-01 | Acessibilidade | **WCAG 2.2 AA** (contraste ≥ 4,5:1, navegação por teclado, foco visível, ARIA, leitores de tela) |
| UX-02 | Responsividade | Desktop ≥ 1280, tablet e celular (≥ 360 px); PWA para o pátio |
| UX-03 | Aprendizado | Um usuário novo conclui a primeira entrada em **≤ 10 min** sem treinamento (teste de usabilidade com 5 usuários) |
| UX-04 | Eficiência | Entrada de usado com ≤ **4 min** de trabalho ativo; atalhos de teclado nas ações frequentes |
| UX-05 | Linguagem | Termos de negócio; erros com causa + ação; o código técnico só em "Detalhes técnicos" |
| UX-06 | Prevenção de erro | Validação em tempo real; confirmação reforçada em ações irreversíveis (ex.: saída Renovar) |
| UX-07 | Satisfação | SUS ≥ **80** nos testes de usabilidade antes do go-live |

## 6.8 Compatibilidade e portabilidade

| ID | Requisito |
|---|---|
| POR-01 | Navegadores: as duas últimas versões de Chrome, Edge, Firefox e Safari |
| POR-02 **[ANEXO]** | Exportação íntegra, autenticada, rastreável e auditável dos dados de cada estabelecimento (JSON Lines + documentos + manifesto SHA-256 assinado) |
| POR-03 | Importação de dados de outra integradora (migração de entrada), com validação e reconciliação |
| POR-04 | Banco e infraestrutura sem dependência proprietária crítica (Postgres, S3 API, OIDC) |
