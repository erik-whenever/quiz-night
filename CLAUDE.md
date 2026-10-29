# Kronan – veckans quiz för Erik och kompisarna

Webbapp där Erik är host (och ofta spelar själv) och kompisarna svarar från mobilen medan de pratar i Discord.
Målet varje vecka: kora en vinnare ("kröna kungen"). Appen utvecklas löpande av AI-rådet i `council/`.

## Stack (allt gratis)
- **Frontend:** React + Vite + TypeScript i `app/src/`
- **Backend:** Cloudflare Worker (`app/worker/`) med Durable Objects
  - `Room`: ett per rumskod. Servern är auktoritativ för urval av alternativ, nedräkning, rättning och poäng.
  - `Hub`: en global instans. Egen frågebank, säsongstabell, datum för nästa quiz.
- **Delade typer:** `app/shared/types.ts`, ändra här först när protokollet ändras.
- **Frågeset från rådet:** `app/quizzes/*.json` (byggs in i appen, visas som "från rådet").
- **Host-skydd:** secret `HOST_PIN` (lokalt i `app/.dev.vars`, i produktion via `wrangler secret put HOST_PIN`).

## Kommandon (kör i `app/`)
```
npm ci
npx tsc -b && npx tsc -p tsconfig.worker.json   # typkontroll klient + worker
npx vite build                                   # bygg till dist/
printf 'HOST_PIN=1234\n' > .dev.vars
npx wrangler dev --port 8787 --ip 127.0.0.1      # lokal server (kör i bakgrunden)
python3 tests/e2e.py http://127.0.0.1:8787 e2e-shots   # helt quizflöde i 4 webbläsare
```
E2E-testet måste vara grönt innan något mergas till `main`. Utöka det när du lägger till funktioner.
Titta på skärmdumparna i `e2e-shots/` efter UI-ändringar. Det är så rådet "testar som en människa".

## Produktion
- https://kronan.swing-check.workers.dev, publiceras av `.github/workflows/ci.yml` vid push till `main` och röktestas (`app/tests/smoke.py`).
- **Agenter når inte workers.dev** (sandlådans nätverk). Appens publika läge (nästa quiz, tabell) synkas till `council/hub.json` varje morgon av `.github/workflows/sync-hub.yml`.
- Extern data (spelstatistik m.m.): curl från sandlådan blockeras oftast. Använd WebFetch/WebSearch. Går inte det, lägg hämtningen i en GitHub Action (som `sync-hub.yml`) med ev. nycklar som repo-secrets, och checka in resultatet under `council/data/`.
- Cloudflares botskydd blockerar Pythons standard-User-Agent. Sätt alltid en webbläsarlik `User-Agent` i skript mot prod.

## Vyer
- `/` startsida (rumskod), `/play/KOD` spelare med svarsknappar, `/tv/KOD` skärmen som delas i Discord
- `/host` starta rum (PIN), `/host/KOD` hostkontroll (facit bara om värden inte spelar), `/bank` frågebank, `/tabell` säsong
- **TV-vyn får aldrig visa svaret innan reveal.** E2E-testet kontrollerar detta.

## Frågor (sedan 2026-10-29: alltid svarsalternativ, inga muntliga svar)
- Standard är **svarsalternativ**: `"answer"` + `"choices"` (rätt svar och gärna 7 fel, högst 12 totalt). Erik väljer i rummet hur många som visas (2–8, `choiceCount`), servern slumpar rätt + så många fel per fråga och rättar automatiskt.
- `"mode": "skill"` + `"skill": { "kind": "lasthit" | "aim" | "stopwatch" | "pour" | "order" }`: minispel i mobilen, 3/2/1 p efter placering. `stopwatch` tar `target` (s), `order` tar `items: [{label, value, show?}]` och `prompt` ("Äldst först"). Se `shared/skill.ts`.
- Frågor utan giltiga alternativ hoppas över när rummet skapas. Muntliga svar och fritextsvar ska inte tillbaka: buzzern finns, men svaret väljs alltid bland alternativen så att allt rättas automatiskt.
- **Spelande värd** (`hostPlays`, standard på): hostkontrollen får aldrig facit eller andras val, och läget kan bara stängas av i lobbyn. E2E kontrollerar detta.
- **Spelform** (`playMode`, standard "turns"): *Lagens tur* = varje alternativfråga går till ett lag (eller en spelare i alla mot alla), lagen roterar, laget snackar högt i Discord och vem som helst i laget låser svaret; rätt ger hela laget poäng, fel går bara vidare. *Buzzerfråga* var `buzzEvery`:e alternativfråga: först att buzza svarar, fel eller för långsamt kostar `penalty` för hela laget och låser ute, sedan kan andra buzza. "all" = alla svarar samtidigt. Skill-utmaningar spelar alltid alla.
- **Svårighet** `"difficulty"`: 1–5 per fråga (sätt alltid, och se till att varje set har frågor på alla nivåer, även 4–5). Värden drar ett reglage under kvällen: nästa fråga väljs närmast målet (0 = setets ordning, skill-utmaningar håller sin plats), och reglaget gör också frågan svårare med fler alternativ och kortare tid (`DIFFICULTY_TUNING` i shared/types.ts).
- Blanda gärna: ungefär en skill-utmaning per fem frågor.
- **Autoplay** (`autoplay`, standard på): kvällen sköter sig själv. Varje alternativfråga börjar med ett kort intro (`INTRO_MS`, svar ignoreras under tiden). När tiden är ute eller alla svarat visas svaret efter `JUDGE_PAUSE_MS`, och nästa fråga startar efter `revealSeconds` (väntar in ett lyckohjul som snurrar). Värden kan pausa, hoppa fram eller stänga av autoplay. Servern äger tidtagningen (`nextAt` i state).

## Lag och mynt
Hosten väljer i lobbyn alla mot alla eller lag om 2/3 (slumpas). Egna poäng samlas, men kvällens resultat är lagets **snitt**. Mynt (`shared/teams.ts`) tjänas på rätt svar, skill-vinster, tre rätt i rad och vinst. De sparas per spelarnamn i `Hub` och betalas ut vid kröningen. Butiken (Extra tid, 50/50, Dubbla poäng, Sabotage, Veto) är öppen i lobbyn; 50/50 används under en fråga.

## Design
Tv-studio-känsla: ultramarin (`--studio`), signalgult (`--signal`) för primära handlingar och alternativens bokstäver.
Typsnitt: Bricolage Grotesque (rubriker/siffror) och Familjen Grotesk (brödtext). Tokens finns i `app/src/index.css`.
Svarsknapparna i mobilen ska vara stora och tydliga (A–H, tangenterna funkar på dator). Håll resten lugnt. All UI-text på svenska.

## Regler för rådet och alla agenter
1. **Gratis först.** Allt som kostar pengar föreslås i `council/BEHOVER-ERIK.md` med pris/månad, vad det ger och ett gratisalternativ. Aldrig köpa något själv.
2. **Stanna bara för Erik när det verkligen krävs**, dvs. beslut som bara han kan ta, konton/nycklar, smak, eller personliga fakta om gänget. Allt annat avgörs självständigt och dokumenteras i `council/beslut.md`.
3. **Parallellisera** oberoende arbete (underagenter i separata worktrees).
4. Små, testade commits. Commit-meddelanden på svenska. Bryt aldrig `main`.
5. Lägg inga hemligheter, personnummer eller lösenord i repot.
