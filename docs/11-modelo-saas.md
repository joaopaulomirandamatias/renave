# 11 — Modelo SaaS: operação da plataforma, clientes e cobrança por registro

> O ViaAuto é um **SaaS B2B multi-tenant**. **Nós somos o operador da plataforma** (a integradora). Concessionárias, revendas, grupos, montadoras, ITEs e instituições credoras são **clientes (tenants)** e assinam o serviço, cada um com seus estabelecimentos (matriz e filiais) e usuários.
> Este documento especifica a camada SaaS: backoffice do operador, ciclo de vida do cliente, cobrança por registro RENAVE, parceiros e a conta do cliente.
> **Escopo:** a ViaAuto é **exclusivamente um sistema RENAVE** (sistema de integração da Res. CONTRAN 1.026/2026). Não é, nem terá módulos de, gestão de veículos, de loja ou comercial (DMS), atividade vedada à integradora.

---

## 11.1 Hierarquia de contas

```mermaid
flowchart TD
  P[Plataforma — ViaAuto<br/>equipe interna: Super admin, Operações, Suporte, Financeiro, CS, Compliance]
  PA[Parceiro DMS/ERP<br/>opcional · white-label · revenue share]
  T1[Tenant: Grupo Auto Prime<br/>contrato · faturamento por registro]
  T2[Tenant: Revenda Bom Negócio]
  E1[Estabelecimento Matriz<br/>CNPJ 0001 · certificado e-CNPJ]
  E2[Filial Campinas<br/>CNPJ 0002]
  E3[Filial Santos<br/>CNPJ 0003]
  U[Usuários do cliente<br/>perfis × escopo por estabelecimento]
  P --> PA
  P --> T1
  PA -.indica / provisiona.-> T2
  T1 --> E1 & E2 & E3
  T1 --> U
```

| Nível | Quem é | Isolamento | Exemplos de dados |
|---|---|---|---|
| **Plataforma** | Nós (operador) | Acesso cross-tenant **apenas** por papéis de plataforma, com auditoria | Tabela oficial de preços por registro, flags, catálogo RENAVE, métricas globais |
| **Parceiro** | Fornecedor de DMS/ERP que integra via API e white-label | Vê apenas os tenants que indicou, com o consentimento deles | Clientes indicados, volume, comissão |
| **Tenant** | Cliente contratante (CNPJ raiz / grupo econômico) | **RLS** por `tenant_id` | Contrato, consumo de registros, faturas, usuários |
| **Estabelecimento** | CNPJ que opera no RENAVE (matriz/filial) | Escopo dentro do tenant | Certificado, estoque, operações |
| **Usuário** | Pessoa ou cliente de API | Perfil × escopo de estabelecimentos | — |

> Um usuário pode pertencer a **mais de um tenant** (ex.: contador ou despachante que atende várias revendas), com troca de contexto explícita e auditada.

## 11.2 Papéis da plataforma (equipe interna)

| Papel | Pode | Não pode | MFA |
|---|---|---|---|
| **Super admin** | Tudo na plataforma; gerenciar equipe e papéis; faixa de preço; flags globais | Ler dados de operação de cliente sem acesso de suporte registrado | Obrigatório (WebAuthn) |
| **Operações / NOC** | Saúde do conector, filas, reconciliação global, incidentes, reprocessamento seguro | Alterar cobrança | Obrigatório |
| **Suporte N1** | Ver cadastro e status dos clientes; abrir e responder chamados; **acessar como** (somente leitura, com motivo e prazo) | Executar operações RENAVE pelo cliente; exportar dados | Obrigatório |
| **Suporte N2** | O mesmo que o N1, mais reprocessamento controlado e diagnóstico técnico (payloads mascarados) | Alterar cobrança | Obrigatório |
| **Financeiro** | Tabela de preços (a partir do ato oficial), faturas, cobranças, régua de cobrança, NFS-e, suspensão por inadimplência | Ver dados de operação | Obrigatório |
| **Comercial / CS** | Criar cliente (provisionamento), acompanhar onboarding e saúde, parceiros | Cobrança, dados operacionais | Obrigatório |
| **Compliance / DPO** | Auditoria da plataforma, solicitações de titulares, exportações para fiscalização, retenção | Alterar dados | Obrigatório |

**Regras:**
- Acesso **just-in-time**: privilégios elevados são temporários, com aprovação.
- Revisão trimestral de acessos.
- Toda ação de plataforma gera um evento na **auditoria da plataforma** (cadeia de hash própria).

## 11.3 Ciclo de vida do cliente (tenant)

```mermaid
stateDiagram-v2
  [*] --> CADASTRADO: self-service ou criado pelo Comercial
  CADASTRADO --> HOMOLOGACAO: e-mail validado + termos aceitos
  HOMOLOGACAO --> ONBOARDING: contrato assinado + dados de faturamento
  ONBOARDING --> ATIVO: adesão aprovada + certificado + homologação OK
  ATIVO --> INADIMPLENTE: fatura vencida (D+1)
  INADIMPLENTE --> ATIVO: pagamento confirmado
  INADIMPLENTE --> SUSPENSO: D+15 sem pagamento (após avisos)
  SUSPENSO --> ATIVO: regularização
  ATIVO --> ENCERRANDO: pedido de encerramento / migração
  SUSPENSO --> ENCERRANDO: 90 dias suspenso
  ENCERRANDO --> ENCERRADO: exportação entregue + prazo de portabilidade (60 dias)
  ENCERRADO --> [*]: eliminação segura após a retenção legal (5 anos)
```

| Estado | O que o cliente pode fazer | Observações |
|---|---|---|
| CADASTRADO | Completar o cadastro | — |
| HOMOLOGACAO | Usar o ambiente de **homologação** (mocks e clientes-padrão), configurar usuários e estabelecimentos | *Trial* sem custo de operação real |
| ONBOARDING | Jornada de adesão (Credencia, certificado, homologação) | Acompanhada pelo CS |
| ATIVO | Tudo, conforme o tipo de estabelecimento | — |
| INADIMPLENTE | Tudo, com banner de aviso | Régua: D+1 lembrete, D+7 aviso formal |
| **SUSPENSO** | **Consultas, documentos, auditoria e exportação** continuam liberadas. **Novas operações** ficam bloqueadas, **exceto** cancelamentos e operações que evitem dano ao cliente (ex.: concluir saída já iniciada), conforme a política | Atraso de escrituração gera multa ao estabelecimento: a suspensão é **precedida de avisos** e o contrato prevê o efeito. Decisão final: jurídico (ver D9) |
| ENCERRANDO | Somente leitura + exportação completa | Portabilidade (Anexo Res. 1.026) |
| ENCERRADO | — | Dados retidos pelo prazo legal, depois eliminados com certificado |

## 11.4 Modelo de cobrança: **por registro RENAVE realizado**

> **Decisão do patrocinador:** a ViaAuto **não cobra mensalidade da plataforma** e **não tem planos nem add-ons**. O cliente paga **por registro RENAVE realizado** (confirmado), com **valores definidos pela autoridade**. Todas as funcionalidades da plataforma ficam incluídas para todos os clientes, conforme o tipo de estabelecimento.

### Base regulatória

1. A Res. 1.026 (art. 32) determina que a integradora observe os **valores de preço público** estabelecidos pela SENATRAN, com **mínimo e máximo**. É **vedado** cobrar fora da faixa ou condicionar o acesso ao RENAVE a outros serviços.
2. A integradora deve dar **ampla publicidade** aos valores.
3. A operação técnica e a tarifação do RENAVE-WS são do **SERPRO**. O detalhamento de quem fixa cada valor e de como se relacionam a tarifa SERPRO e o preço público da integradora está em **§11.4a**, a partir da pesquisa legislativa.

### Princípios

| Princípio | Regra |
|---|---|
| **Fato gerador** | Um **registro RENAVE confirmado** (entrada, saída, transferência, consignação, retomado etc.) |
| **Valor unitário** | O **valor oficial vigente** para o tipo de registro (`price_table` alimentada a partir do ato oficial, com vigência). Nunca um valor livre |
| **Não cobrado** | Rejeições (422), erros técnicos, operações incertas não confirmadas, cancelamentos de iniciativa própria *(a confirmar no ato oficial)*, consultas (aptidão, estoque, documentos) e **todo o ambiente de homologação** |
| **Sem mensalidade** | Não há assinatura, plano, franquia ou add-on. A conta é gratuita; paga-se o que se registra |
| **Tudo incluído** | Painel, pendências, auditoria, dossiê, API/webhooks, usuários, filiais e suporte fazem parte do serviço de integração |
| **Transparência** | Tabela pública de preços por tipo de registro, com o ato normativo e a vigência; extrato detalhado registro a registro |

### Tabela de preços (estrutura)

| Tipo de registro faturável | Unidade | Valor |
|---|---|---|
| Entrada de usado (compra / veículo próprio / retomado) | por registro confirmado | `[VALOR OFICIAL]` |
| Saída de usado (venda) | por registro confirmado | `[VALOR OFICIAL]` |
| Entrada de 0 km | por registro confirmado | `[VALOR OFICIAL]` |
| Saída de 0 km (inclui Renovar) | por registro confirmado | `[VALOR OFICIAL]` |
| Transferência entre estabelecimentos / filiais | por registro confirmado | `[VALOR OFICIAL]` |
| Consignação (entrada / saída / devolução) | por registro confirmado | `[VALOR OFICIAL]` |
| ITE (entrada / saída / transferência) | por registro confirmado | `[VALOR OFICIAL]` |

> A tabela é **dado regulatório versionado** (`price_table` + `price_table_item`, com ato normativo, data de publicação e vigência). Uma mudança de valor entra em vigor na data do ato, por feature flag, e é comunicada aos clientes com antecedência.

## 11.4a Quem define os valores (pesquisa legislativa)

*(Preenchido com o resultado da pesquisa: ato da SENATRAN sobre o preço público, tarifa SERPRO e relação entre os dois.)*

## 11.5 Medição e faturamento

| Etapa | Regra |
|---|---|
| **Medição** | Um `billable_record` é criado **somente** quando o registro é **confirmado** pelo RENAVE, com chave idempotente `(operation_id)`. Retries e reconciliações nunca cobram duas vezes |
| **Estorno** | Se um registro faturado for depois cancelado no RENAVE, o tratamento (estorno ou não) segue o ato oficial; o padrão é **não estornar** o registro original e **não cobrar** o cancelamento *(a confirmar)* |
| **Fechamento** | Mensal por cliente (tenant), com extrato **registro a registro**: placa/chassi, tipo, estabelecimento, data, valor unitário e ato vigente |
| **Prévia** | Em tempo real na tela "Consumo e faturas" do cliente |
| **Faturamento** | Fatura + cobrança via gateway (boleto, PIX, cartão) + **NFS-e** automática |
| **Régua de cobrança** | D-3 lembrete · D+1 aviso · D+7 aviso formal (e-mail + WhatsApp + banner) · D+15 suspensão parcial (ver 11.3) |
| **Conciliação** | Registros faturados ao cliente × consumo/tarifa SERPRO (se houver repasse) × registros confirmados no RENAVE (`GET /api/estoques`) |
| **Webhooks do gateway** | Assinados e idempotentes, com o status de pagamento refletido na fatura |
| **Contestação** | O cliente pode contestar um item do extrato; a evidência é o próprio registro confirmado (id do estoque RENAVE + hash da resposta) |

## 11.6 Provisionamento de clientes

**Dois caminhos:**

1. **Self-service:** "Criar conta da empresa" com CNPJ, responsável (CPF), e-mail e tipo. Em seguida: validação de e-mail → ambiente de **homologação** liberado → dados de faturamento → contrato eletrônico → onboarding regulatório (adesão, certificado, homologação) → produção.
2. **Assistido** (Comercial/CS no backoffice): assistente "Novo cliente" com empresa (CNPJ e CNAE), tipo e módulos RENAVE habilitados, dados de faturamento, administrador do cliente (convite + MFA obrigatório) e ambiente inicial. O cliente recebe o convite e conclui o onboarding.

**Via parceiro (API de parceiro):** o DMS provisiona o cliente programaticamente, com **consentimento** registrado do cliente final, e opera via API e telas *embedded* com a marca do parceiro.

## 11.7 Acesso de suporte ("Acessar como")

- Exige **motivo** obrigatório (texto + chamado vinculado) e **duração máxima** (padrão: 60 min).
- É **somente leitura** por padrão; escrita exige aprovação do cliente ou de um supervisor e fica registrada.
- O **cliente é notificado** e vê o histórico de acessos de suporte em sua auditoria.
- Durante a sessão, um banner persistente mostra "Você está acessando como Auto Prime — somente leitura — expira em 42 min".
- Ações proibidas mesmo com aprovação: ver ou exportar a chave do certificado, alterar MFA do cliente, exportar dados pessoais em massa.

## 11.8 Parceiros DMS/ERP (canal B2B2B)

> A Res. 1.026 **proíbe** fornecedores de DMS/ERP de lojas e concessionárias de serem integradoras. Eles precisarão de uma integradora autorizada, e esse é o nosso canal.

| Capacidade | Descrição |
|---|---|
| Conta de parceiro | Organização de parceiro com usuários próprios, sandbox e chaves de API |
| Clientes indicados | Vínculo parceiro ↔ tenant com **consentimento** do tenant; o parceiro vê status e uso agregado, **não** dados de operação, salvo consentimento específico |
| White-label | Logo, cores e domínio do parceiro nas telas *embedded* e e-mails |
| Embedded | Componentes ou iframes autenticados (assistente de entrada, ficha do veículo) para incorporar no DMS |
| Revenue share | Percentual por cliente indicado, apurado mensalmente |
| Certificação | Programa de certificação técnica da integração do parceiro (testes de contrato) |

> ⚠️ O parceiro **não** pode operar o RENAVE em nome próprio nem ter acesso ao certificado do cliente. A integradora (nós) continua responsável perante a SENATRAN.

## 11.9 Métricas do SaaS (backoffice)

| Métrica | Definição |
|---|---|
| Registros confirmados | Volume no mês por tipo, cliente e estabelecimento (principal indicador de receita) |
| Receita de registros | Registros faturados × valor oficial; tendência mês a mês |
| Clientes por estado | Homologação, onboarding, ativos, inadimplentes, suspensos, encerrados |
| Funil de onboarding | Cadastrado → Credencia → Certificado → Homologação → Produção, com tempo médio por etapa |
| Operações faturáveis | Volume confirmado no mês, por tipo e por cliente |
| Retenção | Clientes ativos que registraram no mês; clientes sem registros há 30/60/90 dias; cancelamentos |
| Health score do cliente | Pendências vencidas, incertos, certificado, uso, chamados, inadimplência |
| Margem por cliente | Receita − custo SERPRO − custo de infraestrutura rateado |
| Parceiros | Clientes indicados, volume, comissão |

## 11.10 Requisitos funcionais da camada SaaS

### M21 — Backoffice do operador (gestão do SaaS)

| ID | Requisito | Prio | Fase |
|---|---|---|---|
| RF-M21-01 | Visão geral do SaaS: registros confirmados e receita de registros no mês, clientes por estado, funil de onboarding, alertas, top clientes | M | F3 |
| RF-M21-02 | Lista de clientes com filtros (estado, tipo, volume de registros, CSM, saúde) e busca por CNPJ ou nome | M | F1 |
| RF-M21-03 | Detalhe do cliente com abas: visão geral, estabelecimentos, usuários, consumo e faturas, módulos RENAVE habilitados, suporte, auditoria | M | F1 |
| RF-M21-04 | Assistente "Novo cliente" (provisionamento assistido) com convite do administrador | M | F1 |
| RF-M21-05 | Suspender, reativar e encerrar cliente, com motivo e efeitos explicados; exportação de portabilidade | M | F1 |
| RF-M21-06 | "Acessar como" auditado (motivo, prazo, somente leitura, notificação) | M | F2 |
| RF-M21-07 | Gestão da equipe da plataforma: papéis, MFA obrigatório, acessos temporários, revisão de acessos | M | F1 |
| RF-M21-08 | Auditoria da plataforma (impersonações, tabela de preços, suspensões, exportações, faixa de preço) com cadeia de hash | M | F1 |
| RF-M21-09 | Configurações globais: faixa de preço SENATRAN, feature flags (por tenant, ambiente e data), integrações da plataforma, templates, retenção | M | F1 |
| RF-M21-10 | Central de suporte multi-tenant com SLA e contexto automático da operação | M | F2 |
| RF-M21-11 | Health score do cliente e alertas para o CS | S | F3 |
| RF-M21-12 | Anúncios e comunicados para clientes (in-app + e-mail), segmentados (ex.: mudança de manual RENAVE) | S | F3 |

### M22 — Cobrança por registro

| ID | Requisito | Prio | Fase |
|---|---|---|---|
| RF-M22-01 | Tabela oficial de preços por tipo de registro, versionada por ato normativo e vigência | M | F3 |
| RF-M22-02 | Validador contra a faixa ou valor oficial vigente e página pública de preços gerada automaticamente | M | F3 |
| RF-M22-03 | Medição idempotente: um item faturável por registro RENAVE confirmado | M | F2 |
| RF-M22-04 | Fechamento mensal com extrato registro a registro, fatura, cobrança via gateway (boleto, PIX, cartão) e NFS-e | M | F3 |
| RF-M22-05 | Régua de cobrança configurável e suspensão parcial automática | M | F3 |
| RF-M22-06 | Webhooks do gateway de pagamento (idempotentes) e conciliação | M | F3 |
| RF-M22-07 | Aplicação automática de novo valor oficial na data de vigência, com aviso prévio aos clientes | M | F3 |
| RF-M22-08 | Conciliação registros faturados × registros confirmados no RENAVE × tarifa SERPRO (se houver repasse) | M | F3 |
| RF-M22-09 | Contestação de item de fatura pelo cliente | C | F3 |

### M23 — Conta do cliente (autoatendimento)

| ID | Requisito | Prio | Fase |
|---|---|---|---|
| RF-M23-01 | Cadastro self-service da empresa com validação de CNPJ e e-mail, aceite de termos e ambiente de homologação | M | F2 |
| RF-M23-02 | "Consumo e faturas": registros do mês por tipo e estabelecimento, valor oficial vigente, previsão de fatura, extrato registro a registro, faturas e 2ª via, forma de pagamento | M | F3 |
| RF-M23-03 | Consultar a tabela pública de preços vigente e o histórico de vigências | M | F3 |
| RF-M23-04 | Exportar todos os dados (portabilidade) a qualquer momento | M | F3 |
| RF-M23-05 | Histórico de acessos de suporte à conta | M | F2 |
| RF-M23-06 | Encerrar conta com assistente (exportação + confirmação) | S | F3 |

### M24 — Parceiros

| ID | Requisito | Prio | Fase |
|---|---|---|---|
| RF-M24-01 | Cadastro de parceiro com sandbox, chaves de API e documentação | S | F3 |
| RF-M24-02 | Provisionamento de clientes via API de parceiro, com consentimento | S | F3 |
| RF-M24-03 | White-label (logo, cores, domínio) e componentes *embedded* | C | F4 |
| RF-M24-04 | Apuração de revenue share e relatório ao parceiro | C | F4 |

## 11.11 Regras de negócio da camada SaaS

| ID | Regra | Sev. | Origem |
|---|---|---|---|
| RN-SAAS-01 | Toda leitura cross-tenant por papel de plataforma exige motivo registrado. Dashboards agregados não expõem dados pessoais | 🔴 | LGPD, PROD |
| RN-SAAS-02 | Não há planos, mensalidade nem add-ons; todas as funcionalidades estão disponíveis a todos os clientes, conforme o tipo de estabelecimento (art. 32 §3º) | 🔴 | RES art. 32, PROD |
| RN-SAAS-03 | O valor cobrado por registro é sempre o oficial vigente (ou dentro da faixa oficial); mudança de ato atualiza a tabela na data de vigência | 🔴 | RES art. 32 |
| RN-SAAS-04 | Cobra-se somente o **registro RENAVE confirmado**, com idempotência por operação; consultas e homologação nunca são cobradas | 🔴 | PROD |
| RN-SAAS-05 | Suspensão por inadimplência só após a régua completa de avisos; consultas e exportação continuam disponíveis | 🔴 | PROD, ANEXO |
| RN-SAAS-06 | Encerramento garante exportação íntegra e verificável e prazo de portabilidade de 60 dias; eliminação só após a retenção legal | 🔴 | ANEXO |
| RN-SAAS-07 | Acesso de suporte é temporário, auditado, somente leitura por padrão e visível ao cliente | 🔴 | PROD, ISO 27001 |
| RN-SAAS-08 | O certificado e a chave do cliente **nunca** ficam acessíveis a papéis de plataforma nem a parceiros | 🔴 | RES art. 30, ANEXO |
| RN-SAAS-09 | Parceiro vê apenas os clientes que indicou, com consentimento, e dados agregados por padrão | 🔴 | LGPD |
| RN-SAAS-10 | Homologação (trial) não gera cobrança de operação nem toca a produção | 🔵 | PROD |
| RN-SAAS-11 | Usuário com acesso a vários tenants troca de contexto explicitamente; cada ação registra o tenant ativo | 🔴 | PROD |

## 11.12 Modelo de dados adicional (camada SaaS)

| Entidade | Campos principais |
|---|---|
| `platform_user` / `platform_role_grant` | Usuário interno, papel, escopo, expira_em (JIT), aprovado_por |
| `tenant` (estendido) | estado do ciclo de vida, dados de faturamento, csm_id, parceiro_id, health_score, datas (trial, ativação, suspensão, encerramento) |
| `price_table` / `price_table_item` | Ato normativo, publicação, vigência; item: tipo de registro, valor unitário (ou mínimo/máximo) |
| `billing_account` | tenant, responsável financeiro, e-mail de cobrança, forma de pagamento, gateway_ref |
| `tenant_module` | Módulo RENAVE habilitado (usados, 0 km, ITE, consignação, retomados), conforme o tipo de estabelecimento e a vigência regulatória |
| `billable_record` | tenant, estabelecimento, operation_id (unique), id do estoque RENAVE, tipo de registro, valor unitário, price_table_item, competência |
| `invoice_saas` / `payment` / `nfse` | Fatura, itens, valor, vencimento, status, gateway_ref, NFS-e |
| `dunning_event` | Fatura, etapa, canal, enviado_em |
| `support_access` | Usuário de plataforma, tenant, motivo, chamado, modo (leitura/escrita), início, fim, aprovado_por |
| `partner` / `partner_tenant` | Parceiro, white-label, chaves; vínculo com consentimento, revenue share |
| `platform_audit_event` | Igual a `audit_event`, com cadeia própria |
| `announcement` | Segmento, conteúdo, canal, publicado_em |

## 11.13 Telas do protótipo (camada SaaS)

As telas estão no mesmo canvas do protótipo, nas páginas **"Gestão do SaaS (Backoffice)"** e **"Conta do cliente"**: https://claude.ai/artifact/HdnUJ7n2pbz9pZY9hD71gN

| Tela | Artboard |
|---|---|
| Visão geral do SaaS | `SaasVisaoGeral` |
| Clientes (tenants) | `SaasClientes` |
| Detalhe do cliente (abas + "Acessar como") | `SaasClienteDetalhe` |
| Novo cliente (provisionamento) | `SaasNovoCliente` |
| Preço por registro (tabela oficial e vigências) | `SaasPlanos` |
| Faturamento e régua de cobrança | `SaasFaturamento` |
| Parceiros DMS/ERP | `SaasParceiros` |
| Suporte multi-tenant | `SaasSuporte` |
| Equipe da plataforma | `SaasEquipe` |
| Auditoria da plataforma | `SaasAuditoria` |
| Configurações globais | `SaasConfig` |
| Operação técnica | `Console` |
| Consumo e faturas (cliente) | `MinhaAssinatura` |
| Cadastro self-service | `Cadastro` |

## 11.14 Reuso dos projetos com modelo SaaS

> Projetos analisados (somente leitura): **baconian**, **kitara-ead**, **incentivatech** e **despachante**. `mirandaserp` (fork do ERPNext) e `vestigio-lab` (laboratório Python) foram descartados como base SaaS.
> Legenda: 🟢 COPIAR · 🟡 ADAPTAR · 🔵 IDEIA · ⚪ NÃO SERVE.

### Panorama

| Projeto | Stack | Maturidade SaaS | Melhor contribuição |
|---|---|---|---|
| **baconian** | Next 16 + pacotes TS independentes (`packages/{db,identity,billing,observability,storage}`), Prisma 7, BullMQ | **Alta no núcleo**: isolamento verificável, billing Asaas robusto, ledger idempotente, auditoria append-only, LGPD | **Base de pacotes** da camada SaaS (portáveis para Fastify) |
| **kitara-ead** | Next 16 monolítico, Prisma 7, Tailwind 4 | **Alta no backoffice**: sessão de suporte auditada, régua de cobrança, métricas MRR/NRR/churn, entitlements por módulo, contratos com hash, saúde do tenant | **Regras puras de operação do SaaS** e fluxos das telas |
| **incentivatech** | Fastify 5 + React 19/Vite 8/Tailwind 4 (**mesma stack-alvo**) | Média: portal admin SaaS, trial, assentos, gate 402, cobrança Asaas | **UI do backoffice e da tela de cobrança do cliente** |
| **despachante** | Fastify 5 + Prisma 6 + Next | Média: `PLATFORM_ADMIN`, escopos concedidos por organização, Asaas com webhook idempotente, termos versionados | **Esqueleto da API**, cliente e webhook Asaas, escopos concedidos |

### Matriz de reuso — camada SaaS

| Tema | Origem | Classe | Como usar no ViaAuto |
|---|---|---|---|
| Escopo obrigatório de tenant na aplicação (extensão Prisma que injeta e confere o tenant; falha se a consulta vier sem escopo) | `baconian/packages/db/src/scoped.ts` | 🟢 | Primeira barreira; **RLS por cima** (doc 02, `withTenantTransaction`) |
| FKs compostas `(tenant_id, id)` + check de CI de colunas de tenant | `baconian/packages/db` (convenções do schema), `scripts/check-tenant-columns.ts` | 🟢 | Integridade cross-tenant no banco |
| Rotas declaradas com escopo (`public / user / tenant / platform`) + manifesto + build que quebra se faltar teste | `baconian` (`defineRoute`, `tests/security/rotas-sem-workspace.ts`) | 🟡 | Reescrever como plugin Fastify |
| Suíte de segurança cross-tenant contra **Postgres real** com dois tenants; negar com **404** | `baconian/apps/web/tests/security/helpers/two-workspaces.ts`, `identity/src/acesso.ts` | 🟡 | Gate de CI (SEC-05) |
| Papéis do tenant mapeados para permissões | `baconian/packages/identity/src/papeis.ts` | 🟡 | Perfis do doc 03 com escopo por estabelecimento |
| Convites com token hash, expiração, revogação, reenvio e limite de plano | `baconian/packages/identity/src/convites.ts` | 🟢 | Convite do admin do cliente e da equipe |
| Admin de plataforma com MFA obrigatória | `baconian/.../platform-admin.ts`, `mfa.ts` | 🟡 | Virar claims do Keycloak + papéis de plataforma (11.2) |
| **Delegação de suporte** concedida pelo cliente (escopo + expiração) | `baconian` (`SupportDelegation`, `ActorType SUPPORT`) | 🟡 | Consentimento do "Acessar como" |
| **Sessão de suporte auditada** (motivo, 15/30/60 min, token de uso único, **somente leitura imposto no servidor**, log de páginas, encerramento remoto) | `kitara-ead/src/lib/sessao-suporte*.ts` + modelos `SessaoSuporte*` | 🟢 (regras) | "Acessar como" (11.7) como hook `onRequest` no Fastify + claim `act` no token |
| `Plan` **versionado** + `Subscription` (próximo plano, cancelar no fim do ciclo, carência, chave idempotente) + entitlements | `baconian/packages/billing` (`catalog.ts`, `entitlements.ts`, `assinaturas.ts`) | 🟡 | Usar só o versionamento por vigência (para a `price_table`) e o padrão idempotente; **não** há planos nem assinaturas |
| Entitlement por módulo com override por tenant | `kitara-ead/src/lib/modulos-ga*.ts` | 🟡 | `tenant_entitlement` |
| Escopos de integração concedidos pela plataforma, com diff e `grantedBy` | `despachante/apps/api/src/routes/v1/platform-detran-scopes.ts` | 🟢 | Habilitar módulos regulatórios (0 km, ITE, consignação) por cliente |
| **Ledger idempotente** (reserva, captura, estorno, unicidade por chave, débito condicional, teste de concorrência) | `baconian/packages/billing/src/ledger.ts` + testes | 🟢 | `usage_record` por operação RENAVE confirmada (RN-SAAS-04) |
| Billing Asaas: evento persistido **antes** de processar, correlação de webhook, `CheckoutAttempt` com estado incerto, reconciliação diária, gateway simulado | `baconian/packages/billing` (`asaas/*`, `eventos.ts`, `correlacao-webhook.ts`) | 🟢 | Núcleo de cobrança (11.5) |
| Cliente Asaas com modo mock + webhook com comparação em tempo constante e upsert idempotente | `despachante/apps/api/src/lib/asaas/*`, `routes/v1/webhooks-asaas.ts` | 🟢 | Complementa o anterior no esqueleto Fastify |
| **Régua de cobrança** pura e testada (D+3/7/10/15) e suspensão/reativação com auditoria | `kitara-ead/src/lib/dunning-regua.ts` (+ teste), `dunning.ts` | 🟢 / 🟡 | Régua (11.5) com **suspensão parcial** (11.3), via fila |
| Fechamento de ciclo (carência → bloqueio) | `baconian` (`fecharCiclosDeAssinatura`) | 🟡 | Inadimplência bloqueia novas operações, não "volta para o free" |
| Dupla aprovação para reembolso e ajuste | `baconian` (`reembolsos.ts`, `ajustes-de-credito.ts`) | 🟢 | Controle financeiro do operador |
| **Métricas de receita** (ponte de MRR: nova, expansão, redução, churn; NRR, ARPU, aging) | `kitara-ead/src/lib/metricas-receita-saas.ts` (+ teste) | 🔵 | Adaptar para receita por registros (sem MRR de assinatura) |
| Saúde e onboarding do tenant; caixa de trabalho priorizada do backoffice | `kitara-ead/src/lib/tenant-admin-lista.ts`, `caixa-trabalho-saas.ts` | 🟡 | Health score e fila do CS |
| Confirmação de configuração crítica (frase + diff) | `kitara-ead/src/lib/configuracoes-criticas.ts` | 🟢 | Faixa de preço, flags globais, suspensão |
| Self-service: tenant criado inativo até a 1ª etapa concluída; trial prorrogável | `kitara-ead/src/lib/onboarding-saas.ts`, `tenant-contract-trial.ts`; `incentivatech` (signup em TRIAL) | 🟡 | Cadastro → homologação (11.6) |
| Contratos SaaS com modelo e **aceite com hash** | `kitara-ead` (`ModeloContratoSaaS`, `TenantContrato`) | 🟡 | Contrato eletrônico do cliente |
| Termos versionados com aceite, IP e data | `despachante` (`TermsVersion`, `TermsAcceptance`, `platform-terms.ts`) | 🟢 | RF-M1-08 |
| Auditoria append-only com severidade e delegação; logger com redação; métricas Prometheus | `baconian/packages/observability` | 🟢 | Auditoria da plataforma; somar cadeia de hash (doc 02) |
| Exportar tudo + exclusão de conta com carência e purga | `baconian` (`AccountDeletion`, export) | 🟡 | Portabilidade e encerramento, com retenção legal de 5 anos |
| Storage S3 agnóstico | `baconian/packages/storage` | 🟢 | Região Brasil, SHA-256 |
| Kit UI do admin (DataTable, Drawer, KpiCard, PageHeader, StatusPill, Tabs, Toast, Pagination, Skeleton, ExportButton) | `incentivatech/apps/web/src/components/admin/*` | 🟡 | Backoffice (já em React/Vite/Tailwind 4) |
| Telas Empresas/Financeiro do admin; tela de cobrança do cliente (`BillingPage`, `ChangePlanModal`, `PlanComparison`, `PaymentMethodSection`) | `incentivatech/apps/web/src/pages/admin-platform/*`, `BillingPage` | 🟡 | `SaasClientes`, `SaasFaturamento`, `MinhaAssinatura` |
| Fluxos das telas do super-admin (tenants com saúde, planos, faturas, métricas, logs, suporte, comunicação em massa, pipeline comercial) | `kitara-ead/src/app/dashboard/*` | 🔵 | Referência de fluxo; **reescrever** em componentes pequenos |
| Gate de assinatura com HTTP 402 | `incentivatech/apps/api/src/plugins/subscription-gate.ts` | 🔵 | Contrato 402 bom; cache precisa ser distribuído |
| Tipo de organização (empresa / publicador / órgão) | `incentivatech` (`OrganizationType`) | 🔵 | Tipos: revenda, concessionária, montadora, ITE, credora, parceiro |
| Branding por organização / white-label | `kitara-ead` (cores, logo, domínio), `incentivatech` (branding de publicador) | 🔵 | Parceiros DMS (11.8) |
| Resolução de tenant por host no proxy do Next; tenant com dezenas de colunas de domínio; hard delete de tenant; plano como texto livre; MRR "estimado" por valor fixo | vários | ⚪ | Substituídos pelas decisões deste documento |

### Lacunas comuns (construir do zero)

- **RLS no Postgres.** Nenhum dos quatro tem; o padrão vem da `plataforma-harmonizacao-normativa` (doc 02).
- **Hierarquia matriz/filial** com estabelecimentos por CNPJ. Base: `organization_establishment` da harmonização.
- **Papéis de plataforma granulares** (suporte, financeiro, CS, compliance) e acesso JIT.
- **NFS-e** (avaliar a emissão nativa do gateway).
- **Faixa de preço regulatória** e o validador.

### Ordem de porte recomendada

1. `baconian/packages/db` (escopo + FKs compostas + check de CI) **+ RLS** (harmonização) + `organization`/`establishment` com matriz/filial.
2. `baconian/packages/observability` (auditoria append-only, logger com redação, métricas) **+ cadeia de hash** e NTP do Observatório Nacional.
3. `baconian/packages/identity` (papéis, acesso 404, convites, MFA) sobre **Keycloak**, com papéis de plataforma e delegação de suporte + regras da sessão de suporte do `kitara-ead`.
4. `baconian/packages/billing` (versionamento por vigência, ledger idempotente, Asaas, eventos, reconciliação, dupla aprovação) + régua do `kitara-ead` + cliente e webhook do `despachante` + **NFS-e** + tabela oficial de preços por registro.
5. Padrão `defineRoute` + suíte cross-tenant (dois tenants em Postgres real) como plugin Fastify.
6. UI: kit admin e telas de cobrança do `incentivatech`, fluxos do `kitara-ead`, design system "Clean Operacional" (doc 08) e métricas de receita do `kitara-ead`.

> **Importante:** este repositório é **público**. O código portado de repositórios privados só deve entrar depois de decidir a visibilidade do repositório e de uma **revisão de segurança** de cada arquivo, sem segredos, sem dados de clientes e com as dívidas listadas no doc 02 §2.5 corrigidas. Registrar a proveniência num `NOTICE.md`, como o `baconian` já faz.
