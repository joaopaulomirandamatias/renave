# ViaAuto — Especificação do produto

> Plataforma de **integração, operação, compliance e auditoria** do RENAVE (Registro Nacional de Veículos em Estoque) para concessionárias, revendas, montadoras, ITEs e instituições credoras.
> *ViaAuto — O caminho simples para sua operação veicular.*

**Status:** especificação v1.0 (23/11/2026), antes do desenvolvimento.
**Base normativa:** Resolução CONTRAN nº 1.026/2026 · Manual e Swagger RENAVE-WS (SERPRO).

## 📚 Documentação

| # | Documento | Conteúdo |
|---|---|---|
| 00 | [Sumário executivo](docs/00-sumario-executivo.md) | Problema, solução, achados críticos, decisões |
| 01 | [Contexto regulatório](docs/01-contexto-regulatorio.md) | Res. 1.026/2026 artigo por artigo, requisitos da integradora, prazos, lacunas da API |
| 02 | [Análise de reuso](docs/02-analise-de-reuso.md) | O que copiar, adaptar ou usar como ideia dos projetos existentes; stack recomendada |
| 03 | [Visão de produto](docs/03-visao-de-produto.md) | Personas, perfis, módulos, escopo, jornadas, mercado, KPIs |
| 04 | [Regras de negócio](docs/04-regras-de-negocio.md) | 146 regras com origem normativa e severidade |
| 05 | [Requisitos funcionais](docs/05-requisitos-funcionais.md) | 168 requisitos por módulo (MoSCoW, fase, rastreabilidade) + histórias com Gherkin |
| 06 | [Requisitos não funcionais](docs/06-requisitos-nao-funcionais.md) | Disponibilidade, segurança, ISO 27001, auditoria, LGPD, observabilidade, UX |
| 07 | [Arquitetura e dados](docs/07-arquitetura-e-dados.md) | C4, máquina de estados, catálogo RENAVE-WS, modelo de dados, API e webhooks |
| 08 | [UX e protótipo](docs/08-ux-e-prototipo.md) | Princípios, design system, inventário de telas, microcopy |
| 09 | [Roadmap e riscos](docs/09-roadmap-riscos.md) | Fases, homologação, checklist de go-live, riscos, decisões |
| 10 | [Glossário e referências](docs/10-glossario-e-referencias.md) | Termos e fontes oficiais |
| 11 | [Modelo SaaS](docs/11-modelo-saas.md) | Operador da plataforma, ciclo de vida do cliente, cobrança por registro RENAVE, parceiros, reuso dos projetos SaaS |
| 12 | [Marca e storytelling](docs/12-marca-e-storytelling.md) | História ViaAuto, plataforma de marca, tom de voz, mensagens, diretrizes de posicionamento |

## 🎨 Protótipo

Mockups navegáveis — 34 telas + componentes, em 6 páginas (operação do cliente, compliance, gestão do SaaS, conta do cliente e mobile): https://claude.ai/artifact/HdnUJ7n2pbz9pZY9hD71gN

## 🧭 Marca

Identidade visual ViaAuto (logo em vários estilos, sistema visual, storytelling e aplicações): https://claude.ai/artifact/HTS8j4iXxAz8RbqX5eU3nZ

## ⚠️ Aviso

O RENAVE é um domínio regulatório em evolução. Antes de cada release, revisar a Resolução vigente, os atos da SENATRAN e o Swagger do RENAVE-WS. Esta especificação não substitui análise jurídica.
