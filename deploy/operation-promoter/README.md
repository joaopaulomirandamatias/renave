# Deployment do promotor de operações

`base/` é um template fail-closed. O `Job` permanece com `suspend: true`, imagem
sentinela, Secrets sentinela e CIDR TEST-NET-1. Aplicar a base não inicia Pod.

O template não cria `Secret`, `Service` ou `Ingress`. A única saída permitida é
DNS do cluster e o PostgreSQL exato depois da substituição do placeholder. Não
existe regra para SERPRO, Internet, metadata service ou API Kubernetes.

O procedimento completo de assinatura, rotação, configuração e execução está em
[`docs/ops/operation-promoter.md`](../../docs/ops/operation-promoter.md).
