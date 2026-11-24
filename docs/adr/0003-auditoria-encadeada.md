# ADR 0003 — Auditoria encadeada e append-only

- **Status:** aceito para homologação
- **Data:** 23/11/2026
- **Escopo:** eventos de identidade, autorização, consulta e mutação RENAVE

## Contexto

O sistema precisa demonstrar ator, estabelecimento, ambiente, identidade confirmada, requisição e resultado de cada operação. Logs operacionais não são uma trilha probatória: podem ser rotacionados, não têm retenção suficiente e não detectam alteração ou exclusão.

## Decisão

1. `renave.audit_event` é append-only, isolada por `FORCE RLS` e sem `UPDATE`/`DELETE` para a aplicação.
2. O banco atribui horário, sequência global, posição na cadeia do tenant, hash anterior e hash do evento.
3. Inserções do mesmo tenant são serializadas. `chain_position` representa a ordem real do encadeamento; a sequência global serve apenas como identificador ordenável.
4. O hash usa representação JSONB determinística e instante em microssegundos desde o epoch, independente do timezone da sessão.
5. `renave.audit_chain_head` preserva contagem, último evento e último hash. O verificador compara a cadeia aos eventos e à cabeça, detectando alteração, exclusão intermediária e truncamento final.
6. Eventos `renave.*` exigem CNPJ enviado, hash da requisição, thumbprint lógico do certificado e referência ao payload protegido. Sucesso/reconciliação também exige CNPJ do estabelecimento e da integradora confirmados.
7. O payload sensível fica cifrado em armazenamento com retenção/WORM; a tabela mantém hashes e referência, não conteúdo aberto.

## Limites e gate de produção

A cabeça está no mesmo banco. Um administrador capaz de alterar simultaneamente eventos e cabeça ainda pode reescrever a história. Antes de produção, o último hash precisa ser ancorado periodicamente fora do banco em armazenamento WORM, com retenção e relógio confiável. O verificador e os testes locais não substituem essa âncora independente.

O RLS atual isola tenants. O escopo por estabelecimento dentro do tenant depende do RBAC derivado da sessão e de repositórios que recebem o estabelecimento autorizado do servidor. Endpoints RENAVE permanecem bloqueados até essa integração estar testada.

## Evidências automatizadas

- duas cadeias isoladas em tenants distintos;
- inserções concorrentes sem bifurcação;
- estabilidade entre UTC e America/Belem;
- aplicação e dono da tabela impedidos de alterar ou apagar;
- adulteração de hash detectada;
- exclusão administrativa do último evento detectada;
- sucesso RENAVE sem campos probatórios recusado.
