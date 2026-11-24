# Seu Renave

Fundação de uma plataforma SaaS multi-tenant para operação de estoque veicular integrada ao RENAVE. O projeto está em desenvolvimento e **não é o sistema oficial do governo**.

## Estado atual

- login corporativo OIDC/BFF sem senha local, com PKCE, sessão opaca e store PostgreSQL isolado;
- PostgreSQL com RLS forçada, papéis separados para negócio/identidade e escopo por tenant;
- descoberta segura de organizações e estabelecimentos, sem expor `subject` ou roles do IdP;
- RBAC deny-by-default com autorização por estabelecimento;
- rate limit distribuído no login, com bucket global e por cliente pseudonimizado;
- gate de concorrência próprio para consulta de sessão, sem consumir o orçamento de login;
- limite distribuído de volume e concorrência nas consultas SERPRO, com leases recuperáveis;
- conector SERPRO somente em homologação, com identidade do estabelecimento e da integradora verificadas antes de cada chamada;
- preflight do vínculo SERPRO por estabelecimento sem mutação remota, com resposta pública sem CNPJ; ele registra evidência/auditoria e pode confirmar ou rejeitar o vínculo local;
- mutações e produção bloqueadas por código;
- trilha de auditoria append-only com hash encadeado e cabeça por tenant;
- evidência de consulta cifrada com AES-256-GCM e binding criptográfico ao tenant/estabelecimento;
- monitor agendável de evidências, com papel isolado, heartbeat agregado e incidentes sem alteração da prova;
- startup verifica papéis/migrations dos bancos; readiness consulta dependências reais;
- topologia de proxy explícita (`direct` ou CIDRs confiáveis), sem confiar genericamente em `X-Forwarded-For`;
- primeira consulta de aptidão autenticada pronta, mas desabilitada até receber certificado e vínculo válidos em homologação;
- monitor do contrato Swagger de produção e homologação.

O detalhamento técnico e regulatório está em [`docs/`](docs/). A situação da fundação está em [`docs/15-fundacao-de-implementacao.md`](docs/15-fundacao-de-implementacao.md).

## Requisitos locais

- Node.js 26.13.x;
- pnpm 9.15.9;
- Docker com Compose v2.

## Instalação

```bash
pnpm install --frozen-lockfile
cp .env.example .env
pnpm db:setup:local
```

O setup local do banco recusa hosts fora de loopback. As credenciais padrão do Compose são descartáveis e não devem ser reutilizadas em ambientes compartilhados.

## Desenvolvimento

```bash
pnpm dev
```

Serviços padrão:

- web/API: conforme `PORT` e configuração local;
- PostgreSQL: `127.0.0.1:54317`.

O login permanece indisponível quando `AUTH_MODE=disabled`. Não crie um login local como atalho.

## Verificações

```bash
pnpm format:check
pnpm check
pnpm test:integration
pnpm contract:serpro
pnpm smoke:serpro:hml
pnpm audit --audit-level=high
```

`pnpm test:integration` cria bancos isolados para validar RLS, papéis, diretório, evidência, limitadores e a composição real da API. Os bancos são removidos ao final. Os papéis de teste são globais no cluster local e usam valores fixos sem valor fora do ambiente de desenvolvimento.

## Limites de segurança

- nunca versione certificados ICP-Brasil, chaves privadas, cookies, tokens ou credenciais OIDC;
- não desabilite a validação TLS nem use `curl -k`/`wget --no-check-certificate`;
- o CNPJ usado no SERPRO é resolvido no servidor a partir do estabelecimento autorizado, nunca aceito do navegador como fonte de autoridade;
- timeout ou resposta inválida depois de uma mutação produz resultado incerto; não há repetição automática;
- a cadeia local de auditoria precisa de âncora ou armazenamento WORM externo antes da produção;
- a integração executável só aceita homologação e lê certificado/chave por arquivos de segredo; produção continua sem caminho PEM;
- bancos remotos em homologação/produção exigem CA explícita e TLS autenticado; URLs não controlam opções SSL;
- fornecer certificado de homologação não remove o bloqueio de produção.

## Referências oficiais

- [Central de Ajuda RENAVE](https://centraldeajuda.serpro.gov.br/renave/)
- [Manual RENAVE](https://renave.estaleiro.serpro.gov.br/renave-ws/manual/)
- [Swagger UI](https://renave.estaleiro.serpro.gov.br/renave-ws/swagger-ui.html)
- [Diagramas oficiais](https://centraldeajuda.serpro.gov.br/renave/diagramas/)
- [Orientações para integradores](https://centraldeajuda.serpro.gov.br/renave/central-ajuda/dicas/)
- [Cliente padrão de homologação](https://renave.estaleiro.serpro.gov.br/renave-ws/manual/cliente-padrao-homologacao)
- [Erros internos](https://renave.estaleiro.serpro.gov.br/renave-ws/manual/erros-internos)
- [Dicas SSL](https://renave.estaleiro.serpro.gov.br/renave-ws/manual/dicas-ssl)
