# ADR 0001 — Identidade do conector SERPRO

- **Status:** aceito para homologação; bloqueado em produção até confirmação formal do SERPRO
- **Data:** 23/11/2026
- **Fontes:** docs 04, 07 e 14; Swagger de homologação; revisão de segurança da fundação

## Contexto

O material anterior pressupunha mTLS com o certificado de cada estabelecimento. A homologação passou a expor o modelo de integradora: uma conexão com o e-CNPJ da integradora e identificação da loja pelo cabeçalho `CNPJ-Estabelecimento`. Quando o CNPJ não está vinculado, a homologação pode ignorar o cabeçalho silenciosamente e responder como cliente-padrão.

## Decisão

1. O modo padrão é `INTEGRADORA`.
2. O e-CNPJ da integradora fica não exportável em HSM e só o workload do conector pode acionar seu handle.
3. `CNPJ-Estabelecimento` vem da operação persistida e do contexto autorizado no servidor; valores enviados pelo navegador ou por cliente externo não controlam o cabeçalho.
4. Antes de toda chamada mutável, `GET /api/cliente-autenticado` precisa confirmar `cnpj` igual ao estabelecimento e `cnpjIntegradora` igual ao CNPJ configurado da integradora. Resposta HTTP 200 com divergência é incidente e produz zero mutações.
5. Homologação e produção têm URLs, truststores, certificados, filas e configurações separadas.
6. O modo `ESTABELECIMENTO` é legado, nasce desligado e só pode ser habilitado por ambiente e estabelecimento com evidência operacional registrada.
7. Produção permanece bloqueada até o Swagger de produção publicar o contrato necessário e o SERPRO responder formalmente sobre o comportamento de CNPJ não vinculado.

## Consequências

- O onboarding padrão acompanha o vínculo Credencia e não recebe PFX da loja.
- O certificado da integradora torna-se ponto de falha de todos os clientes; exige redundância, rotação escalonada, teste de handshake e revogação monitorada.
- A auditoria registra CNPJ enviado, identidades confirmadas, ambiente, thumbprint lógico do certificado, ator e hashes de request/response.
- Testes de contrato devem simular o fallback silencioso e provar que nenhuma mutação é enviada.
