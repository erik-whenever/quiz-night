# Backlogg

Format: `- [ ] P1 | S/M/L | Titel: vad + acceptanskriterie`. `[~]` = pågår (datum), `[x]` = klar (datum).
Produktägaren äger ordningen i **Redo**. Utvecklingsansvarig äger status.

## Redo
- [ ] P1 | M | Rättvis buzz över Discord: mät varje spelares ping (finns redan i `useRoom` som klockoffset) och låt servern vänta ~150 ms efter första buzz och välja den med lägst *justerad* tid. Klart när e2e simulerar två nästan samtidiga buzzar och rätt spelare vinner.
- [ ] P1 | S | Vibration och ljudfeedback på mobilen vid buzz/rätt/fel (`navigator.vibrate`). Klart när det fungerar i Android Chrome och inte kraschar i iOS Safari.
- [ ] P1 | M | Rundtyp "Alla svarar": varje spelare skriver ett svar i hemlighet, hosten markerar rätt i en lista, snabbast rätt får bonus. Sätts per fråga (`"mode": "all"` i JSON) och kan väljas i frågebanken.
- [ ] P2 | M | Bildfrågor: ladda upp en bild i frågebanken (lagras i Durable Object-storage eller R2:s gratisnivå) och visa den stort på TV-vyn.
- [ ] P2 | S | Installbar som app (PWA-manifest + ikon) så buzzern kan ligga på hemskärmen.
- [ ] P2 | S | "Dubbla poäng"-joker: varje spelare kan använda en gång per kväll innan de buzzar.
- [ ] P3 | M | Vinnarens krona syns vid namnet på startsidan och i rummet nästa vecka (regerande kung).

## Teknik
- [ ] P2 | S | Rate-limit för buzz per anslutning (max ~5/s) så ingen kan spamma servern.

## Till PO

## Klart
- [x] 2026-10-27 | Grundversion: rum med kod, buzzer, svarstimer med straff, rätt/fel, TV-vy, hostkontroll, frågebank med snabbinklistring/JSON, säsongstabell, nästa quizdatum, e2e-test.
