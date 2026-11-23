# 00 — Sumário executivo

**Projeto:** **ViaAuto** — *O caminho simples para sua operação veicular.* Plataforma SaaS de integração, operação, compliance e auditoria do RENAVE
**Versão do documento:** 1.0 · **Data:** 23/11/2026
**Base:** Res. CONTRAN nº 1.026/2026 (leitura integral), manual e Swagger do RENAVE-WS (produção e homologação), Central de Ajuda SERPRO, Guia RENAVE 2026 e análise de 6 projetos internos.

---

## O problema

Desde 30/06/2026, o **RENAVE é o único meio** de escriturar entradas e saídas de veículos em estoque (Res. 1.026, art. 1º). **Todas** as operações passam obrigatoriamente por uma **integradora autorizada** pela SENATRAN (art. 5º III). Atraso ou falha de escrituração gera **multa gravíssima**, e a integradora responde **solidariamente** quando a falha é dela (art. 25 §2º). Além disso, o financiamento ao lojista passou a depender de o veículo estar no estoque Renave (art. 34).

## A solução

Uma plataforma SaaS multi-tenant que:
1. Transforma as regras da norma e do manual em **jornadas simples** (dar entrada, vender, transferir, consignar).
2. **Orquestra** as chamadas ao RENAVE-WS com mTLS ICP-Brasil, idempotência e reconciliação, **sem duplicar e sem perder**.
3. Mantém uma **fila de pendências** que responde "o que resolver agora?".
4. Guarda **prova de tudo**: trilha imutável com cadeia de hash, Hora Legal Brasileira e dossiê verificável.
5. Integra ERPs e DMS por **API e webhooks**. Esse é o canal mais promissor, porque os fornecedores de DMS **estão proibidos** de ser integradoras.

## Achados que mudam o jogo

| # | Achado | Consequência |
|---|---|---|
| 1 | Para ser **integradora autorizada**, a empresa precisa de capital mínimo de **R$ 1 mi**, **ISO 27001 até 27/03/2027**, RTO ≤ 4 h, log imutável por 5 anos, datacenter no Brasil, programa de integridade e suporte ampliado | Decisão estratégica imediata: integradora própria (A), parceria (B) ou A+B |
| 2 | **Fornecedores de DMS/ERP de loja**, plataformas de assinatura e de transferência eletrônica, leiloeiros, bancos e seguradoras **não podem** ser integradoras | Posicionar o produto como integrador **puro**; exige parecer jurídico sobre o portfólio do grupo. Ao mesmo tempo, cria um **canal de parceria** com os DMS |
| 3 | O prazo de adequação de 90 dias **venceu em 28/09/2026**. Fontes de terceiros indicam controle de conformidade a partir de **20/11/2026** | Urgência comercial; Fase 0 imediata |
| 4 | A **API do RENAVE ainda não implementa** identificação prévia, estoque vinculado, retomados, termos de entrega e o contrato de consignação (este último só em homologação) | Arquitetura com adapters e feature flags por vigência |
| 5 | A API **não tem versionamento** e campos podem ser removidos "sem aviso" | Testes de contrato diários contra o Swagger |
| 6 | O preço será limitado a uma **faixa definida pela SENATRAN** e o acesso não pode ser condicionado a outros serviços | Módulo RENAVE contratável isoladamente, com preço público |

## Reuso dos projetos existentes

Cerca de **50% do esforço de engenharia** pode ser economizado reaproveitando:
- **detran_gateway:** conector com taxonomia de falhas, desfecho conhecido × desconhecido, Idempotency-Key e testes.
- **despachante:** camada SaaS com tenancy, sessões, 2FA, RBAC, webhooks HMAC, S3 e cifra at-rest.
- **plataforma-harmonizacao-normativa:** RLS, triggers imutáveis, cadeia de hash, motor de regras, dossiê assinado, CNPJ alfanumérico e design system acessível.
- **backend_patio:** domínio veicular e utilitários BR, pendências, vistoria com fotos geolocalizadas e outbox.
- **kitara:** credenciamento como máquina de estados.

**Não existem** em nenhum projeto, e serão construídos do zero: **mTLS ICP-Brasil com chave em HSM**, fila durável, hash de documentos e OpenTelemetry. Detalhes em `02-analise-de-reuso.md`.

## Escopo e entregas

- **20 módulos** e **168 requisitos funcionais** com prioridade, fase e rastreabilidade (`05`).
- **146 regras de negócio** com origem normativa (artigo da Resolução ou seção do manual) e severidade (`04`).
- **69 requisitos não funcionais**, incluindo todos os do Anexo da Resolução (`06`).
- Catálogo de **todas as operações do RENAVE-WS** mapeadas para ações de negócio (`07`).
- **Protótipo com 34 telas** (incluindo backoffice do SaaS e conta do cliente) em design "Clean Operacional" (`08`): https://claude.ai/artifact/HdnUJ7n2pbz9pZY9hD71gN

## Roadmap resumido

F0 Discovery (2–3 sem.) → F1 Fundação (6–7) → **F2 Usados MVP (6–8, piloto)** → F3 Resiliência e ERP (6) → F4 Zero km (4–5) → F5 ITE (4) → F6 Consignação e retomados (6–8, depende do SERPRO) → F7 Inteligência.

Em paralelo, na rota A: **SGSI/ISO 27001 até 27/03/2027** e autorização na SENATRAN.

## Decisões pedidas ao patrocinador

1. **Modelo de mercado** (A, B ou A+B). Recomendação: **A+B**.
2. **Parecer jurídico** sobre as vedações do Anexo diante do portfólio atual (despachante, pátio, ERP).
3. Iniciar **imediatamente** o projeto de ISO 27001 (se A).
4. Nuvem com **região Brasil e HSM gerenciado**.
5. Nome e marca do produto.
