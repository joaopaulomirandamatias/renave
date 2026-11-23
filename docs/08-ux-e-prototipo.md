# 08 — UX, design system e protótipo

> **Protótipo navegável (mockups):** https://claude.ai/artifact/HdnUJ7n2pbz9pZY9hD71gN
> Canvas "ViaAuto — Mockups": 34 telas + componentes compartilhados (Sidebar, Topbar, SidebarSaas), em 6 páginas. Use **Play** nas telas marcadas como interativas para navegar pelo menu lateral.
> O link é privado por padrão; compartilhe pelo menu *Share* da página.

## 8.1 Princípios de UX

| # | Princípio | Como aparece na interface |
|---|---|---|
| 1 | **Tarefa, não endpoint** | Menus e botões com verbos de negócio: *Dar entrada*, *Vender veículo*, *Transferir*, *Resolver pendência* |
| 2 | **O que fazer agora** | O painel abre com "O que precisa da sua atenção agora" e há uma fila de pendências com causa → impacto → ação |
| 3 | **Prevenir em vez de corrigir** | Assistentes com validação em tempo real; checklist de pré-condições; botão de envio desabilitado com motivo explícito |
| 4 | **Estado sempre claro** | Selo de estado com texto, não só cor; linha do tempo; "Resultado incerto" explicado, com botão *Verificar no RENAVE* |
| 5 | **Simples por padrão, técnico sob demanda** | "Detalhes técnicos" recolhível com código RENAVE, `logIdRastreabilidade`, correlation-id e hashes |
| 6 | **Ações contextuais** | Só aparecem as ações válidas para o estado (ex.: *Cancelar entrada* só em SOLICITADO) |
| 7 | **Segurança visível** | Ambiente (Homologação/Produção) sempre no topo; certificado e conector com status; dados pessoais mascarados |
| 8 | **Assíncrono sem ansiedade** | O envio retorna na hora; a tela acompanha o estado em tempo real; notificação quando concluir |
| 9 | **Acessível e responsivo** | WCAG 2.2 AA, alvos ≥ 44 px, teclado completo, layout que empilha no celular, PWA para o pátio |

## 8.2 Design system — "Clean Operacional"

| Token | Valor | Uso |
|---|---|---|
| Fonte | **Inter** 400/500/600/700; títulos 600 com tracking −0,01em | Toda a interface |
| `bg/app` | `#F6F7F9` | Fundo da aplicação |
| `bg/surface` | `#FFFFFF` | Cards, tabelas, painéis |
| `border` | `#E4E7EC` | Divisores |
| `text/primary` | `#101828` | Texto principal |
| `text/secondary` | `#475467` | Texto de apoio (≥ 4,5:1) |
| `accent` | `#0F766E` (hover `#115E59`, suave `#E6F4F1`) | Ação primária, foco, item ativo |
| `status/success` | texto `#067647` / fundo `#ECFDF3` | Confirmado, ok |
| `status/warning` | texto `#B54708` / fundo `#FFFAEB` | Aguardando, incerto, a vencer |
| `status/error` | texto `#B42318` / fundo `#FEF3F2` | Recusado, divergente, impeditivo |
| `status/info` | texto `#175CD3` / fundo `#EFF8FF` | Enviado, verificando |
| `status/neutral` | texto `#344054` / fundo `#F2F4F7` | Rascunho, cancelado |
| Raios | Cards 10 px · inputs/botões 8 px · chips 999 px | — |
| Sombra | `0 1px 2px rgba(16,24,40,.06)` | Mínima |
| Espaçamento | Base 8 px | — |
| Ícones | SVG de traço 1,75 px, 20 px (Lucide na implementação) | Nunca emoji |

**Componentes-base:** AppShell (sidebar + topbar com seletor de estabelecimento e ambiente), Button (primário, secundário, quieto, perigo), StatusBadge, KPI/Stat, Card, DataTable responsiva (vira cards no celular), FilterBar com chips, Stepper/Wizard, Checklist de pré-condições, Timeline, Tabs, Drawer de detalhe, Detalhes técnicos (accordion), EmptyState, Toast, Dialog de confirmação reforçada, Upload com hash e preview, CountdownBadge (prazos), Máscaras BR (placa, CPF/CNPJ, chave NF-e).

> Implementação: Tailwind 4 `@theme` + Radix/shadcn. Os tokens e componentes do console da `plataforma-harmonizacao-normativa` (tabela responsiva, badges, AppShell, scripts de contraste) servem de base (ver `02-analise-de-reuso.md`, seção E).

## 8.3 Arquitetura de informação

```text
Painel
Operação de estoque
  ├─ Estoque (lista) ─ Ficha do veículo (abas: Visão geral · Documentos · Fiscal · Restrições · Auditoria)
  ├─ Entradas  (assistente "Dar entrada")
  ├─ Vendas/Saídas (assistente "Vender veículo")
  ├─ Zero km (Pendentes · Em estoque · Entregas)
  ├─ Transferências (Enviadas · Recebidas · Concluídas)
  └─ Consignação (contratos)
Pendências (fila)
Documentos (central)
Auditoria (trilha + exportação)
Configurações
  ├─ Estabelecimentos & Certificados
  ├─ Integrações (API · Webhooks)
  └─ Usuários & Perfis
Console da integradora (perfil interno)
PWA do pátio (consulta rápida + identificação prévia/vistoria)
```

## 8.4 Inventário de telas do protótipo

| # | Tela (artboard) | Objetivo | Requisitos cobertos |
|---|---|---|---|
| 1 | **Painel** (`Main`) | Visão do dia: alertas, KPIs, "o que precisa da sua atenção", entradas × saídas, estoque por idade, ações rápidas | RF-M16-01/02 |
| 2 | **Login + MFA** (`Login`) | Acesso seguro com SSO e segunda etapa | RF-M3-04, SEC-06 |
| 3 | **Onboarding / Adesão** (`Onboarding`) | Jornada em 7 etapas com checklist e próxima ação | RF-M1-05/06 |
| 4 | **Estoque** (`Estoque`) | Lista filtrável com situação, idade e pendências | RF-M4, RF-M16 |
| 5 | **Ficha do veículo** (`Veiculo`) | Cabeçalho, pré-condições, linha do tempo e abas | RF-M4-04..08 |
| 6 | **Dar entrada — usado** (`Entrada`) | Assistente de 6 passos com validações | RF-M5-01..09 |
| 7 | **Vender veículo** (`Saida`) | Comprador, NF-e, CRV e pré-condições; acompanhamento da ATPV-e | RF-M5-20..23 |
| 8 | **Zero km** (`ZeroKm`) | Pendentes faturados, entrada em lote, entregas | RF-M6 |
| 9 | **Transferências** (`Transferencias`) | Enviar, receber e aceitar; filiais | RF-M8 |
| 10 | **Consignação** (`Consignacao`) | Contratos, assinaturas, prazo de 30 dias, cancelamento | RF-M9 |
| 11 | **Pendências** (`Pendencias`) | Fila priorizada com ação direta; resultado incerto | RF-M12, RF-M13-01 |
| 12 | **Detalhe da operação** (`Operacao`) | Máquina de estados, tentativas, hashes, detalhes técnicos, reconciliar | RF-M13, RN-REC |
| 13 | **Documentos** (`Documentos`) | Central com hash e versão; exportar dossiê | RF-M11 |
| 14 | **Auditoria** (`Auditoria`) | Trilha imutável, filtros, antes/depois, exportação | RF-M14 |
| 15 | **Estabelecimentos & Certificados** (`Estabelecimentos`) | Matriz/filiais, inventário de certificados, rotação | RF-M2 |
| 16 | **Integrações** (`Integracoes`) | Clientes de API, webhooks, entregas | RF-M15 |
| 17 | **Usuários & Perfis** (`Usuarios`) | Usuários, perfis, matriz de permissões, MFA | RF-M3 |
| 18 | **Console da integradora** (`Console`) | Saúde por tenant, conector, incertos, certificados, Regulatory Watch | RF-M18, RF-M19 |
| 19 | **PWA do pátio** (`MobileConsulta`, `MobileVistoria`) | Consulta por placa e identificação prévia com fotos | RF-M5-03, UX-02 |
| — | Componentes compartilhados (`Sidebar`, `Topbar`, `SidebarSaas`) | Navegação do protótipo, seletor de estabelecimento e ambiente, busca | RF-M0 |
| 20–33 | **Gestão do SaaS e Conta do cliente** | Backoffice do operador, preço por registro, faturamento, parceiros, equipe, auditoria da plataforma, consumo e faturas, cadastro | Ver `11-modelo-saas.md` §11.13 |

## 8.5 Padrões de interação-chave

### Assistente "Dar entrada" (6 passos)

1. **Veículo:** placa ou chassi → busca e normalização → confirmação visual (marca/modelo/ano/cor).
2. **Aptidão:** checklist do RENAVE (ok / atenção / impeditivo); impeditivo trava o avanço, com explicação.
3. **Vendedor e valores:** CPF/CNPJ (validado), nome, e-mail, valor, data de compra, hodômetro e data da medição, título do negócio.
4. **Identificação prévia:** escolha entre identificação eletrônica e vistoria; fotos (com data/hora e GPS), chassi e hodômetro.
5. **Documentos:** ATPV-e (status da assinatura do vendedor; escolha do formato de assinatura); NF-e de entrada (chave ou XML ou ERP) com validação de coerência.
6. **Revisão e envio:** resumo; aviso de idempotência; "Enviar ao RENAVE".

A tela de acompanhamento mostra o estado em tempo real (Enviado → Aguardando DETRAN → Confirmado).

### Resultado incerto

Mensagem: *"O RENAVE não respondeu a tempo. Pode ser que a operação tenha sido registrada. Para não duplicar, vamos verificar antes de qualquer reenvio."*

- Ação primária: **Verificar no RENAVE agora**.
- Reconciliação automática agendada; o veículo fica bloqueado para novas operações enquanto isso.

### Ações irreversíveis

Saída com Renovar, cancelamento de contrato de consignação e revogação de certificado usam um **diálogo de confirmação reforçada**: explicação do efeito, digitação da placa ou do CNPJ e motivo obrigatório.

## 8.6 Microcopy (exemplos)

| Situação | ❌ Evitar | ✅ Usar |
|---|---|---|
| 422 vendedor ≠ proprietário | "Erro 422: documentoProprietarioAtual inválido" | "O vendedor informado não é o proprietário que consta no CRV. Confira o CPF/CNPJ do vendedor." |
| Certificado vencendo | "Cert expiring" | "O certificado da filial Santos vence em 12 dias. Renove para não interromper as operações." |
| Aguardando DETRAN | "Status: SOLICITADO" | "Aguardando confirmação do DETRAN. Você será avisado quando concluir." |
| Prazo consignação | "Deadline D-5" | "Faltam 5 dias para o consignante assinar a ATPV-e. Sem assinatura, a venda será cancelada." |

## 8.7 Plano de validação de UX

1. Teste de usabilidade moderado com **5 operadores** (revenda e concessionária) sobre o protótipo: tarefas J2 (entrada), J3 (venda), J8 (pendência) e J9 (incerto).
2. Métricas: taxa de sucesso, tempo por tarefa, erros, **SUS ≥ 80**.
3. Iteração do protótipo → *design handoff* com tokens e componentes.
4. Revisão de acessibilidade (contraste, teclado, leitor de tela) antes do desenvolvimento das telas.
