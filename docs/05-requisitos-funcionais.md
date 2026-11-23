# 05 — Requisitos funcionais

> **Convenções**
> - **ID:** `RF-<módulo>-<nº>`. Os módulos seguem o mapa de `03-visao-de-produto.md` (M1–M20).
> - **Prioridade (MoSCoW):** **M** = Must (obrigatório para o go-live do escopo), **S** = Should, **C** = Could, **W** = Won't (agora).
> - **Fase:** F1 Fundação · F2 Usados MVP · F3 Resiliência & ERP · F4 Zero km · F5 ITE · F6 Modalidades avançadas · F7 Inteligência. Ver `09-roadmap-riscos.md`.
> - **RN:** regras de negócio atendidas (`04-regras-de-negocio.md`).
> - A **rastreabilidade com o Guia** (RF-001 a RF-108) está na seção 5.22.

---

## M1 — Onboarding e adesão

| ID | Requisito | Prio | Fase | RN |
|---|---|---|---|---|
| RF-M1-01 | Cadastrar **organização** (grupo econômico) e **estabelecimentos** (matriz/filiais), com CNPJ, razão social, nome fantasia, endereço, UF, IE, responsáveis e contatos. | M | F1 | ADE-02 |
| RF-M1-02 | **Consultar CNPJ** em fonte oficial ou espelho e **sugerir** os dados (razão social, CNAE principal e secundários, situação, endereço), que o usuário confirma, com proveniência registrada. | M | F1 | ADE-01, ADE-02 |
| RF-M1-03 | Validar **CNAE e objeto social** contra a lista de atividades elegíveis versionada e mostrar o resultado (elegível / não elegível / verificar). | M | F1 | ADE-01 |
| RF-M1-04 | Classificar o **tipo de estabelecimento**: revenda de usados, concessionária, montadora/importadora, ITE, instituição credora, reforma/recuperação (futuro). Isso define os módulos habilitados. | M | F1 | ADE-03 |
| RF-M1-05 | Conduzir a **jornada de adesão** em 7 etapas (cadastro → elegibilidade → Credencia → contratação → certificado → homologação → produção), com status, checklist de documentos e próxima ação em cada etapa. | M | F1 | ADE-06, ADE-07 |
| RF-M1-06 | Registrar o **pedido no Credencia** (protocolo, datas, status, pendências), acompanhar os prazos de 30+30 dias e alertar sobre pendência não sanada. | M | F1 | ADE-06 |
| RF-M1-07 | Registrar o **vínculo formal** estabelecimento ↔ sistema de integração homologado da integradora. | M | F1 | ADE-04 |
| RF-M1-08 | Registrar o **aceite de termos** (uso, privacidade, sigilo), com versão, data, IP e usuário. | M | F1 | AUD-01 |
| RF-M1-09 | **Suspender** ou **reativar** um estabelecimento sem apagar o histórico; registrar bloqueio cautelar ou cancelamento de adesão com data e motivo. | M | F1 | GER-13, ADE-08 |
| RF-M1-10 | Tratar a **sucessão empresarial** (transferir estoque e consignados para a sucessora, preservando o histórico). | C | F6 | ADE-09 |
| RF-M1-11 | Tratar **falência ou liquidação** (perfil de administrador judicial, segregação dos consignados). | C | F6 | ADE-10 |

## M2 — Estabelecimentos e certificados

| ID | Requisito | Prio | Fase | RN |
|---|---|---|---|---|
| RF-M2-01 | Fazer upload de certificado **e-CNPJ A1** (PFX + senha) com envio **direto ao cofre**, extraindo metadados: titular, CNPJ, emissor, série, impressão digital, validade inicial e final, cadeia. | M | F1 | CER-01, CER-02 |
| RF-M2-02 | Validar a **cadeia ICP-Brasil**, a **revogação** (CRL/OCSP) e a coerência do CNPJ com o estabelecimento. | M | F1 | CER-01, CER-04 |
| RF-M2-03 | Suportar certificado **A3 / HSM de rede** (chave não exportável), quando o cliente usar. | S | F3 | CER-02 |
| RF-M2-04 | Manter o **inventário de certificados** por estabelecimento e ambiente, com status (ativo, a vencer, vencido, revogado, substituído). | M | F1 | CER-07 |
| RF-M2-05 | Enviar **alertas de vencimento** (60/30/15/7/0 dias) por e-mail, painel e notificação, com responsáveis configuráveis. | M | F1 | CER-03 |
| RF-M2-06 | Fazer **rotação** sem indisponibilidade (validar → ativar → aposentar), mantendo o histórico. | M | F1 | CER-05 |
| RF-M2-07 | **Bloquear automaticamente** as chamadas com certificado inválido e criar a pendência correspondente. | M | F1 | CER-04, GER-02 |
| RF-M2-08 | Selecionar o **certificado correto por chamada** (estabelecimento × ambiente) e registrar na operação o identificador usado. | M | F1 | CER-06 |
| RF-M2-09 | Revogar ou desativar um certificado em emergência (incidente) com um clique, com registro na auditoria. | M | F1 | — |

## M3 — Usuários, perfis e acesso

| ID | Requisito | Prio | Fase | RN |
|---|---|---|---|---|
| RF-M3-01 | Gerenciar usuários: convite por e-mail, ativação, bloqueio, desligamento e reset de MFA. | M | F1 | — |
| RF-M3-02 | Atribuir **perfis** (ver 3.4) com **escopo por estabelecimento**. | M | F1 | GER-01 |
| RF-M3-03 | Exibir uma **matriz de permissões** por ação de domínio, com perfis customizáveis pelo admin do tenant. | S | F1 | — |
| RF-M3-04 | Exigir **MFA** (TOTP/WebAuthn) para perfis privilegiados; MFA opcional ou obrigatório configurável para os demais. | M | F1 | — |
| RF-M3-05 | Suportar **SSO** (OIDC/SAML) corporativo por tenant. | S | F3 | — |
| RF-M3-06 | Fazer **revisão periódica de acessos** (trimestral): relatório de quem tem acesso a quê, com aprovação registrada. | S | F3 | — |
| RF-M3-07 | Gerenciar **sessões**: listar dispositivos e encerrar sessões; expirar por inatividade. | M | F1 | — |
| RF-M3-08 | Registrar na auditoria login, falha de login, troca de perfil e exportações. | M | F1 | AUD-01 |

## M4 — Veículos e consulta

| ID | Requisito | Prio | Fase | RN |
|---|---|---|---|---|
| RF-M4-01 | Fazer **busca global** por placa, chassi ou RENAVAM (atalho `/`), com validação e normalização de formato. | M | F2 | VEI-01 |
| RF-M4-02 | **Consultar o veículo no RENAVE** (cadastro e situação agregada) e guardar o snapshot com data, hora e hash. | M | F2 | VEI-01 |
| RF-M4-03 | **Consultar aptidão** para entrada ou saída e mostrar o resultado como checklist (ok / atenção / impeditivo), com explicação e ação. | M | F2 | GER-04, VEI-02 |
| RF-M4-04 | Manter a **ficha do veículo**: identificação, características (marca, modelo, versão, ano fab./mod., cor, combustível, espécie, tipo, categoria), estado no estoque, estabelecimento, dias em estoque e hodômetro. | M | F2 | — |
| RF-M4-05 | Exibir a **linha do tempo** completa de eventos do veículo (operações, documentos, pendências, mudanças de estado). | M | F2 | — |
| RF-M4-06 | Exibir o **checklist de pré-condições** para a próxima ação (ex.: "apto a vender?"), calculado pelo motor de regras. | M | F2 | SAI-02, SAI-03 |
| RF-M4-07 | Mostrar apenas as **ações contextuais válidas** para o estado atual. | M | F2 | — |
| RF-M4-08 | Organizar as abas Documentos, Fiscal, Restrições e Auditoria (esta última conforme o perfil). | M | F2 | VEI-07 |
| RF-M4-09 | Detectar **pendência ou restrição superveniente** e marcar "Em estoque vinculado". | M | F3 | VEI-03 |
| RF-M4-10 | Mostrar o indicador **"apto a financiamento"**. | S | F3 | VEI-08 |
| RF-M4-11 | Registrar o **hodômetro** com data e validação de regressão. | M | F2 | VEI-06 |

## M5 — Estoque de usados (entrada e saída)

### Entrada

| ID | Requisito | Prio | Fase | RN |
|---|---|---|---|---|
| RF-M5-01 | Oferecer o assistente **"Dar entrada — usado"** em passos: Veículo → Aptidão → Vendedor e valores → Identificação prévia/vistoria → Documentos (ATPV-e, NF-e) → Revisão e envio. | M | F2 | ENT-01 |
| RF-M5-02 | Suportar os títulos: **compra de usado**, **entrada de veículo próprio**, **retomado** (via M10). | M | F2 | GER-03, ENT-03 |
| RF-M5-03 | Fazer a **identificação prévia** eletrônica ou a **vistoria**, com captura de evidências (fotos com data/hora e geolocalização, hodômetro, chassi). | M | F2 | ENT-04 |
| RF-M5-04 | Coletar os dados do **vendedor** (CPF/CNPJ, nome, e-mail, endereço quando exigido) e a **data/hora da assinatura** do vendedor ou o reconhecimento de firma. | M | F2 | ENT-01 |
| RF-M5-05 | Registrar e assinar a **ATPV-e** e acompanhar o status das assinaturas. | M | F2 | ENT-02, DOC-06 |
| RF-M5-06 | **Vincular a NF-e de entrada**: digitar a chave, enviar o XML ou importar do ERP, validar a chave, CNPJ, chassi e valor. | M | F2 | ENT-06, ENT-07, DOC-01 |
| RF-M5-07 | **Solicitar a entrada** ao RENAVE com idempotência e acompanhar consentimentos/retornos estaduais. | M | F2 | REC-01, REC-02 |
| RF-M5-08 | Consolidar o estado **"Em estoque"** somente após a confirmação, e guardar os **termos** retornados. | M | F2 | GER-05 |
| RF-M5-09 | Salvar **rascunho** em qualquer passo e retomar depois. | M | F2 | — |
| RF-M5-10 | Gerar a pendência de **prazo de escrituração** quando a entrada não for concluída no prazo configurado. | M | F2 | ENT-09 |
| RF-M5-11 | Fazer **entrada em lote** por planilha ou API para usados, com validação linha a linha. | C | F3 | — |

### Saída

| ID | Requisito | Prio | Fase | RN |
|---|---|---|---|---|
| RF-M5-20 | Oferecer o assistente **"Vender veículo"**: comprador → valor e data → CRV e código de segurança → NF-e de saída → revisão. | M | F2 | SAI-01 |
| RF-M5-21 | Mostrar um painel lateral de **pré-condições** e bloquear o envio se alguma estiver pendente. | M | F2 | SAI-02, SAI-03 |
| RF-M5-22 | **Solicitar a saída**, acompanhar a assinatura da ATPV-e pelo comprador e o retorno do RENAVE/DETRAN. | M | F2 | SAI-05 |
| RF-M5-23 | **Baixar o estoque** só após a confirmação; guardar termos e comprovantes. | M | F2 | SAI-06 |
| RF-M5-24 | Registrar a **expedição do novo CRV** quando informada. | S | F3 | SAI-07 |
| RF-M5-25 | **Cancelar entrada ou saída** quando permitido (tipo e janela) com justificativa, gerando nova operação. | M | F2 | REC-09 |
| RF-M5-26 | Consultar os **termos de entrada e saída** e as **assinaturas da ATPV-e**. | M | F2 | DOC-06 |

## M6 — Zero km

| ID | Requisito | Prio | Fase | RN |
|---|---|---|---|---|
| RF-M6-01 | Listar os **0 km pendentes de entrada** (pré-cadastrados e faturados para o CNPJ), com data de faturamento e alerta de antiguidade. | M | F4 | 0KM-01, 0KM-03 |
| RF-M6-02 | Fazer a **entrada de 0 km** individual e em **lote**, com resultado por veículo. | M | F4 | 0KM-02, 0KM-05 |
| RF-M6-03 | Fazer a **saída de 0 km** (venda) com NF-e sincronizada. | M | F4 | 0KM-04 |
| RF-M6-04 | Registrar a **entrega** de 0 km e o seu cancelamento quando permitido. | M | F4 | 0KM-06 |
| RF-M6-05 | Cancelar entrada ou saída de 0 km dentro da janela permitida. | M | F4 | 0KM-06 |
| RF-M6-06 | Suportar a **venda direta de montadora** e a indicação de gestor/entregador. | S | F4 | 0KM-06 |
| RF-M6-07 | Marcar **benefícios fiscais / programas** previstos no RENAVE vigente. | S | F4 | 0KM-07 |
| RF-M6-08 | Exibir o painel "0 km faturados sem entrada" (risco de não emplacar). | M | F4 | 0KM-03 |

## M7 — ITE e veículos inacabados

| ID | Requisito | Prio | Fase | RN |
|---|---|---|---|---|
| RF-M7-01 | Identificar veículo **inacabado**, tipo de montagem e fase industrial. | M | F5 | ITE-01 |
| RF-M7-02 | **Autorizar transferência para ITE** e **cancelar** a autorização antes do aceite. | M | F5 | ITE-02 |
| RF-M7-03 | **Transferir estoque vindo de ITE** e aceitar recebimento na ITE. | M | F5 | ITE-02 |
| RF-M7-04 | Registrar a **transformação/conclusão** com dados técnicos e evidências. | M | F5 | ITE-03 |

## M8 — Transferências

| ID | Requisito | Prio | Fase | RN |
|---|---|---|---|---|
| RF-M8-01 | **Solicitar a transferência** para outro estabelecimento aderido, com validação prévia da adesão do destino. | M | F3 | TRF-01, TRF-02 |
| RF-M8-02 | Mostrar uma **caixa de entrada de transferências recebidas** com Aceitar ou Recusar, prazo e documentos. | M | F3 | TRF-03 |
| RF-M8-03 | **Cancelar a autorização** de transferência antes do aceite. | M | F3 | TRF-07 |
| RF-M8-04 | Oferecer um fluxo simplificado de **transferência entre filiais**, com visão das duas pontas. | M | F3 | TRF-05 |
| RF-M8-05 | Bloquear venda ou nova transferência durante "Em transferência". | M | F3 | TRF-03 |
| RF-M8-06 | Gerar pendência para transferência sem aceite no prazo. | S | F3 | TRF-06 |

## M9 — Consignação

| ID | Requisito | Prio | Fase | RN |
|---|---|---|---|---|
| RF-M9-01 | Criar o **contrato eletrônico de consignação** a partir do modelo padrão, editando só os campos parametrizáveis: consignante, veículo, valor mínimo, comissão, vigência e condições. | M | F6 | CON-01, CON-02 |
| RF-M9-02 | Colher as **assinaturas**: estabelecimento (e-CNPJ) e consignante (e-CNPJ ou assinatura avançada/qualificada por plataforma homologada). | M | F6 | CON-03 |
| RF-M9-03 | **Registrar o contrato** no RENAVE e acompanhar a anotação "consignado em processo de transferência". | M | F6 | CON-05 |
| RF-M9-04 | Mostrar a **contagem de 30 dias** para a assinatura da ATPV-e pelo consignante, com alertas em D-10, D-5 e D-1 e cancelamento automático registrado ao vencer. | M | F6 | CON-06, CON-07 |
| RF-M9-05 | **Cancelar o contrato** (por qualquer parte) somente enquanto permitido, com explicação do efeito. | M | F6 | CON-08 |
| RF-M9-06 | Após o cancelamento, **exigir a NF-e de devolução** e o **registro de saída**; notificar consignante e credora. | M | F6 | CON-09 |
| RF-M9-07 | Registrar o período de responsabilidade por infrações (posse início/fim). | S | F6 | CON-04 |
| RF-M9-08 | Mostrar o **portal/link do consignante** para assinar e acompanhar o status, sem login completo. | S | F6 | CON-03 |

## M10 — Retomados (instituições credoras)

| ID | Requisito | Prio | Fase | RN |
|---|---|---|---|---|
| RF-M10-01 | Cadastrar e qualificar a **instituição credora** aderida. | M | F6 | RET-01 |
| RF-M10-02 | Fazer a **entrada de veículo retomado** com NSU, nº de processo ou registro RTD. | M | F6 | RET-02 |
| RF-M10-03 | Aceitar **Auto de Apreensão Extrajudicial** ou **Termo de Entrega Voluntária** em substituição à identificação prévia. | M | F6 | RET-03 |
| RF-M10-04 | Exigir **evidências reforçadas** e aplicar retenção ampliada. | M | F6 | RET-04 |
| RF-M10-05 | Oferecer a **consulta de estoque vinculado** por contrato de garantia, para a credora. | S | F6 | RET-05 |

## M11 — Documentos e fiscal

| ID | Requisito | Prio | Fase | RN |
|---|---|---|---|---|
| RF-M11-01 | Registrar a **NF-e de entrada e de saída** (chave, número, série, emitente, destinatário, data, valor, CFOP/finalidade, XML opcional). | M | F2 | DOC-01 |
| RF-M11-02 | **Validar a coerência** NF-e × operação: CNPJs, chassi, valor, data e status da NF-e quando disponível. | M | F2 | DOC-02, ENT-07 |
| RF-M11-03 | Impedir o **reuso de NF-e** em outra operação. | M | F2 | DOC-03 |
| RF-M11-04 | Obter e disponibilizar o **PDF da ATPV-e**. | M | F2 | — |
| RF-M11-05 | Baixar o **CRLV-e** quando autorizado, com trilha de acesso. | S | F3 | DOC-05 |
| RF-M11-06 | Guardar documentos com **SHA-256**, versões e origem; manter uma central de documentos com filtros. | M | F2 | DOC-04 |
| RF-M11-07 | Controlar o **acesso e download** por perfil, com auditoria. | M | F2 | AUD-06 |
| RF-M11-08 | **Exportar o dossiê da operação** (PDF determinístico + pacote ZIP com manifesto de hashes + assinatura) e verificá-lo publicamente. | M | F3 | DOC-07 |
| RF-M11-09 | Importar NF-e (XML) do ERP ou por **manifestação/consulta** quando houver integração. | S | F3 | INT-05 |

## M12 — Pendências e restrições

| ID | Requisito | Prio | Fase | RN |
|---|---|---|---|---|
| RF-M12-01 | Manter a **fila de pendências** com filtros (estabelecimento, categoria, responsável, prazo, risco, veículo). | M | F2 | PEN-01 |
| RF-M12-02 | Mostrar em cada item **causa, impacto, próxima ação e link direto** para resolver. | M | F2 | PEN-01 |
| RF-M12-03 | **Priorizar automaticamente** por risco × prazo × valor. | M | F2 | PEN-03 |
| RF-M12-04 | **Atribuir** a responsável, comentar e mencionar (@). | S | F2 | — |
| RF-M12-05 | **Resolver automaticamente** ao reavaliar a regra; descartar manualmente com justificativa. | M | F2 | PEN-05, PEN-06 |
| RF-M12-06 | **Traduzir os erros técnicos** em mensagens operacionais, com o detalhe técnico sob demanda. | M | F2 | GER-10 |
| RF-M12-07 | Registrar a **evidência de causa externa** (indisponibilidade SERPRO/DETRAN) na pendência. | M | F3 | PEN-07 |
| RF-M12-08 | Oferecer **SLA e escalonamento**: notificar o gestor quando a pendência se aproxima do prazo. | S | F3 | — |

## M13 — Reconciliação

| ID | Requisito | Prio | Fase | RN |
|---|---|---|---|---|
| RF-M13-01 | Disparar a **reconciliação automática** para "Resultado incerto" (backoff: 1, 5, 15, 60 minutos) e manual (botão "Verificar no RENAVE"). | M | F2 | REC-03 |
| RF-M13-02 | Rodar a **reconciliação periódica** de estoque, NF-e, documentos, transferências e certificados por estabelecimento. | M | F3 | REC-06 |
| RF-M13-03 | Registrar e tratar **divergências** (`reconciliation_issue`) com tipo, evidência dos dois lados e ação sugerida. | M | F3 | REC-06 |
| RF-M13-04 | **Bloquear repetição cega** com divergência aberta. | M | F2 | REC-07 |
| RF-M13-05 | **Reprocessar tarefas seguras** de forma controlada (perfil de operações), com registro. | M | F3 | REC-04 |
| RF-M13-06 | Gerar um **relatório de exceções** (divergências, incertos, rejeições) por período. | S | F3 | — |

## M14 — Auditoria e dossiê

| ID | Requisito | Prio | Fase | RN |
|---|---|---|---|---|
| RF-M14-01 | Gerar **evento de auditoria** para toda ação sensível, com os campos mínimos de RN-AUD-01. | M | F1 | AUD-01 |
| RF-M14-02 | Encadear os eventos por **hash** e **verificar a integridade** (rotina diária e sob demanda, com relatório). | M | F1 | AUD-02 |
| RF-M14-03 | Guardar os **payloads de entrada e saída** do RENAVE (cifrados) por ≥ 5 anos. | M | F1 | AUD-03 |
| RF-M14-04 | **Pesquisar a auditoria** por veículo, operação, usuário, IP, estabelecimento, ação, resultado e período. | M | F2 | — |
| RF-M14-05 | Mostrar o painel do evento com **antes/depois** e hashes. | M | F2 | AUD-04 |
| RF-M14-06 | Fazer a **exportação autorizada** (CSV/JSON assinado) com motivo registrado. | M | F2 | AUD-05 |
| RF-M14-07 | Aplicar **retenção configurável** (mínimo legal) e descarte seguro com registro. | M | F3 | DOC-08 |
| RF-M14-08 | Oferecer um **portal de fiscalização**: acesso temporário e restrito de leitura para órgão fiscalizador, com escopo, prazo e trilha. | C | F6 | RES art. 5º V |

## M15 — Integrações (API, webhooks, ERP/DMS)

| ID | Requisito | Prio | Fase | RN |
|---|---|---|---|---|
| RF-M15-01 | Disponibilizar uma **API REST** autenticada (OAuth2 client credentials ou mTLS) para ERP/DMS. | M | F3 | INT-01 |
| RF-M15-02 | **Versionar a API** (`/v1`) com OpenAPI publicado e changelog. | M | F3 | INT-01 |
| RF-M15-03 | Gerenciar **clientes de API** com escopos, quotas e rate limit; rotacionar segredos. | M | F3 | INT-01 |
| RF-M15-04 | Exigir `Idempotency-Key` em mutações, com conflito de payload detectado. | M | F3 | INT-02 |
| RF-M15-05 | Emitir **webhooks assinados**, com cadastro de endpoints e seleção de eventos. | M | F3 | INT-03 |
| RF-M15-06 | **Reentregar** webhooks com backoff; reenviar manualmente; pausar automaticamente. | M | F3 | INT-03, INT-04 |
| RF-M15-07 | Exibir o **histórico de entregas** (status, latência, resposta, tentativas). | M | F3 | — |
| RF-M15-08 | **Importar** NF-e e veículos de sistemas parceiros (API, planilha, XML). | S | F3 | INT-05 |
| RF-M15-09 | **Exportar** eventos e dados permitidos (CSV, JSON). | M | F3 | GER-11 |
| RF-M15-10 | Propagar o **correlation-id** ponta a ponta (header `X-Correlation-Id`). | M | F1 | REC-08 |
| RF-M15-11 | Oferecer um **sandbox** por tenant que simula o RENAVE (mocks com cenários positivos e negativos). | S | F3 | — |
| RF-M15-12 | Oferecer **SDK/coleção** (Postman/Bruno) e guia de integração. | C | F3 | — |
| RF-M15-13 | Exportar os dados completos do estabelecimento para **portabilidade** (migração de integradora). | M | F3 | GER-11 |

## M16 — Painéis e relatórios

| ID | Requisito | Prio | Fase | RN |
|---|---|---|---|---|
| RF-M16-01 | Mostrar o **painel operacional**: em estoque (total, por filial, por idade), entradas e saídas (hoje, semana, mês), pendências por tipo e idade, divergências, certificados e saúde do conector. | M | F2 | — |
| RF-M16-02 | Exibir o card **"O que precisa da sua atenção agora"**, priorizado. | M | F2 | PEN-03 |
| RF-M16-03 | Gerar relatórios: **livro eletrônico** de entradas e saídas por período (espelho da escrituração), estoque por idade, movimentações por filial, operações por usuário, exceções. | M | F2 | RES art. 5º V |
| RF-M16-04 | Exportar relatórios em PDF, CSV e XLSX. | M | F2 | — |
| RF-M16-05 | Mostrar o **painel executivo** multi-filial para grupos. | S | F3 | — |
| RF-M16-06 | Agendar o envio de relatórios por e-mail. | C | F3 | — |

## M17 — Notificações

| ID | Requisito | Prio | Fase | RN |
|---|---|---|---|---|
| RF-M17-01 | Oferecer uma **central de notificações** in-app, com lido e não lido. | M | F2 | — |
| RF-M17-02 | Enviar notificações por **e-mail** com preferências por usuário e tipo. | M | F2 | — |
| RF-M17-03 | Enviar notificações por **WhatsApp/SMS** para alertas críticos (certificado, prazo, resultado incerto). | C | F3 | — |
| RF-M17-04 | Gerar um **resumo diário** de pendências por e-mail. | S | F3 | — |

## M18 — Console da integradora (backoffice)

| ID | Requisito | Prio | Fase | RN |
|---|---|---|---|---|
| RF-M18-01 | Gerenciar **tenants**: criar, suspender, ver consumo de registros, estabelecimentos e ambientes. | M | F1 | — |
| RF-M18-02 | Mostrar a **saúde do conector RENAVE**: disponibilidade, latência p50/p95/p99, taxa de sucesso por operação, erros por código. | M | F2 | — |
| RF-M18-03 | Exibir uma **fila global** de resultados incertos, divergências e webhooks falhos. | M | F2 | — |
| RF-M18-04 | Mostrar uma **visão global de certificados** a vencer em todos os clientes. | M | F2 | — |
| RF-M18-05 | Permitir **impersonação auditada** para suporte (somente leitura por padrão, com consentimento e prazo). | S | F3 | — |
| RF-M18-06 | Disponibilizar **feature flags** por tenant e ambiente (transições regulatórias). | M | F1 | — |
| RF-M18-07 | Medir o **uso e faturamento** por tenant; gerenciar a tabela de preços dentro da faixa SENATRAN. | M | F3 | COB-01..04 |
| RF-M18-08 | Mostrar uma **página de status** pública (componentes e incidentes). | S | F3 | — |

## M19 — Gestão regulatória (Regulatory Watch)

| ID | Requisito | Prio | Fase | RN |
|---|---|---|---|---|
| RF-M19-01 | **Versionar as regras** de negócio internas (expressão, hash, autor, aprovação, vigência). | M | F1 | GER-08 |
| RF-M19-02 | Registrar a **origem normativa** de cada regra crítica (norma, artigo, manual e seção). | M | F1 | GER-08 |
| RF-M19-03 | Manter o **catálogo de endpoints e versões** do RENAVE-WS e o catálogo de **erros** com tradução. | M | F1 | GER-10 |
| RF-M19-04 | Registrar **mudanças normativas e de API** com data de publicação, data de vigência, impacto e status. | M | F2 | — |
| RF-M19-05 | Disparar **testes de regressão** (suíte de contrato) a cada mudança registrada. | M | F2 | — |
| RF-M19-06 | Manter a **matriz de impacto por UF** (procedimentos estaduais complementares). | S | F3 | — |
| RF-M19-07 | Usar **feature flags** para ativar regras em data de vigência. | M | F2 | — |
| RF-M19-08 | Monitorar o DOU, as Resoluções CONTRAN, as Portarias SENATRAN e o changelog do manual SERPRO, com alerta para a equipe. | C | F7 | — |

## M20 — Suporte e chamados

| ID | Requisito | Prio | Fase | RN |
|---|---|---|---|---|
| RF-M20-01 | Abrir **chamado** a partir de uma operação, veículo ou pendência, com contexto anexado automaticamente (correlation-id, estado, erro). | M | F2 | ANEXO |
| RF-M20-02 | Acompanhar o chamado, com SLA por severidade e **horário comercial ampliado**. | M | F2 | ANEXO |
| RF-M20-03 | Oferecer uma **base de conhecimento** contextual (ajuda por tela e por código de erro). | S | F3 | — |
| RF-M20-04 | Permitir **comentários e notas internas** em operações. | S | F2 | — |

## M0 — Transversais (todas as telas)

| ID | Requisito | Prio | Fase |
|---|---|---|---|
| RF-M0-01 | Seletor de **estabelecimento** (matriz/filial) e indicador de **ambiente** (Homologação/Produção) sempre visíveis. | M | F1 |
| RF-M0-02 | Busca global e **paleta de comandos** (`Ctrl/⌘+K`). | S | F2 |
| RF-M0-03 | **Mascaramento** de CPF/CNPJ e dados pessoais por perfil. | M | F1 |
| RF-M0-04 | **Estados vazios** úteis, skeletons de carregamento e mensagens de erro com ação. | M | F1 |
| RF-M0-05 | **Responsividade** (desktop, tablet e celular) e PWA para o pátio. | M | F2 |
| RF-M0-06 | Idioma pt-BR, formatos brasileiros (moeda, data, CPF/CNPJ, placa). | M | F1 |

---

## 5.21 Histórias de usuário críticas com critérios de aceite

### HU-01 — Dar entrada em veículo usado comprado de pessoa física (RF-M5-01..08)

> **Como** operadora RENAVE, **quero** dar entrada num usado comprado **para** que ele fique regular no estoque e possa ser vendido.

```gherkin
Cenário: Entrada concluída com sucesso
  Dado que o estabelecimento "Auto Prime — Matriz" tem certificado válido em Produção
  E o veículo de chassi "9BWZZZ377VT004251" está apto para entrada
  Quando eu informo vendedor, valor, data de entrada, identificação prévia e NF-e de entrada válida
  E a ATPV-e está assinada pelo vendedor
  E eu confirmo o envio
  Então a operação passa a "Enviado ao RENAVE" com chave de idempotência persistida
  E ao receber a confirmação o veículo passa a "Em estoque"
  E os termos retornados ficam disponíveis em Documentos com hash SHA-256
  E um evento "stock.entry.confirmed" é gravado na auditoria e enviado aos webhooks assinados

Cenário: Veículo com restrição impeditiva
  Dado que a consulta de aptidão retorna restrição judicial impeditiva
  Quando eu tento avançar do passo "Aptidão"
  Então o botão Continuar fica desabilitado
  E vejo a mensagem "Este veículo tem restrição judicial que impede a entrada no estoque"
  E vejo a ação sugerida e o código técnico em "Detalhes técnicos"

Cenário: NF-e incoerente
  Dado que a chave da NF-e informada tem CNPJ destinatário diferente do estabelecimento
  Quando eu valido a NF-e
  Então vejo "A NF-e não é destinada a Auto Prime — Matriz (CNPJ ***.***.***/0001-**)"
  E não consigo enviar a operação

Cenário: Timeout do RENAVE
  Dado que enviei a operação e a resposta não chegou dentro do timeout
  Então a operação fica "Resultado incerto"
  E o sistema NÃO reenvia automaticamente
  E uma reconciliação é agendada em 1 minuto
  E aparece uma pendência "Verificar no RENAVE" no topo da fila
```

### HU-02 — Vender veículo usado (RF-M5-20..23)

```gherkin
Cenário: Pré-condição não atendida
  Dado um veículo "Em estoque" cuja NF-e de entrada não foi vinculada
  Quando abro "Vender veículo"
  Então o painel de pré-condições mostra "NF-e de entrada não vinculada" com o botão "Vincular NF-e"
  E o botão "Enviar ao RENAVE" fica desabilitado

Cenário: Saída aguardando assinatura do comprador
  Dado que todas as pré-condições estão atendidas
  Quando envio a saída com comprador, valor, CRV, código de segurança e NF-e de saída
  Então a operação fica "Aguardando assinatura da ATPV-e"
  E o veículo continua "Em estoque" até a confirmação do RENAVE
  E quando o RENAVE confirmar, o veículo passa a "Baixado (vendido)"
```

### HU-03 — Reconciliar resultado incerto (RF-M13-01, RF-M13-04)

```gherkin
Cenário: Operação aplicada no RENAVE apesar do timeout
  Dado uma operação "Resultado incerto"
  Quando a reconciliação consulta o RENAVE e encontra a entrada registrada
  Então a operação passa a "Confirmado" sem novo envio
  E a pendência é resolvida automaticamente com evento de auditoria

Cenário: Operação não aplicada
  Dado uma operação "Resultado incerto"
  Quando a reconciliação confirma que nada foi registrado
  Então a operação volta a "Pronta para reenvio" com a MESMA chave de idempotência
  E o reenvio exige confirmação do usuário (ou política automática segura configurada)

Cenário: Bloqueio de operação concorrente
  Dado uma operação "Resultado incerto" para o veículo X
  Quando outro usuário tenta iniciar "Vender veículo" para X
  Então o sistema bloqueia e mostra "Há uma operação em verificação para este veículo"
```

### HU-04 — Consignação com prazo de 30 dias (RF-M9-04..06)

```gherkin
Cenário: Prazo de assinatura vencido
  Dado um contrato de consignação com venda iniciada há 30 dias
  E o consignante não assinou a ATPV-e
  Quando o prazo expira
  Então a venda é marcada como cancelada conforme o RENAVE
  E consignante, estabelecimento e credora (se houver) são notificados
  E é criada uma pendência "Emitir NF-e de devolução e registrar saída"

Cenário: Cancelamento não permitido
  Dado que o consignante já assinou a ATPV-e
  Então a ação "Cancelar contrato" não é exibida
```

### HU-05 — Aceitar transferência recebida (RF-M8-02)

```gherkin
Cenário: Aceite pelo estabelecimento comprador
  Dado uma transferência recebida de "Auto Prime — Campinas" para "Auto Prime — Santos"
  Quando o operador de Santos revisa NF-e e dados e clica em "Aceitar"
  Então o RENAVE confirma a transferência
  E o veículo sai do estoque de Campinas e entra no de Santos
  E ambos os estabelecimentos veem o evento na linha do tempo
```

### HU-06 — Certificado vencendo (RF-M2-05, RF-M2-07)

```gherkin
Cenário: Alerta de vencimento
  Dado um certificado que vence em 15 dias
  Então o administrador e o responsável técnico recebem alerta por e-mail e no painel
  E o card de alertas do painel mostra "Certificado de Santos vence em 15 dias" com a ação "Rotacionar"

Cenário: Bloqueio automático
  Dado um certificado vencido
  Quando qualquer operação do estabelecimento tenta chamar o RENAVE
  Então a chamada não é feita
  E a operação fica em "Erro — certificado inválido" com pendência "Certificado" no topo
```

---

## 5.22 Rastreabilidade com o Guia RENAVE 2026 (RF-001 a RF-108)

| Guia | Requisito neste documento |
|---|---|
| RF-001 a RF-010 (Cadastro e acesso) | RF-M1-01..09, RF-M3-01..07 |
| RF-011 a RF-018 (Certificados) | RF-M2-01..09 |
| RF-019 a RF-028 (Veículos e estoque) | RF-M4-01..11 |
| RF-029 a RF-038 (Usados) | RF-M5-01..26 |
| RF-039 a RF-052 (Zero km e ITE) | RF-M6-01..08, RF-M7-01..04 |
| RF-053 a RF-062 (Documentos e fiscal) | RF-M11-01..09 |
| RF-063 a RF-072 (Transferências e modalidades) | RF-M8-01..06, RF-M9-01..08, RF-M10-01..05 |
| RF-073 a RF-082 (Operação e suporte) | RF-M12-01..08, RF-M13-01..06, RF-M20-01..04, RF-M17 |
| RF-083 a RF-092 (APIs e integrações) | RF-M15-01..13 |
| RF-093 a RF-100 (Auditoria e compliance) | RF-M14-01..08, RF-M1-08 |
| RF-101 a RF-108 (Gestão regulatória) | RF-M19-01..08, RF-M18-06 |

**Requisitos novos além do Guia** (derivados da Res. 1.026 e da análise de produto): RF-M1-06/07/10/11, RF-M2-09, RF-M4-10, RF-M9-08, RF-M10-05, RF-M14-08, RF-M15-11/13, RF-M16-03 (livro eletrônico), RF-M18-07 (preço na faixa SENATRAN) e todo o M0.
