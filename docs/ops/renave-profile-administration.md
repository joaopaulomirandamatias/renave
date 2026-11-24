# Administração segura de perfis RENAVE

Este job isolado cria apenas candidatos `pending`, consulta estado sanitizado e
suspende perfis existentes. Ele não verifica identidade, não promove para
`verified`, não chama SERPRO e não carrega certificado mTLS.

## Segredos e papel do banco

O mount real `/run/secrets/seu-renave/stock-entry-provisioning/` deve pertencer
ao UID do job, sem escrita por grupo/outros. Arquivos secretos aceitos:

- `keys.json` — bundle pinado usado pela API, `0400` ou `0440`;
- `profile-admin-key.json` — chave mestra administrativa separada, `0400` ou
  `0440`;
- `profile-request.json` — request efêmero e único lugar que pode conter CPF ou
  e-mail, `0400` ou `0440`;
- `database-ca.pem` — CA pública do PostgreSQL, obrigatória para estes comandos.

Os quatro comandos mutantes exigem todos esses arquivos. `profile-status` é
deliberadamente status-only: lê apenas `profile-request.json` e
`database-ca.pem`; `keys.json` e `profile-admin-key.json` não devem ser montados
nesse job de consulta.

`DATABASE_PROFILE_PROVISIONER_URL` é a única configuração de conexão e deve
usar exatamente `renave_profile_provisioner`. O job valida `session_user`,
`current_user` e os atributos seguros do papel. A URL nunca é impressa.

Neste ciclo, `status-only` limita os arquivos e a operação da CLI, mas ainda
usa o mesmo papel de banco que possui `EXECUTE` nas rotinas mutantes. Isole o
job e sua credencial como administrativos. Uma role dedicada, exclusivamente
leitora para status, permanece como hardening futuro antes de delegar essa
consulta a um contexto de menor confiança.

Nunca coloque CPF, e-mail, request JSON ou chave em argumento, variável de
ambiente, ticket, chat ou log. O output contém somente identificadores técnicos,
status, versão, replay e códigos de erro fechados.

## Gerar a chave administrativa

Gere em diretório privado fora de worktree Git. O destino é `0400`, publicado
sem sobrescrita por hard link atômico:

```bash
pnpm stock-entry:profile-admin-key:generate -- \
  --key-id profile-admin-hml-v1 \
  --output-dir /caminho/privado/novo
```

Guarde no cofre e valide restauração por duas pessoas. A chave não substitui e
não deve ser igual a nenhuma chave de `keys.json`. Dela são derivados por HKDF
três domínios independentes: ator, evidência de suspensão e idempotência.

Se o comando devolver
`PROFILE_ADMIN_KEY_PUBLISHED_DURABILITY_UNCERTAIN`, o destino pode já conter a
chave íntegra. Preserve-o e investigue o filesystem; não tente gerar outra
chave no mesmo caminho.

## Request fechado

O orquestrador seguro materializa um único `profile-request.json` no mount. O
parser rejeita campos extras, inclusive `status`, `verificationSource`,
`verifiedAt` e qualquer verifier. Cada mutação exige UUID de idempotência.

Nos comandos mutantes, `actorSubject` é uma atribuição operacional
autoafirmada pelo artefato de request aprovado. O digest preserva rastreabilidade
e detecta divergência, mas não constitui não-repúdio. Uma integração futura
deve obter o ator de claim assinada ou identidade de workload autenticada e
vinculá-lo criptograficamente ao request, sem aceitar o campo como prova por si
só.

Schemas aceitos:

```json
{"schemaVersion":1,"command":"stage-operator","tenantId":"UUID","profileId":"UUID","subject":"OIDC_SUBJECT","cpf":"CPF_VALIDO","actorSubject":"OIDC_ADMIN_SUBJECT","idempotencyKey":"UUID"}
{"schemaVersion":1,"command":"stage-establishment","tenantId":"UUID","profileId":"UUID","establishmentId":"UUID","email":"EMAIL_VALIDO","actorSubject":"OIDC_ADMIN_SUBJECT","idempotencyKey":"UUID"}
{"schemaVersion":1,"command":"profile-status","tenantId":"UUID","profileKind":"operator","subject":"OIDC_SUBJECT"}
{"schemaVersion":1,"command":"profile-status","tenantId":"UUID","profileKind":"establishment","establishmentId":"UUID"}
{"schemaVersion":1,"command":"suspend-operator","tenantId":"UUID","subject":"OIDC_SUBJECT","expectedVersion":1,"reasonCode":"access_revoked","confirmation":"SUSPEND_RENAVE_PROFILE","actorSubject":"OIDC_ADMIN_SUBJECT","idempotencyKey":"UUID"}
{"schemaVersion":1,"command":"suspend-establishment","tenantId":"UUID","establishmentId":"UUID","expectedVersion":1,"reasonCode":"access_revoked","confirmation":"SUSPEND_RENAVE_PROFILE","actorSubject":"OIDC_ADMIN_SUBJECT","idempotencyKey":"UUID"}
```

O `profileId` é gerado antes da primeira tentativa e deve ser reutilizado junto
com a mesma chave de idempotência em retry. Para suspensão, confira a versão
obtida por `profile-status` e mantenha a confirmação literal no arquivo.

## Executar

Use o comando que coincide exatamente com `command` dentro do request:

```bash
pnpm stock-entry:profile:stage-operator
pnpm stock-entry:profile:stage-establishment
pnpm stock-entry:profile:status
pnpm stock-entry:profile:suspend-operator
pnpm stock-entry:profile:suspend-establishment
```

Remova o request do mount ao terminar conforme a política do cofre/orquestrador.
Não reutilize uma idempotência para outro conteúdo. `replayed: true` significa
que o banco reconheceu a repetição exata; divergência falha fechada.

## Limite deliberado

O diretório `verification-providers` contém apenas a interface e um registro
vazio. Adicionar provider não cria permissão de promoção: uma futura cerimônia
de verificação precisa de threat model, adapter próprio, prova verificável e
rotina SQL separada. Não há `verify`, `promote` nem atualização direta de
status neste aplicativo.
