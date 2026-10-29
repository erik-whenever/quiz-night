# Beslut

Rådets egna beslut, nyast överst. Eriks svar flyttas hit från BEHOVER-ERIK.md.

- **2026-10-29: Spelstatistik hämtas av GitHub Action `sync-stats.yml`** (sandlådan når inte Steam). Bara publik, dokumenterad data utan nycklar: Steam-profilernas XML. WardUps interna API används inte utan tillstånd (frågat Erik). Fredagsquizet fick 3 personliga frågor om Steam-kontonas ålder, med Steam-namn eftersom kopplingen till riktiga namn saknas.
- **2026-10-29: Kungasatsningen P1 före Bluffrundan.** Den passar kvällens mål (kröna en kung) och håller spänningen till sista frågan. Båda bygger på den hemliga svarsinsamlingen från "Alla svarar", som därför byggs först. Bildfrågor och "Dubbla poäng"-joker parkeras (jokern överlappar Lyckohjulet och satsningen).

- **2026-10-28 (Erik):** Gänget spelar främst HoN Reborn, en del CS2. Vill ha allmänna frågor, mycket mat, mycket tv-serier och citat (Breaking Bad, GoT, HIMYM m.fl.). Sparat i `council/gänget.md`. Quizresearchern bygger nu ett lager av temaset även när inget quiz är beställt, och "Vem sa det?" lades in som P1.
- **2026-10-28 (Erik):** Cloudflare-hemligheterna (`CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `HOST_PIN`) ligger i GitHub. Varje push till `main` publicerar appen.
- **2026-10-28 (Erik):** Gav HoN Reborn-namn och Steam-id för fem spelare, se `council/gänget.md`. Quizresearchern ska undersöka gratis statistikkällor för båda spelen.

- **2026-10-28: Rättvis buzz med 150 ms fönster och max 70 ms kompensation.** Servern mäter själv varje anslutnings ping (sping/spong, bara äkta svar godtas, lägsta av 5 senaste) och väljer lägst justerad tid inom 150 ms efter första buzz. Kompensationen är RTT/2 + 25 ms men högst 70 ms (`BUZZ_MAX_COMP_MS`). Kvarvarande risk som accepteras: den som fuskar via devtools kan vinna nära-lika buzzar med upp till ~70 ms (25 ms bara genom att fejka tidsstämpeln). Det är en rimlig kompromiss i ett kompisquiz; varje buzz syns ~150 ms senare.
- **2026-10-28: PWA utan cache.** Service workern släpper igenom allt (ingen `respondWith`) så att en ny deploy aldrig fastnar och websockets/API inte påverkas. Ikoner ritas med `app/scripts/ikoner.py` (Pillow), inga nya npm-paket.
- **2026-10-28: Vibration bara för spelarens egna händelser**, ljud för alla. Funktionsdetekteras så iOS Safari (saknar vibrate) inte kraschar.

- **2026-10-28: Nya rundtyper byggs på samma `mode`-fält i fråge-JSON** (`all`, `closest`, senare `clues`). "Alla svarar" byggs före "Närmast på skalan" så den hemliga svarsinsamlingen kan återanvändas. Fler rundtyper som inte gynnar låg ping prioriteras, eftersom gänget spelar över Discord.
- **2026-10-27: Cloudflare Workers + Durable Objects i stället för Firebase/Supabase.** Gratis, pausar aldrig (Supabase gratisprojekt pausas efter en veckas inaktivitet), och en auktoritativ server per rum avgör buzz-ordning och nedräkning rättvist. Hela stacken kan dessutom köras lokalt för automatiska tester.
- **2026-10-27: Tre separata vyer (TV / host / spelare).** Erik skärmdelar TV-vyn i Discord. Hostkontrollen visar svaren och delas aldrig.
- **2026-10-27: Rådets minne och kommunikation via filer i repot**, inte GitHub Issues. Enklast för agenter att läsa och skriva, och Erik kan svara direkt på github.com.
- **2026-10-27: Erik gav rådet mandat** att arbeta självständigt, parallellisera och bara stanna för input eller tester som kräver honom. Gratis föredras alltid. Kostnader föreslås med pris och motivering.
