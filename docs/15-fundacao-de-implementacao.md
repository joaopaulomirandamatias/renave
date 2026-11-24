# 15 — Fundação de implementação

## Estado inicial

Em 23/11/2026, o repositório continha apenas a especificação versionada e os mockups exportados localmente. A primeira implementação cria um monorepo pnpm com API Fastify, aplicação React/Vite e um pacote de UI compartilhado.

## Decisões aplicadas

1. **Autenticação delegada a OIDC.** A aplicação não coleta senha ou TOTP. O BFF implementa Authorization Code + PKCE, valida assinatura/issuer/audience/nonce/tempo, usa sessão opaca e persiste somente hashes dos identificadores. Em produção, a API recusa iniciar sem OIDC e store PostgreSQL.
2. **Ambiente é configuração, não escolha do usuário.** Produção e homologação devem usar hosts/configurações separados. A interface apenas informa o ambiente ativo.
3. **Tokens semânticos.** Verde UI `#067A45`, azul-marinho `#0B2550` e âmbar `#F2A90C` seguem os mockups mais recentes e o doc. 12. Valores antigos em teal não são usados como ação primária.
4. **Falha fechada.** Sem configuração OIDC completa, `/api/auth/login` responde `503`; sem certificado, chave de evidência e configuração RENAVE completa, a rota de aptidão não é composta. Não existe login local temporário.
5. **Sem segredos no frontend.** Logs já removem `authorization`, cookies, senha e token. Configurações sensíveis futuras ficam no servidor.

## Fatia vertical atual

- BFF OIDC com sessão opaca e cookie `HttpOnly`, `Secure`, `SameSite=Lax` — **implementado**;
- sessão ligada ao `subject` e ao RBAC local por tenant/estabelecimento, sem confiar nos papéis do IdP — **implementado**;
- primeira consulta de aptidão autenticada, auditada e com evidência cifrada — **implementada e bloqueada por configuração até existirem credenciais reais de homologação**;
- preflight read-only do certificado/vínculo por estabelecimento, sob RBAC e limite distribuído, com evidência cifrada e sem expor CNPJ — **implementado e bloqueado pela mesma configuração segura**;
- fornecer por cofre o certificado de homologação, a chave de evidência e confirmar o vínculo da integradora — **pendente externo**;
- descoberta de tenants/estabelecimentos para a UX e rate limit distribuído no login — **implementados**;
- manter mutações indisponíveis até cofre/HSM, vínculo, outbox e âncora/WORM;
- adicionar outbox/idempotência somente quando a primeira mutação entrar no escopo.

## Controles já implementados

- API Fastify com headers defensivos, redação de autorização/cookie/senha/token e probes de saúde;
- OIDC com PKCE S256, state de uso único, binding do navegador, nonce, JWKS com rotação limitada, cookies `__Host-` e proteção CSRF por `Origin`;
- sessões OIDC em papel PostgreSQL exclusivo, anti-replay atômico, expiração ociosa/absoluta e purga limitada por lote;
- login protegido por token bucket PostgreSQL global e por cliente, usando HMAC do endereço e falha fechada antes do IdP;
- callback OIDC passa pelo mesmo limite público; `/api/session` usa um gate local separado para preservar o pool sem consumir o orçamento de login; erros de sessão/callback/logout retornam indisponibilidade controlada sem detalhes internos;
- tela de acesso sem coleta local de senha ou TOTP, com ambiente somente informativo;
- tokens oficiais da marca, foco visível e alvos interativos de no mínimo 44 px;
- `AppShell` responsivo com navegação semântica, link de salto, ambiente persistente e seletor de estabelecimento por identificador interno;
- painel autenticado isolado do fluxo público, exibindo explicitamente o bloqueio da integração até a validação do vínculo no RENAVE;
- diretório global mínimo com hash do `subject`, seleção de tenant e estabelecimentos filtrados pelo mesmo RBAC da operação;
- PostgreSQL 17.12 com papéis separados para migração e aplicação, `tenant`/`establishment` e RLS habilitada e forçada;
- contexto de tenant por transação com `set_config(..., true)`, recusando UUID inválido e consultas sem tenant;
- autorização deny-by-default por papel e estabelecimento, com vínculos OIDC armazenados no tenant e escopo de filial para operadores;
- CNPJ alfanumérico normalizado e validado em TypeScript e PostgreSQL, com unicidade por tenant;
- conector isolado por porta de transporte: antes de cada mutação, confirma `cnpj` e `cnpjIntegradora`; divergência gera erro estruturado e zero mutações;
- transporte HTTP com hosts fixos por ambiente, operações registradas e cliente mTLS obrigatoriamente injetado pelo runtime;
- consulta de aptidão por placa, RENAVAM ou CRV, com exatamente um identificador e confirmação de identidade também nas leituras;
- rota BFF usa POST local para não colocar placa em URL/log e deriva a autoridade do `subject` + RBAC local;
- consultas SERPRO usam limites de volume/concorrência global, por tenant e por operador/estabelecimento, com leases expiráveis e nenhum SQL aberto durante a chamada;
- request/response da consulta são cifrados com AES-256-GCM; AAD liga versão, key id, tenant, evidência, estabelecimento, ação e tipo;
- evidência pendente acima do SLA gera incidente operacional idempotente; o job não lê ciphertext, não apaga prova e não inventa desfecho;
- mutações sem retry cego: timeout, falha de conexão e HTTP 5xx produzem `RENAVE_MUTATION_OUTCOME_UNKNOWN` com hash dos bytes enviados;
- monitor diário do Swagger com hash global e assertions semânticas da primeira fatia;
- trilha de auditoria append-only com RLS forçada, hash encadeado serializado por tenant e verificador de adulteração;
- testes cobrindo fail-closed de autenticação, isolamento multi-tenant, escopo por estabelecimento, reuso concorrente do pool e fallback silencioso de identidade;
- bancos remotos exigem CA explícita; o startup confirma papéis mínimos e migrations, e readiness consulta os pools sem revelar a dependência indisponível;
- o contrato de runtime compara checksums das migrations e rejeita ownership ou qualquer caminho de `SET ROLE`; proxy direto/CIDRs confiáveis são configuração explícita;
- ADR 0001 consolidando o modo `INTEGRADORA` e bloqueando produção até confirmação do SERPRO.
- ADR 0002 definindo reconciliação antes de qualquer repetição de mutação.
- ADR 0003 definindo cadeia de auditoria, cabeça por tenant e necessidade de âncora/WORM externo antes da produção.
- ADR 0004 separando isolamento de tenant por RLS e autorização de estabelecimento por RBAC, com CNPJ resolvido somente no servidor.
- ADR 0005 definindo evidência cifrada, rotação de chaves e transações curtas fora da chamada de rede.

## Estado de liberação

- **Desenvolvimento local:** fundação executável e testada.
- **Homologação SERPRO:** rota de consulta pronta e fail-closed; falta fornecer certificado válido por meio seguro, provisionar chave de evidência e confirmar o vínculo de integradora. O smoke sem certificado confirma apenas o fallback do cliente-padrão e não autoriza operação.
- **Produção SERPRO:** bloqueada por código. Não há chave de configuração que contorne o bloqueio.
- **Mutações RENAVE:** bloqueadas. Identidade, evidência, monitor de pendências e reconciliação já existem; ainda faltam cofre/HSM, certificado/vínculo reais, outbox e âncora/WORM.

## Evidência adicional recebida

O PDF “RESUMO RENAVE”, criado em 28/09/2026, confirma as vedações para atuação como integradora, o patrimônio líquido/capital mínimo de R$ 1 milhão, a homologação do sistema, as regras gerais de entrada/saída e o contrato eletrônico de consignação. Por ser anterior às verificações de homologação de 23/11/2026, ele confirma a base regulatória, mas não substitui o modelo técnico do doc. 14 nem a ADR 0001.
