# ADR 0004 — Autorização por estabelecimento acima da RLS de tenant

- **Status:** aceita
- **Data:** 23/11/2026

## Contexto

Um tenant pode administrar vários estabelecimentos. A RLS do PostgreSQL garante que uma transação não leia nem escreva dados de outro tenant, mas, intencionalmente, não cria uma variável de sessão adicional para cada estabelecimento. Sem outro controle, uma sessão válida do tenant poderia operar uma filial para a qual o usuário não recebeu permissão.

O CNPJ enviado ao RENAVE determina a identidade do estabelecimento. Aceitar esse valor do navegador permitiria que uma requisição manipulada tentasse selecionar outra identidade dentro do mesmo tenant.

## Decisão

1. A RLS permanece responsável pelo isolamento entre tenants.
2. O vínculo entre `subject` OIDC, papel e estabelecimentos autorizados é armazenado no banco, sob a mesma RLS do tenant.
3. Cada caso de uso RENAVE valida, em ordem:
   - sujeito e tenant da sessão;
   - papel exigido para a ação;
   - presença do estabelecimento no escopo do papel;
   - existência, tenant e estado ativo do estabelecimento;
   - identidade devolvida pelo RENAVE (`cnpj` e `cnpjIntegradora`).
4. A entrada HTTP pode fornecer apenas o identificador interno do estabelecimento. O CNPJ é carregado pelo servidor dentro da transação do tenant.
5. Administradores do tenant recebem escopo global por papel; operadores RENAVE precisam de ao menos um estabelecimento explícito.
6. Toda consulta ou mutação RENAVE gera evidência e auditoria com tenant, estabelecimento, sujeito e hashes dos payloads. Dados operacionais sensíveis não são copiados para a trilha append-only.

## Consequências

- Uma falha de filtro no repositório continua limitada pela RLS ao tenant.
- Uma tentativa de trocar `establishmentId` na requisição é negada pelo RBAC antes de tocar no conector.
- O seletor visual de estabelecimento representa contexto, não concede permissão.
- Os casos de uso precisam usar portas server-side para autorização e estabelecimento; não podem confiar em claims arbitrárias enviados pelo frontend.
- A consistência entre grants, estabelecimento e chamada externa precisa ser coberta por testes negativos em cada nova operação.

## Alternativas rejeitadas

### RLS também por estabelecimento

Adicionar um segundo GUC e policies por estabelecimento aumentaria a defesa em profundidade, mas complicaria consultas administrativas, auditoria e operações com escopo global. A decisão pode ser revista se a superfície SQL crescer ou se processos não confiáveis passarem a compartilhar o papel de aplicação.

### CNPJ fornecido pela interface

Rejeitado porque transforma um dado controlado pelo cliente em fonte de autoridade para a identidade mTLS/RENAVE.

### Escopo somente em claims OIDC

Rejeitado como fonte única porque mudanças de acesso precisariam aguardar renovação de token e o provedor passaria a carregar detalhes operacionais mutáveis. O `subject` identifica o usuário; grants e estabelecimentos ativos permanecem no domínio da aplicação.
