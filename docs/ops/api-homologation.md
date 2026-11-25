# Operação segura da API em homologação

Este runbook prepara a API do RenavEstoque para consultas no RENAVE-WS de
homologação. Ele não autoriza produção nem mutações. O objetivo é validar cada
controle separadamente, manter o tráfego externo fechado até o último gate e
preservar uma forma rápida de interromper a integração sem derrubar o acesso
SaaS.

## Estado seguro

Sem a configuração RENAVE completa, a API continua atendendo autenticação,
diretório e recursos locais, mas não compõe preflight ou consultas SERPRO. A
ausência da integração deve aparecer como `disabled` no relatório autenticado
de prontidão; não é falha de saúde do serviço.

O CI gera um SBOM CycloneDX da imagem final da API com Syft non-root preso por
digest. O scanner recebe um `docker save` somente leitura, roda sem rede, sem
socket Docker e com capacidades removidas. Um validador local confirma formato,
raiz `container`, componentes e ausência de sentinelas antes de apagar os
artefatos temporários. Scan de CVEs, assinatura e provenance continuam gates
separados para uma futura publicação imutável; o SBOM isoladamente não autoriza
release nem deploy.

Produção e mutações SERPRO permanecem bloqueadas por código. Não crie flags,
aliases de host ou proxies para contornar esse limite. O primeiro tráfego
externo autorizado não envia mutação ao SERPRO. O preflight registra
evidência/auditoria e pode confirmar ou rejeitar o vínculo local.

## Material e configuração

O cofre entrega arquivos separados para CA, certificado e chave privada. A
chave de evidência e as chaves HMAC também vêm do cofre, nunca do repositório,
imagem, ConfigMap, argumento de processo ou log.

O processo lê esses valores exclusivamente do mount fixo
`/run/secrets/seu-renave/api/`. Fora de desenvolvimento, qualquer variável de
ambiente equivalente é recusada antes da leitura do mount. Os arquivos devem
ser regulares, `0400` ou `0440`; projeções atômicas são aceitas somente por um
único symlink `..data`, resolvido uma vez por carga para impedir mistura entre
versões.

| Arquivo | Conteúdo |
|---|---|
| `database-url` / `database-ca.pem` | DSN e CA do banco SaaS |
| `identity-database-url` / `identity-database-ca.pem` | DSN e CA do banco de identidade |
| `login-rate-limit-hmac-key` | HMAC do limite de login |
| `tenant-admin-hmac-key` | HMAC administrativo |
| `platform-reader-database-url` / `platform-reader-database-ca.pem` | DSN e CA exclusivos do leitor global `renave_platform_reader` |
| `platform-operator-hmac-key` | HMAC exclusivo de ator, ticket, trace e cursor do console global |
| `serpro-query-limit-hmac-key` | HMAC do limite de consultas SERPRO |
| `oidc-client-secret` | segredo do cliente confidencial, se houver |
| `mtls-ca.pem`, `mtls-cert.pem`, `mtls-key.pem`, `mtls-passphrase` | material mTLS; passphrase opcional |
| `evidence-keyring.json` | chave ativa e chaves históricas de evidência |

O keyring tem schema fechado e versionado. Cada ID e cada material aparecem uma
única vez; a chave ativa precisa existir na lista. Durante rotação, mantenha as
chaves históricas necessárias para autenticar evidências ainda retidas:

```json
{
  "version": 1,
  "activeKeyId": "evidence-2026-12",
  "keys": [
    { "keyId": "evidence-2026-12", "keyBase64": "BASE64_32_BYTES" },
    { "keyId": "evidence-2026-11", "keyBase64": "BASE64_32_BYTES" }
  ]
}
```

Antes de iniciar a API, verifique por controles da plataforma:

- arquivos regulares, somente leitura e acessíveis apenas pelo UID do processo;
- certificado e chave correspondentes, com EKU de cliente e validade vigente;
- CA específica do endpoint de homologação;
- banco com TLS autenticado e papel de runtime esperado;
- relógio dos nós sincronizado e monitorado;
- egress fechado para produção e para a Internet em geral.

Não imprima o conteúdo, o caminho completo ou a impressão digital do material
em evidências de mudança. Registre somente a versão lógica do Secret e o
resultado do gate.

O console global permanece desligado com `PLATFORM_CONSOLE_ENABLED=false` na
API e `VITE_PLATFORM_CONSOLE_ENABLED=false` no build web. As duas flags aceitam
somente `true` canônico e falham fechadas. Para ativá-lo, publique primeiro a
API com a capability e depois o bundle web com a apresentação; para desativar,
faça a ordem inversa. Configure `OIDC_MFA_ACCEPTED_ACR_VALUES`, force autenticação recente
com `OIDC_MAX_AUTHENTICATION_AGE_SECONDS` e limite a janela com
`PLATFORM_OPERATOR_MFA_MAX_AGE_SECONDS` (60–900 s). A API valida `auth_time` e
o issuer do ID token; criação ou toque da sessão não renovam essa prova. O
endpoint `GET /api/platform/renave-link-queue` exige o header canônico
`x-renave-reason-ticket`, envia ao banco somente HMACs e ignora roles do IdP.
Somente um grant interno ativo libera a projeção sanitizada.
Antes da leitura auditada, a instância aceita no máximo duas consultas
concorrentes e uma por ator; o banco aplica ainda uma janela distribuída de 60
segundos (30 tentativas por ator e 120 globais). Saturação retorna `429` com
`Retry-After`, e falha do limitador retorna `503` sem liberar a consulta.

## Sequência de liberação

1. Publique uma imagem imutável por digest, com SBOM, provenance, assinatura e
   scans aprovados.
2. Inicie uma instância sem configuração RENAVE e confirme `/health`,
   `/readiness` e o relatório autenticado com integração `disabled` e mutações
   `blocked`.
3. Monte os Secrets com o egress SERPRO ainda negado. Reinicie a instância para
   que o cliente mTLS carregue uma única versão coerente do material.
4. Confirme que startup, banco, validade temporal do certificado, limitador e
   cifra de evidência passam sem revelar detalhes sensíveis.
5. Libere exclusivamente
   `hom.renave.estaleiro.serpro.gov.br:443` em um controle FQDN fail-closed. Não
   use `0.0.0.0/0:443`, não permita o host de produção e não termine mTLS em
   proxy intermediário.
6. Execute uma única vez o smoke read-only de identidade. Ele pode chamar apenas
   `GET /api/cliente-autenticado`, deve manter redirect bloqueado e não pode
   imprimir CNPJ ou resposta bruta.
7. Execute o preflight pelo BFF para um estabelecimento de homologação
   autorizado. Confirme evidência cifrada, auditoria sanitizada, limite de
   consulta e vínculo `confirmed`.
8. Libere aptidão e consulta de estoque somente para vínculos aceitos pela regra
   vigente. Mutações continuam bloqueadas.

Um gate que falhar encerra a sequência. Corrija a causa e recomece a partir da
imagem e das versões de Secret registradas; não relaxe TLS, RBAC, RLS, Origin ou
rate limit para obter um resultado verde.

## Verificação sem chamada externa

Os seguintes comandos validam o código local e não autorizam tráfego SERPRO:

```bash
pnpm check
pnpm prehomologation:serpro
pnpm --filter @seu-renave/renave-connector test
pnpm --filter @seu-renave/api test
```

### Pré-validação negativa H-04 a H-07

O runner compila a aplicação e passa quatro diagnósticos brutos pelo mesmo normalizador usado pelo serviço. Assim, confirma os códigos seguros esperados sem usar `.env`, mTLS, CNPJ, placa ou RENAVAM:

| Cenário | Mock oficial a reproduzir depois em homologação | Código seguro esperado |
|---|---|---|
| H-04 | `comRouboFurto` | `THEFT_OR_ROBBERY` |
| H-05 | `comRestricaoPgfn` | `PGFN_RESTRICTION` |
| H-06 | `comPendenciaEmissaoCrv` | `CRV_ISSUANCE_PENDING` |
| H-07 | `jaBaixado` | `VEHICLE_WRITTEN_OFF` |

Para gerar evidências locais consumíveis pela CI, escolha destinos novos. O runner recusa sobrescrita, symlink de destino, opções duplicadas e o mesmo caminho para os dois formatos:

```bash
pnpm prehomologation:serpro -- \
  --json artifacts/serpro-prehomologation.json \
  --junit artifacts/serpro-prehomologation.junit.xml
```

O código de saída é `0` somente quando os quatro casos passam, `1` quando um cenário ou a publicação do relatório falha e `2` para uso inválido. Não anexe respostas brutas do SERPRO a esses relatórios. A aprovação offline prepara a cerimônia, mas não marca H-04 a H-07 como homologados externamente.

O relatório autenticado de prontidão também é local. Consultá-lo não deve
resolver DNS, abrir socket ou consumir cota SERPRO. A probe pública
`/readiness` permanece mínima e não informa qual dependência falhou.

## Smoke read-only

O smoke oficial do repositório é deliberadamente separado do startup e exige
material provisionado pelo cofre. Execute-o somente em uma janela aprovada,
com egress de homologação já validado e produção negada.

Critérios de sucesso:

- uma única requisição de identidade autenticada;
- origem de homologação e hostname verificado;
- identidade da integradora e do estabelecimento confirmadas pelo caso de uso;
- resposta integral somente na evidência cifrada;
- saída operacional sem CNPJ, PEM, token, cookie, fingerprint ou texto externo.

Falha não autoriza repetição em loop. Classifique a causa entre configuração,
certificado, vínculo, limite, rede ou contrato e preserve a evidência da
tentativa.

## Cerimônia do canário somente leitura (GET)

Antes de autorizar qualquer mutação (`POST`) em homologação, execute e registre
esta cerimônia estritamente somente leitura nesta ordem:

1. **Pré-validação offline negativa (H-04 a H-07):** execute
   `pnpm prehomologation:serpro` (com `--json` e `--junit` em caminhos novos
   quando gerar artefatos de CI) e confirme código de saída `0`. Este passo não
   abre rede nem exige credenciais.
2. **Smoke read-only de identidade:** em janela aprovada, com egress de
   homologação liberado e produção negada, execute uma única vez
   `pnpm smoke:serpro:hml` (que chama apenas `GET /api/cliente-autenticado` com
   `RENAVE_MTLS_CA_FILE`, `RENAVE_MTLS_CERT_FILE`, `RENAVE_MTLS_KEY_FILE`,
   `RENAVE_INTEGRATOR_CNPJ`, `RENAVE_ESTABLISHMENT_CNPJ` e opcionalmente
   `RENAVE_MTLS_KEY_PASSPHRASE`). Confirme a mensagem sanitizada de sucesso sem
   CNPJ ou payload bruto.
3. **Ensaio serial no painel `HomologationCanaryPanel`:** no frontend
   autenticado, execute uma única sequência serial sem mutação (6 etapas, sem
   repetição automática nem espera):
   - `initial_readiness` (Prontidão local: `environment: "homologation"`,
     `integration: "configured"`, `certificate` em `ready` ou `warning`,
     `mutations: "blocked"`);
   - `preflight` (Identidade e vínculo — registra evidência/auditoria e atualiza
     o vínculo local);
   - `confirmed_readiness` (Prontidão após o vínculo: `link` em `confirmed` ou
     `enabled`, `queries: "ready"`, `operatorIdentity: "verified"`,
     `establishmentContact: "verified"`);
   - `eligibility` (Consulta de aptidão);
   - `stocks` (Consulta de estoque — exige exatamente 1 registro `CONFIRMADO`
     para a placa);
   - `vehicle` (Consulta do veículo — valida correspondência da placa).

   Em qualquer resultado inconclusivo (`INITIAL_READINESS_BLOCKED`,
   `LINK_NOT_READY`, `STOCK_NOT_UNIQUE_CONFIRMED`) ou falha (`CANARY_ABORTED`,
   `CANARY_STAGE_FAILED`), a sequência é interrompida imediatamente sem retry;
   corrija a causa raiz antes de nova cerimônia.
4. **Pré-requisitos operacionais obrigatórios antes de habilitar qualquer `POST`:**
   confirme a adoção e verificação de todos os controles descritos nos três
   runbooks complementares:
   - [`certificate-lifecycle.md`](./certificate-lifecycle.md) — ciclo de vida,
     monitoramento 90/60/30/15/7/1 dia, deduplicação multi-réplica, fechamento
     do readiness, rotação, revogação emergencial, TLS/CA e NTP;
   - [`reconciliation-worker.md`](./reconciliation-worker.md) — agenda fixa em
     1/5/15/60 min (ADR 0002), tolerância máxima de 5 min sem ampliar
     candidatos, proibição de 5ª leitura ou retry cego, triagem de
     `MANUAL_REVIEW` e checagem de leases/locks;
   - [`observability-and-incidents.md`](./observability-and-incidents.md) —
     sinais/alertas sanitizados (zero PII), matriz SEV-1..SEV-4, registro de
     prova de causa externa SERPRO/DETRAN, resposta ao monitor de evidências e
     resposta à adulteração da cadeia de hash de auditoria (ADR 0003).

## Observabilidade

Monitore separadamente:

- saúde da API e dos bancos;
- estado temporal do certificado nas faixas 90/60/30/15/7/1 dia;
- disponibilidade e latência das consultas SERPRO;
- preflights aceitos, rejeitados e limitados;
- saturação dos limitadores e do store de sessão;
- evidências pendentes e resultados incertos;
- mudanças do Swagger de produção e homologação.

Logs não podem conter CNPJ, placa, RENAVAM, CPF, UUID de tenant ou operação,
paths de Secret, material criptográfico, URL de banco ou resposta livre do
SERPRO. Alertas devem apontar para este runbook e para um owner, sem copiar o
payload que originou o evento.

## Kill switch

Em incidente, execute nesta ordem:

1. negue o egress FQDN para o RENAVE-WS;
2. remova a configuração RENAVE da próxima revisão e reinicie a API de forma
   controlada;
3. confirme no relatório autenticado que a integração voltou a `disabled` e as
   consultas estão `blocked`;
4. preserve banco, auditoria e evidências para investigação.

Não desligue o banco nem apague registros como mecanismo de contenção. A API
SaaS deve continuar disponível para acesso, diagnóstico e encerramento seguro
de sessões.

## Rotação e rollback

Rotação de certificado, CA, chave de evidência ou HMAC exige nova versão
imutável de Secret e reinício controlado. Atualizar apenas o volume não troca o
Agent mTLS já carregado.

No console global, a HMAC também deriva o identificador dos grants e assina os
cursores. Portanto sua rotação revoga, por construção, todos os grants e
cursores anteriores. Bloqueie a rota, rotacione simultaneamente API e
provisionador offline, refaça as concessões autorizadas e só então reative a
flag.

Para rollback:

1. feche o egress SERPRO;
2. confirme compatibilidade da imagem anterior com migrations e keyrings atuais;
3. restaure o digest anterior sem reutilizar tag móvel;
4. valide o relatório local com integração desabilitada;
5. repita a sequência de liberação antes de reabrir o egress.

O rollback nunca habilita produção, reduz validação TLS ou apaga uma operação de
resultado incerto.
