// /workspaces/ssvSulzbach/auto-sync.js
import { synchronizeAllData } from './sync-manager.js';
import { getLocalData, LAST_SYNC_KEY } from './local-storage-utils.js';

// --- Konfiguration ---
const AUTO_SYNC_INTERVAL = 15 * 60 * 1000; // 15 Minuten
// const AUTO_SYNC_INTERVAL = 30 * 1000; // 30 Sekunden zum Testen
const AUTO_SYNC_START_DELAY = 10 * 1000; // 10 Sekunden Verzögerung nach dem Laden einer Seite

// --- Verhindern mehrerer Intervalle ---
// Globale Variable, um sicherzustellen, dass der Timer nur einmal gestartet wird.
if (!window.autoSyncTimerId) {
    console.log("Initialisiere automatische Hintergrund-Synchronisation...");

    // Funktion für den Hintergrund-Sync-Check
    const performBackgroundSync = async () => {
        console.log("Automatischer Sync-Check gestartet (Hintergrund)...");
        try {
            // Führe den Sync "im Hintergrund" aus (ohne UI-Statusmeldungen)
            const syncSuccess = await synchronizeAllData(false); // false = keine UI-Meldungen

            // Wenn der Sync erfolgreich war UND die Admin-Seite offen ist,
            // aktualisiere dort den Zeitstempel.
            if (syncSuccess) {
                const adminLastSyncSpan = document.getElementById('lastSyncTime'); // Prüfe, ob das Element existiert
                if (adminLastSyncSpan) {
                    const lastSyncTimestamp = getLocalData(LAST_SYNC_KEY);
                    if (lastSyncTimestamp) {
                        try {
                            const date = new Date(lastSyncTimestamp);
                            adminLastSyncSpan.textContent = date.toLocaleString('de-DE');
                        } catch (e) {
                            adminLastSyncSpan.textContent = "Ungültiges Datum";
                        }
                    } else {
                        adminLastSyncSpan.textContent = "Noch nie synchronisiert";
                    }
                }
            }
        } catch (error) {
            console.error("Fehler während des automatischen Hintergrund-Sync:", error);
            // Keine UI-Meldung anzeigen, nur loggen.
        }
    };

    // Starte das Intervall nach einer kurzen Verzögerung
    setTimeout(() => {
        console.log(`Starte automatischen Sync alle ${AUTO_SYNC_INTERVAL / 60000} Minuten.`);
        // Speichere die Intervall-ID global, um mehrfaches Starten zu verhindern
        window.autoSyncTimerId = setInterval(performBackgroundSync, AUTO_SYNC_INTERVAL);

        // Optional: Führe einen ersten Sync kurz nach dem Laden *irgendeiner* Seite durch.
        // Überlege, ob dies gewünscht ist oder ob der initiale Sync in adminOnly.html reicht.
        // performBackgroundSync(); // Einkommentieren für initialen Sync auf jeder Seite

    }, AUTO_SYNC_START_DELAY);

} else {
    console.log("Automatische Synchronisation bereits initialisiert.");
}
