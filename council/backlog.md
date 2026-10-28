# Backlogg

Format: `- [ ] P1 | S/M/L | Titel: vad + acceptanskriterie`. `[~]` = pågår (datum), `[x]` = klar (datum).
Produktägaren äger ordningen i **Redo**. Utvecklingsansvarig äger status.

## Redo
- [~] 2026-10-28 P1 | M | Rättvis buzz över Discord: mät varje spelares ping (finns redan i `useRoom` som klockoffset) och låt servern vänta ~150 ms efter första buzz och välja den med lägst *justerad* tid. Klart när e2e simulerar två nästan samtidiga buzzar och rätt spelare vinner.
- [~] 2026-10-28 P1 | S | Vibration och ljudfeedback på mobilen vid buzz/rätt/fel (`navigator.vibrate`). Klart när det fungerar i Android Chrome och inte kraschar i iOS Safari.
- [ ] P1 | M | Rundtyp "Alla svarar": varje spelare skriver ett svar i hemlighet, hosten markerar rätt i en lista, snabbast rätt får bonus. Sätts per fråga (`"mode": "all"` i JSON) och kan väljas i frågebanken.
- [ ] P1 | M | Rundtyp "Närmast på skalan": `"mode": "closest"` med `min`/`max`/`answer` i fråge-JSON (och valbar i frågebanken). Alla drar ett reglage på mobilen och låser sin gissning före tidens slut; TV:n visar allas nålar på en tallinje en i taget och sist rätt svar. Närmast 3 p, tvåa 1 p, prick rätt +2 bonus. Servern räknar avstånd. Klart när e2e låter tre spelare gissa olika tal, rätt spelare får 3 p och TV-vyn inte visar svaret före reveal.
- [~] 2026-10-28 P2 | S | Installbar som app (PWA-manifest + ikon) så buzzern kan ligga på hemskärmen.
- [ ] P2 | S | Kvällens pris: efter sista frågan röstar alla på mobilen i två kategorier (standard "Kvällens fail" och "Modigaste chansningen", hosten kan byta namn). En röst per spelare och kategori, inte på sig själv. TV-vyn visar vinnarna som prisutdelning och utmärkelsen sparas i `Hub` och syns vid namnet i `/tabell`. Klart när e2e röstar med fyra spelare och priset syns i tabellen.
- [ ] P2 | M | Fallande poäng (På spåret): `"clues": [...]` i fråge-JSON med poängtrappa (standard 10/8/6/4/2). Hosten släpper nästa ledtråd med en knapp, TV-vyn visar ledtrådarna och aktuell poäng. Varje spelare får bara ett försök per fråga, servern låser den som gissat fel. Klart när e2e visar att en spelare som buzzar på ledtråd 2 får 8 p och en som gissat fel inte kan buzza igen.
- [ ] P2 | M | Bildfrågor: ladda upp en bild i frågebanken (lagras i Durable Object-storage eller R2:s gratisnivå) och visa den stort på TV-vyn.
- [ ] P2 | S | "Dubbla poäng"-joker: varje spelare kan använda en gång per kväll innan de buzzar.
- [ ] P3 | M | Vinnarens krona syns vid namnet på startsidan och i rummet nästa vecka (regerande kung).

## Teknik
- [ ] P2 | S | Rate-limit för buzz per anslutning (max ~5/s) så ingen kan spamma servern.

## Till PO

## Klart
- [x] 2026-10-27 | Grundversion: rum med kod, buzzer, svarstimer med straff, rätt/fel, TV-vy, hostkontroll, frågebank med snabbinklistring/JSON, säsongstabell, nästa quizdatum, e2e-test.
