# Cerimônia produtiva de promoção de operações

Este procedimento libera uma única operação `HELD_LOCAL` para `PENDING_SEND`.
O Job não chama o SERPRO, não lê o ciphertext da solicitação e não inicia o
envio. O banco revalida tenant, estabelecimento, perfis, vínculo, jurisdição e
escopo sob locks antes de criar uma única outbox.

## Fronteiras de autoridade

Há três autoridades separadas:

1. o serviço de aprovação assina a decisão com Ed25519;
2. o orquestrador materializa artefato, keyring, target, DSN e CA em Secrets
   imutáveis e cria o Job;
3. o workload usa exclusivamente `renave_operation_promoter` para invocar a
   função fechada do banco.

A chave privada Ed25519 não entra no cluster. O DSN do promotor também não pode
ser entregue a pessoa, API, worker de reconciliação, shell interativo ou outro
workload. O papel é uma autoridade de workload e não substitui a assinatura.

## Estado dormente e sentinelas

O template em `deploy/operation-promoter/base` tem:

- `suspend: true`, `backoffLimit: 0`, uma conclusão e paralelismo um;
- imagem presa a um digest zerado deliberadamente inválido;
- referências de Secret iniciadas por `replace-`;
- PostgreSQL em `192.0.2.10/32` (TEST-NET-1), deliberadamente inoperante;
- Pod restricted, UID/GID `10001`, filesystem read-only, todas as capabilities
  removidas, seccomp `RuntimeDefault` e token de ServiceAccount desabilitado;
- nenhum sidecar, `hostPath`, namespace do host, `Service` ou `Ingress`.

Não crie um overlay permanente com `suspend: false`. Cada execução deve nascer
de uma cópia revisada, ter nome único e referenciar Secrets imutáveis daquela
decisão. Admission policy deve rejeitar sentinelas, imagem por tag, alteração de
entrypoint/args, mais de um container e qualquer volume adicional.

## Identidade lógica do banco

Cada banco recebe uma identidade write-once composta por ambiente e UUID. Use
um UUID aleatório por banco lógico; restaurações que representam o mesmo banco
mantêm a identidade, enquanto clone, homologação e produção usam UUIDs distintos.

A configuração é feita pelo canal controlado do migrator, nunca pelo Job:

```sql
select renave_promotion.configure_operation_promotion_identity(
  'homologation',
  '00000000-0000-4000-8000-000000000074'::uuid
);
```

O UUID acima é apenas sentinela documental. Registre o UUID real no inventário
de ambiente e no `target.json`. A função recusa reconfiguração; divergência
entre decisão, target e banco falha fechada. Inclua essa identidade nos testes
de backup/restauração e nunca corrija divergência alterando tabelas diretamente.

## Artefato assinado e keyring

O serviço de aprovação deve usar o encoder do pacote
`@seu-renave/operation-promotion-decision`. JSON manual, reordenação, espaço,
newline, campo extra, timestamp não canônico ou base64url não canônico são
rejeitados. O artefato contém exatamente:

- ação `promote-held-local-operation` e efeito `allow`;
- ambiente, UUID lógico do banco, tenant, operação e decisão;
- `issuedAt`, `notBefore`, `expiresAt` e nonce;
- digest do aprovador e digest do workload executor;
- política com ID, versão e digest;
- manifesto de evidência com tipo e digest;
- binding completo: natureza, UF, gerações de jurisdição/escopo, versão do
  vínculo e IDs/versões dos perfis de operador e estabelecimento.

O TTL máximo aceito pelo Job é dez minutos e a tolerância futura é trinta
segundos. O banco confere a validade novamente, depois dos locks. O digest do
artefato e o digest canônico do binding são calculados somente depois da
assinatura ser validada; não são parâmetros livres do operador.

`decision-keyring.json` contém somente chaves públicas Ed25519 em SPKI DER
base64url. O arquivo é canônico, sem chave privada. Seu SHA-256 bruto em
base64url fica em `target.json`, impedindo que outro keyring seja usado por
engano.

### Rotação Ed25519

1. Gere a nova chave no HSM/serviço de assinatura e atribua um key ID novo.
2. Acrescente a chave pública ao keyring canônico sem remover a anterior.
3. Publique um Secret imutável novo e atualize o digest do keyring no target.
4. Passe a assinar decisões novas com o novo key ID.
5. Depois do TTL máximo, da conclusão de Jobs antigos e da auditoria, remova a
   chave anterior e publique outro par keyring/target.

Não reutilize key ID, não sobreponha Secret e não faça rotação durante um Job.
Revogar a chave no assinador impede decisões novas; para interromper um Job já
materializado, suspenda/delete o Job e revogue o egress/DSN.

## Secrets montados

O cofre/CSI cria versões imutáveis. O repositório não cria `Secret`:

| Secret | Chave projetada | Conteúdo |
| --- | --- | --- |
| decisão | `promotion-decision.json` | artefato canônico assinado |
| keyring | `decision-keyring.json` | chaves públicas Ed25519 |
| target | `target.json` | ambiente, banco lógico, workload e destino |
| banco | `database-url` | DSN exclusivo de `renave_operation_promoter` |
| CA | `database-ca.pem` | cadeia pública do PostgreSQL |

O mount fixo é `/run/secrets/seu-renave/operation-promoter`. Arquivos são
read-only e `0440` com `fsGroup: 10001` (ou `0400` quando pertencem ao UID do
processo). Não use `secretKeyRef`, variável de ambiente, argumento, init
container, sidecar ou wrapper shell.

O `target.json` fecha ambiente, UUID lógico, host, porta, database name, digest
do keyring e digest do workload. Este último deve representar o digest imutável
da imagem aprovado pela política e coincidir com o claim assinado. Admission e
o orquestrador são responsáveis por vincular esse valor à imagem por digest.

O DSN deve conter usuário `renave_operation_promoter`, senha própria, host,
porta e database exatos. Query string, `sslmode`, fragmento, outro usuário ou
outro destino são recusados. A conexão usa a CA montada, valida hostname e exige
TLS 1.2 ou superior.

## Rede

A NetworkPolicy nega ingress e egress por padrão. As únicas exceções são:

- UDP/TCP 53 para o seletor exato do DNS do cluster;
- TCP para o CIDR e porta exatos do PostgreSQL.

Confirme os labels reais do DNS antes de executar. Para banco com IP dinâmico,
use controle de egress da plataforma que permaneça fail-closed; não amplie para
sub-rede genérica. É proibido liberar `0.0.0.0/0`, `::/0`, porta 443 genérica,
SERPRO, metadata service, API Kubernetes ou redes internas não necessárias.

## Preparação e execução

1. Configure e audite a identidade lógica do banco.
2. Publique a imagem assinada e verificada por digest; confira SBOM, provenance
   e scan antes de usá-la.
3. Gere a decisão no serviço assinador após obter o binding atual e a aprovação
   de duas pessoas. Não edite o JSON produzido.
4. Publique cinco Secrets imutáveis. Confira owner, grupo, modo, o schema do
   target e ausência de newline nos dois JSON canônicos e no DSN.
5. Em uma cópia do template, substitua digest da imagem, nomes dos Secrets,
   CIDR/porta do banco e nome do Job. Mantenha um container e nenhum argumento.
6. Renderize e valide localmente, sem acessar o cluster:

```bash
kubectl kustomize deploy/operation-promoter/base > /tmp/operation-promoter.yaml
```

O render da base deve continuar mostrando `suspend: true` e sentinelas. Valide
a cópia executável com schema Kubernetes vendorizado e confirme que não contém:

```text
REPLACE_  replace-  sha256:000000...  192.0.2.10/32
secretKeyRef  envFrom  hostPath  0.0.0.0/0  ::/0
```

7. Somente após a revisão, altere a cópia para `suspend: false` e crie o Job.
8. Aceite uma única conclusão `Complete`. O log permitido contém apenas
   `promoted` ou `replayed` e `promotedAt`; não arquive os arquivos projetados.
9. Remova os Secrets efêmeros conforme retenção aprovada. A decisão e os
   digests persistem na auditoria append-only do banco.

## Sem retry automático

`backoffLimit: 0` é obrigatório. Timeout, encerramento ou falha técnica exigem
consulta da auditoria por um canal separado. Enquanto o artefato ainda estiver
válido, uma repetição manual usa exatamente os mesmos bytes e pode retornar
`replayed`. Depois da expiração, não fabrique automaticamente nova decisão:
confirme primeiro se a promoção ocorreu e, se necessário, recomece a aprovação.

Uma negação indica binding expirado/divergente, autorização revogada, ambiente
incorreto ou estado incompatível. Não contorne a negação alterando claims,
relógio, keyring, role ou política de rede.

## Resposta a incidente

Para interromper a capacidade, nesta ordem:

1. mantenha/suspenda Jobs e aplique deny egress ao seletor do promotor;
2. revogue/rotacione a credencial exclusiva do banco;
3. revogue a chave no serviço assinador e publique keyring sem a chave afetada;
4. preserve Job, eventos e auditoria para investigação, sem copiar Secrets para
   tickets ou logs.

Não há rollback de schema pelo Job. Uma imagem anterior só pode ser usada se
for compatível com o contrato atual, novamente por digest e com nova revisão.
