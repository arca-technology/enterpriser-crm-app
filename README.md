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
