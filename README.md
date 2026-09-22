# ENTERPRISER • CRM

Versão web em Next.js 16, React e TypeScript. O Supabase continua sendo o backend do CRM.

## Desenvolvimento

```bash
npm install
npm run dev
```

Acesse `http://localhost:3000`.

## Migração do legado

A interface atual permanece funcional dentro de uma fronteira cliente enquanto os módulos são convertidos para componentes React. `index.html`, `app.js` e `config.js` continuam sendo a fonte temporária dessa camada.

Depois de alterar um desses arquivos, sincronize os artefatos usados pelo Next.js:

```bash
npm run sync:legacy
```

O comando `npm run build` já executa essa sincronização automaticamente.

## Recursos exclusivos da extensão

- Captura automática do WhatsApp Web
- Captura automática do Reddit Chat
- Importação do Google Contacts via `chrome.identity`
# ENTERPRISER CRM Web

## E-mails automáticos de clientes

Ao criar uma entrega, a versão web solicita ao cPanel a conta formada pelos oito primeiros dígitos do CNPJ, por exemplo `12345678@ecommerce365.com.br`. A mesma automação também roda quando uma entrega nasce de um negócio marcado como ganho.

As credenciais do cPanel ficam nos Secrets das Edge Functions do Supabase. A interface hospedada na Vercel não recebe nem armazena esses valores. Use um token de API exclusivo para o CRM e revogue imediatamente qualquer token que tenha sido compartilhado em mensagem ou arquivo.

`EMAIL_CREDENTIALS_ENCRYPTION_KEY` deve ser um segredo longo e aleatório. Não altere esse valor depois de haver contas registradas, pois ele é usado para criptografar e descriptografar as senhas salvas no Supabase.

Em desenvolvimento local, os mesmos valores podem ser fornecidos por `supabase/functions/.env`, que é ignorado pelo Git.
