# Monetize — Revenue Intelligence

Dashboard demonstrativo para visualizar métricas de Google Ad Manager e Google AdSense.

## Executar localmente

```bash
npm install
npm run dev
```

Abra [http://localhost:3000](http://localhost:3000).

## Escopo da demonstração

- Páginas de visão geral, desempenho, sites, receita, público, relatórios, usuários, pagamentos e configurações.
- Dados fictícios e interações persistidas apenas no navegador.
- A página GitHub Pages continua em modo demo, sem sessão nem dados reais.

## Backend preparado

- Supabase Auth com login por e-mail e senha e criação do primeiro workspace com papel Admin.
- Modelo multi-tenant para workspaces, membros Admin/Gestor, sites, receita diária, custos e conexões Google.
- RLS por workspace; gestores consultam receita e custos, admins também gerenciam equipe, integrações e lançamentos de custo.
- Funções Supabase para convite de membros e início/retorno do OAuth do Google Ad Manager e AdSense.
- Tokens de atualização Google cifrados com AES-256-GCM e guardados sem acesso pelas roles públicas.
- Visão SQL `workspace_profit_daily` calcula a receita menos os custos registrados.

O backend ainda não está ligado a um projeto Supabase e o OAuth ainda precisa de credenciais de um projeto Google Cloud. O link público continua usando os dados de demonstração.

### Configurar Supabase

1. Crie/seleciona um projeto Supabase e copie `NEXT_PUBLIC_SUPABASE_URL` e `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` para `.env.local`.
2. Faça o link local com `npm exec supabase -- link --project-ref SEU_PROJECT_REF`.
3. Revise a migration em `supabase/migrations/` e aplique com `npm exec supabase -- db push --remote`.
4. Cadastre no Google Cloud um OAuth Client do tipo Web. Adicione `https://SEU_PROJECT_REF.supabase.co/functions/v1/google-oauth-callback` como URI de redirecionamento autorizado e habilite as APIs necessárias.
5. Configure os secrets das Edge Functions: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_TOKEN_ENCRYPTION_KEY`, `APP_BASE_URL` e `APP_ALLOWED_ORIGINS`. Gere a chave de cifragem com `openssl rand -base64 32` e não a coloque no frontend.
6. Publique as funções com `npm exec supabase -- functions deploy invite-workspace-member google-oauth google-oauth-callback --remote`.

As rotas de autenticação estão preparadas em `/login` e `/auth/callback`. A demonstração principal não exige login até a integração de dados reais ser ativada.

## Publicação

O GitHub Actions gera a exportação estática e publica o site no GitHub Pages a cada push na branch `main`.
