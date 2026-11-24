# Operation promoter

Aplicativo one-shot que valida uma decisão Ed25519 e promove exatamente uma
operação `HELD_LOCAL`. Não aceita argumentos nem configuração por ambiente.

O runtime lê exclusivamente estes arquivos do mount fixo
`/run/secrets/seu-renave/operation-promoter`:

- `promotion-decision.json` — artefato canônico assinado;
- `decision-keyring.json` — keyring público Ed25519 canônico;
- `target.json` — ambiente, identidade lógica, digest do workload e destino;
- `database-url` — DSN exclusivo de `renave_operation_promoter`;
- `database-ca.pem` — cadeia pública usada para TLS autenticado.

Todos os arquivos devem ser regulares, limitados, `0400` do processo ou `0440`
de um grupo do processo. O Job não faz retry: uma repetição operacional usa o
mesmo artefato, e o banco decide o replay idempotente.

O output contém apenas `promoted`/`replayed` e timestamp. UUIDs, digests, DSN,
claims e mensagens do driver não são enviados aos logs.
