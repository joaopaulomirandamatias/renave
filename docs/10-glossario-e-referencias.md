# 10 — Glossário e referências

## 10.1 Glossário

| Termo | Definição |
|---|---|
| **RENAVE** | Registro Nacional de Veículos em Estoque: subsistema do Renavam para a escrituração eletrônica de entrada e saída de veículos (Res. CONTRAN 1.026/2026) |
| **RENAVE-WS** | WebService do RENAVE, operado pelo SERPRO (REST, Swagger 2.0, mTLS) |
| **Renavam** | Registro Nacional de Veículos Automotores |
| **SENATRAN** | Secretaria Nacional de Trânsito, o "órgão máximo executivo de trânsito da União" |
| **SERPRO** | Serviço Federal de Processamento de Dados, operador técnico do RENAVE |
| **DETRAN** | Departamento Estadual de Trânsito, órgão executivo de trânsito estadual |
| **Credencia** | Sistema da SENATRAN para adesão de estabelecimentos, autorização de integradoras e habilitação de certificados |
| **Estabelecimento** | PJ que compra e vende, desmonta, reforma ou recupera veículos (art. 330 do CTB) |
| **Integradora** | PJ autorizada pela SENATRAN que desenvolve e opera o sistema de integração |
| **Sistema de integração** | Sistema privado, homologado, que se comunica com o RENAVE em nome do estabelecimento |
| **ITE** | Implementadora, Transformadora ou Encarroçadora |
| **Inacabado** | Veículo 0 km ainda sem a montagem final (complementação/transformação por ITE) |
| **Pré-cadastro** | Registro inicial do 0 km no Renavam, feito pelo fabricante, importador ou RFB, com o "faturado" |
| **Aptidão** | Diagnóstico do RENAVE sobre a possibilidade de entrada ou saída do veículo |
| **Identificação prévia de entrada** | Validação eletrônica da identificação do veículo antes da entrada; substituível por vistoria |
| **ATPV / ATPV-e** | Autorização para Transferência de Propriedade do Veículo (papel-moeda / eletrônica) |
| **CRV** | Certificado de Registro de Veículo (tipos: azul, verde, branco, digital) |
| **Código de segurança do CRV** | Código exigido para operações sobre o veículo |
| **CRLV-e** | Certificado de Registro e Licenciamento de Veículo eletrônico |
| **NF-e** | Nota Fiscal eletrônica; chave de acesso de 44 dígitos |
| **SPED** | Sistema Público de Escrituração Digital |
| **Título do negócio jurídico** | Natureza da movimentação: compra, venda, transferência, consignação, garantia, veículo próprio, retomado |
| **Estoque vinculado** | Veículo em estoque com pendência, restrição ou débito superveniente, ou retomado |
| **Consignação** | Entrega do veículo ao estabelecimento para venda, sem transferência de propriedade, por contrato eletrônico |
| **Retomado** | Veículo com propriedade consolidada pela instituição credora (execução de garantia) |
| **NSU** | Número Sequencial Único da execução extrajudicial |
| **Renovar** | Programa ou benefício cuja saída no RENAVE tem endpoint próprio e não pode ser cancelada |
| **e-CNPJ / ICP-Brasil** | Certificado digital de pessoa jurídica da Infraestrutura de Chaves Públicas Brasileira |
| **mTLS** | TLS com autenticação mútua por certificado |
| **KMS / HSM** | Key Management Service / Hardware Security Module, cofres de chaves |
| **Idempotência** | Repetir uma solicitação sem causar efeito duplicado |
| **Resultado incerto** | Estado em que não se sabe se o RENAVE aplicou a operação (timeout ou 5xx) |
| **Reconciliação** | Comparação do estado local com o estado do RENAVE para detectar e resolver divergências |
| **Outbox** | Padrão em que a intenção de envio é gravada na mesma transação do estado, antes de enviar |
| **RLS** | Row-Level Security: isolamento por linha no PostgreSQL |
| **Cadeia de hash** | Encadeamento em que cada evento inclui o hash do anterior, o que torna a adulteração detectável |
| **JCS** | JSON Canonicalization Scheme (RFC 8785) |
| **Hora Legal Brasileira** | Hora oficial mantida pelo Observatório Nacional |
| **DMS** | Dealer Management System, o sistema de gestão de concessionária ou loja |
| **Tenant** | Cliente lógico isolado na plataforma SaaS |
| **Regulatory Watch** | Processo de acompanhamento de mudanças normativas e técnicas |
| **RTO / RPO** | Tempo máximo de recuperação / perda máxima de dados aceitável |

## 10.2 Referências oficiais

| ID | Fonte | URL |
|---|---|---|
| R1 | Resolução CONTRAN nº 1.026/2026 (DOU 30/06/2026, Ed. Extra, Seção 1, nº 120-C) | https://www.gov.br/transportes/pt-br/assuntos/transito/conteudo-Senatran/resolucoes-contran |
| R2 | Manual RENAVE-WS (produção) | https://renave.estaleiro.serpro.gov.br/renave-ws/manual/ |
| R3 | Manual RENAVE-WS (homologação) | https://hom.renave.estaleiro.serpro.gov.br/renave-ws/manual |
| R4 | Swagger RENAVE-WS | `/renave-ws/v2/api-docs?group=<grupo>` nas duas URLs base |
| R5 | Central de Ajuda SERPRO — RENAVE | https://centraldeajuda.serpro.gov.br/renave/ |
| R6 | Como contratar | https://centraldeajuda.serpro.gov.br/renave/institucional/como-contratar/ |
| R7 | Homologação | https://centraldeajuda.serpro.gov.br/renave/central-ajuda/homologacao/ |
| R8 | Zero km inacabado / ITE | https://centraldeajuda.serpro.gov.br/renave/central-ajuda/zero-km-inacabado/ |
| R9 | Credencia | https://credencia.estaleiro.serpro.gov.br |
| R10 | Serviço gov.br — contratar RENAVE | https://www.gov.br/pt-br/servicos (busca "Renave") |
| R11 | Código de Trânsito Brasileiro, art. 123 e art. 330 | Lei nº 9.503/1997 |
| R12 | Lei nº 14.063/2020 (assinaturas eletrônicas) | — |
| R13 | LGPD — Lei nº 13.709/2018 | — |
| R14 | Guia "Sistema RENAVE — Integração, Operação, Compliance e Auditoria" v1.0 (25/09/2026) | Documento interno de referência |
| R15 | Swagger UI RENAVE-WS (produção) | https://renave.estaleiro.serpro.gov.br/renave-ws/swagger-ui.html |
| R16 | Diagramas oficiais de fluxos e estados | https://centraldeajuda.serpro.gov.br/renave/diagramas/ |
| R17 | Central de Ajuda — Integradores | https://centraldeajuda.serpro.gov.br/renave/central-ajuda/dicas/ |

**A obter na Fase 0:** Circular SENATRAN nº 2/2026; Res. CONTRAN nº 1.027/2026; ato da SENATRAN sobre o preço público (art. 32); procedimentos de homologação de integradora (art. 3º VI); modelo padrão do contrato de consignação (art. 20 §3º); especificação da identificação prévia (art. 3º X).

> **Nota de atualização:** o RENAVE é um domínio regulatório e técnico em evolução. Antes de cada release, revisar a Resolução vigente, os atos da SENATRAN, o Credencia e o Swagger do RENAVE-WS. Este documento não substitui análise jurídica.
