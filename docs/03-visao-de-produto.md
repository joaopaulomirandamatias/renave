# 03 — Visão de produto, personas e escopo

## 3.1 Declaração de visão

> **Para** concessionárias, revendas, montadoras, ITEs e instituições credoras **que** precisam escriturar no RENAVE cada entrada e saída de veículo sem atraso nem erro, **a ViaAuto** **é** uma plataforma de integração e compliance **que** transforma regras regulatórias em tarefas simples, executa as chamadas ao RENAVE com segurança e guarda a prova de tudo. **Diferente** de integrações "chama-API", ela **orquestra** pré-condições, documentos, assinaturas e pendências, **reconcilia** o estado com o RENAVE e entrega um **dossiê auditável** de cada operação.

### Princípios de produto

1. **O usuário opera um negócio, não um endpoint.** As ações são "Dar entrada", "Vender veículo", "Transferir", "Resolver pendência".
2. **Prevenir em vez de corrigir.** O sistema valida tudo o que for possível antes de enviar.
3. **Nunca repetir às cegas.** Resultado incerto significa reconciliar antes de reenviar.
4. **Tudo deixa prova.** Cada ação gera evento imutável e evidência exportável.
5. **Simples por padrão, técnico sob demanda.** O detalhe técnico do RENAVE fica disponível em "Detalhes técnicos".
6. **Um só lugar para o que precisa de atenção.** A fila de pendências responde "o que resolver agora?".

## 3.2 Proposta de valor por segmento

| Segmento | Dor principal | Valor entregue |
|---|---|---|
| **Revenda de usados** (pequena e média) | Medo de multa gravíssima; processo confuso (ATPV-e, NF-e, identificação prévia) | Assistente passo a passo, checklist de pré-condições, alertas de prazo |
| **Concessionária / grupo** (multi-filial) | Volume alto, várias filiais, integração com o DMS | Lote de 0 km, transferência entre filiais, API e webhooks, painel consolidado |
| **Montadora / importadora** | Pré-cadastro, venda direta, faturamento a concessionárias | Visão de veículos pendentes, venda direta, entrega |
| **ITE** (implementadora, transformadora, encarroçadora) | Veículos inacabados e transformações | Fluxo próprio de autorização, transformação e conclusão |
| **Instituição credora** | Retomados e garantias; com o novo Art. 34, Renave virou pré-condição de crédito | Entrada de retomados com NSU, consulta de estoque vinculado, visão "apto a financiar" |
| **Integradora** (operação interna) | Escala, SLA, solidariedade nas multas, ISO 27001 | Console de saúde, reconciliação, trilha imutável, Regulatory Watch |

## 3.3 Personas

### P1 — Marina, operadora RENAVE (revenda média)
- **Contexto:** dá entrada e saída de 20 a 40 veículos por semana. Trabalha no desktop e, no pátio, pelo celular.
- **Objetivos:** registrar rápido, sem retrabalho; saber o que está travado.
- **Frustrações:** mensagens técnicas incompreensíveis; não saber se "foi ou não foi" para o RENAVE.
- **Precisa de:** assistente guiado, linguagem simples, status claro, fila de pendências.

### P2 — Ricardo, gerente administrativo / fiscal (grupo com 3 filiais)
- **Objetivos:** NF-e coerente com o RENAVE; zero multas; visão por filial.
- **Precisa de:** painel consolidado, validação de NF-e, relatórios de exceção, alertas de certificado.

### P3 — Dra. Helena, compliance / auditoria
- **Objetivos:** provar conformidade em fiscalização e defender a empresa.
- **Precisa de:** trilha imutável, dossiê por operação, exportação controlada, busca por veículo e período.

### P4 — Tiago, TI do grupo / integração com DMS
- **Objetivos:** automatizar a partir do ERP/DMS, sem digitação dupla.
- **Precisa de:** API versionada, webhooks assinados, sandbox, idempotência, documentação OpenAPI.

### P5 — Carla, analista de operações da integradora (backoffice)
- **Objetivos:** manter o SLA, resolver incidentes e reconciliar divergências antes que virem multa.
- **Precisa de:** console multi-tenant, métricas do conector, fila de resultados incertos, runbooks, Regulatory Watch.

### P6 — Paulo, administrador da empresa cliente
- **Objetivos:** configurar filiais, usuários, perfis e certificados.
- **Precisa de:** onboarding guiado, gestão de certificado sem expor a chave, matriz de permissões.

## 3.4 Perfis de acesso (RBAC)

| Perfil | Escopo | Permissões típicas | MFA |
|---|---|---|---|
| **Administrador da integradora** | Plataforma | Tenants, ambientes, conector, métricas, suporte, Regulatory Watch | Obrigatório |
| **Analista de operações (integradora)** | Plataforma, leitura ampla | Reconciliação, reprocessamento seguro, chamados | Obrigatório |
| **Administrador da empresa** | Tenant | Estabelecimentos, usuários, perfis, certificados, integrações | Obrigatório |
| **Operador RENAVE** | Estabelecimentos atribuídos | Consultar, dar entrada, vender, transferir, consignar, resolver pendências | Recomendado |
| **Financeiro / Fiscal** | Estabelecimentos atribuídos | NF-e, valores, documentos fiscais, relatórios | Recomendado |
| **Compliance / Auditoria** | Tenant, somente leitura | Auditoria, evidências, exportações autorizadas | Obrigatório |
| **Consulta** | Estabelecimentos atribuídos | Somente leitura, com dados pessoais **mascarados** | — |
| **Cliente de API** (máquina) | Escopos por credencial | Conforme os escopos (`stock:write`, `documents:read`…) | n/a (mTLS/HMAC) |

**Regra:** permissões por **ação de domínio** × **escopo** (tenant → organização → estabelecimento), avaliadas **no backend**, com RLS como segunda barreira.

## 3.5 Mapa de módulos

```text
┌─────────────────────────────────── ViaAuto ───────────────────────────────────┐
│  M1 Onboarding & Adesão     M2 Estabelecimentos & Certificados   M3 Usuários  │
│  M4 Veículos & Consulta     M5 Estoque (entrada / saída usados)  M6 Zero km   │
│  M7 ITE & Inacabados        M8 Transferências                    M9 Consignação│
│  M10 Retomados (credoras)   M11 Documentos & Fiscal (NF-e, ATPV-e, CRLV-e)    │
│  M12 Pendências & Restrições           M13 Reconciliação                      │
│  M14 Auditoria & Dossiê     M15 Integrações (API, Webhooks, ERP/DMS)          │
│  M16 Painéis & Relatórios   M17 Notificações   M18 Console da Integradora     │
│  M19 Gestão Regulatória (Regulatory Watch)     M20 Suporte & Chamados         │
├────────────────────────── Camada SaaS (ver doc 11) ───────────────────────────┤
│  M21 Backoffice do operador   M22 Assinaturas & Cobrança                      │
│  M23 Conta do cliente (autoatendimento)        M24 Parceiros DMS/ERP          │
└───────────────────────────────────────────────────────────────────────────────┘
          │ Conector RENAVE (mTLS ICP-Brasil) │ Fila/Outbox │ Cofre de certificados │
```

## 3.6 Escopo

### Dentro do escopo (produto RENAVE)
- Todos os registros eletrônicos de estoque previstos na Res. 1.026 e no manual RENAVE-WS: usados, 0 km, ITE, transferências, consignação e retomados.
- Gestão de documentos vinculados às operações (NF-e, ATPV-e, CRLV-e, termos, contratos de consignação, identificação prévia/vistoria).
- Orquestração, pendências, reconciliação, auditoria, dossiê, API e webhooks.
- Onboarding do estabelecimento, incluindo o apoio à adesão no Credencia quando feita via integradora.

### Fora do escopo
- **DMS / gestão comercial** (CRM, precificação, financeiro da loja, estoque de peças). Há **vedação regulatória** à integradora que provê DMS.
- **Plataforma de assinatura eletrônica** e **plataforma de transferência eletrônica** (vedações do Anexo). O sistema **consome** essas plataformas.
- **Emissão de NF-e**. O sistema **importa ou valida** NF-e emitida pelo ERP/emissor do cliente. Um emissor parceiro fica como integração opcional.
- **Apontamento e gravame** (Art. 1º §2º).
- **Placas de experiência e reforma/recuperação**: dependem de especificação futura da SENATRAN (Art. 1º §4º). Ficam previstos no roadmap.

## 3.7 Jornadas principais (resumo)

| # | Jornada | Persona | Resultado |
|---|---|---|---|
| J1 | Adesão: cadastro → elegibilidade → Credencia → contratação → certificado → homologação → produção | P6 | Estabelecimento operante |
| J2 | Compra de usado: consulta → aptidão → identificação prévia → dados do vendedor → ATPV-e → NF-e de entrada → entrada confirmada | P1 | Veículo **em estoque** |
| J3 | Venda de usado: pré-condições → comprador → NF-e de saída → ATPV-e → saída confirmada → baixa | P1, P2 | Veículo **baixado**; CRV novo informado |
| J4 | 0 km: pendentes faturados → identificação prévia → entrada em lote → venda → NF-e → saída → entrega | P1, P4 | Veículo apto a emplacar |
| J5 | Transferência entre estabelecimentos/filiais: solicitação → NF-e → aceite do destino → entrada no destino | P1, P2 | Estoque movido |
| J6 | Consignação: contrato eletrônico → assinaturas → anúncio → venda → ATPV-e do consignante em 30 dias, ou cancelamento + NF-e de devolução | P1 | Venda ou devolução |
| J7 | Retomado: dados da credora + NSU/processo → identificação prévia ou auto/termo → entrada | P1 (credora) | Estoque vinculado |
| J8 | Pendência: alerta → entender causa → ação guiada → revalidação | P1, P2 | Pendência resolvida |
| J9 | Resultado incerto: timeout → reconciliação automática → confirmação ou reenvio seguro | P5 | Estado consistente |
| J10 | Fiscalização: buscar veículo/período → exportar dossiê assinado | P3 | Evidência entregue |
| J11 | Integração ERP: credencial → sandbox → webhooks → produção | P4 | Automação ponta a ponta |

O detalhamento de cada jornada está em `04-regras-de-negocio.md` (regras) e `05-requisitos-funcionais.md` (requisitos com critérios de aceite).

## 3.8 Mercado e concorrência

> Fontes de terceiros consultadas em 23/11/2026. **Nenhuma integradora foi confirmada como autorizada** em lista oficial, que ainda não foi encontrada.

| Player | Posicionamento declarado | Observação |
|---|---|---|
| Renave.net | Diz ser "integradora homologada"; sem mensalidade, cobra por uso | Concorrente direto |
| Trillia (B3) | Diz ser "a principal integradora" | Pode ser alcançada pelas vedações do Anexo (entidade registradora/plataforma) |
| Renavix | Conformidade de estoque, NF-e, consignação digital, ATPV-e | Não afirma ter autorização |
| KAVO | "Em implementação"; plano de R$ 2.700/mês + R$ 6.950 de setup | Referência de preço premium |
| ERPs/DMS de revenda com "Renave incluso" (Simples Veículo, Use Minha Revenda, Click Garage, Autocerto, ItCar, Revenda Mais, Autoconf) | R$ 119 a R$ 360/mês com Renave embutido | **Impedidos de ser integradoras** pelo Anexo: precisarão de parceiro autorizado |

**Referências de custo:**
- Tarifas SERPRO, com base na FAQ de 2022 (podem estar desatualizadas): **R$ 4,43 por entrada ou saída de usado**; **R$ 4,97 por saída de 0 km**; entrada de 0 km sem custo.
- Estimativa de terceiros para o preço praticado pelas integradoras: **R$ 40 a 70 por veículo** (entrada + saída).
- O preço final dependerá da **faixa mínima e máxima** que a SENATRAN vai publicar (Art. 32).

### Oportunidades de diferenciação

1. **Canal B2B2B com fornecedores de DMS/ERP.** Eles **não podem** mais operar o Renave e precisam de uma integradora independente com API de primeira linha, webhooks e white-label de telas (*embedded*). É o maior canal de distribuição do mercado.
2. **Compliance como produto.** Dossiê verificável, trilha imutável e defesa contra a multa gravíssima, em que a integradora responde solidariamente.
3. **Usabilidade.** Assistentes guiados e fila de pendências em vez de formulários técnicos.
4. **Crédito.** Com o Art. 34, "apto a financiar" passa a ser decisivo para o lojista; há espaço para integrar com credoras.
5. **Portabilidade sem lock-in.** Exportação padronizada como argumento de venda.

## 3.9 Métricas de sucesso (North Star e KPIs)

| Métrica | Definição | Meta inicial |
|---|---|---|
| **North Star: operações confirmadas no prazo** | % de registros confirmados no RENAVE dentro do prazo regulatório/SLA | ≥ 99% |
| Tempo médio de entrada (usado) | Do início do assistente até "Confirmado" (excluindo espera externa) | ≤ 4 min de trabalho do usuário |
| Taxa de rejeição evitável | Rejeições do RENAVE que uma pré-validação local teria detectado | ≤ 2% |
| Resultados incertos sem resolução > 1h | Quantidade | 0 |
| Pendências vencidas | Pendências além do prazo | Tendência a 0 |
| Certificados vencidos em produção | Quantidade | 0 |
| Disponibilidade do conector | Uptime mensal | ≥ 99,5% |
| NPS / CSAT de operadores | Pesquisa trimestral | NPS ≥ 50 |
