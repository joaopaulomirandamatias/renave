# Operação do monitor de evidências

O monitor identifica evidências que continuam `pending` além do SLA. Ele cria
um incidente operacional único, mas não altera nem remove a prova. O job usa o
papel `renave_maintenance_app`, sem leitura direta das tabelas de evidência.

## Contrato portátil do job

Execute `pnpm db:scan-evidence` em um scheduler externo. A frequência inicial
recomendada é a cada cinco minutos; ajuste após medir volume e duração. Configure
`EVIDENCE_MONITOR_MAX_SILENCE_SECONDS` com pelo menos o dobro dessa frequência.

A saída padrão é uma única linha JSON com `schemaVersion: 1`, duração,
heartbeat e contadores agregados. Ela não contém ID de evidência, tenant,
estabelecimento, CNPJ, placa ou ciphertext.

| Código | Significado | Ação do scheduler |
| ------ | ----------- | ----------------- |
| `0` | Execução concluída e sem atenção pendente. | Registrar sucesso. |
| `2` | Execução concluída, mas há incidente aberto, novo incidente ou backlog. | Alertar operação; não tratar como queda do banco. |
| `1` | Falha técnica ou de configuração. | Alertar plataforma e aplicar retry limitado. |

O código `2` é deliberadamente diferente de falha técnica. O scheduler não deve
reiniciar em loop: o incidente permanece visível até a evidência ser finalizada.

## Heartbeat e alerta de ausência

`pnpm db:status-evidence` lê o último sucesso sem iniciar nova varredura. Use-o
em um monitor externo independente do scheduler. Ele retorna `2` quando o
heartbeat venceu, há incidente aberto ou o último lote indicou backlog.

Alertas mínimos:

- código `1` em qualquer execução;
- código `2` persistente ou `openIncidentCount > 0`;
- `heartbeatStale: true` no comando de status;
- crescimento de `oldestPendingAgeSeconds` entre execuções.

O banco atualiza o heartbeat na mesma transação da varredura. Uma conexão
interrompida antes do commit não produz um falso sucesso. Scanners concorrentes
usam `SKIP LOCKED`; o heartbeat mais novo prevalece, mesmo se uma execução mais
antiga terminar depois.

## Configuração

```dotenv
MAINTENANCE_DATABASE_URL=postgres://renave_maintenance_app:...@db/renave
EVIDENCE_MONITOR_BATCH_SIZE=100
EVIDENCE_MONITOR_MAX_SILENCE_SECONDS=900
```

O valor máximo do lote é `1000`; o silêncio máximo aceito é um dia. Credenciais
ficam no cofre da plataforma e nunca em argumentos de linha de comando ou logs.

## Exemplo de scheduler

Use o comando abaixo como unidade de execução, independentemente da plataforma:

```bash
pnpm db:scan-evidence
```

O deploy deve garantir concorrência controlada, timeout menor que a próxima
janela e retenção dos JSONs conforme a política de observabilidade. A escolha
entre CronJob, systemd timer, Railway cron ou workflow gerenciado fica para a
infraestrutura do ambiente; o contrato do processo é o mesmo em todos eles.
