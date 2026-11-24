# Proveniência de padrões reutilizados

Este repositório reaproveita padrões arquiteturais de projetos mantidos pelo mesmo proprietário, sem copiar credenciais, dados de clientes ou configurações privadas.

- `baconian`: organização do monorepo pnpm, scripts de verificação e política de Node.js.
- `plataforma-harmonizacao-normativa`: API Fastify com redação de logs, probes de saúde e tokens semânticos de design; a paleta foi substituída pela identidade oficial do Seu Renave.
- Mockups locais em `doc/Seu Renave — Mockups-project`: composição visual da tela de acesso e SVG da marca.
- `detran_gateway`: somente o conceito de classificar resultado conhecido/desconhecido e testar que uma mutação não foi duplicada. O conector deste repositório foi reimplementado sem copiar código ou dados de cliente.

O fluxo de autenticação foi deliberadamente adaptado: credenciais e MFA pertencem ao provedor OIDC, não à aplicação Seu Renave.
