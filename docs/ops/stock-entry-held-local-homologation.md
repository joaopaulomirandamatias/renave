# Cerimônia HELD_LOCAL em homologação

Este procedimento habilita somente a criação cifrada de operações
`HELD_LOCAL`. Ele não cria outbox, não libera worker mutável e não envia dados à
SERPRO.

## Pré-condições

- migrations `0055` e `0056` aplicadas;
- duas pessoas responsáveis pela conferência;
- cofre com versionamento, auditoria e backup criptografado independente;
- egress da API para mutações SERPRO negado;
- `RENAVE_STOCK_ENTRY_LOCAL_ENABLED=false` e
  `VITE_RENAVE_STOCK_ENTRY_LOCAL_ENABLED=false`;
- perfis verificados e vínculo permanecem bloqueados até suas cerimônias
  próprias.

## 1. Gerar fora do repositório

Crie um diretório privado, pertencente ao operador, sem escrita por grupo ou
outros. Ele não pode estar dentro de nenhum worktree Git.

```bash
pnpm stock-entry:bundle:generate -- \
  --generation-id hml-AAAA-MM \
  --output-dir /caminho/privado/novo
```

O comando cria `keys.json` como `0400`, nunca sobrescreve um destino e imprime
somente a geração. Não há opção `--force`; o fingerprint é conferido depois
pelo `pin-status` com o bundle restaurado.

Se o comando devolver `BUNDLE_PUBLISHED_DURABILITY_UNCERTAIN`, o hard link já
pode ter publicado um bundle íntegro. Não apague o destino e não gere outro.
Preserve o arquivo existente, monte-o no diretório administrativo e confira sua
geração/fingerprint pelo `pin-status` antes de decidir qualquer ação.

## 2. Guardar e provar restauração

1. Importe o arquivo no cofre auditável.
2. Grave uma cópia em backup criptografado independente.
3. Restaure o bundle do cofre em ambiente isolado.
4. Compare apenas geração e fingerprint. Não copie chaves para ticket, chat,
   log ou variável de shell.
5. Registre a aprovação de duas pessoas.

Não prossiga se a restauração ainda não foi testada. Após o pin, perder esse
bundle exige uma migration corretiva; regenerar não é recuperação.

## 3. Preparar o mount administrativo

Monte os arquivos abaixo em
`/run/secrets/seu-renave/stock-entry-provisioning/`:

- `keys.json` — bundle restaurado, `0400` ou `0440`;
- `database-ca.pem` — CA do PostgreSQL remoto, opcional apenas em loopback.

Forneça `DATABASE_MIGRATOR_URL` pelo ambiente seguro do job. A URL não pode
conter parâmetros TLS; fora de loopback a CA é obrigatória. O papel deve ser
exatamente `renave_migrator`, sem superuser, `CREATEROLE` ou `BYPASSRLS`.

## 4. Conferir e provisionar uma vez

Antes do `INSERT`, confirme novamente geração, fingerprint, banco-alvo e o
registro de backup/restauração. Defina a confirmação não secreta apenas no job:

```bash
export STOCK_ENTRY_PIN_WRITE_ONCE_ACK=BACKUP_AND_RESTORE_VERIFIED_WRITE_ONCE
pnpm stock-entry:pin:status
pnpm stock-entry:pin:provision -- \
  --confirm-generation hml-AAAA-MM \
  --confirm-fingerprint SHA256_HEX_CONFERIDO
pnpm stock-entry:pin:status
```

O primeiro status deve ser `absent`; o último, `matching`. Um segundo
provisionamento, `UPDATE`, `DELETE` ou `TRUNCATE` é recusado pelo banco. O
status também mostra somente geração e fingerprint não secreto para a dupla
conferência. O comando não aplica migrations e nunca imprime URL, caminho ou
material de chave.

Se a conexão cair durante ou logo após o `COMMIT`, nunca repita
`provision-pin` às cegas. Execute `pin-status` com o mesmo bundle restaurado:

- `matching`: o provisionamento terminou; não repita;
- `absent`: o `INSERT` não persistiu e uma nova tentativa exige nova dupla
  aprovação;
- `divergent`: interrompa a cerimônia e investigue, sem alterar o pin.

## 5. Distribuir sem ativar

Monte o mesmo bundle em cada réplica da API no caminho fixo
`/run/secrets/seu-renave/api-stock-entry/keys.json`. Mantenha ambas as flags
desligadas. Valide readiness, MFA, vínculo, perfis verificados e limitador.

A ativação deve ocorrer primeiro no backend e só depois no build web. O
rollback é desligar as flags. Nunca apague o pin e nunca gere outro bundle.

## Rotação

Rotação está bloqueada neste schema. O pin cobre todo o bundle e é imutável.
Uma rotação futura exige migration que versione digests, suporte dual-read e
reindexe operações existentes. Não tente contornar os triggers.
