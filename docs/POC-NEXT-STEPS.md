# PoC next steps

1. Habilitar o Codex App Server real com `codex --version` e `codex app-server --help`; iniciar a aplicação e confirmar que o health deixa `NOT_CONFIGURED`.
2. Autenticar com ChatGPT pelo fluxo oficial do Codex (`codex login`), sem copiar tokens para o HiveForge.
3. Testar o `gh` CLI com `gh --version` e `gh auth status`.
4. Preparar uma mailbox em pasta sincronizada e registrar esse caminho em `reviewMailboxPath`.
5. Executar manualmente os passos restantes para a PoC ChatGPT Work → bridge: webhook oficial, validação de origem, escrita do RCP na mailbox e reconciliação operacional.
