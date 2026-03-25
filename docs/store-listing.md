# Chrome Web Store – butikslistning

## Namn
ICA Prisjämförelse

## Kort beskrivning (max 132 tecken)
Jämför din ICA-varukorg mellan alla butiker med hemleverans och öppna korgen hos den billigaste.

## Detaljerad beskrivning
Har du undrat om din ICA-varukorg skulle bli billigare i en annan butik? ICA Prisjämförelse jämför automatiskt din nuvarande varukorg mot alla ICA-butiker med hemleverans i ditt postnummerområde — och visar exakt hur mycket du kan spara.

**Hur det fungerar:**
1. Logga in på handlaprivatkund.ica.se och lägg varor i din varukorg som vanligt
2. Ange ditt postnummer i extensionen
3. Klicka "Jämför priser" — extensionen hämtar priser från alla tillgängliga butiker
4. Se rankat vilken butik som är billigast för just din varukorg
5. Klicka "Öppna billigaste varukorg" för att automatiskt bygga om din korg hos den butiken

**Funktioner:**
• Jämför totalpriset för hela din varukorg — inte bara enskilda produkter
• Visar kampanjpriser och stammisrabatter
• Ser vilka varor som saknas i respektive butik
• Öppnar och bygger om varukorgen med ett klick
• All data stannar i din webbläsare — inget skickas till externa servrar

**Integritet:**
Extensionen läser din inloggade ICA-session för att hämta din varukorg och prisdata. Denna information används uteslutande för att visa prisjämförelsen och lämnar aldrig din webbläsare. Endast ditt postnummer och butiks-ID sparas lokalt mellan sessioner.

## Kategori
Produktivitet / Shopping

## Behörighetsmotivering (fylls i i granskningsformuläret)

**scripting + host permissions (handlaprivatkund.ica.se):**
The extension reads the user's own shopping cart and price data from their authenticated ICA session on handlaprivatkund.ica.se. This is the core functionality — comparing grocery prices across stores. The scripting permission is used to run same-origin fetch requests within the user's ICA tab to access ICA's own APIs on behalf of the user. No data is transmitted to external servers.

**tabs:**
Used solely to identify the user's open ICA tab so the price comparison can be run in the correct context.

**storage:**
Used to save the user's postal code and store ID locally between sessions, so they don't have to re-enter it each time.

**windows:**
Used to bring the user's existing ICA browser tab to the foreground when "Öppna billigaste varukorg" is clicked, so the user can see the cart being rebuilt without having to manually switch windows.
