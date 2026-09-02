# Review ZIP canônico

O fechamento de cada incremento executor do HiveForge deve atualizar automaticamente um único pacote auditável:

```powershell
.\scripts\create-review-zip.ps1
```

O script descobre a raiz pelo próprio diretório `scripts`, executa as validações reais configuradas no `package.json`, captura stdout/stderr/exit code e cria um ZIP temporário em `review/.staging`. O pacote é validado antes de substituir:

```text
review/HIVEFORGE-REVIEW-LATEST.zip
```

Uma falha de teste é registrada como evidência e não impede a criação do pacote. Uma falha na geração ou validação do ZIP preserva o último pacote canônico válido e impede o fechamento completo.

O conteúdo inclui os manifests JSON/Markdown, evidências Git, remoto canônico, base de comparação e diff `base..HEAD` quando disponível, PR/release/CI, ambiente mínimo, comandos executados, resultados de tests/lint/typecheck/build e um snapshot do repositório. `.git`, `node_modules`, `.next`, builds, caches, temporários, ZIPs anteriores, secrets e arquivos de credenciais ficam fora.

Para testar o caminho de falha sem substituir o pacote existente:

```powershell
.\scripts\create-review-zip.ps1 -SimulateFailureBeforeReplace
```

Esse contrato passa a ser implícito para prompts executores futuros: validar, corrigir dentro do escopo, gerar/validar o ZIP temporário, substituir o `LATEST` e só então responder o review final.
