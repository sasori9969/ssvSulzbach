// sync-manager.js
import { db } from './firebase-config.js';
import { collection, doc, serverTimestamp, writeBatch, Timestamp } from "https://www.gstatic.com/firebasejs/11.4.0/firebase-firestore.js";
import {
    getLocalData,
    setLocalData,
    finalizeLocalItems,
    removeDeletedLocalItems, // Hinzugefügt für das Entfernen nach Sync
    TEILNEHMER_KEY,
    TEAMS_KEY,
    ERGEBNISSE_KEY,
    // SCHEIBEN_KEY, // Auskommentiert
    PAYMENT_STATUS_KEY,
    LAST_SYNC_KEY
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
        } else if (collectionName === 'teilnehmer') {
             // Stelle sicher, dass vorname/name vorhanden sind
             dataForFirestore.vorname = item.vorname || "";
             dataForFirestore.name = item.name || "";
        }

        // --- Batch-Operationen hinzufügen ---
        if (item._syncStatus === 'new') {
            const docRef = doc(collection(db, collectionName));
            // Setze den Timestamp nur für neue Dokumente
            dataForFirestore.timestamp = serverTimestamp();
            delete dataForFirestore.createdAt; // Lokales createdAt nicht nach Firestore

            batch.set(docRef, dataForFirestore);
            itemsToFinalize.push({ localId: item.localId, firestoreId: docRef.id });
            console.log(`Sync (${collectionName}): Neues Item "${item.name || item.teamname || item.localId}" wird hinzugefügt.`);

        } else if (item._syncStatus === 'modified' && item.firestoreId) {
            const docRef = doc(db, collectionName, item.firestoreId);
            // Timestamp bei Update nicht ändern, außer explizit gewünscht
            delete dataForFirestore.timestamp;
            // Lokales createdAt *nicht* als Timestamp verwenden, da es das Erstellungsdatum ist
            delete dataForFirestore.createdAt;
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
        [PAYMENT_STATUS_KEY]: [] // Für Abrechnung
    };
    let allIdsToDeleteLocally = {
        [TEILNEHMER_KEY]: [],
        [TEAMS_KEY]: [],
        [ERGEBNISSE_KEY]: [],
        // [SCHEIBEN_KEY]: [] // Auskommentiert
    };

    try {
        // --- 1. Teilnehmer synchronisieren ---
        const { itemsToFinalize: teilnehmerToFinalize, idsToDeleteLocally: teilnehmerToDelete, changesDetected: teilnehmerChanges } = await syncTeilnehmer(batch);
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
        const { itemsToFinalize: teamsToFinalize, idsToDeleteLocally: teamsToDelete, changesDetected: teamChanges } = await syncTeams(batch, teilnehmerIdMap);
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
        const { itemsToFinalize: ergebnisseToFinalize, idsToDeleteLocally: ergebnisseToDelete, changesDetected: ergebnisChanges } = await syncErgebnisse(batch, teilnehmerIdMap, teamIdMap);
        if (ergebnisChanges) anyChangesMade = true;
        allItemsToFinalize[ERGEBNISSE_KEY] = ergebnisseToFinalize;
        allIdsToDeleteLocally[ERGEBNISSE_KEY] = ergebnisseToDelete;

        // --- 4. Scheiben synchronisieren (AUSKOMMENTIERT) ---
        /*
        const { itemsToFinalize: scheibenToFinalize, idsToDeleteLocally: scheibenToDelete, changesDetected: scheibenChanges } = await syncScheiben(batch, teilnehmerIdMap);
        if (scheibenChanges) anyChangesMade = true;
        allItemsToFinalize[SCHEIBEN_KEY] = scheibenToFinalize;
        allIdsToDeleteLocally[SCHEIBEN_KEY] = scheibenToDelete;
        */

        // --- 5. Abrechnung synchronisieren ---
        // *** HIER DIE ÄNDERUNG: Übergebe teamsToDelete ***
        const { itemsToFinalize: paymentToFinalize, changesDetected: paymentChanges } = await syncAbrechnung(batch, teamIdMap, teamsToDelete);
        if (paymentChanges) anyChangesMade = true;
        allItemsToFinalize[PAYMENT_STATUS_KEY] = paymentToFinalize; // Speichere teamLocalIds


        // --- 6. Batch ausführen, wenn Änderungen vorhanden sind ---
        if (anyChangesMade) {
            displayStatus("Sende Änderungen an Server...", 'info');
            await batch.commit();
            displayStatus("Änderungen erfolgreich gesendet.", 'info');

            // --- 7. Lokale Daten finalisieren (Status 'synced' setzen, Gelöschte entfernen) ---
            let localSaveSuccess = true;

            // Finalisiere Teilnehmer, Teams, Ergebnisse
            for (const key of [TEILNEHMER_KEY, TEAMS_KEY, ERGEBNISSE_KEY /*, SCHEIBEN_KEY*/]) { // Scheiben auskommentiert
                const itemsToUpdate = allItemsToFinalize[key];
                const idsToRemove = allIdsToDeleteLocally[key];

                // Zuerst Status aktualisieren
                if (itemsToUpdate && itemsToUpdate.length > 0) {
                    if (!finalizeLocalItems(key, itemsToUpdate)) {
                        localSaveSuccess = false;
                        syncErrors.push(`Fehler beim Finalisieren von ${key}.`);
                    }
                }
                // Dann Gelöschte entfernen
                if (idsToRemove && idsToRemove.length > 0) {
                     if (!removeDeletedLocalItems(key, idsToRemove)) {
                         localSaveSuccess = false;
                         syncErrors.push(`Fehler beim lokalen Löschen von ${key}.`);
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

        // --- 8. Gesamtergebnis verarbeiten ---
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
