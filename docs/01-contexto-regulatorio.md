# 01 — Contexto regulatório

> **Base normativa:** Resolução CONTRAN nº 1.026, de 26/06/2026, publicada no DOU de 30/06/2026 (Edição Extra, Seção 1, nº 120-C), em vigor na data da publicação. Altera a Res. CONTRAN nº 807/2020 e revoga as Res. nº 797/2020 e nº 818/2021.
> **Leitura:** integral, a partir do PDF oficial do DOU fornecido. Este documento não substitui parecer jurídico.

---

## 1.1 O que é o RENAVE

O **Registro Nacional de Veículos em Estoque (Renave)** é o sistema eletrônico que registra as movimentações de **entrada e saída** de veículos, novos ou usados, e o uso de placas de experiência, pelos estabelecimentos do art. 330 do CTB (Art. 1º).

| Característica | Regra | Fonte |
|---|---|---|
| Natureza | **Único** meio eletrônico admitido para escrituração de entrada/saída; substitui os livros físicos | Art. 1º §1º |
| Vínculo | Subsistema do Renavam, mantido pela SENATRAN (operação técnica SERPRO) | Art. 1º §3º |
| Fora do escopo | Transferência de propriedade (art. 123 CTB), contrato de compra e venda, coleta de assinaturas, apontamento/gravame | Art. 1º §2º |
| Acesso | Exclusivamente com **certificado e-CNPJ ICP-Brasil válido**; certificado expirado/suspenso/revogado gera **bloqueio automático** | Art. 30 |
| Uso de dados | Somente para escrituração e finalidades da Resolução; SENATRAN é **controladora** dos dados | Art. 31 |
| NF-e | Cadastro implica autorização de acesso aos dados de NF-e no **SPED** | Art. 29 |

## 1.2 Atores e papéis

| Ator | Papel no Renave | Fonte |
|---|---|---|
| **SENATRAN** (órgão máximo executivo de trânsito da União) | Organiza, mantém, audita; autoriza adesões e integradoras; homologa sistemas de integração; define preço público; opera o **Credencia** | Art. 3º |
| **DETRANs** | Procedimentos locais compatíveis com o padrão nacional; fiscalizam estabelecimentos e aplicam multa; podem dar **autorização complementar** à integradora | Art. 4º, Art. 9º §1º |
| **Estabelecimento** | Adere via Credencia; informa o sistema de integração escolhido; registra **todas** as entradas, saídas, transferências e consignações; emite NF-e compatível; garante veracidade | Art. 5º |
| **Integradora** | Pessoa jurídica autorizada pela SENATRAN que desenvolve, mantém e opera o **sistema de integração**, submetido à homologação | Art. 2º IV, Art. 6º |
| **Instituição credora** | Adesão **facultativa**; entrada de veículo retomado; consulta de estoque vinculado ao contrato de garantia | Art. 7º II, Art. 17, Art. 24 |
| **Entidades registradoras** (BACEN) | Interoperam com DETRANs para gravames; integração de monitoramento com a SENATRAN | Art. 23 |

## 1.3 Definições que viram regra de software (Art. 2º)

| Termo | Definição resumida | Impacto no sistema |
|---|---|---|
| Registro eletrônico de estoque | Lançamento de entrada/saída no Renave | Entidade `operation` com ciclo de vida próprio |
| Título do negócio jurídico | Compra, venda, transferência entre estabelecimentos, consignação, execução de garantia real | Enum obrigatório em toda operação |
| Veículo em estoque | Adquirido para comercialização, com entrada **ativa** | Estado `EM_ESTOQUE` só após confirmação do Renave |
| Veículo consignado | Entregue por contrato eletrônico de consignação, **sem** transferência de propriedade | Domínio próprio de consignação |
| Veículo em estoque **vinculado** | Pendência/restrição/débito inserido **após** a entrada, ou veículo **retomado** | Estado `VINCULADO`, alertas e bloqueios |
| Identificação prévia de entrada | Validação eletrônica da identificação do veículo antes da entrada; substituível por **vistoria** | Etapa obrigatória do fluxo de entrada |
| Termo de entrega (entrada) | Documento eletrônico do Renave; intenção de entrada imediata; exige **assinatura eletrônica do proprietário** | Documento + status de assinatura |
| Termo de entrega (saída) | Indica saída imediata, com dados do comprador; exige assinatura eletrônica do proprietário | Documento + status de assinatura |

## 1.4 Adesão do estabelecimento (Arts. 7º a 10)

- Adesão via **Credencia**, diretamente ou **por intermédio de integradora autorizada** (Art. 8º). Os efeitos são os mesmos, desde que com e-CNPJ válido do estabelecimento.
- Se a adesão for feita pela integradora, o sistema de integração do estabelecimento **deve ser o homologado** dessa integradora (Art. 8º §3º).
- **CNAE principal** e objeto social compatíveis com: compra e venda de veículos novos/usados; instituição credora (facultativa); outras atividades definidas pela SENATRAN (Art. 7º).
- **Obrigatória** para quem comercializa **veículos novos**: sem entrada prévia no Renave, o 0 km não pode ser registrado, licenciado nem emplacado (Art. 7º §2º).
- A SENATRAN analisa em até **30 dias** (prorrogáveis uma vez). Pendência suspende o prazo; se não for sanada em 30 dias, o pedido é **indeferido** (Art. 10).

> ⚠️ **Tensão normativa a resolver formalmente:** o Art. 9º, §§1º a 3º, prevê autorização complementar do DETRAN para a integradora atuar na respectiva circunscrição, com hipóteses de dispensa pela SENATRAN. O Anexo, em "Competências e abrangência de atuação", afirma atuação nacional e veda autorização, credenciamento ou habilitação estadual adicional. O produto deve modelar ambos os estados e não liberar produção com base em interpretação própria; a aplicabilidade deve ser confirmada com a SENATRAN e assessoria jurídica.

## 1.5 Conteúdo mínimo de cada registro

| Operação | Dados mínimos exigidos | Artigo |
|---|---|---|
| **Entrada — 0 km (compra)** | Atribuída ao estabelecimento após o **pré-cadastro** do fabricante/importador/RFB. O estabelecimento é identificado pelo **faturado** do pré-cadastro. Exige identificação prévia (ou vistoria). | Art. 12 |
| **Saída — 0 km (venda)** | Estabelecimento vendedor; veículo; comprador; data de saída; valor; título do negócio; **número e chave da NF-e**, emitida de forma integrada e sincronizada | Art. 13 |
| **Compra de usado** | O estabelecimento deve emitir a **NF-e de compra** e **assinar a ATPV-e** | Art. 14 |
| **Entrada — usado (compra)** | Estabelecimento comprador; identificação prévia (ou vistoria); vendedor; data de entrada; valor; título; NF-e; **data do reconhecimento de firma ou data/hora da assinatura eletrônica avançada/qualificada do vendedor** | Art. 15 |
| **Entrada — usado próprio** | Estabelecimento proprietário; identificação prévia; data; valor; título "entrada em estoque de veículo próprio" | Art. 16 |
| **Entrada — retomado** | Instituição credora; identificação prévia (ou Auto de Apreensão Extrajudicial / Termo de Entrega Voluntária); **NSU** da execução extrajudicial ou nº do processo/registro; data; valor; título "veículo retomado". Só se a credora aderiu. | Art. 17 |
| **Saída — usado (venda)** | Vendedor; veículo, incluindo **nº do CRV e código de segurança**; comprador (o destinatário, ainda sem a transferência concluída); data; valor; título; NF-e. Formalizada com **NF-e de saída + ATPV-e assinada eletronicamente**. O novo CRV do comprador é **informado ao vendedor** pelo Renave. | Art. 18 |
| **Transferência entre estabelecimentos** | Solicitada pelo **vendedor**; identificação prévia (ou vistoria pelo comprador); comprador; data; valor; título; NF-e. Só entre estabelecimentos **aderidos**; **concluída após confirmação do comprador**; entrada no comprador exclusivamente digital. | Art. 19 |
| **Consignação** | Contrato eletrônico **registrado no Renave** antes de qualquer venda; padrão SENATRAN (cláusulas fixas + campos parametrizáveis); assinado por estabelecimento (e-CNPJ) e consignante (e-CNPJ se PJ; assinatura avançada/qualificada se PF) | Art. 20 |

### Regras específicas de consignação (Art. 20)

1. Validado o contrato, inicia-se a venda e o Renave anota **"veículo consignado em processo de transferência"** (§4º).
2. A propriedade só se transfere após o **consignante assinar a ATPV-e** (§6º).
3. Se o consignante **não assinar em 30 dias**, ou cancelar o contrato, **a venda é cancelada** e a anotação é baixada. Restrições de financiamento permanecem até a restituição à credora (§7º).
4. O contrato pode ser cancelado **por ambas as partes** antes da assinatura da ATPV-e e, se houver financiamento com alienação fiduciária, antes da formalização do financiamento (§8º). O cancelamento pelo consignante previsto no §7º é hipótese distinta; não se presume cancelamento unilateral pelo estabelecimento.
5. O cancelamento é comunicado de forma **instantânea e simultânea** ao estabelecimento, ao consignante e à credora (§9º).
6. Depois do cancelamento, o estabelecimento emite **NF-e de devolução** e **registra a saída** no Renave (§10).

### Situações empresariais (Arts. 21 e 22)

- **Falência ou liquidação:** o administrador judicial gere as movimentações. Os consignados **não** entram na massa falida: os contratos são cancelados e a posse é restituída. O estoque vinculado com garantia real fica afetado ao crédito.
- **Incorporação, fusão, cisão ou sucessão:** a sucessora pode assumir o estoque e os consignados mediante atualização cadastral, sem invalidar os registros anteriores.

## 1.6 Efeitos no Renavam (Art. 11)

- A entrada gera a anotação **"veículo em estoque"** ou a restrição **"veículo em estoque vinculado"**.
- A anotação só sai com o **registro de saída**, a regularização das pendências ou a liquidação dos débitos.
- **Não** há registro de estoque para veículo com **restrição impeditiva** ou **débito não liquidado** (§2º). Por isso a consulta de aptidão é obrigatória antes de qualquer envio.

## 1.7 Ecossistema financeiro (Arts. 23, 24 e 34)

- **Mudança relevante na Res. 807/2020 (Art. 34):** o **apontamento** de financiamento **não pode ser feito** quando o beneficiário for estabelecimento do art. 330 **e o veículo não estiver no estoque Renave**. Ou seja, o Renave passa a ser **pré-condição do crédito** ao lojista. O sistema deve deixar visível quais veículos estão "aptos a financiamento".
- Credoras consultam o estoque vinculado ao contrato de garantia (Art. 24).

## 1.8 Sanções (Arts. 25 a 28)

| Sujeito | Infração / hipótese | Consequência |
|---|---|---|
| Estabelecimento | Falta, **atraso**, fraude ou recusa de exibição da escrituração | Multa de **infração gravíssima** (art. 330 §5º CTB), aplicada pelo DETRAN |
| **Integradora** | Infração causada por **sua ação ou omissão** | **Responsabilidade solidária** com o estabelecimento (Art. 25 §2º) |
| Estabelecimento reincidente ou com prática grave | — | Cancelamento da adesão; nova adesão só após **180 dias** |
| Integradora | Descumprimento técnico, operacional, de governança ou de segurança | Advertência, suspensão ou **desautorização** (nova autorização só após 180 dias) |
| Qualquer um | Indício relevante de irregularidade, ou **inadimplência** com a SENATRAN | **Bloqueio cautelar** de acesso |

> **Implicação de produto:** como a integradora responde solidariamente pelo atraso de escrituração, o sistema precisa de **SLA interno, alertas de prazo e evidência** de que cada atraso foi causado pelo estabelecimento ou por terceiro (DETRAN, SERPRO) e não pela plataforma. A trilha de auditoria é também a **defesa jurídica** da integradora.

## 1.9 Preço público (Art. 32)

- A SENATRAN fixará **valores mínimo e máximo** para os serviços de integração.
- É **vedado** cobrar fora da faixa ou **condicionar o acesso ao Renave à contratação de outros serviços**.
- Os preços cobrados devem ter **ampla publicidade**, com acesso prévio pelos estabelecimentos.

> **Implicação de produto:** o Seu Renave é **exclusivamente RENAVE** e cobra **por registro RENAVE confirmado**, no valor oficial, sem mensalidade, planos ou serviços acoplados. A tabela de preços é pública. Não haverá módulos de gestão (DMS, CRM, pátio), por causa da vedação do Anexo (seção 1.10).

## 1.10 Requisitos para ser **integradora autorizada** (Anexo)

> Esta é a seção de maior impacto estratégico. A Resolução exige da integradora requisitos **empresariais** além dos técnicos.

### Vedações de conflito de interesse

**Não podem** ser integradoras:
- instituições financeiras, de pagamento, SCD, SEP e administradoras de consórcio;
- seguradoras (SUSEP);
- leiloeiros oficiais e organizadores de leilão de veículos;
- **provedores de sistemas de gestão de concessionárias, lojas de veículos, montadoras e importadoras (DMS)**;
- operadoras de plataforma de **transferência eletrônica** homologadas;
- operadoras de plataforma de **assinatura eletrônica** homologadas.

**Vedações cruzadas posteriores** (ver doc 13):
- **Res. CONTRAN 1.027/2026**, Anexos I e II, item 1.2.1.5: integradoras Renave **não podem** ser plataformas de transferência eletrônica nem de assinatura eletrônica.
- **Res. CONTRAN 1.032/2026**, item 1.3.2.7: integradoras Renave **não podem** ser integradoras de vistoria veicular.
- O Seu Renave **integra-se** a essas plataformas. A comunicação de venda **poderá** ser realizada automaticamente por integração entre o Renave e plataformas homologadas, condicionada aos requisitos da SENATRAN (Res. 1.027, Art. 28 §6º), mas o Seu Renave **não as opera**.

A vedação alcança também quem tenha **participação societária ou controle** nessas empresas.

### Requisitos jurídicos, fiscais e econômico-financeiros

- Objeto social compatível com integração de sistemas; CNPJ ativo; alvará, quando exigido.
- CND federal (RFB/PGFN), FGTS, CNDT, inscrição e regularidade municipal/distrital.
- Balanço anual assinado por contador (CRC), enviado em até **150 dias** após o fim do exercício. Auditoria independente (CVM) acima de um volume a definir.
- Certidão negativa de falência e recuperação judicial.
- **Capital social integralizado ou patrimônio líquido mínimo de R$ 1.000.000,00**, mantido durante toda a autorização.

### Requisitos técnicos (viram requisitos não funcionais)

| Requisito do Anexo | Tradução para o sistema |
|---|---|
| SGSI formal com **ISO/IEC 27001** vigente, em até **270 dias** da publicação, ou seja, até **27/03/2027** | Programa de segurança, políticas, evidências e auditoria de certificação |
| e-CNPJ válido e tecnologia **ICP-Brasil** | Certificado e transações ICP-Brasil. O mecanismo de transporte e identidade — hoje mTLS com e-CNPJ da integradora e identificação da loja no cabeçalho — decorre do manual SERPRO, não desta Resolução (doc 14) |
| Infraestrutura **redundante** | Multi-AZ, sem ponto único de falha |
| **RTO ≤ 4 horas** | DR testado e documentado |
| **Rastreabilidade integral e imutável**: usuário, **IP de origem**, horário sincronizado com a **Hora Legal Brasileira (Observatório Nacional)**, operação, **dados de entrada e saída**, **hash de integridade** | Log de auditoria append-only com encadeamento de hash; NTP do ON (`ntp.on.br`) |
| Disponível para auditoria dos órgãos por **no mínimo 5 anos** | Retenção ≥ 5 anos; exportação para fiscalização |
| Prevenção a fraudes e monitoramento contínuo | Regras antifraude, detecção de anomalias, SOC/alertas |
| **Processamento primário em datacenter no Brasil**; backup no exterior só com LGPD/ANPD | Região brasileira (ex.: `sa-east-1` / `southamerica-east1`) |
| Mesmo sistema de integração durante todo o ciclo de um veículo, salvo mudança de integradora pelo estabelecimento | Não trocar de conector no meio de uma operação; em migração legítima, preservar continuidade, histórico e evidências |
| Responsável técnico formal por segurança e continuidade | Papel organizacional + registro no sistema |
| Suporte em **horário comercial ampliado** | Central de atendimento, SLA, chamados ligados à operação |
| Programa de integridade, política de privacidade, termo de sigilo | Governança/compliance documental |

### Continuidade e migração

- Em desautorização, falência ou liquidação, o estabelecimento migra para outra integradora em até **60 dias**.
- A integradora encerrada deve fazer **exportação íntegra, autenticada, rastreável e auditável** dos dados e depois a **eliminação segura**.
- **Implicação:** é preciso um **exportador padronizado de dados por estabelecimento** desde o MVP. Isso também ajuda na venda, porque o cliente sabe que não fica preso à plataforma.

## 1.11 Prazos — situação em 24/11/2026

| Marco | Data | Situação |
|---|---|---|
| Publicação / vigência | 30/06/2026 | Em vigor |
| Adequação de estabelecimentos, integradoras e DETRANs (90 dias) | **28/09/2026** | **Vencido.** Autorizações estaduais não regularizadas perderam efeito (Art. 33 §3º), salvo prorrogação |
| Prazo de análise da SENATRAN para pedidos | 30 dias + 30 de prorrogação | Por pedido |
| **ISO/IEC 27001** para integradoras (em operação e solicitantes) | **27/03/2027** | **≈ 4 meses restantes** |
| Migração em caso de descontinuidade | 60 dias do ato | Por evento |
| Balanço anual | 150 dias após o exercício | Anual |

> ⚠️ **Cronograma não revalidado nesta rodada.** O doc 13 registra a **Circular SENATRAN nº 2/2026** como fonte oficial a partir da pesquisa anterior. Como seu texto não integra os PDFs fornecidos em 24/11/2026, as datas abaixo continuam sujeitas ao Regulatory Watch:
> - Credencia para integradoras: 1 a 15/10;
> - indicação da integradora pelas lojas: 9 a 20/10;
> - consignado: 15 a 30/10;
> - intermediação financeira: 30/10 a 10/11;
> - assinaturas e transferência: 9 a 20/11;
> - **controle de conformidade a partir de 20/11/2026**.
>
> A **Res. CONTRAN 1.027/2026** foi lida integralmente no PDF oficial fornecido em 24/11/2026 e suas regras relevantes estão consolidadas abaixo e no doc 13. O texto da Circular não integra o conjunto de PDFs fornecido nesta revisão; seu cronograma continua sujeito ao Regulatory Watch.

## 1.11a Situação da API RENAVE-WS em relação à norma (lacunas)

A leitura do Swagger de produção e de homologação, em 23/11/2026, mostra que a API **ainda não implementa** todos os conceitos da Res. 1.026:

| Conceito da Res. 1.026 | Situação na API | Estratégia do produto |
|---|---|---|
| Identificação prévia de entrada / vistoria | **Sem endpoint** | Capturar evidências localmente (fotos, hodômetro, chassi); *adapter* desligado por feature flag até a publicação |
| Estoque vinculado / retomados (NSU) | **Sem endpoint** | Modelar o domínio; ativar quando publicado |
| Termos de entrega para entrada e saída (assinatura do proprietário) | Só os termos de entrada/saída do estoque (o de saída "deve ser extinto") | Acompanhar o Regulatory Watch |
| Contrato eletrônico de consignação | **Só em homologação** (`/api/consignados/*` + mocks de DETRAN); sem contrato | Implementar contra a homologação, atrás de feature flag |
| Integradora identificada na API | Em homologação, `cliente-autenticado` passou a ter `cnpjIntegradora` e `nomeIntegradora` | Indica o modelo de integradora em transição |
| ATPV-e gerada pelo órgão máximo executivo de trânsito | Base normativa confirmada pela Res. 1.027, Art. 27 §1º; o manual ainda cita normas revogadas e a API não expõe toda a jornada | O Seu Renave não gera a ATPV-e; recebe e acompanha por integração. Só poderá solicitá-la se houver autorização técnica e normativa expressa no canal SERPRO |

> **Conclusão:** a arquitetura precisa de **adapters versionados por capacidade** e **feature flags por data de vigência**, porque a norma está à frente da API.

## 1.11b Regras confirmadas da transferência eletrônica (Res. 1.027)

| Regra | Impacto no produto | Fonte |
|---|---|---|
| A ATPV-e é gerada **exclusivamente** pelo órgão máximo executivo de trânsito e disponibilizada por integração | Tratar o documento como recurso externo; guardar identificador, versão, eventos e evidências, sem geração local | Art. 27 §1º |
| Só pode existir **uma ATPV-e ativa por veículo** | Bloqueio de duplicidade e reconciliação antes de nova solicitação | Art. 27 §5º |
| Na ATPV-e são admitidas somente assinaturas eletrônicas avançadas ou qualificadas; cada assinatura é registrada imediatamente no Renavam | Máquina de estados por evento, sem aceitar upload de assinatura manuscrita como conclusão do fluxo eletrônico | Art. 28 §§1º e 2º |
| Depois das duas assinaturas e validações, a comunicação de venda é gerada automaticamente | O estado local só avança após confirmação sistêmica; assinatura isolada não equivale a comunicação de venda | Art. 28 §4º |
| Em operações com estabelecimento do art. 330, a integração Renave ↔ plataformas homologadas **poderá** automatizar a comunicação | Capacidade condicionada aos requisitos e à disponibilidade técnica da SENATRAN; não prometer automação universal | Art. 28 §6º |
| Após a comunicação de venda, o cancelamento da ATPV-e fica restrito a decisão judicial, fraude, erro material ou distrato formal bilateral, preservando histórico e efeitos perante terceiros | Fluxo excepcional, auditado e sem exclusão de evidências | Art. 29 §§2º a 4º |
| Operações com estabelecimento aderente ao Renave devem ser processadas preferencialmente por transferência eletrônica | Priorizar a jornada eletrônica, mantendo fallback somente quando normativamente admitido | Art. 37 VI |

## 1.12 Decisões de produto derivadas da norma

1. **Posicionamento:** a plataforma é **sistema de integração e compliance**, **não** DMS. Funcionalidades de gestão comercial (CRM, precificação, financeiro de loja) ficam fora do produto RENAVE. Qualquer relação societária com fornecedores de DMS, assinatura eletrônica ou transferência eletrônica precisa de análise jurídica.
2. **Rota de entrada no mercado** (decisão de negócio, ver `09-roadmap-riscos.md`):
   - **A — Integradora autorizada própria:** exige capital de R$ 1 mi, ISO 27001 até 27/03/2027, autorização na SENATRAN e homologação. Maior margem e maior barreira.
   - **B — Parceria tecnológica / white-label** com uma integradora já autorizada: time-to-market menor. Precisa confirmar com a SENATRAN se o modelo é admitido, porque a homologação é **da integradora**.
3. **Evidência como produto:** cada operação gera um dossiê verificável, porque a integradora responde solidariamente.
4. **Fluxos guiados pela norma:** cada formulário pede exatamente os dados mínimos dos arts. 13 a 20, com validação preventiva.
5. **Preço transparente e módulo isolado** (Art. 32).
6. **Portabilidade de dados** nativa (Anexo, "Continuidade e migração").
