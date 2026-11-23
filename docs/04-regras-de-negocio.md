# 04 — Regras de negócio

> **Convenções**
> - **ID:** `RN-<domínio>-<nº>`. Domínios: GER (geral), ADE (adesão), CER (certificado), VEI (veículo), ENT (entrada), SAI (saída), 0KM, ITE, TRF (transferência), CON (consignação), RET (retomado), DOC (documentos/fiscal), PEN (pendências), REC (reconciliação), AUD (auditoria), INT (integrações), COB (cobrança/preço).
> - **Origem:** `RES art. X` = Res. CONTRAN 1.026/2026 · `ANEXO` = Anexo da Res. 1.026 · `MAN` = Manual RENAVE-WS (SERPRO) · `GUIA` = Guia RENAVE 2026 (base interna) · `PROD` = decisão de produto.
> - **Severidade:** 🔴 **Bloqueante** (impede a operação) · 🟠 **Alerta** (permite com confirmação explícita e registro) · 🔵 **Informativa**.
> - Toda regra que envolve dado externo é avaliada pelo **motor de regras** (resultado TRUE/FALSE/UNKNOWN), com trace guardado (`rule_evaluation`).
> - Regras com origem `MAN` devem ser **revalidadas contra o manual vigente** a cada release (ver Regulatory Watch, RN-GER-08).

---

## 4.1 Regras gerais (GER)

| ID | Regra | Sev. | Origem |
|---|---|---|---|
| RN-GER-01 | Toda operação pertence a **um tenant e um estabelecimento**. O contexto é resolvido **no backend**, nunca vindo só do frontend. | 🔴 | GUIA, ANEXO |
| RN-GER-02 | O RENAVE só é acessado com **certificado e-CNPJ ICP-Brasil válido** do estabelecimento. Certificado expirado, suspenso ou revogado **bloqueia** qualquer chamada. | 🔴 | RES art. 30 |
| RN-GER-03 | Todo registro exige um **título do negócio jurídico**: compra, venda, transferência entre estabelecimentos, consignação, execução de garantia real, entrada de veículo próprio ou entrada de veículo retomado. | 🔴 | RES art. 2º VI, 16, 17 |
| RN-GER-04 | Não há registro para veículo com **restrição impeditiva** ou **débito não liquidado**. Exigir consulta de aptidão **válida e recente** antes do envio. | 🔴 | RES art. 11 §2º |
| RN-GER-05 | O estado local **"Em estoque"** ou **"Baixado"** só é assumido **após confirmação** do RENAVE ou reconciliação. Nunca de forma otimista. | 🔴 | GUIA |
| RN-GER-06 | O **mesmo sistema de integração** atende todo o ciclo de um mesmo veículo. Migração de integradora segue o fluxo de portabilidade (RN-GER-11). | 🔴 | ANEXO |
| RN-GER-07 | Os dados do RENAVE só são usados para escrituração e finalidades da Resolução. Uso analítico/comercial de dados pessoais é **vedado**. | 🔴 | RES art. 31 |
| RN-GER-08 | Regras com origem normativa têm **versão, vigência (início e fim) e referência ao dispositivo**. Mudança de manual/API gera nova versão, teste de regressão e data de entrada em vigor. | 🔴 | GUIA, PROD |
| RN-GER-09 | Ambientes de **homologação** e **produção** são isolados: certificados, endpoints, dados e credenciais separados. A UI mostra o ambiente o tempo todo. | 🔴 | GUIA |
| RN-GER-10 | Erros do RENAVE nunca são ocultados: aparecem **traduzidos** e o **código e a mensagem originais** ficam guardados e visíveis em "Detalhes técnicos". | 🔴 | GUIA |
| RN-GER-11 | O estabelecimento pode **exportar todos os seus dados** (operações, documentos, trilha) em formato íntegro, autenticado e verificável. Em descontinuidade, isso é feito em até **60 dias**, seguido de **eliminação segura**, salvo guarda legal. | 🔴 | ANEXO |
| RN-GER-12 | Datas e horas são registradas em **UTC**, com o relógio sincronizado com a **Hora Legal Brasileira** (Observatório Nacional), e exibidas em `America/Sao_Paulo`. | 🔴 | ANEXO |
| RN-GER-13 | Estabelecimento com **adesão suspensa, cancelada ou bloqueada cautelarmente** não envia operações; consultas e exportação continuam liberadas. | 🔴 | RES art. 26, 28 |

## 4.2 Adesão e onboarding (ADE)

| ID | Regra | Sev. | Origem |
|---|---|---|---|
| RN-ADE-01 | O estabelecimento precisa ter **CNAE principal** e **objeto social** compatíveis com compra e venda de veículos (novos ou usados), instituição credora ou atividade definida pela SENATRAN. O sistema valida o CNAE na consulta de CNPJ e sinaliza incompatibilidade. | 🔴 | RES art. 7º |
| RN-ADE-02 | CNPJ deve ter DV válido, aceitando o **formato alfanumérico** e situação cadastral **ativa**. | 🔴 | PROD |
| RN-ADE-03 | Quem vende **0 km** tem adesão **obrigatória**. Credoras têm adesão **facultativa**. | 🔵 | RES art. 7º §2º, II |
| RN-ADE-04 | Quando a adesão é feita **por intermédio da integradora**, o estabelecimento passa a usar **o sistema homologado dessa integradora** (vínculo registrado). | 🔴 | RES art. 8º §3º |
| RN-ADE-05 | A adesão exige o **e-CNPJ válido do estabelecimento**. Sem certificado cadastrado e válido, a etapa "Credencia" não avança. | 🔴 | RES art. 8º §1º, 10 |
| RN-ADE-06 | O status do pedido segue a máquina: `RASCUNHO → PROTOCOLADO → EM_ANALISE → (PENDENTE ↔ EM_ANALISE) → APROVADO / INDEFERIDO`. Os prazos de análise são acompanhados (30 + 30 dias). Pendência não sanada em **30 dias** gera **alerta de indeferimento iminente** a partir do 20º dia. | 🟠 | RES art. 10 |
| RN-ADE-07 | Só vai para **produção** o estabelecimento com adesão aprovada, certificado válido, homologação concluída e aceite dos termos de uso e privacidade. | 🔴 | GUIA, ANEXO |
| RN-ADE-08 | Com a adesão cancelada por reincidência, nova adesão só é possível **180 dias** após a decisão definitiva. O sistema guarda essa data e bloqueia nova solicitação. | 🔴 | RES art. 26 §2º |
| RN-ADE-09 | Em **sucessão empresarial** (incorporação, fusão, cisão), o estoque e os consignados são transferidos à sucessora **sem perder o histórico**, com a operação de sucessão registrada na auditoria. | 🟠 | RES art. 22 |
| RN-ADE-10 | Em **falência ou liquidação**, um **administrador judicial** recebe perfil próprio. Os consignados são separados e seus contratos cancelados, com a posse restituída. | 🟠 | RES art. 21 |

## 4.3 Certificados (CER)

| ID | Regra | Sev. | Origem |
|---|---|---|---|
| RN-CER-01 | O certificado é **e-CNPJ ICP-Brasil** e o CNPJ do titular coincide com o do estabelecimento, ou com a raiz da matriz se o manual admitir o uso pela matriz *(validar no MAN)*. | 🔴 | RES art. 10, 30 |
| RN-CER-02 | A chave privada fica **somente em cofre** (KMS/HSM/Vault). É **proibido** guardá-la no banco, em log ou no frontend, e o arquivo PFX nunca volta ao usuário. | 🔴 | GUIA, ANEXO |
| RN-CER-03 | Alertas de vencimento em **60, 30, 15 e 7 dias** e no dia do vencimento, para o administrador e o responsável técnico, por e-mail, painel e notificação. | 🟠 | GUIA |
| RN-CER-04 | Certificado **vencido ou revogado** bloqueia automaticamente as chamadas do estabelecimento. O sistema verifica a revogação (CRL/OCSP) **diariamente** e no cadastro. | 🔴 | RES art. 30 |
| RN-CER-05 | A **rotação** é feita sem indisponibilidade: o novo certificado é validado antes de ser ativado e o anterior fica no histórico. | 🔴 | GUIA |
| RN-CER-06 | Cada operação registra **qual certificado foi usado** (identificador lógico e impressão digital), nunca o segredo. | 🔴 | GUIA |
| RN-CER-07 | Certificados de homologação e de produção são **distintos e não intercambiáveis**. | 🔴 | GUIA |

## 4.4 Veículo e consulta (VEI)

| ID | Regra | Sev. | Origem |
|---|---|---|---|
| RN-VEI-01 | O veículo é identificado por **RENAVAM** (11 dígitos), **chassi** (17 caracteres, sem I, O ou Q, com DV quando aplicável) ou **placa** (formatos antigo e Mercosul). Ao menos um identificador forte (chassi ou RENAVAM) deve ser confirmado antes de enviar. | 🔴 | GUIA, PROD |
| RN-VEI-02 | A consulta de **aptidão** vale para uma janela configurável *(padrão: 24h; ajustar ao MAN)*. Expirada a janela, é refeita automaticamente antes do envio. | 🔴 | PROD |
| RN-VEI-03 | Após a entrada, o sistema monitora o surgimento de **pendência, restrição ou débito superveniente** e marca o veículo como **"Em estoque vinculado"**, com alerta. | 🟠 | RES art. 2º IX, 11 |
| RN-VEI-04 | Veículo **retomado** entra como "Em estoque vinculado". | 🔵 | RES art. 2º IX b |
| RN-VEI-05 | Há uma **única posição ativa** por veículo: o mesmo veículo não pode estar em estoque em dois estabelecimentos ao mesmo tempo (salvo o estado transitório "Em transferência"). | 🔴 | PROD |
| RN-VEI-06 | O **hodômetro** é registrado com a data da medição e não pode ser menor que o último valor registrado, salvo justificativa com evidência (troca de painel). | 🟠 | GUIA, PROD |
| RN-VEI-07 | O histórico de proprietários e partes é mostrado só a perfis autorizados, com mascaramento conforme o perfil. | 🔴 | GUIA, LGPD |
| RN-VEI-08 | O veículo mostra se está **apto a financiamento**, ou seja, em estoque Renave e sem restrição. Sem estoque Renave, o apontamento é vedado quando o beneficiário é estabelecimento. | 🔵 | RES art. 34 |

## 4.5 Entrada de usado (ENT)

| ID | Regra | Sev. | Origem |
|---|---|---|---|
| RN-ENT-01 | **Compra de usado** exige: estabelecimento comprador, **identificação prévia** (ou vistoria), **vendedor** (CPF/CNPJ, nome, e-mail se exigido), **data de entrada**, **valor**, título "compra", **NF-e** (número e chave) e **data do reconhecimento de firma ou data/hora da assinatura eletrônica avançada/qualificada do vendedor**. | 🔴 | RES art. 15 |
| RN-ENT-01a | O payload do RENAVE-WS para entrada (`POST /api/solicitacoes-entrada-estoque`) exige: `cpfOperadorResponsavel`, `dataCompra`, `valorCompra`, `emailVendedor`, `emailEstabelecimento` e o veículo com `placa`, `codigoSegurancaCrv`, `tipoCrv` (AZUL / VERDE / BRANCO / DIGITAL), `numeroCrv`, `documentoProprietarioAtual` e seu tipo (CPF/CNPJ), `quilometragemHodometro` e `dataHoraMedicaoHodometro`. O operador logado precisa ter **CPF cadastrado**. | 🔴 | MAN |
| RN-ENT-01b | O **vendedor** deve ser o **proprietário que consta no CRV**, e o estabelecimento **não pode** ser o proprietário atual (nesse caso usa-se "entrada de veículo próprio"). | 🔴 | MAN |
| RN-ENT-01c | O **e-mail do estabelecimento** é cadastrado uma vez e enviado sempre igual. Se já houver uma intenção de venda ("2 — Venda Comunicada"), valor e e-mails devem **coincidir** com ela. | 🔴 | MAN |
| RN-ENT-01d | A assinatura do vendedor no ATPV é enviada num de quatro formatos: foto do ATPV papel-moeda assinado de próprio punho; foto do ATPV-e assinado de próprio punho; P7S qualificado sobre a foto; ou **P7S qualificado sobre o XML do ATPV-e**, assinando **exatamente os bytes** retornados pelo RENAVE. A assinatura **avançada gov.br** (contas prata/ouro) é feita pela CDT e dispensa o envio. Um novo envio sobrescreve o anterior até o DETRAN iniciar a transferência. Veículo próprio **não** precisa de assinatura. | 🔴 | MAN |
| RN-ENT-01e | O RENAVE pede **consentimento ao DETRAN**. Se a comunicação com o DETRAN falhar (`comunicacaoComDetranFalhou`), a operação fica **"Aguardando DETRAN"** e é refeita automaticamente mais tarde. | 🟠 | MAN |
| RN-ENT-02 | Na compra de usado, o estabelecimento deve **emitir NF-e de compra** e **assinar a ATPV-e**. | 🔴 | RES art. 14 |
| RN-ENT-03 | **Entrada de veículo próprio** exige: estabelecimento proprietário, identificação prévia, data, valor e título "entrada em estoque de veículo próprio". Não exige vendedor. | 🔴 | RES art. 16 |
| RN-ENT-04 | A identificação prévia pode ser **substituída por vistoria veicular**, a critério do estabelecimento. A escolha e as evidências são registradas. | 🔵 | RES art. 15 par. único, 16 |
| RN-ENT-05 | A **data de entrada** não pode ser futura e não pode ser anterior à data da ATPV-e/assinatura do vendedor. | 🔴 | PROD |
| RN-ENT-06 | O **valor** deve ser maior que zero e **coerente com a NF-e** (tolerância zero, salvo regra MAN diferente). | 🔴 | RES art. 5º VI, PROD |
| RN-ENT-07 | O CNPJ do **destinatário/emitente da NF-e** deve coincidir com o estabelecimento da operação, e o veículo da NF-e (chassi) com o veículo da operação. | 🔴 | GUIA |
| RN-ENT-08 | Se o **termo de entrega para entrada** for usado, ele só é válido com **assinatura eletrônica do proprietário**. O sistema acompanha o status. | 🔴 | RES art. 2º XI |
| RN-ENT-09 | O **prazo interno** para concluir a entrada após o recebimento físico é configurável e gera pendência ao vencer *(padrão: D+1 útil; ajustar ao prazo do MAN/DETRAN)*, porque atraso na escrituração é infração gravíssima. | 🟠 | RES art. 25 |

## 4.6 Saída de usado (SAI)

| ID | Regra | Sev. | Origem |
|---|---|---|---|
| RN-SAI-01 | A saída de usado exige: estabelecimento vendedor, veículo com **nº do CRV e código de segurança**, **comprador**, **data de saída**, **valor**, título e **NF-e de saída** (número e chave). | 🔴 | RES art. 18 |
| RN-SAI-02 | Só sai veículo cujo estoque está **CONFIRMADO** (pelo DETRAN) no estabelecimento, sem impedimento incompatível. | 🔴 | GUIA, MAN |
| RN-SAI-03 | Antes da saída, valida-se que as **exigências de entrada** estão completas: **NF-e de entrada enviada** e **assinatura do vendedor enviada** (exceto veículo próprio). | 🔴 | GUIA, MAN |
| RN-SAI-03a | O **comprador** exige: tipo e número de documento, nome, e-mail e **endereço completo** (CEP, logradouro, número, bairro, **código de município RENAVE** obtido de `/api/municipios`). | 🔴 | MAN |
| RN-SAI-03b | NF-e: na **entrada**, o emitente é o estabelecimento (ou matriz/filial) e o destinatário é o vendedor, ou, se a NF é de saída do vendedor, o inverso. Na **saída**, o emitente é o estabelecimento ou a matriz e o destinatário é o comprador. O RENAVE valida **só a chave** contra o SPED, e a chave pode ser alterada depois. Não se envia NF quando a saída é para o próprio estabelecimento. | 🔴 | MAN |
| RN-SAI-04 | Comprador é quem consta como **destinatário** da venda, independentemente da transferência de propriedade. | 🔵 | RES art. 18 §1º |
| RN-SAI-05 | A venda se formaliza com **NF-e de saída + ATPV-e assinada eletronicamente**. Até a ATPV-e ser assinada, a operação fica em "Aguardando assinatura". | 🔴 | RES art. 18 §2º |
| RN-SAI-06 | O estoque local é baixado **somente após confirmação** do RENAVE (RN-GER-05). | 🔴 | GUIA |
| RN-SAI-07 | Quando o RENAVE informar a **expedição de novo CRV** em nome do comprador, isso é registrado no veículo e notificado. | 🔵 | RES art. 18 §4º |
| RN-SAI-08 | Se o **termo de entrega para saída** for usado, ele exige assinatura eletrônica do proprietário e os dados do comprador. | 🔴 | RES art. 2º XII |
| RN-SAI-09 | A data de saída deve ser maior ou igual à data de entrada e não pode ser futura. | 🔴 | PROD |

## 4.7 Zero km (0KM)

| ID | Regra | Sev. | Origem |
|---|---|---|---|
| RN-0KM-01 | O 0 km só pode entrar no estoque de quem consta como **faturado** no **pré-cadastro** do Renavam (montadora, importadora ou RFB). | 🔴 | RES art. 12 §1º |
| RN-0KM-02 | A entrada do 0 km exige **identificação prévia**, que pode ser substituída por vistoria. | 🔴 | RES art. 12 §2º, §3º |
| RN-0KM-03 | Sem entrada no Renave, o 0 km **não pode ser registrado, licenciado nem emplacado**. O sistema destaca 0 km faturados ainda **sem entrada**. | 🔴 | RES art. 7º §2º |
| RN-0KM-04 | A saída de 0 km exige: vendedor, veículo, comprador, data, valor, título e NF-e **integrada e sincronizada**. | 🔴 | RES art. 13 |
| RN-0KM-05 | **Entrada em lote** é permitida, mas cada veículo é uma operação independente, com idempotência própria e resultado individual. | 🔴 | PROD |
| RN-0KM-06 | **Venda direta** de montadora, indicação de gestor/entregador, **entrega** e **cancelamentos** seguem as janelas e regras do MAN. O sistema só mostra a ação de cancelar **dentro da janela permitida**. | 🔴 | GUIA, MAN |
| RN-0KM-07 | Benefício tributário na saída é um enum do MAN: `NAO_TEM`, `NAO_TRATADO_PELO_RENAVE`, `PJ` (1 ano), `PCD_ICMS_IPI` (4 anos), `PCD_IPI` (2 anos), `TAXI` (2 anos), `TAXI_COM_DESCONTO_IOF` (3 anos), `PRODUTOR_RURAL` (1 ano). O sistema mostra o prazo de restrição associado. | 🟠 | MAN |
| RN-0KM-08 | **Hodômetro** e data/hora da medição são **obrigatórios** na entrada de 0 km (informar 0 se zerado). | 🔴 | MAN |
| RN-0KM-09 | A saída de 0 km exige **montagem acabada**. O **inacabado** sai sem comunicação Renave e sem ATPV-e. Em leasing de inacabado, o comprador é a instituição financeira. | 🔴 | MAN |
| RN-0KM-10 | Saídas com benefício **Renovar** (`…-renovar`) exigem a ciência expressa do estabelecimento (`estabelecimentoCienteDeResponsabilidadeSobreProcessoRenovar`), a lista de veículos a baixar, e **não** podem ser canceladas. A UI pede confirmação reforçada. | 🔴 | MAN |
| RN-0KM-11 | **Devolução à montadora** e **rejeição de 0 km** (com o cancelamento da rejeição) são operações próprias do RENAVE e aparecem como ações contextuais na aba Zero km. | 🔴 | MAN |
| RN-0KM-12 | Na **entrega indicada** pela montadora (venda direta), a concessionária vendedora é obrigatória e a entregadora é facultativa. A concessionária registra a **realização** ou o **cancelamento** da entrega. | 🔴 | MAN |

## 4.8 ITE e inacabados (ITE)

| ID | Regra | Sev. | Origem |
|---|---|---|---|
| RN-ITE-01 | O veículo **inacabado** tem o tipo de montagem e a fase industrial identificados. | 🔴 | GUIA |
| RN-ITE-02 | A **transferência para ITE** exige autorização do remetente e **aceite** da ITE. A autorização pode ser cancelada até o aceite. | 🔴 | GUIA, MAN |
| RN-ITE-03 | A **transformação/conclusão** registra dados técnicos, evidências e o novo estado ("acabado"), e libera saída e emplacamento. | 🔴 | GUIA |

## 4.9 Transferência entre estabelecimentos (TRF)

| ID | Regra | Sev. | Origem |
|---|---|---|---|
| RN-TRF-01 | Só ocorre entre estabelecimentos **aderidos** ao Renave. O sistema checa a adesão do destino antes de solicitar. | 🔴 | RES art. 19 §1º |
| RN-TRF-02 | É solicitada **pelo vendedor**, com identificação prévia, comprador, data, valor, título e NF-e. | 🔴 | RES art. 19 |
| RN-TRF-03 | É **concluída somente após a confirmação** do estabelecimento comprador. Até lá, o veículo fica "Em transferência" e **não pode** ser vendido nem transferido de novo. | 🔴 | RES art. 19 §2º |
| RN-TRF-04 | O comprador pode substituir a identificação prévia por **vistoria**. | 🔵 | RES art. 19 §4º |
| RN-TRF-05 | A **transferência entre filiais** do mesmo grupo tem tratamento próprio quando previsto no MAN e mostra as duas pontas no mesmo painel. | 🔵 | GUIA |
| RN-TRF-06 | Transferência não aceita no **prazo interno** configurável vira pendência para as duas pontas. | 🟠 | PROD |
| RN-TRF-07 | A **autorização de transferência** pode ser cancelada pelo remetente **antes do aceite**. | 🔴 | GUIA, MAN |
| RN-TRF-08 | Fluxo técnico (usados): a **origem autoriza** (`POST /api/autorizacoes-transferencias`, com CNPJ destino, placa e valor) e o **destino consome** a autorização (`POST /api/solicitacoes-transferencia-entre-estabelecimentos`, com hodômetro e data). A UI apresenta isso como "Enviar transferência" e "Aceitar transferência". | 🔴 | MAN |
| RN-TRF-09 | Entre **filiais** (mesma raiz de CNPJ), usa-se `POST /api/solicitacoes-transferencia-entre-filiais`: **não exige** autorização nem consentimento do DETRAN, e o estoque já nasce **CONFIRMADO**. | 🔵 | MAN |

## 4.10 Consignação (CON)

| ID | Regra | Sev. | Origem |
|---|---|---|---|
| RN-CON-01 | **Nenhuma venda ou intermediação** de veículo consignado sem **contrato eletrônico de consignação registrado** previamente no Renave. | 🔴 | RES art. 20 §1º |
| RN-CON-02 | O contrato segue o **modelo padrão** da SENATRAN (cláusulas fixas + campos parametrizáveis). O sistema não permite editar as cláusulas fixas. | 🔴 | RES art. 20 §3º |
| RN-CON-03 | Assinaturas: **estabelecimento** com e-CNPJ; consignante **PJ** com e-CNPJ; consignante **PF** com assinatura eletrônica **avançada ou qualificada**. | 🔴 | RES art. 20 §2º |
| RN-CON-04 | O estabelecimento é **responsável pelas infrações de trânsito** do período de consignação. O sistema registra a data de início (posse) e de fim. | 🔵 | RES art. 20 caput |
| RN-CON-05 | Validado o contrato e iniciada a venda, o veículo fica em **"Consignado em processo de transferência"**. | 🔵 | RES art. 20 §4º |
| RN-CON-06 | Iniciada a venda, o **consignante tem 30 dias** para assinar a ATPV-e. O sistema mostra contagem regressiva e alerta em D-10, D-5 e D-1. | 🟠 | RES art. 20 §7º |
| RN-CON-07 | Sem assinatura em 30 dias, ou com cancelamento pelo consignante, a **venda é cancelada** e a anotação é baixada. Restrições de financiamento permanecem até a restituição à credora. | 🔴 | RES art. 20 §7º |
| RN-CON-08 | **Qualquer parte** pode cancelar o contrato **antes da assinatura da ATPV-e** e, se houver financiamento com alienação fiduciária, **antes da formalização do financiamento**. Depois disso, a ação **não aparece**. | 🔴 | RES art. 20 §8º |
| RN-CON-09 | Cancelado o contrato, o sistema **exige** a NF-e de **devolução de mercadoria em consignação** e o **registro de saída**, e notifica simultaneamente estabelecimento, consignante e credora (se houver). | 🔴 | RES art. 20 §9º, §10 |
| RN-CON-10 | Em falência do estabelecimento, os consignados **não integram a massa falida**: os contratos são cancelados e a posse é restituída. | 🔴 | RES art. 21 §1º |

## 4.11 Retomados — instituições credoras (RET)

| ID | Regra | Sev. | Origem |
|---|---|---|---|
| RN-RET-01 | Só se aplica se a **instituição credora aderiu** ao Renave. | 🔴 | RES art. 17 §1º |
| RN-RET-02 | Exige: credora detentora da propriedade consolidada, identificação prévia, **NSU** da execução extrajudicial **ou** nº do processo judicial/registro em cartório de RTD, data, valor e título "veículo retomado". | 🔴 | RES art. 17 |
| RN-RET-03 | Na execução extrajudicial integrada ao subsistema da SENATRAN, a identificação prévia pode ser substituída pelo **Auto de Apreensão Extrajudicial** ou pelo **Termo de Entrega/Disponibilização Voluntária**. | 🔵 | RES art. 17 §2º |
| RN-RET-04 | Retomados exigem **evidências reforçadas** (documento de origem anexado, hash, responsável) e auditoria com retenção ampliada. | 🔴 | GUIA |
| RN-RET-05 | A credora consulta a situação dos veículos vinculados ao seu contrato de garantia, conforme as regras de acesso e sigilo. | 🔵 | RES art. 24 |

## 4.12 Documentos e fiscal (DOC)

| ID | Regra | Sev. | Origem |
|---|---|---|---|
| RN-DOC-01 | A **chave de acesso da NF-e** tem 44 dígitos com DV válido (módulo 11). O CNPJ embutido na chave deve corresponder à parte esperada (emitente). | 🔴 | PROD |
| RN-DOC-02 | A NF-e deve ser **emitida de forma integrada e sincronizada** com o registro. O sistema bloqueia operação com NF-e cancelada, denegada ou não autorizada, quando essa consulta estiver disponível. | 🔴 | RES art. 13 VII, 15 VII, 18 VII |
| RN-DOC-03 | A NF-e é **artefato da operação**, não só do veículo. Uma NF-e não pode ser reutilizada em duas operações. | 🔴 | GUIA |
| RN-DOC-04 | Todo documento guardado tem **SHA-256**, tamanho, MIME, origem, versão e data. Uma nova versão **não sobrescreve** a anterior. | 🔴 | GUIA, ANEXO |
| RN-DOC-05 | **CRLV-e** só é baixado conforme as permissões e regras vigentes, com **trilha de acesso** (quem baixou e quando). | 🔴 | GUIA |
| RN-DOC-06 | O status de assinatura da **ATPV-e** (pendente, assinada pelo vendedor, assinada pelo comprador, cancelada) é acompanhado por eventos, com data e hora. | 🔴 | GUIA |
| RN-DOC-07 | O **dossiê da operação** reúne dados, documentos, eventos, respostas RENAVE (por hash) e trilha. É gerado de forma **determinística**, assinado e verificável. | 🔴 | GUIA, PROD |
| RN-DOC-08 | Documentos com dados pessoais seguem as regras de minimização e retenção (mínimo de **5 anos** para evidências de escrituração). | 🔴 | ANEXO |

## 4.13 Pendências e restrições (PEN)

| ID | Regra | Sev. | Origem |
|---|---|---|---|
| RN-PEN-01 | Toda condição que impede ou atrasa uma operação vira uma **pendência**: categoria, causa, impacto, **próxima ação**, responsável, prazo e risco. | 🔴 | GUIA |
| RN-PEN-02 | Categorias: **Fiscal** (NF-e ausente ou rejeitada), **Documental** (ATPV-e ou assinatura pendente), **DETRAN** (consentimento ou retorno estadual), **Restrição** (judicial, administrativa, débito), **Certificado** (expirando ou inválido), **Divergência** (local ≠ RENAVE), **Resultado incerto** e **Prazo** (escrituração em risco). | 🔵 | GUIA |
| RN-PEN-03 | A **prioridade** vem de risco regulatório × prazo × valor. Pendências de **prazo de escrituração** e **resultado incerto** sempre ficam no topo. | 🔵 | PROD |
| RN-PEN-04 | Pendência fiscal **bloqueia a etapa dependente** até a correção e revalidação. | 🔴 | GUIA |
| RN-PEN-05 | Uma pendência é **resolvida automaticamente** quando a condição deixa de existir (reavaliação de regra), com evento de auditoria. | 🔵 | PROD |
| RN-PEN-06 | Pendência **descartada manualmente** exige justificativa e perfil autorizado. | 🟠 | PROD |
| RN-PEN-07 | Atrasos causados por terceiros (SERPRO indisponível, DETRAN sem retorno) são marcados com **evidência da causa externa**, para defesa da integradora e do estabelecimento (RES art. 25 §2º). | 🔴 | RES art. 25 |

## 4.14 Resiliência, idempotência e reconciliação (REC)

| ID | Regra | Sev. | Origem |
|---|---|---|---|
| RN-REC-01 | Toda operação mutável tem `operation_id` e **chave de idempotência**, gerados e **persistidos antes** da chamada externa. | 🔴 | GUIA |
| RN-REC-02 | O estado **"Enviado"** é persistido **antes** do envio (padrão outbox). | 🔴 | GUIA |
| RN-REC-03 | Em **timeout, queda de conexão ou 500/5xx**, o resultado é **"Resultado incerto"** e uma **reconciliação** é disparada antes de qualquer reenvio (`GET /api/estoques?placa=…` / `GET /api/estoques/{id}`). Se o estado RENAVE mostrar a operação aplicada, ela é confirmada **sem reenvio**. | 🔴 | GUIA, MAN |
| RN-REC-04 | Se a reconciliação mostrar que a operação **não** foi aplicada, o reenvio é feito com **payload byte a byte idêntico** (o RENAVE converge reenvios idênticos). Também há retry automático para falha local antes do envio e para 503/429 com backoff exponencial e jitter. **Nunca** se reenvia com dados alterados sem nova operação. | 🔴 | GUIA, MAN |
| RN-REC-04a | **Timeouts** do conector: **120 s para POST** e **60 s para GET** (recomendação do manual). A UI nunca espera a chamada: a operação é assíncrona e a tela acompanha o estado. | 🔴 | MAN |
| RN-REC-05 | **400** (requisição inválida, normalmente bug do integrador) gera alerta técnico para a integradora. **422** (erro de negócio) vira pendência com a `mensagemParaUsuarioFinal` mostrada ao operador. Nenhum dos dois é repetido. | 🔴 | GUIA, MAN |
| RN-REC-05a | Toda resposta de erro guarda **integralmente** `titulo`, `dataHora`, `detalhe`, `mensagemParaUsuarioFinal` e `logIdRastreabilidade`. Para 500, o `logIdRastreabilidade` e a data/hora vão automaticamente para o chamado ao SERPRO. | 🔴 | MAN |
| RN-REC-06 | **Reconciliação periódica** (padrão: diária e sob demanda) compara estoque, NF-e, documentos, transferências e certificados. Cada divergência vira um `reconciliation_issue`. | 🔴 | GUIA |
| RN-REC-07 | Com divergência aberta para o veículo, novas operações sobre ele ficam **bloqueadas** até a resolução ("bloquear repetição cega"). | 🔴 | GUIA |
| RN-REC-08 | O `correlation_id` é propagado em logs, filas, chamadas externas e webhooks. | 🔴 | GUIA |
| RN-REC-09 | O **cancelamento** de uma operação só é oferecido quando permitido pelo RENAVE (tipo e janela) e gera uma **nova operação** de cancelamento, sem apagar a original. | 🔴 | GUIA, MAN |
| RN-REC-10 | **Cancelar entrada** só é possível com o estoque no estado **SOLICITADO**. Depois de CONFIRMADO, a saída do veículo é feita por saída de estoque. O cancelamento anula a intenção de venda, e a ATPV-e já assinada perde o valor (o usuário é avisado). | 🔴 | MAN |
| RN-REC-11 | **Cancelar saída** é exceção e só é possível enquanto o DETRAN **não** transferiu o veículo. Ela recria o estoque como CONFIRMADO. Saídas com benefício **Renovar** **não** podem ser canceladas. | 🔴 | MAN |
| RN-REC-12 | O estado local mapeia os estados do RENAVE: `SOLICITADO` → "Aguardando DETRAN/confirmação"; `CONFIRMADO` → "Em estoque"; `TRANSFERIDO` → "Transferido"; `FINALIZADO` → "Baixado". Qualquer divergência entre os dois estados gera `reconciliation_issue`. | 🔴 | MAN |

## 4.15 Auditoria (AUD)

| ID | Regra | Sev. | Origem |
|---|---|---|---|
| RN-AUD-01 | Toda ação sensível gera **evento imutável** com: `event_id`, tenant e estabelecimento, ator (usuário ou serviço), **IP de origem**, `operation_id`, veículo, ação, certificado usado (identificador), **timestamp sincronizado com a Hora Legal Brasileira**, **hash de request e response**, resultado (success / business_error / technical_error) e `correlation_id`. | 🔴 | ANEXO, GUIA |
| RN-AUD-02 | Os eventos formam uma **cadeia de hash** por tenant. Qualquer alteração quebra a cadeia, o que é verificável por rotina diária e sob demanda. | 🔴 | ANEXO |
| RN-AUD-03 | Os **dados de entrada e saída** de cada chamada ao RENAVE ficam guardados (payload cifrado e/ou por referência com hash) por **no mínimo 5 anos** e ficam disponíveis aos órgãos de trânsito. | 🔴 | ANEXO |
| RN-AUD-04 | Alterações de cadastro registram **antes/depois**. | 🔴 | GUIA |
| RN-AUD-05 | Exportações de auditoria e de dados pessoais exigem perfil autorizado, motivo e geram evento próprio. | 🔴 | GUIA, LGPD |
| RN-AUD-06 | Leitura de dados sensíveis (CRLV-e, documentos de partes) também é auditada. | 🔴 | GUIA |

## 4.16 Integrações (INT)

| ID | Regra | Sev. | Origem |
|---|---|---|---|
| RN-INT-01 | A API externa é **versionada** (`/v1`), autenticada por cliente com **escopos**, **quota/rate limit** por cliente e `Idempotency-Key` **obrigatória** em mutações. | 🔴 | GUIA |
| RN-INT-02 | A mesma `Idempotency-Key` com **payload diferente** gera erro 422 (conflito de idempotência). Com payload igual, devolve a **mesma resposta**. | 🔴 | PROD |
| RN-INT-03 | Webhooks são **assinados** (HMAC-SHA256 com timestamp), **reentregáveis** com backoff (até 24h), **idempotentes** (`event_id`) e ordenados por veículo quando possível. | 🔴 | GUIA |
| RN-INT-04 | Após N falhas consecutivas *(padrão: 20)*, o endpoint de webhook é **pausado** e o administrador é notificado. | 🟠 | PROD |
| RN-INT-05 | Dados importados do ERP (NF-e, veículos) passam pelas **mesmas validações** da UI. | 🔴 | PROD |

## 4.17 Preço e cobrança (COB)

| ID | Regra | Sev. | Origem |
|---|---|---|---|
| RN-COB-01 | Os valores cobrados pelos serviços RENAVE respeitam a **faixa mínima e máxima** da SENATRAN. O sistema impede configurar preço fora da faixa vigente. | 🔴 | RES art. 32 |
| RN-COB-02 | O acesso ao RENAVE **não pode** ser condicionado à contratação de outros serviços. A ViaAuto não tem planos, mensalidade nem add-ons: cobra **por registro RENAVE confirmado**. | 🔴 | RES art. 32 §3º, PROD |
| RN-COB-03 | A tabela de preços vigente fica **publicada** e acessível antes da contratação. | 🔴 | RES art. 32 §4º |
| RN-COB-04 | O uso é medido por operação, estabelecimento e mês, com relatório para o cliente. Os repasses ao SERPRO/SENATRAN, quando houver, são conciliados. | 🔵 | PROD |
