# ADR 0005 — Evidência protegida da consulta RENAVE

- **Status:** aceito
- **Data:** 23/11/2026

## Contexto

A consulta de aptidão contém placa, identificadores do veículo e diagnóstico
de restrições. A auditoria precisa provar o que foi consultado e recebido, mas
esses payloads não podem ficar em texto claro na trilha operacional nem na
tabela append-only de auditoria.

## Decisão

1. Request e response são cifrados na aplicação com AES-256-GCM antes de chegar
   ao PostgreSQL. A chave de 32 bytes vem do cofre/runtime e nunca é persistida.
2. O banco guarda `key_id`, nonce aleatório de 96 bits, tag de 128 bits e
   ciphertext. O `key_id` permite manter chaves antigas somente para leitura
   durante rotação.
3. O AAD vincula versão, `key_id`, tenant, evidência, estabelecimento, ação e tipo
   (`request`/`response`). Copiar um ciphertext para outro contexto invalida a
   autenticação criptográfica.
4. A referência pública usa `pev1_<uuid>` e não revela tenant, estabelecimento
   nem dado da pessoa.
5. A tabela é tenant-scoped, usa FK composta para o estabelecimento e aplica
   RLS com `FORCE`. O runtime não recebe `DELETE` nem `TRUNCATE`.
6. Toda evidência nasce `pending` e só transita uma vez para `completed` ou
   `failed`. Trigger e `UPDATE ... WHERE status = 'pending'` impedem
   sobrescrita, corrida e reabertura. Falha guarda apenas código fechado.
7. A auditoria append-only referencia a evidência; não duplica o payload.

## Operação e rotação

- A chave ativa cifra novos payloads. Chaves anteriores permanecem no keyring
  enquanto houver evidência dentro da retenção legal.
- Rotação não reescreve automaticamente o histórico. Recriptografia, se
  necessária, será um job privilegiado separado e auditado.
- Logs não contêm chave, plaintext, nonce, tag ou ciphertext.
- Cada operação do adapter abre sua própria transação curta. Nenhuma transação
  PostgreSQL permanece aberta durante uma chamada ao SERPRO.
- Backup do banco sem acesso ao cofre não revela o conteúdo, mas metadados
  (horários, tenant e estabelecimento) continuam protegidos pelos controles de
  acesso e retenção do banco.

## Limitações

- O adapter atual grava e finaliza a primeira consulta de aptidão; uma interface
  de leitura para auditor autorizado será criada separadamente, com permissão e
  justificativa explícitas.
- AES-GCM não substitui armazenamento WORM nem âncora externa. Esses controles
  continuam necessários antes da produção.
- Um reconciliador deve alertar e tratar evidências `pending` acima do SLA;
  elas não são descartadas automaticamente porque representam tentativa iniciada.
