# Behöver Erik

Svara direkt i filen på github.com (pennan uppe till höger) under **Svar:**, eller säg till i chatten. Max 3 öppna frågor åt gången.

## 2026-10-27: Publicera appen (krävs, ca 5 min, gratis)
Appen körs på Cloudflares gratisnivå. Det behövs ett konto och tre hemligheter i GitHub, sedan publicerar varje push till `main` sig själv.
1. Skapa gratiskonto på dash.cloudflare.com.
2. **My Profile → API Tokens → Create Token → mallen "Edit Cloudflare Workers"** → Create. Kopiera token.
3. Kopiera ditt **Account ID** (står i högerspalten på Workers & Pages-översikten).
4. I repot på GitHub: **Settings → Secrets and variables → Actions → New repository secret**, lägg till:
   - `CLOUDFLARE_API_TOKEN` = token från steg 2
   - `CLOUDFLARE_ACCOUNT_ID` = id från steg 3
   - `HOST_PIN` = valfri PIN du använder för att låsa upp host-läget
5. Skriv "klart" nedan. Adressen blir `https://kronan.<ditt-subdomännamn>.workers.dev`.

**Svar:**

## 2026-10-28: Era spelarnamn i HoN Reborn och CS2
Erik svarade 2026-10-28: HoN Reborn mest, en del CS2. Frågor om mat, tv-serier och citat (se `council/gänget.md`).
Nästa steg för personliga frågor, t.ex. "vem har flest kills senaste månaden?":
- **HoN Reborn:** allas användarnamn i spelet
- **CS2:** allas Steam-profillänk. Profilen och "Game details" måste vara **publika** i Steams sekretessinställningar.
- Gärna vad ni heter i Discord/smeknamn, så frågorna blir rätt.

**Svar:**
