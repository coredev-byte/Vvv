# Deploy do VALO INSIGHT na Vercel

Este pacote é propositalmente mínimo: **um `index.html`** (frontend) e
**uma função serverless** (`api/sync.js`, o único "backend" que existe aqui).
Dá pra subir num repositório e fazer deploy na Vercel sem configuração extra.

## Passo a passo

1. **Suba isto para um repositório no GitHub**
   ```bash
   cd valo-insight-vercel
   git init
   git add .
   git commit -m "VALO INSIGHT - primeira versão"
   git branch -M main
   git remote add origin <seu-repo-no-github>
   git push -u origin main
   ```

2. **Importe na Vercel**
   - vercel.com → *Add New* → *Project* → selecione o repositório.
   - Framework preset: **Other** (não precisa de build step — é HTML estático + `/api`).
   - Não clique em Deploy ainda — primeiro configure as variáveis de ambiente (próximo passo), senão o deploy sobe sem chaves e o formulário vai falhar.

3. **Configure as variáveis de ambiente**
   Project → **Settings → Environment Variables**. Adicione (veja `.env.example`):
   - `RIOT_API_KEY` — obrigatória
   - `RIOT_PLATFORM_SHARD` — `na`, `eu`, `ap`, `kr`, `latam` ou `br`
   - `ANTHROPIC_API_KEY` — opcional, ativa a análise de IA real
   - `HENRIKDEV_ENABLED` / `HENRIKDEV_API_KEY` — opcionais, veja abaixo

4. **Deploy** (ou *Redeploy*, se já tinha subido antes de configurar as variáveis).

5. Abra a URL que a Vercel te der. Digite um Riot ID + Tag reais e clique em
   **ANALISAR MEU PERFIL**.

## O que esperar ao testar com sua chave pessoal

- ✅ **Identidade real** — seu Riot ID vira PUUID de verdade, confirmado pela Riot.
- ✅ **Catálogo real** — a contagem de agentes/mapas vem de `val-content-v1`.
- ❌ **Histórico de partidas** — vai cair numa tela explicando que sua chave é
  pessoal e a Riot exige aprovação de produção para `val-match-v1`. Isso é
  esperado, não é bug (a Riot mesma restringe isso, ver mensagem na tela).
  Nessa tela tem um botão para ver o dashboard completo com **dados de
  demonstração**, só para você validar o resto da interface.
- Se você configurar `ANTHROPIC_API_KEY` e conseguir dados de partida reais
  (produção aprovada, ou HenrikDev ativado), a análise de IA no dashboard
  vem de uma chamada real ao Claude (`claude-sonnet-4-6`), não é mais texto
  gerado localmente.

## Ativando o fallback HenrikDev (opcional, não-oficial)

Enquanto sua produção da Riot não é aprovada, você pode testar com dados de
partida reais via uma API comunitária não-oficial:
1. Leia os termos de uso em https://docs.henrikdev.xyz antes de decidir usar.
2. Pegue uma chave lá.
3. Configure `HENRIKDEV_ENABLED=true` e `HENRIKDEV_API_KEY=...` na Vercel.
4. Redeploy.

Isso não é mantido pela Riot nem pela Anthropic — pode mudar ou parar de
funcionar sem aviso. É só uma ponte enquanto a aprovação oficial não sai.

## Limitações conhecidas deste build único

- Sem banco de dados: cada análise é recalculada a cada clique (sem cache
  de `last_synced_at`, sem histórico salvo). O projeto completo com
  Postgres/Supabase está no zip `valo-insight.zip` entregue antes.
- A função serverless busca no máximo 10 partidas por chamada, para não
  estourar o timeout padrão da Vercel (Hobby: ~10s). Ajuste em
  `api/sync.js` (`slice(0, 10)`) e em `vercel.json` (`maxDuration`) se seu
  plano permitir chamadas mais longas.
- ADR e First Kills/Deaths ficam com cálculo simplificado no caminho da
  Riot direta (exigem somar `roundResults[]`, que ainda não é implementado
  aqui) — não são inventados, apenas ficam como `0` até essa parte ser
  completada. O caminho HenrikDev já traz ADR real.
- Sem autenticação de usuários — qualquer pessoa que acesse a URL pode
  consultar qualquer Riot ID (respeitando os limites da sua chave).
