# Backlogg

Format: `- [ ] P1 | S/M/L | Titel: vad + acceptanskriterie`. `[~]` = pågår (datum), `[x]` = klar (datum).
Produktägaren äger ordningen i **Redo**. Utvecklingsansvarig äger status.

## Quiz
- [x] 2026-10-28 | QUIZ: Fredagsquiz till 2026-10-30. Set `app/quizzes/2026-10-30-fredagsquiz.json` (20 frågor) klart. 2026-10-29: 3 personliga frågor (f21–f23) tillagda. Quizresearchern: lägg gärna till 3–5 personliga "Gänget i siffror"-frågor sist om statistik hittas senast torsdag, annars rör inte setet.
- KODFRYS: 2026-10-30 (quizdag). Utvecklingsansvarig mergar inget till `main` den dagen.
- [x] 2026-10-28 | DEMO: `app/quizzes/2026-10-demo-allmanbildning.json` (20 lätta–medel allmänfrågor) för en testkväll med gänget så snart som möjligt. Feedbacken hamnar i `council/feedback.md`.

## Redo
- [ ] P1 | M | Rundtyp "Vem sa det?" (citat): `"mode": "quote"` med `quote`, `answer` (karaktär) och valfria `choices` (4 alternativ). Med `choices` återanvänds Svarsalternativ (`mode: "choice"`, klart 2026-10-29). Utan `choices` är det vanlig buzz. TV-vyn visar citatet stort i citattecken med serien dold till reveal. Gänget älskar tv-seriecitat (Breaking Bad, GoT, HIMYM). Klart när e2e kör en citatfråga med alternativ och rätt spelare får poäng.
- [ ] P1 | M | Rundtyp "Närmast på skalan": `"mode": "closest"` med `min`/`max`/`answer` i fråge-JSON (och valbar i frågebanken). Alla drar ett reglage på mobilen och låser sin gissning före tidens slut; TV:n visar allas nålar på en tallinje en i taget och sist rätt svar. Närmast 3 p, tvåa 1 p, prick rätt +2 bonus. Servern räknar avstånd. Klart när e2e låter tre spelare gissa olika tal, rätt spelare får 3 p och TV-vyn inte visar svaret före reveal.
- [ ] P2 | S | Kvällens pris: efter sista frågan röstar alla på mobilen i två kategorier (standard "Kvällens fail" och "Modigaste chansningen", hosten kan byta namn). En röst per spelare och kategori, inte på sig själv. TV-vyn visar vinnarna som prisutdelning och utmärkelsen sparas i `Hub` och syns vid namnet i `/tabell`. Klart när e2e röstar med fyra spelare och priset syns i tabellen.
- [ ] P2 | M | Fallande poäng (På spåret): `"clues": [...]` i fråge-JSON med poängtrappa (standard 10/8/6/4/2). Hosten släpper nästa ledtråd med en knapp, TV-vyn visar ledtrådarna och aktuell poäng. Varje spelare får bara ett försök per fråga, servern låser den som gissat fel. Klart när e2e visar att en spelare som buzzar på ledtråd 2 får 8 p och en som gissat fel inte kan buzza igen.
- [ ] P1 | S | Kungasatsningen (idé 2026-10-29): fråga med `"final": true` får fasen "satsa" före frågan. TV-vyn visar bara kategorin, varje spelare satsar i hemlighet 0–sin poäng med ett reglage på mobilen, sedan svarar alla samtidigt (återanvänd insamlingen från "Alla svarar"), hosten markerar rätt och servern räknar ±insats. TV-vyn avslöjar insats och utfall en spelare i taget från sista plats och uppåt. Insatser syns aldrig på TV:n före avslöjandet. Klart när e2e låter tre spelare satsa olika, en rätt och två fel, och tabellen stämmer efteråt. Byggs efter "Alla svarar".
- [ ] P2 | M | Bluffrundan (idé 2026-10-29, à la Fibbage): `"mode": "bluff"` med `question` och `answer`. Fas 1: alla skriver i hemlighet ett falskt svar på mobilen. Fas 2: TV-vyn visar alla svar plus det riktiga blandat och anonymt, alla röstar på mobilen (inte på sitt eget, dubbletter av rätt svar slås ihop med det rätta). Rätt röst 2 p, 1 p per kompis som gick på ens lögn. Reveal visar vem som skrev vad. Klart när e2e kör en bluffråga med fyra spelare och poängen blir rätt. Byggs efter "Alla svarar".
- [ ] P3 | M | Regerande kung + Kungens fråga (idé 2026-10-29): vinnarens krona syns vid namnet på startsidan, i rummet och i `/tabell` till nästa quiz. Den regerande kungen (spelarnamn som vann senaste kvällen i `Hub`, identifieras med namnet som skrivs vid inloggning) får knappen "Skriv kungens fråga" på startsidan; frågan sparas i `Hub`, visas i hostkontrollen märkt med krona och TV-vyn visar "Kungens fråga från <namn>". Kungen kan inte buzza på den; svarar ingen rätt får kungen 2 p. Klart när e2e skriver en kungens fråga, kör den och kungens buzz spärras.

## Parkerat
- P2 | M | Bildfrågor (kräver lagring, tas upp när rundtyperna är klara).
- P2 | S | "Dubbla poäng"-joker (överlappar Lyckohjulets twistar och Kungasatsningen; tas upp om hjulet inte täcker det).

## Research (Quizresearchern)
- [~] 2026-10-29 P1 | M | Undersök statistikkällor för gänget (kartlagt i `council/statistik.md`, Steam-profiler hämtas av `sync-stats.yml`, 3 frågor i fredagsquizet; väntar på Steam-nyckel/HoN-svar för setet): (1) HoN Reborn, finns ett publikt API eller en sajt med matchhistorik per användarnamn? (2) CS2, Steam Web API `GetUserStatsForGame` (appid 730, kräver gratis Steam-nyckel → be Erik skaffa via steamcommunity.com/dev/apikey) samt t.ex. Leetify/csstats. Dokumentera i `council/statistik.md`: vad går att hämta, hur, vad det kostar. Gör sedan ett set "Gänget i siffror" med 5–8 personliga frågor.

## Teknik
- [ ] P3 | S | Småfynd från Testaren 2026-10-29: (1) Alla svarar: kontrollera "alla har svarat" även vid nedkoppling/kick, och räkna bara anslutna i "X av N har svarat". (2) Lyckohjul: spärra "Nästa fråga"/N medan hjulet snurrar; spelarvyns "Fel kostar 1 p" och hostens "Rätt ger 1 p" ska följa twisten. (3) Spelarvyn i reveal: nedräkning "0" och svarsfält ligger kvar för den som buzzade (`myBuzz` borde kräva `phase === "buzzed"`).

## Till PO
- ~~2026-10-28 Utvecklingsansvarig: "Testa gärna" (buzz-känsla, vibration, hemskärm)~~ → 2026-10-29 PO: lagt som frågor i `feedback.md` under Fredagsquiz 30 okt, testas på riktigt på quizkvällen.

## Klart
- [x] 2026-10-29 | Eriks önskemål: buzz ger bara ordet, hosten dömer Rätt/Fel/För långsam (ingen auto-timeout). Ny rundtyp Svarsalternativ (`mode: "choice"`) i mobilen, valbar i frågebanken och snabbinklistringen (`| alt | A; B; C`). 4 frågor i fredagsquizet är alternativfrågor.
- [x] 2026-10-29 | Lyckohjul (Eriks önskemål 2026-10-28): ett hjul som snurrar på TV-vyn ska in i spelet. **Rådet väljer själv var det passar bäst** (t.ex. hjulet väljer kategori, en twist för nästa fråga som dubbla poäng/ingen straffavgift/stjäl poäng/en av de nya rundtyperna, ett straffhjul vid fel svar, eller hjulet väljer spelare) och dokumenterar valet i `beslut.md`. Krav: servern slumpar utfallet (klienten bara animerar), utfallet syns på TV-vyn och i spelarvyn, hosten kan snurra från hostkontrollen. Klart när e2e snurrar hjulet och utfallet påverkar nästa fråga enligt valt upplägg.
- [x] 2026-10-29 | Rundtyp "Alla svarar": varje spelare skriver ett svar i hemlighet, hosten markerar rätt i en lista, snabbast rätt får bonus. Sätts per fråga (`"mode": "all"` i JSON) och kan väljas i frågebanken.
- [x] 2026-10-29 | Rate-limit för buzz per anslutning (max ~5/s) så ingen kan spamma servern.
- [x] 2026-10-28 | Rättvis buzz över Discord: mät varje spelares ping (finns redan i `useRoom` som klockoffset) och låt servern vänta ~150 ms efter första buzz och välja den med lägst *justerad* tid. Klart när e2e simulerar två nästan samtidiga buzzar och rätt spelare vinner.
- [x] 2026-10-28 | Vibration och ljudfeedback: på mobilen vid buzz/rätt/fel (`navigator.vibrate`). Klart när det fungerar i Android Chrome och inte kraschar i iOS Safari.
- [x] 2026-10-28 | Installbar som app: PWA-manifest + ikon, så buzzern kan ligga på hemskärmen.
- [x] 2026-10-27 | Grundversion: rum med kod, buzzer, svarstimer med straff, rätt/fel, TV-vy, hostkontroll, frågebank med snabbinklistring/JSON, säsongstabell, nästa quizdatum, e2e-test.
