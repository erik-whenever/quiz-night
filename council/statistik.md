# Statistikkällor för gänget

Quizresearcherns kartläggning (2026-10-29). Allt gratis. Agenternas sandlåda når inte Steam eller statistiksajterna direkt, så datan hämtas av GitHub Action `sync-stats.yml` (torsdagar + manuellt) och checkas in under `council/data/`.

## CS2 (Steam)
| Källa | Vad | Kostnad | Status |
|---|---|---|---|
| Steam-profilens publika XML (`steamcommunity.com/profiles/<id>/?xml=1`, `/games?tab=all&xml=1`) | Steam-namn, CS2-timmar totalt och senaste 2 veckorna, mest spelade spel | Gratis, ingen nyckel | Hämtas av `sync-stats.yml` → `council/data/steam.json`. Kräver att profil + speldetaljer är publika. |
| Steam Web API `GetUserStatsForGame` (appid 730) | Livstidsstatistik: kills, deaths, headshots, vinster, per vapen/karta | Gratis nyckel (steamcommunity.com/dev/apikey) | Ej påbörjat. Ger bäst frågor ("Vem har flest headshots?"). Fråga till Erik om nyckel när XML-datan är testad. |
| Leetify / csstats.gg / csdb.gg | Matchhistorik, rating per match | Gratis att titta | Sidorna renderas med JS eller kräver att agenten fått URL:en av Erik. Inget öppet API utan nyckel. |

## HoN Reborn
| Källa | Vad | Status |
|---|---|---|
| WardUp (ward-up.com) | Tracker för HoN Reborn: spelarstatistik, MMR, KDR, GPM, matchhistorik, topplistor | Ingen dokumenterad API. `sync-stats.yml` sparar startsidan och provar spelarsidor (`council/data/hon-wardup.json`, rådata i `council/data/raw/`) för att hitta URL-mönster/JSON-API. |
| honstats.com ("HoN Reborn Statistics Platform") | Statistik för Reborn | robots.txt stoppar hämtning. Inte använd. |
| Gamla `api.heroesofnewerth.com` | Statistik-API för original-HoN (nedlagt 2022) | Gäller inte Reborn. |

## Läge
- 2026-10-29: Ingen statistik hämtad än, så fredagsquizet 2026-10-30 får inga "Gänget i siffror"-frågor (setet rörs inte, enligt backloggen). Nästa körning läser `council/data/` och bygger setet "Gänget i siffror" när datan finns.
- Frågor formuleras med spelarnamnen (kopplingen namn ↔ konto saknas, se `BEHOVER-ERIK.md`).
