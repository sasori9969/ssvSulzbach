// local-storage-utils.js

// Schlüssel für die verschiedenen Daten im localStorage
export const TEILNEHMER_KEY = 'ssv_teilnehmer';
export const TEAMS_KEY = 'ssv_teams';
export const ERGEBNISSE_KEY = 'ssv_ergebnisse';
export const LAST_SYNC_KEY = 'ssv_last_sync_timestamp'; // Zeitstempel des letzten erfolgreichen Syncs

/**
 * Liest Daten aus dem localStorage.
 * @param {string} key Der Schlüssel, unter dem die Daten gespeichert sind.
 * @returns {any} Die Daten oder null bei Fehlern oder wenn nichts gefunden wurde.
 *         Gibt für Array-Keys (Teilnehmer, Teams, Ergebnisse) ein leeres Array zurück, wenn der Wert ungültig ist.
 */
export function getLocalData(key) {
    try {
        const data = localStorage.getItem(key);
        if (data === null) {
            // Wenn der Schlüssel explizit nicht existiert, null zurückgeben
            // Außer für unsere Array-Daten, da wollen wir immer ein Array
            if ([TEILNEHMER_KEY, TEAMS_KEY, ERGEBNISSE_KEY].includes(key)) {
                return [];
            }
            return null;
        }
        // Wenn Daten vorhanden sind, versuchen zu parsen
        const parsedData = JSON.parse(data);

        // Für Array-Keys sicherstellen, dass es ein Array ist
        if ([TEILNEHMER_KEY, TEAMS_KEY, ERGEBNISSE_KEY].includes(key)) {
            return Array.isArray(parsedData) ? parsedData : [];
        }

        // Für andere Schlüssel (wie den Timestamp) den geparsten Wert zurückgeben
        return parsedData;

    } catch (error) {
        console.error(`Fehler beim Lesen von ${key} aus localStorage:`, error);
        // Im Fehlerfall für Arrays leeres Array, sonst null zurückgeben
        if ([TEILNEHMER_KEY, TEAMS_KEY, ERGEBNISSE_KEY].includes(key)) {
            return [];
        }
        return null;
    }
}

/**
 * Schreibt Daten in den localStorage.
 * @param {string} key Der Schlüssel, unter dem die Daten gespeichert werden sollen.
 * @param {any} data Die zu speichernden Daten (wird als JSON serialisiert).
 * @returns {boolean} True bei Erfolg, False bei Fehler.
 */
export function setLocalData(key, data) {
    try {
        // Stelle sicher, dass 'undefined' nicht gespeichert wird (führt zu Problemen beim Parsen)
        if (data === undefined) {
            console.warn(`Versuch, 'undefined' für Schlüssel ${key} zu speichern. Speichere stattdessen 'null'.`);
            data = null;
        }
        localStorage.setItem(key, JSON.stringify(data));
        return true;
    } catch (error) {
        console.error(`Fehler beim Schreiben von ${key} in localStorage:`, error);
        // Hier könntest du dem Nutzer eine Meldung anzeigen, falls das Speichern fehlschlägt
        // z.B. mit einer importierten UI-Funktion
        // zeigeStatus(`Konnte lokale Daten (${key}) nicht speichern!`, 'fehler');
        return false;
    }
}

/**
 * Generiert eine einfache, wahrscheinlich eindeutige lokale ID.
 * Für robustere Lösungen eine UUID-Bibliothek verwenden.
 * @returns {string} Eine lokale ID.
 */
export function generateLocalId() {
    // Einfache Kombination aus Zeitstempel und Zufallszahl
    return `local_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
}

/**
 * Bereinigt den Sync-Status und entfernt Hilfsflags von einem Array von Objekten.
 * Wird nach erfolgreichem Sync aufgerufen.
 * @param {Array<Object>} items Das Array der zu bereinigenden Items.
 * @returns {Array<Object>} Das bereinigte Array.
 */
export function finalizeLocalItems(items) {
    if (!Array.isArray(items)) {
        console.error("finalizeLocalItems erwartet ein Array, erhielt:", items);
        return []; // Leeres Array im Fehlerfall zurückgeben
    }
    return items
        .filter(item => item && !item._toBeRemoved) // Entferne als gelöscht markierte Items und null/undefined
        .map(item => {
            // Erstelle eine Kopie, um das Original nicht direkt zu mutieren (falls es noch woanders verwendet wird)
            const newItem = { ...item };
            if (newItem._pendingSync) {
                newItem._syncStatus = 'synced'; // Setze Status auf 'synced'
                delete newItem._pendingSync;   // Entferne Hilfsflag
            }
            // Entferne sicherheitshalber auch _toBeRemoved, falls es noch existiert
            delete newItem._toBeRemoved;
            return newItem;
        });
}
