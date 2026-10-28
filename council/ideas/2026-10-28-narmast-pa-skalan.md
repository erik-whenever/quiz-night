# Närmast på skalan
**Typ:** ny spelrunda
**Inspiration:** Wavelength, där laget gissar var på en skala ett svar hamnar ([regler](https://gamerules.com/rules/wavelength/), [Wikipedia](https://wikipedia.com/wiki/Wavelength_(game)))
**Pitch:** Frågan har ett tal som svar ("Hur många meter är Kaknästornet?"). Alla drar samtidigt i ett reglage på mobilen och låser sin gissning innan tiden går ut. På TV-vyn landar allas nålar på en tallinje en i taget, sist kommer det rätta svaret. Närmast får 3 poäng, tvåan 1, och prick rätt ger bonus.
**Varför vi:** Ingen buzz-stress, så den som har sämre ping eller tänker långsamt är lika med. Avslöjandet på tallinjen blir ett naturligt skratt- och tjafsögonblick i Discord ("du gissade 40 meter??"). Passar som omväxling mellan buzzrundor.
**Insats:** M (nytt `"mode": "closest"` med `min`/`max`/`answer` i fråge-JSON, reglage i spelarvyn, animerad tallinje i TV-vyn, servern räknar avstånd)
**Kostnad:** gratis
**PO:** In i backlog, P1. Jämnar ut ping-fördelen och ger ett tydligt skrattögonblick på TV:n. Byggs efter "Alla svarar" och återanvänder samma `mode`-fält och hemliga svarsinsamling.
