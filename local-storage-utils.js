// local-storage-utils.js

// --- Schlüssel für Local Storage ---
export const TEILNEHMER_KEY = "teilnehmerListe_v2";
export const TEAMS_KEY = "teamsListe_v2";
export const ERGEBNISSE_KEY = "ergebnisseListe_v2";
export const PAYMENT_STATUS_KEY = "paymentStatus_v2"; // Für Abrechnung
export const LAST_SYNC_KEY = "lastSyncTimestamp";
// export const SCHEIBEN_KEY = "scheibenErgebnisse_v1"; // Auskommentiert, da scheibenErfassen.html ignoriert wird

// Array aller Schlüssel, die gelöscht werden sollen (für clearLocalStorageData)
const ALL_DATA_KEYS = [
    TEILNEHMER_KEY,
    TEAMS_KEY,
    ERGEBNISSE_KEY,
    PAYMENT_STATUS_KEY,
    LAST_SYNC_KEY,
    // SCHEIBEN_KEY // Einkommentieren, falls benötigt
];


// --- Hilfsfunktionen für Local Storage Zugriff ---

/**
 * Holt Daten aus dem Local Storage für einen gegebenen Schlüssel.
 * Gibt ein leeres Array zurück, wenn nichts gefunden wird oder ein Fehler auftritt.
 * @param {string} key Der Schlüssel im Local Storage.
 * @returns {Array|Object} Die geparsten Daten oder ein leeres Array/Objekt.
 */
export function getLocalData(key) {
  try {
    const data = localStorage.getItem(key);
    if (data === null) {
      // Wenn der Schlüssel nicht existiert, gib je nach Schlüsseltyp ein leeres Array oder Objekt zurück
      return key === PAYMENT_STATUS_KEY ? {} : [];
    }
    return JSON.parse(data);
  } catch (error) {
    console.error(`Fehler beim Lesen von "${key}" aus Local Storage:`, error);
    // Im Fehlerfall ebenfalls leeres Array/Objekt zurückgeben
    return key === PAYMENT_STATUS_KEY ? {} : [];
  }
}

/**
 * Speichert Daten im Local Storage unter einem gegebenen Schlüssel.
 * @param {string} key Der Schlüssel im Local Storage.
 * @param {any} data Die zu speichernden Daten (werden als JSON stringifiziert).
 * @returns {boolean} True bei Erfolg, False bei Fehler.
 */
export function setLocalData(key, data) {
  try {
    localStorage.setItem(key, JSON.stringify(data));
    return true;
  } catch (error) {
    console.error(`Fehler beim Schreiben von "${key}" in Local Storage:`, error);
    // Hier könnte man prüfen, ob es ein QuotaExceededError ist
    if (error.name === 'QuotaExceededError') {
        alert('Speicherplatz im Browser ist voll! Synchronisation oder manuelle Bereinigung könnte nötig sein.');
    }
    return false;
  }
}

/**
 * Generiert eine eindeutige lokale ID.
 * @returns {string} Eine eindeutige ID (Kombination aus Zeitstempel und Zufallszahl).
 */
export function generateLocalId() {
  return `local_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
}

/**
 * Aktualisiert lokale Einträge nach erfolgreicher Synchronisation mit Firestore.
 * Setzt den _syncStatus auf 'synced' und speichert die Firestore ID.
 * @param {string} key Der Local Storage Schlüssel.
 * @param {Array<{localId: string, firestoreId: string}>} syncedItems Array von Objekten mit localId und der neuen firestoreId.
 * @returns {boolean} True bei Erfolg, False bei Fehler.
 */
export function finalizeLocalItems(key, syncedItems) {
  if (!syncedItems || syncedItems.length === 0) {
    return true; // Nichts zu tun
  }
  try {
    const localData = getLocalData(key);
    const localIdMap = new Map(syncedItems.map(item => [item.localId, item.firestoreId]));

    let changed = false;
    localData.forEach(item => {
      if (localIdMap.has(item.localId)) {
        item.firestoreId = localIdMap.get(item.localId);
        item._syncStatus = 'synced'; // Status auf 'synced' setzen
        // Entferne ggf. 'lastModifiedLocal', da jetzt synchronisiert
        delete item.lastModifiedLocal;
        changed = true;
      }
    });

    if (changed) {
      return setLocalData(key, localData);
    }
    return true; // Keine Änderungen nötig
  } catch (error) {
    console.error(`Fehler beim Finalisieren der lokalen Daten für Schlüssel "${key}":`, error);
    return false;
  }
}

/**
 * Entfernt Einträge aus dem Local Storage, die erfolgreich in Firestore gelöscht wurden.
 * @param {string} key Der Local Storage Schlüssel.
 * @param {Array<string>} deletedLocalIds Array der localIds, die gelöscht wurden.
 * @returns {boolean} True bei Erfolg, False bei Fehler.
 */
export function removeDeletedLocalItems(key, deletedLocalIds) {
    if (!deletedLocalIds || deletedLocalIds.length === 0) {
        return true; // Nichts zu tun
    }
    try {
        let localData = getLocalData(key);
        const initialLength = localData.length;
        // Filtere alle Einträge heraus, deren localId in deletedLocalIds enthalten ist
        localData = localData.filter(item => !deletedLocalIds.includes(item.localId));

        if (localData.length < initialLength) {
            return setLocalData(key, localData);
        }
        return true; // Keine Änderungen nötig
    } catch (error) {
        console.error(`Fehler beim Entfernen gelöschter lokaler Daten für Schlüssel "${key}":`, error);
        return false;
    }
}

/**
 * Löscht alle wettkampfrelevanten Daten aus dem Local Storage.
 * @returns {boolean} True bei Erfolg, False bei mindestens einem Fehler.
 */
export function clearLocalStorageData() {
    console.log("Lösche alle lokalen Wettkampfdaten...");
    let success = true;
    try {
        ALL_DATA_KEYS.forEach(key => {
            try {
                localStorage.removeItem(key);
                console.log(`Schlüssel "${key}" aus Local Storage entfernt.`);
            } catch (error) {
                console.error(`Fehler beim Entfernen von Schlüssel "${key}":`, error);
                success = false; // Markiere als fehlgeschlagen, wenn ein Schlüssel Probleme macht
            }
        });
        if (success) {
            console.log("Alle lokalen Wettkampfdaten erfolgreich gelöscht.");
        } else {
            console.warn("Einige lokale Daten konnten nicht gelöscht werden.");
        }
        return success;
    } catch (error) {
        console.error("Schwerwiegender Fehler beim Löschen lokaler Daten:", error);
        return false;
    }
}


// --- NEUE Hilfsfunktionen für Datenzugriff ---

/**
 * Holt Daten für einen Schlüssel und filtert Einträge heraus, die zum Löschen markiert sind.
 * @param {string} key Der Local Storage Schlüssel.
 * @returns {Array} Ein Array mit den aktiven Daten.
 */
export function getActiveLocalData(key) {
    const data = getLocalData(key);
    // Stelle sicher, dass es ein Array ist, bevor gefiltert wird
    if (!Array.isArray(data)) {
        // Für PAYMENT_STATUS_KEY ist ein Objekt erwartet, kein Array
        if (key === PAYMENT_STATUS_KEY) {
            // Hier könnten wir aktive Zahlungsstati filtern, wenn nötig,
            // aber die Funktion ist primär für Listen gedacht.
            // Vorerst geben wir das Objekt zurück oder ein leeres Objekt.
            return data || {};
        }
        console.warn(`getActiveLocalData: Daten für Schlüssel "${key}" sind kein Array.`);
        return [];
    }
    return data.filter(item => item._syncStatus !== 'deleted');
}

/**
 * Holt alle aktiven Teilnehmer aus dem Local Storage, sortiert nach Nachnamen.
 * @returns {Array} Ein sortiertes Array der aktiven Teilnehmer.
 */
export function getActiveTeilnehmer() {
    const teilnehmer = getActiveLocalData(TEILNEHMER_KEY);
    return teilnehmer.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
}

/**
 * Holt alle aktiven Teams aus dem Local Storage, sortiert nach Teamnamen.
 * @returns {Array} Ein sortiertes Array der aktiven Teams.
 */
export function getActiveTeams() {
    const teams = getActiveLocalData(TEAMS_KEY);
    return teams.sort((a, b) => (a.teamname || '').localeCompare(b.teamname || ''));
}

/**
 * Holt alle aktiven Ergebnisse aus dem Local Storage, sortiert nach Erstellungsdatum (neueste zuerst).
 * @returns {Array} Ein sortiertes Array der aktiven Ergebnisse.
 */
export function getActiveErgebnisse() {
    const ergebnisse = getActiveLocalData(ERGEBNISSE_KEY);
    // Sortiere nach createdAt absteigend (neueste zuerst)
    // Stelle sicher, dass createdAt existiert und ein vergleichbarer Wert ist (z.B. ISO String)
    return ergebnisse.sort((a, b) => {
        const dateA = a.createdAt ? new Date(a.createdAt).getTime() : 0;
        const dateB = b.createdAt ? new Date(b.createdAt).getTime() : 0;
        return dateB - dateA; // Neueste zuerst
    });
}

/**
 * Erstellt eine Map für schnellen Zugriff auf Teilnehmer über ihre localId.
 * Verwendet standardmäßig die aktiven Teilnehmer, kann aber auch eine Liste übergeben bekommen.
 * @param {Array} [teilnehmerList=getActiveTeilnehmer()] Optionale Liste von Teilnehmern.
 * @returns {Map<string, Object>} Eine Map mit localId als Schlüssel und Teilnehmerobjekt als Wert.
 */
export function createTeilnehmerMap(teilnehmerList = getActiveTeilnehmer()) {
    return new Map(teilnehmerList.map(t => [t.localId, t]));
}

/**
 * Erstellt eine Map für schnellen Zugriff auf Teams über ihre localId.
 * Verwendet standardmäßig die aktiven Teams, kann aber auch eine Liste übergeben bekommen.
 * @param {Array} [teamList=getActiveTeams()] Optionale Liste von Teams.
 * @returns {Map<string, Object>} Eine Map mit localId als Schlüssel und Teamobjekt als Wert.
 */
export function createTeamMap(teamList = getActiveTeams()) {
    return new Map(teamList.map(t => [t.localId, t]));
}

// --- Ende NEUE Hilfsfunktionen ---
