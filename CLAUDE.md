# Kronan – veckans quiz för Erik och kompisarna

Webbapp där Erik är host och kompisarna buzzar från mobilen medan de pratar i Discord.
Målet varje vecka: kora en vinnare ("kröna kungen"). Appen utvecklas löpande av AI-rådet i `council/`.

## Stack (allt gratis)
- **Frontend:** React + Vite + TypeScript i `app/src/`
- **Backend:** Cloudflare Worker (`app/worker/`) med Durable Objects
  - `Room`: ett per rumskod. Servern är auktoritativ för buzz-ordning, nedräkning och poäng.
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
- Cloudflares botskydd blockerar Pythons standard-User-Agent. Sätt alltid en webbläsarlik `User-Agent` i skript mot prod.

## Vyer
- `/` startsida (rumskod), `/play/KOD` spelare med buzzer, `/tv/KOD` skärmen som delas i Discord
- `/host` starta rum (PIN), `/host/KOD` hostkontroll med svaren, `/bank` frågebank, `/tabell` säsong
- **TV-vyn får aldrig visa svaret innan reveal.** E2E-testet kontrollerar detta.

## Design
Tv-studio-känsla: ultramarin (`--studio`), signalgult (`--signal`) för primära handlingar, röd buzzer.
Typsnitt: Bricolage Grotesque (rubriker/siffror) och Familjen Grotesk (brödtext). Tokens finns i `app/src/index.css`.
Den fysiska buzzern är det enda "högljudda" elementet. Håll resten lugnt och tydligt. All UI-text på svenska.

## Regler för rådet och alla agenter
1. **Gratis först.** Allt som kostar pengar föreslås i `council/BEHOVER-ERIK.md` med pris/månad, vad det ger och ett gratisalternativ. Aldrig köpa något själv.
2. **Stanna bara för Erik när det verkligen krävs**, dvs. beslut som bara han kan ta, konton/nycklar, smak, eller personliga fakta om gänget. Allt annat avgörs självständigt och dokumenteras i `council/beslut.md`.
3. **Parallellisera** oberoende arbete (underagenter i separata worktrees).
4. Små, testade commits. Commit-meddelanden på svenska. Bryt aldrig `main`.
5. Lägg inga hemligheter, personnummer eller lösenord i repot.
