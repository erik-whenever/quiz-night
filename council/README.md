# AI-rådet

Rådet är fem roller som körs som schemalagda Claude-uppgifter mot det här repot. Varje körning startar från noll, så **allt minne finns i filerna här**.

| Roll | Fil | När | Gör |
|---|---|---|---|
| Idéspanaren | `roles/idespanare.md` | dagligen 06:47 | Bevakar andra partyspel och quizappar, skriver idéer till `ideas/` |
| Produktägaren | `roles/produktagare.md` | dagligen 07:43 | Prioriterar idéer in i `backlog.md`, håller helheten och designen, sköter frågor till Erik |
| Quizresearchern | `roles/quizresearcher.md` | dagligen 08:41 (avslutar direkt om inget att göra) | Tar fram frågeset till nästa quiz utifrån tema, inklusive personliga frågor från spelstatistik |
| Utvecklingsansvarig | `roles/utvecklingsansvarig.md` | dagligen 09:37 | Plockar backloggen, fördelar på parallella underagenter, mergar testat arbete |
| Testaren | `roles/testare.md` | anropas av Utvecklingsansvarig + CI | E2E-test, skärmdumpar, granskar UI som en spelare |

## Filer
- `backlog.md`: prioriterad lista. Produktägaren äger ordningen, Utvecklingsansvarig äger status.
- `ideas/`: en fil per idé från Idéspanaren (`YYYY-MM-DD-kort-namn.md`).
- `BEHOVER-ERIK.md`: **det enda ställe Erik behöver titta på.** Öppna frågor med svarsfält.
- `beslut.md`: logg över beslut rådet tagit själv, med kort motivering.
- `status.md`: Produktägarens dagliga lägesrapport (skrivs över varje dag).
- `logg/`: en rad per körning och roll, för felsökning.

## Så svarar Erik
Öppna `council/BEHOVER-ERIK.md` på github.com, klicka på pennan, skriv under **Svar:** och committa.
Det går även bra att säga till i chatten med Claude. Produktägaren plockar upp svaren vid nästa körning.

## Kostnad
Allt körs på gratisnivåer (Cloudflare Workers + Durable Objects, GitHub). Det enda som förbrukas är Eriks Claude-användning:
ungefär 4 körningar per dag. Vill du dra ner, sänk frekvensen på Idéspanaren först.
