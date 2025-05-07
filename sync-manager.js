// sync-manager.js
import { db } from './firebase-config.js';
import {
    // Hinzugefügt: getDoc, setDoc, deleteDoc für einzelne Dokumente (Wettkampf)
    // Hinzugefügt: query, where (optional für spätere Optimierungen)
    collection,
    doc,
    serverTimestamp,
    writeBatch,
    getDoc, setDoc, deleteDoc, query, where, // Hinzugefügt
    Timestamp,
    getDocs // Hinzugefügt für deleteAllFirebaseData
} from "https://www.gstatic.com/firebasejs/11.4.0/firebase-firestore.js";
import {
    getLocalData,
    setLocalData,
    finalizeLocalItems,
    TEILNEHMER_KEY,
    TEAMS_KEY,
    ERGEBNISSE_KEY,
    PAYMENT_STATUS_KEY,
    LAST_SYNC_KEY,
    WETTKAMPF_KEY, // NEU hinzugefügt
    ALL_KEYS // NEU hinzugefügt (wird in local-storage-utils definiert)
} from './local-storage-utils.js';
import { zeigeStatus } from './ui-utils.js';

// Hilfsfunktion, um das Status-Element zu finden
function getStatusElement() {
    // Versuche, das Element auf der aktuellen Seite zu finden
    let statusElement = document.getElementById('statusMeldung');
    // Wenn nicht gefunden, erstelle ein temporäres Element (optional, für Hintergrund-Syncs)
    // if (!statusElement) {
    //     statusElement = document.createElement('div'); // Nur als Fallback, wenn keine UI nötig
    // }
    return statusElement; // Kann null sein, wenn nicht gefunden
}

// --- Hilfsfunktion zum Verarbeiten eines Arrays von Items (Teilnehmer, Teams, Ergebnisse) ---
/**
 * Verarbeitet ein Array von lokalen Datenobjekten für die Synchronisation mit Firestore.
 * Erstellt Batch-Operationen (set, update, delete) basierend auf dem _syncStatus.
 * @param {Array<Object>} items Das Array der lokalen Datenobjekte.
 * @param {string} collectionName Der Name der Firestore Collection.
 * @param {WriteBatch} batch Der Firestore WriteBatch, zu dem die Operationen hinzugefügt werden.
 * @param {Map<string, string>} [teilnehmerIdMap] Optional: Map von localId zu firestoreId für Teilnehmer (benötigt für Teams, Ergebnisse).
 * @param {Map<string, string>} [teamIdMap] Optional: Map von localId zu firestoreId für Teams (benötigt für Ergebnisse).
 * @returns {{itemsToFinalize: Array<{localId: string, firestoreId: string}>, idsToDeleteLocally: Array<string>, changesDetected: boolean}} Ein Objekt mit Items zum Finalisieren, IDs zum lokalen Löschen und einem Flag, ob Änderungen erkannt wurden.
 */
function processItemsForSync(items, collectionName, batch, teilnehmerIdMap = null, teamIdMap = null) {
    let changesDetected = false;
    const itemsToFinalize = []; // { localId, firestoreId } für neue/geänderte Items
    const idsToDeleteLocally = []; // localIds für lokal zu löschende Items

    items.forEach((item) => {
        // Überspringe Items ohne Status oder bereits synchronisierte
        if (!item || !item._syncStatus || item._syncStatus === 'synced') return;

        // --- ID-Konvertierung (falls benötigt) ---
        let teilnehmerFirestoreId = null;
        let teamFirestoreId = null;
        let canProceed = true; // Flag, ob das Item verarbeitet werden kann

        // Prüfung für Ergebnisse (benötigt Teilnehmer und optional Team)
        if (collectionName === 'ergebnisse') {
            if (!teilnehmerIdMap) {
                console.error(`SyncManager (${collectionName}): Teilnehmer-ID-Map fehlt!`);
                canProceed = false;
            } else {
                teilnehmerFirestoreId = teilnehmerIdMap.get(item.teilnehmerLocalId);
                if (!teilnehmerFirestoreId && item._syncStatus !== 'deleted') {
                    console.warn(`SyncManager (${collectionName}): Überspringe Item ${item.localId}, da Teilnehmer-FirestoreID für ${item.teilnehmerLocalId} fehlt (Teilnehmer evtl. noch nicht synchronisiert?).`);
                    canProceed = false;
                }
            }
            if (canProceed && item.teamLocalId) {
                if (!teamIdMap) {
                    console.error(`SyncManager (${collectionName}): Team-ID-Map fehlt!`);
                    canProceed = false;
                } else {
                    teamFirestoreId = teamIdMap.get(item.teamLocalId);
                    if (!teamFirestoreId && item._syncStatus !== 'deleted') {
                        console.warn(`SyncManager (${collectionName}): Überspringe Item ${item.localId}, da Team-FirestoreID für ${item.teamLocalId} fehlt (Team evtl. noch nicht synchronisiert?).`);
                        canProceed = false;
                    }
                }
            }
        }
        // Prüfung für Teams (benötigt Teilnehmer für Mitglieder)
        else if (collectionName === 'teams') {
            if (!teilnehmerIdMap) {
                console.error(`SyncManager (${collectionName}): Teilnehmer-ID-Map fehlt für Mitglieder-Konvertierung!`);
                // Weitermachen, aber Mitglieder werden nicht korrekt sein
            }
        }

        // Wenn eine benötigte ID fehlt (und nicht gelöscht wird), überspringe dieses Item
        if (!canProceed) {
            return; // Zum nächsten Item in forEach
        }

        changesDetected = true; // Es gibt mindestens eine Änderung, die versucht wird

        // --- Daten für Firestore vorbereiten ---
        const dataForFirestore = { ...item };
        // Felder entfernen, die nicht in Firestore sollen
        delete dataForFirestore.localId;
        delete dataForFirestore.firestoreId;
        delete dataForFirestore._syncStatus;
        delete dataForFirestore.lastModifiedLocal; // Wird nicht in Firestore gespeichert
        // createdAt wird speziell behandelt (siehe unten)

        // Spezifische Anpassungen pro Collection
        if (collectionName === 'teams') {
            const mitgliederFirestoreIds = (item.mitglieder || [])
                .map(localId => teilnehmerIdMap ? teilnehmerIdMap.get(localId) : null) // Konvertiere zu Firestore IDs
                .filter(firestoreId => !!firestoreId); // Nur gültige IDs
            dataForFirestore.mitglieder = mitgliederFirestoreIds;
            // Stelle sicher, dass teamname vorhanden ist
            dataForFirestore.teamname = item.teamname || "Unbenanntes Team";
        } else if (collectionName === 'ergebnisse') {
            dataForFirestore.teilnehmerId = teilnehmerFirestoreId;
            dataForFirestore.teamId = teamFirestoreId; // Kann null sein
            delete dataForFirestore.teilnehmerLocalId;
            delete dataForFirestore.teamLocalId;
            // Timestamp-Handling (siehe unten)
            // Konvertiere createdAt zu Firestore Timestamp, falls es ein String ist
            if (typeof dataForFirestore.createdAt === 'string') {
                 try {
                     dataForFirestore.timestamp = Timestamp.fromDate(new Date(dataForFirestore.createdAt));
                 } catch (e) {
                     console.warn(`Konnte createdAt "${dataForFirestore.createdAt}" nicht in Timestamp umwandeln. Verwende Server-Timestamp.`);
                     dataForFirestore.timestamp = serverTimestamp();
                 }
            } else if (!dataForFirestore.createdAt) {
                 dataForFirestore.timestamp = serverTimestamp(); // Fallback
            } else {
                 // Wenn es schon ein Timestamp-Objekt ist oder etwas anderes, nicht ändern
                 dataForFirestore.timestamp = dataForFirestore.createdAt;
            }
            delete dataForFirestore.createdAt; // Entferne das Originalfeld

        } else if (collectionName === 'teilnehmer') {
             // Stelle sicher, dass vorname/name vorhanden sind
             dataForFirestore.vorname = item.vorname || "";
             dataForFirestore.name = item.name || "";
             // Konvertiere createdAt zu Firestore Timestamp
             if (typeof dataForFirestore.createdAt === 'string') {
                 try {
                     dataForFirestore.timestamp = Timestamp.fromDate(new Date(dataForFirestore.createdAt));
                 } catch (e) {
                     console.warn(`Konnte createdAt "${dataForFirestore.createdAt}" nicht in Timestamp umwandeln. Verwende Server-Timestamp.`);
                     dataForFirestore.timestamp = serverTimestamp();
                 }
             } else if (!dataForFirestore.createdAt) {
                 dataForFirestore.timestamp = serverTimestamp(); // Fallback
             } else {
                 dataForFirestore.timestamp = dataForFirestore.createdAt;
             }
             delete dataForFirestore.createdAt;
        }

        // --- Batch-Operationen hinzufügen ---
        if (item._syncStatus === 'new') {
            const docRef = doc(collection(db, collectionName));
            // Setze den Timestamp nur für neue Dokumente (oder verwende den konvertierten createdAt)
            if (!dataForFirestore.timestamp) {
                dataForFirestore.timestamp = serverTimestamp();
            }

            batch.set(docRef, dataForFirestore);
            itemsToFinalize.push({ localId: item.localId, firestoreId: docRef.id });
            console.log(`Sync (${collectionName}): Neues Item "${item.name || item.teamname || item.localId}" wird hinzugefügt.`);

        } else if (item._syncStatus === 'modified' && item.firestoreId) {
            const docRef = doc(db, collectionName, item.firestoreId);
            // Timestamp bei Update nicht ändern, außer explizit gewünscht
            delete dataForFirestore.timestamp; // Entferne Timestamp, um ihn nicht zu überschreiben
            // Optional: dataForFirestore.lastModified = serverTimestamp();

            batch.update(docRef, dataForFirestore);
            itemsToFinalize.push({ localId: item.localId, firestoreId: item.firestoreId });
            console.log(`Sync (${collectionName}): Item "${item.name || item.teamname || item.localId}" (${item.firestoreId}) wird aktualisiert.`);

        } else if (item._syncStatus === 'deleted' && item.firestoreId) {
            const docRef = doc(db, collectionName, item.firestoreId);
            batch.delete(docRef);
            idsToDeleteLocally.push(item.localId); // Markieren für lokales Entfernen nach Commit
            console.log(`Sync (${collectionName}): Item "${item.name || item.teamname || item.localId}" (${item.firestoreId}) wird gelöscht.`);

        } else if (item._syncStatus === 'deleted' && !item.firestoreId) {
            // Item wurde lokal erstellt und direkt wieder gelöscht, bevor es synchronisiert wurde
            console.warn(`Sync (${collectionName}): Item "${item.name || item.teamname || item.localId}" war 'new' und wurde lokal gelöscht. Wird direkt lokal entfernt.`);
            idsToDeleteLocally.push(item.localId); // Direkt lokal entfernen

        } else if (item._syncStatus === 'modified' && !item.firestoreId) {
             // Sollte nicht passieren, wenn 'new' korrekt behandelt wird
             console.error(`Sync (${collectionName}): Inkonsistenter Status für "${item.name || item.teamname || item.localId}". Status 'modified' aber keine Firestore ID.`);
             changesDetected = false; // Diese Änderung kann nicht durchgeführt werden
        }
    });

    return { itemsToFinalize, idsToDeleteLocally, changesDetected };
}


// --- Sync-Funktion für Teilnehmer ---
async function syncTeilnehmer(batch) {
    console.log("SyncManager: Prüfe Teilnehmer...");
    const lokaleDaten = getLocalData(TEILNEHMER_KEY);
    return processItemsForSync(lokaleDaten, "teilnehmer", batch);
}

// --- Sync-Funktion für Teams ---
async function syncTeams(batch, teilnehmerIdMap) {
    console.log("SyncManager: Prüfe Teams...");
    const lokaleDaten = getLocalData(TEAMS_KEY);
    return processItemsForSync(lokaleDaten, "teams", batch, teilnehmerIdMap);
}

// --- Sync-Funktion für Ergebnisse ---
async function syncErgebnisse(batch, teilnehmerIdMap, teamIdMap) {
    console.log("SyncManager: Prüfe Ergebnisse...");
    const lokaleDaten = getLocalData(ERGEBNISSE_KEY);
    return processItemsForSync(lokaleDaten, "ergebnisse", batch, teilnehmerIdMap, teamIdMap);
}

// --- Sync-Funktion für Scheiben (AUSKOMMENTIERT) ---
/*
async function syncScheiben(batch, teilnehmerIdMap) {
    console.log("SyncManager: Prüfe Scheiben...");
    const lokaleDaten = getLocalData(SCHEIBEN_KEY); // Fehlerquelle, wenn Key nicht existiert
    // Annahme: processItemsForSync kann auch 'scheibenErgebnisse' verarbeiten
    return processItemsForSync(lokaleDaten, "scheibenErgebnisse", batch, teilnehmerIdMap);
}
*/

// --- Sync-Funktion für Abrechnung ---
/**
 * Synchronisiert den Zahlungsstatus, indem das entsprechende Team-Dokument aktualisiert wird.
 * Überspringt Updates für Teams, die im selben Batch gelöscht werden.
 * @param {WriteBatch} batch Der Firestore WriteBatch.
 * @param {Map<string, string>} teamIdMap Map von teamLocalId zu teamFirestoreId.
 * @param {Array<string>} teamLocalIdsToDelete Array der localIds von Teams, die gelöscht werden sollen.
 * @returns {{itemsToFinalize: Array<string>, changesDetected: boolean}}
 */
async function syncAbrechnung(batch, teamIdMap, teamLocalIdsToDelete) { // <-- Neuer Parameter
    console.log("SyncManager: Prüfe Abrechnung...");
    const paymentStatus = getLocalData(PAYMENT_STATUS_KEY) || {};
    let changesDetected = false;
    const itemsToFinalize = []; // Hier speichern wir teamLocalIds zum Finalisieren
    const deletedIdsSet = new Set(teamLocalIdsToDelete); // Für schnellen Check

    for (const teamLocalId in paymentStatus) {
        const status = paymentStatus[teamLocalId];

        // *** NEUE PRÜFUNG: Überspringe, wenn das Team gelöscht wird ***
        if (deletedIdsSet.has(teamLocalId)) {
            console.log(`Sync (Abrechnung): Überspringe Update für Team ${teamLocalId}, da es gelöscht wird.`);
            // Wichtig: Status hier NICHT ändern, das Team wird ja eh entfernt.
            continue; // Nächste Iteration
        }

        // Nur modifizierte Einträge synchronisieren
        if (status && status._syncStatus === 'modified') {
            const teamFirestoreId = teamIdMap.get(teamLocalId);

            if (teamFirestoreId) { // Nur synchronisieren, wenn das Team eine Firestore ID hat
                changesDetected = true; // Markieren, dass der Batch ausgeführt werden muss

                const docRef = doc(db, "teams", teamFirestoreId);
                // Daten filtern, die *nicht* nach Firestore sollen
                const paymentDataForFirestore = { ...status };
                delete paymentDataForFirestore._syncStatus;
                delete paymentDataForFirestore.lastModifiedLocal; // Falls verwendet

                // Aktualisiere ein bestimmtes Feld im Team-Dokument, z.B. 'paymentInfo'
                batch.update(docRef, {
                    paymentInfo: paymentDataForFirestore,
                    paymentLastUpdated: serverTimestamp() // Zeitstempel für letzte Zahlungsänderung
                });
                console.log(`Sync (Abrechnung): Aktualisiere paymentInfo für Team mit FirestoreID ${teamFirestoreId}.`);

                // Markiere für lokales Update nach erfolgreichem Commit
                itemsToFinalize.push(teamLocalId);

            } else {
                console.warn(`Sync (Abrechnung): Team ${teamLocalId} hat Zahlungsstatus 'modified', aber keine Firestore ID (wahrscheinlich noch 'new' oder bereits gelöscht). Wird beim nächsten Mal synchronisiert.`);
                // Status NICHT ändern, damit es beim nächsten Sync erneut versucht wird.
            }
        }
    }
    // Gebe die zu finalisierenden IDs und das changesDetected Flag zurück
    return { itemsToFinalize, changesDetected };
}

/**
 * Synchronisiert die Wettkampfdaten (einzelnes Objekt) zwischen Local Storage und Firestore.
 * Annahme: Es gibt nur EIN Dokument in der 'wettkampf'-Collection mit der ID 'current'.
 * @param {Date | null} lastSyncTime - Der Zeitpunkt der letzten Synchronisation (wird hier nicht direkt verwendet, aber für Konsistenz übergeben).
 * @param {Date} now - Der aktuelle Zeitpunkt (Start des Syncs).
 * @returns {Promise<{changesDetected: boolean, needsFinalize: boolean}>} - True, wenn Änderungen vorgenommen wurden, needsFinalize, wenn lokale Daten aktualisiert werden müssen.
 */
async function syncWettkampfData(lastSyncTime, now) {
  console.log(`Starte Sync für Wettkampfdaten (${WETTKAMPF_KEY})`);
  let changesDetected = false; // Änderungen, die einen Batch-Commit erfordern
  let needsFinalize = false; // Änderungen, die ein lokales Update nach dem Commit erfordern
  const collectionName = "wettkampf"; // Name der Firestore Collection
  const docId = "current"; // Feste ID für das Wettkampf-Dokument

  try {
    // 1. Lokale Wettkampfdaten holen
    let localWettkampfData = getLocalData(WETTKAMPF_KEY);

    // 2. Firestore Wettkampfdaten holen
    const docRef = doc(db, collectionName, docId);
    const docSnap = await getDoc(docRef);
    let remoteWettkampfData = null;
    let remoteTimestamp = null;

    if (docSnap.exists()) {
      remoteWettkampfData = docSnap.data();
      remoteTimestamp = remoteWettkampfData.serverTimestamp?.toDate() || (remoteWettkampfData.lastModifiedLocal ? new Date(remoteWettkampfData.lastModifiedLocal) : null);
      console.log(`Firestore Wettkampfdaten gefunden. Remote Timestamp: ${remoteTimestamp}`);
    } else {
      console.log(`Keine Wettkampfdaten in Firestore unter ${collectionName}/${docId} gefunden.`);
    }

    // 3. Vergleichen und Synchronisieren

    // Fall A: Lokale Daten vorhanden
    if (localWettkampfData) {
      const localTimestamp = localWettkampfData.lastModifiedLocal ? new Date(localWettkampfData.lastModifiedLocal) : null;
      const localSyncStatus = localWettkampfData._syncStatus;

      // Fall A.1: Lokale Daten sind neu oder geändert -> Upload zu Firestore
      if (localSyncStatus === 'new' || localSyncStatus === 'modified') {
        console.log(`Lokale Wettkampfdaten (${localSyncStatus}) werden nach Firestore hochgeladen.`);
        const dataToUpload = { ...localWettkampfData, serverTimestamp: serverTimestamp() };
        delete dataToUpload._syncStatus;

        // Direkt schreiben (kein Batch nötig, da nur ein Dokument)
        await setDoc(docRef, dataToUpload, { merge: true });
        changesDetected = true; // Markieren, dass eine Änderung stattgefunden hat
        needsFinalize = true; // Lokaler Status muss auf 'synced' gesetzt werden
      }
      // Fall A.2: Lokale Daten sind synchronisiert, aber Firestore hat neuere Daten -> Download
      else if (localSyncStatus === 'synced' && remoteTimestamp && localTimestamp && remoteTimestamp > localTimestamp) {
        console.log("Neuere Wettkampfdaten in Firestore gefunden, aktualisiere lokale Daten.");
        // Direkt lokal speichern (kein Batch nötig)
        const updatedLocalData = { ...remoteWettkampfData, _syncStatus: 'synced', lastModifiedLocal: remoteTimestamp.toISOString() };
        delete updatedLocalData.serverTimestamp;
        setLocalData(WETTKAMPF_KEY, updatedLocalData);
        // Keine Änderungen für den Batch, aber lokale Änderung wurde durchgeführt
      }
    }
    // Fall B: Keine lokalen Daten, aber Daten in Firestore -> Download
    else if (remoteWettkampfData) {
      console.log("Keine lokalen Wettkampfdaten, aber Daten in Firestore gefunden. Lade herunter.");
      const downloadedData = { ...remoteWettkampfData, _syncStatus: 'synced', lastModifiedLocal: remoteTimestamp ? remoteTimestamp.toISOString() : now.toISOString() };
      delete downloadedData.serverTimestamp;
      setLocalData(WETTKAMPF_KEY, downloadedData);
    }
  } catch (error) {
    console.error(`Fehler beim Synchronisieren der Wettkampfdaten (${WETTKAMPF_KEY}):`, error);
    throw error; // Fehler weitergeben
  }

  console.log(`Sync für Wettkampfdaten (${WETTKAMPF_KEY}) abgeschlossen. Batch-Änderungen: ${changesDetected}, Lokale Finalisierung nötig: ${needsFinalize}`);
  // Wichtig: Diese Funktion verwendet keinen Batch, da sie direkt schreibt/liest.
  // `changesDetected` hier bedeutet eher "Änderung in Firestore vorgenommen".
  // `needsFinalize` bedeutet "lokaler Status muss nach Sync aktualisiert werden".
  return { changesDetected, needsFinalize };
}


// --- Zentrale Synchronisationsfunktion ---
export async function synchronizeAllData(showStatus = true) {
    const statusElement = getStatusElement(); // Element einmal holen
    // Nur Status anzeigen, wenn showStatus true ist UND das Element existiert
    const displayStatus = (message, type, duration = 3000) => {
        if (showStatus && statusElement) {
            zeigeStatus(message, type, duration);
        }
        // Logge immer in der Konsole
        if (type === 'fehler') console.error(message);
        else console.log(message);
    };

    displayStatus("Starte Synchronisation...", 'info', 5000);

    // 0. Prüfen, ob online
    if (!navigator.onLine) {
        displayStatus("Offline, Synchronisation übersprungen.", 'info');
        return false; // Sync nicht erfolgreich
    }

    const batch = writeBatch(db);
    let overallSuccess = true;
    let anyChangesMade = false;
    let syncErrors = [];

    // Arrays zum Sammeln der Ergebnisse aus processItemsForSync
    let allItemsToFinalize = {
        [TEILNEHMER_KEY]: [],
        [TEAMS_KEY]: [],
        [ERGEBNISSE_KEY]: [],
        // [SCHEIBEN_KEY]: [], // Auskommentiert
        [WETTKAMPF_KEY]: false, // Flag für Wettkampf-Finalisierung
        [PAYMENT_STATUS_KEY]: [] // Für Abrechnung
    };
    let allIdsToDeleteLocally = {
        [TEILNEHMER_KEY]: [],
        [TEAMS_KEY]: [],
        [ERGEBNISSE_KEY]: [],
        // [SCHEIBEN_KEY]: [] // Auskommentiert
        [WETTKAMPF_KEY]: [] // Nicht benötigt für Wettkampf
    };

    let teilnehmerChanges = false; // Wird hier deklariert, um im Scope zu sein
    let teamChanges = false;
    let ergebnisChanges = false;
    // let scheibenChanges = false; // Für den Fall, dass SCHEIBEN_KEY wieder aktiv wird

    try {
        // --- 1. Teilnehmer synchronisieren ---
        const { itemsToFinalize: teilnehmerToFinalize, idsToDeleteLocally: teilnehmerToDelete, changesDetected: tc } = await syncTeilnehmer(batch);
        teilnehmerChanges = tc; // Wert zuweisen
        if (teilnehmerChanges) anyChangesMade = true;
        allItemsToFinalize[TEILNEHMER_KEY] = teilnehmerToFinalize;
        allIdsToDeleteLocally[TEILNEHMER_KEY] = teilnehmerToDelete;

        // --- ID Map für Teilnehmer erstellen (wird für Teams, Ergebnisse benötigt) ---
        // Wichtig: Nutze die *aktuellen* lokalen Daten + die gerade zum Sync vorbereiteten neuen Items
        const currentTeilnehmer = getLocalData(TEILNEHMER_KEY);
        const combinedTeilnehmerForMap = [...currentTeilnehmer];
        // Füge Infos aus finalize hinzu (neue IDs)
        const finalizeMap = new Map(teilnehmerToFinalize.map(f => [f.localId, f.firestoreId]));
        combinedTeilnehmerForMap.forEach(t => {
            if (finalizeMap.has(t.localId)) {
                t.firestoreId = finalizeMap.get(t.localId); // Update ID für die Map-Erstellung
            }
        });
        const teilnehmerIdMap = new Map(
            combinedTeilnehmerForMap
            .filter(t => t.localId && t.firestoreId) // Nur die mit beiden IDs
            .map(t => [t.localId, t.firestoreId])
        );


        // --- 2. Teams synchronisieren ---
        const { itemsToFinalize: teamsToFinalize, idsToDeleteLocally: teamsToDelete, changesDetected: tmc } = await syncTeams(batch, teilnehmerIdMap);
        teamChanges = tmc; // Wert zuweisen
        if (teamChanges) anyChangesMade = true;
        allItemsToFinalize[TEAMS_KEY] = teamsToFinalize;
        allIdsToDeleteLocally[TEAMS_KEY] = teamsToDelete; // teamsToDelete enthält die localIds der zu löschenden Teams

        // --- ID Map für Teams erstellen (wird für Ergebnisse, Abrechnung benötigt) ---
        const currentTeams = getLocalData(TEAMS_KEY);
        const combinedTeamsForMap = [...currentTeams];
        const finalizeTeamMap = new Map(teamsToFinalize.map(f => [f.localId, f.firestoreId]));
        combinedTeamsForMap.forEach(t => {
            if (finalizeTeamMap.has(t.localId)) {
                t.firestoreId = finalizeTeamMap.get(t.localId);
            }
        });
        const teamIdMap = new Map(
            combinedTeamsForMap
            .filter(t => t.localId && t.firestoreId)
            .map(t => [t.localId, t.firestoreId])
        );

        // --- 3. Ergebnisse synchronisieren ---
        const { itemsToFinalize: ergebnisseToFinalize, idsToDeleteLocally: ergebnisseToDelete, changesDetected: ec } = await syncErgebnisse(batch, teilnehmerIdMap, teamIdMap);
        ergebnisChanges = ec; // Wert zuweisen
        if (ergebnisChanges) anyChangesMade = true;
        allItemsToFinalize[ERGEBNISSE_KEY] = ergebnisseToFinalize;
        allIdsToDeleteLocally[ERGEBNISSE_KEY] = ergebnisseToDelete;

        // --- 4. Scheiben synchronisieren (AUSKOMMENTIERT) ---
        /*
        const { itemsToFinalize: scheibenToFinalize, idsToDeleteLocally: scheibenToDelete, changesDetected: sc } = await syncScheiben(batch, teilnehmerIdMap);
        scheibenChanges = sc;
        if (scheibenChanges) anyChangesMade = true;
        allItemsToFinalize[SCHEIBEN_KEY] = scheibenToFinalize;
        allIdsToDeleteLocally[SCHEIBEN_KEY] = scheibenToDelete;
        */

        // --- 5. Abrechnung synchronisieren ---
        // *** HIER DIE ÄNDERUNG: Übergebe teamsToDelete ***
        const { itemsToFinalize: paymentToFinalize, changesDetected: paymentChanges } = await syncAbrechnung(batch, teamIdMap, allIdsToDeleteLocally[TEAMS_KEY]); // Korrigiert: Übergebe die tatsächlichen IDs
        if (paymentChanges) anyChangesMade = true;
        allItemsToFinalize[PAYMENT_STATUS_KEY] = paymentToFinalize; // Speichere teamLocalIds

        // --- 6. Wettkampfdaten synchronisieren (separat, da kein Batch nötig) ---
        // Führe dies *vor* dem Batch-Commit aus, falls es Fehler wirft
        const { changesDetected: wettkampfChanges, needsFinalize: wettkampfNeedsFinalize } = await syncWettkampfData(null, new Date()); // lastSyncTime nicht relevant hier
        if (wettkampfChanges) anyChangesMade = true; // Wenn Firestore geändert wurde
        if (wettkampfNeedsFinalize) {
            allItemsToFinalize[WETTKAMPF_KEY] = true; // Markieren für lokale Finalisierung
        }

        // --- 7. Batch ausführen, wenn Änderungen vorhanden sind ---
        if (anyChangesMade) {
            displayStatus("Sende Änderungen an Server...", 'info');
            await batch.commit();
            displayStatus("Batch-Änderungen erfolgreich gesendet.", 'info');

            // --- 8. Lokale Daten finalisieren (Status 'synced' setzen, Gelöschte entfernen) ---
            let localSaveSuccess = true;

            // Finalisiere Teilnehmer, Teams, Ergebnisse
            for (const key of [TEILNEHMER_KEY, TEAMS_KEY, ERGEBNISSE_KEY /*, SCHEIBEN_KEY*/]) { // Scheiben auskommentiert
                const itemsToUpdate = allItemsToFinalize[key];
                // const idsToRemove = allIdsToDeleteLocally[key]; // idsToRemove wird in finalizeLocalItems nicht direkt benötigt, da es alle 'deleted' Items verarbeitet

                // Prüfen, ob für diesen Key überhaupt Änderungen (neue, modifizierte oder gelöschte)
                // während des Sync-Vorgangs verarbeitet wurden.
                let keySpecificChangesMade = false;
                if (key === TEILNEHMER_KEY) keySpecificChangesMade = teilnehmerChanges;
                else if (key === TEAMS_KEY) keySpecificChangesMade = teamChanges;
                else if (key === ERGEBNISSE_KEY) keySpecificChangesMade = ergebnisChanges;
                // Falls SCHEIBEN_KEY wieder verwendet wird, hier ergänzen:
                // else if (key === SCHEIBEN_KEY) keySpecificChangesMade = scheibenChanges;

                // Rufe finalizeLocalItems auf, wenn für diesen Key Änderungen verarbeitet wurden.
                // finalizeLocalItems kümmert sich sowohl um das Aktualisieren von 'new'/'modified'-Items
                // als auch um das Entfernen von 'deleted'-Items aus dem Local Storage.
                if (keySpecificChangesMade) {
                    if (!finalizeLocalItems(key, itemsToUpdate)) { // itemsToUpdate enthält die {localId, firestoreId} Paare für 'new'/'modified'
                        localSaveSuccess = false;
                        syncErrors.push(`Fehler beim Finalisieren von ${key}.`);
                    }
                }
            }

            // Abrechnung finalisieren (Status 'synced' setzen)
            const paymentStatus = getLocalData(PAYMENT_STATUS_KEY) || {};
            let paymentStatusChanged = false;
            allItemsToFinalize[PAYMENT_STATUS_KEY].forEach(teamLocalId => {
                if (paymentStatus[teamLocalId]) {
                    // Prüfen, ob das Team nicht gerade gelöscht wurde (Sicherheitscheck)
                    if (!allIdsToDeleteLocally[TEAMS_KEY].includes(teamLocalId)) {
                        paymentStatus[teamLocalId]._syncStatus = 'synced';
                        delete paymentStatus[teamLocalId].lastModifiedLocal; // Auch hier ggf. entfernen
                        paymentStatusChanged = true;
                    } else {
                        // Wenn das Team gelöscht wurde, entferne den Zahlungsstatus-Eintrag
                        delete paymentStatus[teamLocalId];
                        paymentStatusChanged = true;
                        console.log(`Sync (Abrechnung Finalize): Entferne Zahlungsstatus für gelöschtes Team ${teamLocalId}.`);
                    }
                }
            });
            if (paymentStatusChanged) {
                if (!setLocalData(PAYMENT_STATUS_KEY, paymentStatus)) {
                    localSaveSuccess = false;
                    syncErrors.push("Fehler beim Finalisieren der Abrechnung.");
                }
            }

            // Wettkampfdaten finalisieren (Status 'synced' setzen)
            if (allItemsToFinalize[WETTKAMPF_KEY]) {
                let localWettkampfData = getLocalData(WETTKAMPF_KEY);
                if (localWettkampfData) {
                    localWettkampfData._syncStatus = 'synced';
                    delete localWettkampfData.lastModifiedLocal; // Optional
                    if (!setLocalData(WETTKAMPF_KEY, localWettkampfData)) {
                        localSaveSuccess = false;
                        syncErrors.push("Fehler beim Finalisieren der Wettkampfdaten.");
                    }
                }
            }

            // Prüfe, ob lokales Speichern erfolgreich war
            if (!localSaveSuccess) {
                overallSuccess = false; // Markieren als fehlgeschlagen
                console.error("SyncManager: Fehler beim Speichern finalisierter lokaler Daten!", syncErrors);
            } else {
                // Zeitstempel für letzten Sync speichern (nur bei Erfolg)
                setLocalData(LAST_SYNC_KEY, new Date().toISOString());
            }

        } else {
            displayStatus("Keine Änderungen zum Synchronisieren gefunden.", 'info');
            // Zeitstempel trotzdem aktualisieren, da geprüft wurde
            setLocalData(LAST_SYNC_KEY, new Date().toISOString());
        }

        // --- 9. Gesamtergebnis verarbeiten ---
        if (overallSuccess) {
            displayStatus(anyChangesMade ? "Synchronisation erfolgreich abgeschlossen!" : "Keine Änderungen zum Synchronisieren.", anyChangesMade ? 'erfolg' : 'info');
            // Event auslösen, damit andere Seiten ggf. neu laden können
            window.dispatchEvent(new CustomEvent('datasync-complete', { detail: { success: true, changesMade: anyChangesMade } }));
            return true; // Sync war erfolgreich
        } else {
            // Fehlerfall wurde schon oben behandelt
            displayStatus(`Synchronisation fehlgeschlagen. ${syncErrors.join(' ')}`, 'fehler', 5000);
            window.dispatchEvent(new CustomEvent('datasync-complete', { detail: { success: false, error: syncErrors.join('; ') } }));
            return false; // Sync fehlgeschlagen
        }

    } catch (error) {
        // Fängt Fehler im Batch-Commit oder in der Hauptlogik ab
        console.error("SyncManager: Schwerwiegender Fehler während der Synchronisation:", error);
        syncErrors.push(error.message || "Unbekannter Fehler");
        displayStatus(`Synchronisationsfehler: ${error.message}`, 'fehler', 5000);
        window.dispatchEvent(new CustomEvent('datasync-complete', { detail: { success: false, error: error.message } }));
        return false; // Sync fehlgeschlagen
    }
}


// --- NEU: Funktion zum Löschen aller Firebase-Daten ---

/**
 * Versucht, alle Dokumente aus den relevanten Firestore Collections zu löschen.
 * ACHTUNG: Benötigt entsprechende Firestore-Regeln und kann bei vielen Daten langsam sein.
 * Eine Cloud Function wäre für diesen Zweck oft besser geeignet.
 * @returns {Promise<boolean>} True bei Erfolg, False bei Fehlern.
 */
export async function deleteAllFirebaseData() {
    console.warn("Starte Löschung aller Firebase Wettkampfdaten...");
    // Definiere die Collections, die geleert werden sollen
    const collectionsToClear = [
        'teilnehmer',
        'teams',
        'ergebnisse',
        'paymentStatus', // NEU: Auch Zahlungsstatus-Dokumente löschen
        // 'scheiben' // Auskommentiert
    ];

    let allSuccess = true;

    for (const collectionName of collectionsToClear) {
        console.log(`Lösche Dokumente in Collection: ${collectionName}...`);
        try {
            const collectionRef = collection(db, collectionName);
            const querySnapshot = await getDocs(collectionRef);

            if (querySnapshot.empty) {
                console.log(`Collection "${collectionName}" ist bereits leer.`);
                continue; // Nächste Collection
            }

            // Firestore erlaubt maximal 500 Operationen pro Batch
            const batchLimit = 500;
            let batch = writeBatch(db);
            let count = 0;

            for (const docSnapshot of querySnapshot.docs) {
                batch.delete(docSnapshot.ref);
                count++;
                if (count === batchLimit) {
                    console.log(`Committing batch delete for ${collectionName} (${count} docs)...`);
                    await batch.commit();
                    // Neuen Batch für die nächsten Dokumente starten
                    batch = writeBatch(db);
                    count = 0;
                }
            }

            // Letzten Batch committen, falls noch Operationen offen sind
            if (count > 0) {
                console.log(`Committing final batch delete for ${collectionName} (${count} docs)...`);
                await batch.commit();
            }
            console.log(`Alle Dokumente in "${collectionName}" erfolgreich gelöscht.`);

        } catch (error) {
            console.error(`Fehler beim Löschen der Collection "${collectionName}":`, error);
            allSuccess = false;
            // Optional: Hier aufhören oder weitermachen? Wir machen weiter, um möglichst viel zu löschen.
        }
    }

    // --- NEU: Lösche das einzelne Wettkampf-Dokument ---
    console.log("Lösche Wettkampf-Dokument...");
    try {
        const wettkampfDocRef = doc(db, "wettkampf", "current");
        await deleteDoc(wettkampfDocRef);
        console.log("Wettkampf-Dokument erfolgreich gelöscht.");
    } catch (error) {
        // Fehler nur loggen, wenn das Dokument nicht existiert (ist ok)
        if (error.code !== 'not-found') {
            console.error("Fehler beim Löschen des Wettkampf-Dokuments:", error);
            allSuccess = false;
        } else {
            console.log("Wettkampf-Dokument existierte nicht (oder wurde bereits gelöscht).");
        }
    }

    if (allSuccess) {
        console.log("Alle definierten Firebase Collections erfolgreich geleert.");
    } else {
        console.error("Einige Firebase Collections konnten nicht vollständig geleert werden!");
    }
    return allSuccess;
}
