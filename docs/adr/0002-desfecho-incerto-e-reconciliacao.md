# ADR 0002 — Desfecho incerto e reconciliação

- **Status:** aceito
- **Data:** 23/11/2026
- **Fontes:** manual oficial “Erros internos”; Swagger de homologação; revisão de segurança

## Contexto

Uma mutação pode chegar ao RENAVE e ser efetivada, mas a resposta se perder por timeout, queda de conexão ou erro interno. Repetir automaticamente a chamada pode duplicar um efeito nacional. O manual informa que erros internos podem causar assincronia e orienta que uma repetição use a mesma requisição.

## Decisão

1. HTTP 2xx representa sucesso conhecido. HTTP 4xx representa rejeição conhecida e não é repetido automaticamente.
2. Timeout, falha de transporte e HTTP 5xx após iniciar uma mutação representam `RENAVE_MUTATION_OUTCOME_UNKNOWN`.
3. O transporte não executa retry de mutações. Ele registra a operação estável, o hash SHA-256 dos bytes exatos enviados e o status recebido, quando existir.
4. A operação passa para `PENDING_RECONCILIATION`. O corpo original permanece imutável e qualquer repetição futura deve produzir bytes idênticos.
5. Para entrada em estoque, a primeira reconciliação consulta `GET /api/estoques?placa=...`, novamente após confirmar `cnpj` e `cnpjIntegradora`. O resultado é comparado ao veículo, CPF do operador e janela de envio.
6. Resultado inexistente permite nova tentativa somente após o período de consistência definido operacionalmente. Resultado único compatível confirma a operação. Mais de um resultado ou correspondência parcial mantém o caso bloqueado para revisão humana.
7. Nunca se usa `--insecure`, desativação de hostname ou trust-all para “resolver” falha TLS.
8. A reconciliação usa somente `dataHoraRegistro` com fuso explícito (`Z` ou `±hh:mm`). `dataHora` é um instante de negócio e não substitui o relógio de registro; horário sem fuso ou campo ausente torna o candidato ambíguo.
9. A janela entre envio e observação é limitada a uma hora, além da tolerância de relógio nas bordas. Uma observação mais tardia não confirma automaticamente um registro de outro ciclo operacional.
10. Um registro da mesma placa dentro da janela só é confirmado quando CPF do operador, tipo e segurança do CRV e os identificadores veiculares fornecidos na requisição coincidem. Registro cancelado, finalizado, incompleto ou divergente vai para revisão humana e nunca é tratado como ausência.

## Consequências

- A outbox precisa distinguir `PENDING_SEND`, `SENT`, `REJECTED`, `PENDING_RECONCILIATION`, `CONFIRMED` e `MANUAL_REVIEW`.
- O hash não é idempotência do SERPRO; é evidência local de repetição idêntica.
- A busca por placa não prova sozinha que o estoque veio da nossa tentativa. A decisão exige os demais campos e uma janela temporal, e permanece conservadora quando houver ambiguidade.
- Alertas e painéis devem tratar “resultado incerto” como estado operacional próprio, não como erro genérico.

## Referências oficiais

- https://renave.estaleiro.serpro.gov.br/renave-ws/manual/erros-internos
- https://hom.renave.estaleiro.serpro.gov.br/renave-ws/v2/api-docs?group=Estabelecimento%20(Concession%C3%A1ria%20ou%20Revenda)
