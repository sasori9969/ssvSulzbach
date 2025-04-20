// local-storage-utils.js

// Schlüssel für die verschiedenen Daten im localStorage
export const TEILNEHMER_KEY = 'ssv_teilnehmer';
export const TEAMS_KEY = 'ssv_teams';
export const ERGEBNISSE_KEY = 'ssv_ergebnisse';
// Füge hier bei Bedarf weitere Schlüssel hinzu (z.B. für Zuordnungen)

/**
 * Liest Daten aus dem localStorage.
 * @param {string} key Der Schlüssel, unter dem die Daten gespeichert sind.
 * @returns {Array} Ein Array mit den Daten oder ein leeres Array bei Fehlern oder wenn nichts gefunden wurde.
 */
export function getLocalData(key) {
    try {
        const data = localStorage.getItem(key);
        // Gib leeres Array zurück, wenn nichts da ist oder der Wert ungültig ist
        return data ? JSON.parse(data) : [];
    } catch (error) {
        console.error(`Fehler beim Lesen von ${key} aus localStorage:`, error);
        // Im Fehlerfall auch leeres Array zurückgeben, um Folgefehler zu vermeiden
        return [];
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
    return items
        .filter(item => !item._toBeRemoved) // Entferne als gelöscht markierte Items
        .map(item => {
            if (item._pendingSync) {
                item._syncStatus = 'synced'; // Setze Status auf 'synced'
                delete item._pendingSync;   // Entferne Hilfsflag
            }
            // Entferne sicherheitshalber auch _toBeRemoved, falls es noch existiert
            delete item._toBeRemoved;
            return item;
        });
}
