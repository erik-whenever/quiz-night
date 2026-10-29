# Statistikkällor för gänget

Quizresearcherns kartläggning (2026-10-29). Allt gratis. Agenternas sandlåda når inte Steam eller statistiksajterna direkt, så datan hämtas av GitHub Action `sync-stats.yml` (torsdagar + manuellt) och checkas in under `council/data/`.

## CS2 (Steam)
| Källa | Vad | Kostnad | Status |
|---|---|---|---|
| Steam-profilens publika XML (`steamcommunity.com/profiles/<id>/?xml=1`) | Steam-namn, när kontot skapades, timmar senaste 2 veckorna | Gratis, ingen nyckel | **Fungerar.** Hämtas av `sync-stats.yml` → `council/data/steam.json`. Alla fem profiler är publika. |
| Steam-spellistan (`/games?tab=all&xml=1`) | Timmar per spel (CS2 totalt) | Gratis | Kräver numera inloggning, går inte utan nyckel. |
| Steam Web API `GetOwnedGames` + `GetUserStatsForGame` (appid 730) | CS2-timmar och livstidsstatistik: kills, deaths, headshots, vinster, per vapen/karta | Gratis nyckel (steamcommunity.com/dev/apikey) | Väntar på nyckel från Erik (se `BEHOVER-ERIK.md`). Ger bäst frågor. |
| Leetify / csstats.gg / csdb.gg | Matchhistorik, rating per match | Gratis att titta | Inget öppet API utan nyckel. Inte använd. |

## HoN Reborn
| Källa | Vad | Status |
|---|---|---|
| WardUp (ward-up.com) | Tracker för HoN Reborn: profil, MMR, KDR, GPM, matchhistorik, topplistor. Spelarsidor: `ward-up.com/player/<namn>` (renderas med JS) | Inget **dokumenterat** publikt API. Rådet använder inte odokumenterade interna API:er utan tillstånd. Fråga till Erik i `BEHOVER-ERIK.md`. |
| honstats.com | Statistik för Reborn | robots.txt stoppar hämtning. Inte använd. |
| Gamla `api.heroesofnewerth.com` | Statistik-API för original-HoN (nedlagt 2022) | Gäller inte Reborn. |

## Läge
- 2026-10-29: Steam-profildata hämtad. Fredagsquizet 2026-10-30 fick 3 "Gänget i siffror"-frågor (f21–f23) om Steam-kontonas ålder, formulerade med Steam-namn.
- Nästa steg: Steam-nyckel → CS2-frågor (timmar, headshots). HoN-frågor när Erik svarat om WardUp.
