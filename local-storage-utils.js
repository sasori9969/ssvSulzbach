// /workspaces/ssvSulzbach/local-storage-utils.js

// --- Konstanten für Local Storage Keys ---
export const TEILNEHMER_KEY = "teilnehmerListe_v2";
export const TEAMS_KEY = "teamsListe_v2";
export const ERGEBNISSE_KEY = "ergebnisseListe_v2";
export const PAYMENT_STATUS_KEY = "paymentStatus_v2";
export const WETTKAMPF_KEY = "wettkampfData_v1"; // Key für scheibenErfassen.html
export const LAST_SYNC_KEY = "lastSyncTimestamp";

// Array mit allen relevanten Daten-Keys für Lösch- und Sync-Operationen
export const ALL_KEYS = [
    TEILNEHMER_KEY,
    TEAMS_KEY,
    ERGEBNISSE_KEY,
    PAYMENT_STATUS_KEY,
    WETTKAMPF_KEY // WETTKAMPF_KEY hinzugefügt
];

// --- Hilfsfunktionen ---

/**
 * Holt Daten aus dem Local Storage und parsed sie als JSON.
 * Gibt ein leeres Array zurück, wenn der Key nicht existiert oder der Wert ungültig ist (außer für spezielle Keys).
 * @param {string} key Der Local Storage Key.
 * @returns {any} Die geparsten Daten oder ein Standardwert (meist []).
 */
export function getLocalData(key) {
  try {
    const data = localStorage.getItem(key);
    if (data === null) {
      // Spezielle Behandlung für Keys, die Objekte sein können oder null/string
      if (key === LAST_SYNC_KEY) return null;
      if (key === PAYMENT_STATUS_KEY) return {}; // Leeres Objekt für Zahlungsstatus
      if (key === WETTKAMPF_KEY) return null; // Null für Wettkampfdaten
      return []; // Standard: leeres Array
    }
    // Für Zahlungsstatus und Wettkampfdaten direkt das Objekt zurückgeben
    if (key === PAYMENT_STATUS_KEY || key === WETTKAMPF_KEY) {
        return JSON.parse(data);
    }
    // Für Zeitstempel den String zurückgeben
    if (key === LAST_SYNC_KEY) {
        return data;
    }
    // Für Listen (Teilnehmer, Teams, Ergebnisse)
    const parsedData = JSON.parse(data);
    return Array.isArray(parsedData) ? parsedData : [];

  } catch (error) {
    console.error(`Fehler beim Lesen von Local Storage Key "${key}":`, error);
    // Standardwerte bei Fehler
    if (key === LAST_SYNC_KEY) return null;
    if (key === PAYMENT_STATUS_KEY) return {};
    if (key === WETTKAMPF_KEY) return null;
    return [];
  }
}

/**
 * Speichert Daten im Local Storage als JSON-String.
 * @param {string} key Der Local Storage Key.
 * @param {any} data Die zu speichernden Daten.
 * @returns {boolean} True bei Erfolg, False bei Fehler.
 */
export function setLocalData(key, data) {
  try {
    // Zeitstempel direkt als String speichern
    if (key === LAST_SYNC_KEY && typeof data === 'string') {
        localStorage.setItem(key, data);
    } else {
        localStorage.setItem(key, JSON.stringify(data));
    }
    return true;
  } catch (error) {
    console.error(`Fehler beim Schreiben von Local Storage Key "${key}":`, error);
    // Hier könnte man spezifischer auf Quota-Fehler reagieren
    if (error.name === 'QuotaExceededError') {
      alert("Speicherplatz im Browser ist voll! Daten konnten nicht gespeichert werden.");
    }
    return false;
  }
}

/**
 * Generiert eine einfache lokale ID (Zeitstempel + Zufallszahl).
 * @returns {string} Eine lokale ID.
 */
export function generateLocalId() {
  return `local_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
}

/**
 * Aktualisiert lokale Elemente nach einer erfolgreichen Synchronisation.
 * Setzt firestoreId, ändert _syncStatus von 'new' zu 'synced' und entfernt 'deleted' Elemente.
 * @param {string} key Der Local Storage Key der zu aktualisierenden Liste.
 * @param {Array<{localId: string, firestoreId: string}>} syncedItems Eine Liste von Objekten mit localId und der neuen firestoreId.
 * @returns {boolean} True bei Erfolg, False bei Fehler.
 */
export function finalizeLocalItems(key, syncedItems) {
  try {
    const localData = getLocalData(key);
    const syncedMap = new Map(syncedItems.map(item => [item.localId, item.firestoreId]));
    let changed = false;

    // Filtere 'deleted' Elemente heraus und aktualisiere 'new' Elemente
    const updatedData = localData.filter(item => {
      if (item._syncStatus === 'deleted') {
        changed = true;
        return false; // Entfernen
      }
      return true;
    }).map(item => {
      if (item._syncStatus === 'new' && syncedMap.has(item.localId)) {
        item.firestoreId = syncedMap.get(item.localId);
        item._syncStatus = 'synced';
        changed = true;
      } else if (item._syncStatus === 'modified') {
        // Nach erfolgreichem Update in Firestore wird der Status wieder 'synced'
        item._syncStatus = 'synced';
        changed = true;
      }
      return item;
    });

    if (changed) {
      return setLocalData(key, updatedData);
    }
    return true; // Nichts geändert, aber kein Fehler
  } catch (error) {
    console.error(`Fehler beim Finalisieren von Local Storage Key "${key}":`, error);
    return false;
  }
}


/**
 * Löscht alle wettkampfspezifischen Daten aus dem Local Storage.
 * @param {string[]} [keysToClear=ALL_KEYS] Die Liste der zu löschenden Keys. Standardmäßig alle definierten Daten-Keys.
 * @returns {boolean} True bei Erfolg, False bei Fehler.
 */
export function clearLocalStorageData(keysToClear = ALL_KEYS) {
  try {
    console.log("Lösche lokale Wettkampfdaten...");
    keysToClear.forEach(key => {
      localStorage.removeItem(key);
      console.log(`  - Lokaler Key entfernt: ${key}`);
    });
    // Auch den Sync-Zeitstempel entfernen
    localStorage.removeItem(LAST_SYNC_KEY);
    console.log(`  - Lokaler Key entfernt: ${LAST_SYNC_KEY}`);
    return true;
  } catch (error) {
    console.error("Fehler beim Löschen der Local Storage Daten:", error);
    return false;
  }
}

// --- Hilfsfunktionen für aktiven Daten ---

/**
 * Generische Funktion zum Holen aktiver (nicht gelöschter) Elemente.
 * @param {string} key Der Local Storage Key.
 * @returns {Array<any>} Ein Array mit aktiven Elementen.
 */
function getActiveItems(key) {
    const items = getLocalData(key);
    if (!Array.isArray(items)) {
        console.warn(`Daten für Key "${key}" sind kein Array.`);
        return [];
    }
    return items.filter(item => item._syncStatus !== 'deleted');
}

/**
 * Holt alle aktiven Teilnehmer (nicht als gelöscht markiert).
 * @returns {Array<object>} Ein Array mit aktiven Teilnehmer-Objekten.
 */
export function getActiveTeilnehmer() {
    return getActiveItems(TEILNEHMER_KEY);
}

/**
 * Holt alle aktiven Teams (nicht als gelöscht markiert).
 * @returns {Array<object>} Ein Array mit aktiven Team-Objekten.
 */
export function getActiveTeams() {
    return getActiveItems(TEAMS_KEY);
}

/**
 * Holt alle aktiven Ergebnisse (nicht als gelöscht markiert).
 * Sortiert nach Erstellungsdatum (createdAt) absteigend.
 * @returns {Array<object>} Ein Array mit aktiven Ergebnis-Objekten, sortiert.
 */
export function getActiveErgebnisse() {
    const ergebnisse = getActiveItems(ERGEBNISSE_KEY);
    // Sortieren nach Datum (neueste zuerst)
    ergebnisse.sort((a, b) => {
        const dateA = a.createdAt ? new Date(a.createdAt) : 0;
        const dateB = b.createdAt ? new Date(b.createdAt) : 0;
        return dateB - dateA; // Absteigend sortieren
    });
    return ergebnisse;
}


// --- Hilfsfunktionen zum Erstellen von Maps ---

/**
 * Erstellt eine Map von Teilnehmern mit localId als Schlüssel.
 * @param {Array<object>} teilnehmerListe Ein Array von Teilnehmer-Objekten.
 * @returns {Map<string, object>} Eine Map mit localId => Teilnehmerobjekt.
 */
export function createTeilnehmerMap(teilnehmerListe) {
    const map = new Map();
    if (Array.isArray(teilnehmerListe)) {
        teilnehmerListe.forEach(t => map.set(t.localId, t));
    }
    return map;
}

/**
 * Erstellt eine Map von Teams mit localId als Schlüssel.
 * @param {Array<object>} teamListe Ein Array von Team-Objekten.
 * @returns {Map<string, object>} Eine Map mit localId => Teamobjekt.
 */
export function createTeamMap(teamListe) {
    const map = new Map();
     if (Array.isArray(teamListe)) {
        teamListe.forEach(t => map.set(t.localId, t));
    }
    return map;
}
