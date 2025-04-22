// sync-manager.js
import { db } from './firebase-config.js';
import { collection, doc, serverTimestamp, writeBatch, Timestamp } from "https://www.gstatic.com/firebasejs/11.4.0/firebase-firestore.js";
import {
    getLocalData,
    setLocalData,
    finalizeLocalItems,
    TEILNEHMER_KEY,
    TEAMS_KEY,
    ERGEBNISSE_KEY,
    SCHEIBEN_KEY, // NEU
    PAYMENT_STATUS_KEY, // NEU
    LAST_SYNC_KEY
} from './local-storage-utils.js';
import { zeigeStatus } from './ui-utils.js';

// Hilfsfunktion, um den Status-Container zu finden
function getStatusElement() {
    return document.getElementById('statusMeldung') || document.body; // Fallback auf body
}

// --- Hilfsfunktion zum Verarbeiten eines Arrays von Items (Teilnehmer, Teams, Ergebnisse, Scheiben) ---
/**
 * Verarbeitet ein Array von lokalen Datenobjekten für die Synchronisation mit Firestore.
 * Erstellt Batch-Operationen (set, update, delete) basierend auf dem _syncStatus.
 * @param {Array<Object>} items Das Array der lokalen Datenobjekte.
 * @param {string} collectionName Der Name der Firestore Collection.
 * @param {WriteBatch} batch Der Firestore WriteBatch, zu dem die Operationen hinzugefügt werden.
 * @param {Map<string, string>} [teilnehmerIdMap] Optional: Map von localId zu firestoreId für Teilnehmer (benötigt für Teams, Ergebnisse, Scheiben).
 * @param {Map<string, string>} [teamIdMap] Optional: Map von localId zu firestoreId für Teams (benötigt für Ergebnisse).
 * @returns {{updatedItems: Array<Object>, changesDetected: boolean}} Ein Objekt mit den potenziell aktualisierten Items und einem Flag, ob Änderungen erkannt wurden.
 */
function processItemsForSync(items, collectionName, batch, teilnehmerIdMap = null, teamIdMap = null) {
    let changesDetected = false;
    let updatedItems = structuredClone(items); // Kopie erstellen

    updatedItems.forEach((item, index) => {
        if (!item || !item._syncStatus || item._syncStatus === 'synced') return;

        changesDetected = true; // Es gibt mindestens eine Änderung

        // --- ID-Konvertierung (falls benötigt) ---
        let teilnehmerFirestoreId = null;
        let teamFirestoreId = null;

        if (collectionName === 'ergebnisse' || collectionName === 'scheibenErgebnisse') {
            if (!teilnehmerIdMap) {
                console.error(`SyncManager (${collectionName}): Teilnehmer-ID-Map fehlt!`);
                return; // Kann nicht synchronisieren
            }
            teilnehmerFirestoreId = teilnehmerIdMap.get(item.teilnehmerLocalId);
            if (!teilnehmerFirestoreId && item._syncStatus !== 'deleted') {
                console.warn(`SyncManager (${collectionName}): Überspringe Item ${item.localId}, da Teilnehmer-FirestoreID für ${item.teilnehmerLocalId} fehlt.`);
                changesDetected = false; // Diese spezifische Änderung kann nicht durchgeführt werden
                return; // Nächstes Item
            }
        }
        if (collectionName === 'ergebnisse' && item.teamLocalId) {
             if (!teamIdMap) {
                 console.error(`SyncManager (${collectionName}): Team-ID-Map fehlt!`);
                 return; // Kann nicht synchronisieren
             }
            teamFirestoreId = teamIdMap.get(item.teamLocalId);
             if (!teamFirestoreId && item._syncStatus !== 'deleted') {
                 console.warn(`SyncManager (${collectionName}): Überspringe Item ${item.localId}, da Team-FirestoreID für ${item.teamLocalId} fehlt.`);
                 changesDetected = false; // Diese spezifische Änderung kann nicht durchgeführt werden
                 return; // Nächstes Item
             }
        }
         if (collectionName === 'teams') {
             if (!teilnehmerIdMap) {
                 console.error(`SyncManager (${collectionName}): Teilnehmer-ID-Map fehlt!`);
                 // Weitermachen, aber Mitglieder werden evtl. nicht korrekt synchronisiert
             }
         }


        // --- Daten für Firestore vorbereiten ---
        const dataForFirestore = { ...item };
        // Felder entfernen, die nicht in Firestore sollen
        delete dataForFirestore.localId;
        delete dataForFirestore.firestoreId;
        delete dataForFirestore._syncStatus;
        delete dataForFirestore._pendingSync;
        delete dataForFirestore._toBeRemoved;
        delete dataForFirestore.createdAt; // Wird durch timestamp ersetzt oder nicht aktualisiert

        // Spezifische Anpassungen pro Collection
        if (collectionName === 'teams') {
            const mitgliederFirestoreIds = (item.mitglieder || [])
                .map(localId => teilnehmerIdMap ? teilnehmerIdMap.get(localId) : null) // Konvertiere zu Firestore IDs
                .filter(firestoreId => !!firestoreId); // Nur gültige IDs
            dataForFirestore.mitglieder = mitgliederFirestoreIds;
            delete dataForFirestore.teamname; // Nur teamname speichern
            dataForFirestore.teamname = item.teamname;
        } else if (collectionName === 'ergebnisse') {
            dataForFirestore.teilnehmerId = teilnehmerFirestoreId;
            dataForFirestore.teamId = teamFirestoreId; // Kann null sein
            delete dataForFirestore.teilnehmerLocalId;
            delete dataForFirestore.teamLocalId;
            // Timestamp-Handling (siehe unten)
        } else if (collectionName === 'scheibenErgebnisse') {
            dataForFirestore.teilnehmerId = teilnehmerFirestoreId;
            delete dataForFirestore.teilnehmerLocalId;
            dataForFirestore.werte = Array.isArray(item.werte) ? item.werte : []; // Sicherstellen, dass es ein Array ist
            // Timestamp-Handling (siehe unten)
        } else if (collectionName === 'teilnehmer') {
             delete dataForFirestore.vorname; // Nur vorname/name speichern
             delete dataForFirestore.name;
             dataForFirestore.vorname = item.vorname;
             dataForFirestore.name = item.name;
        }

        // --- Batch-Operationen hinzufügen ---
        if (item._syncStatus === 'new') {
            const docRef = doc(collection(db, collectionName));
            dataForFirestore.timestamp = serverTimestamp(); // Zeitstempel für neue Docs
            // Bei Update wird timestamp nicht automatisch gesetzt, muss manuell erfolgen falls gewünscht
            if (collectionName === 'ergebnisse' || collectionName === 'scheibenErgebnisse') {
                 // createdAt wurde oben gelöscht, timestamp wird durch serverTimestamp gesetzt
            }

            batch.set(docRef, dataForFirestore);
            updatedItems[index].firestoreId = docRef.id; // ID für lokales Update vormerken
            updatedItems[index]._pendingSync = true; // Markieren für Status-Update nach Commit
            console.log(`Sync (${collectionName}): Neues Item "${item.name || item.teamname || item.localId}" wird hinzugefügt.`);

        } else if (item._syncStatus === 'modified' && item.firestoreId) {
            const docRef = doc(db, collectionName, item.firestoreId);
            delete dataForFirestore.timestamp; // Standardmäßig Timestamp nicht ändern bei Update
            // Falls doch gewünscht: dataForFirestore.lastModified = serverTimestamp();
            if (collectionName === 'ergebnisse' || collectionName === 'scheibenErgebnisse') {
                // Lokales Datum beibehalten, wenn vorhanden und gewünscht
                if (item.createdAt) {
                    try {
                        dataForFirestore.timestamp = Timestamp.fromDate(new Date(item.createdAt));
                    } catch (e) { console.warn("Ungültiges createdAt Datum:", item.createdAt); }
                }
            }

            batch.update(docRef, dataForFirestore);
            updatedItems[index]._pendingSync = true;
            console.log(`Sync (${collectionName}): Item "${item.name || item.teamname || item.localId}" (${item.firestoreId}) wird aktualisiert.`);

        } else if (item._syncStatus === 'deleted' && item.firestoreId) {
            const docRef = doc(db, collectionName, item.firestoreId);
            batch.delete(docRef);
            updatedItems[index]._toBeRemoved = true; // Markieren für lokales Entfernen nach Commit
            console.log(`Sync (${collectionName}): Item "${item.name || item.teamname || item.localId}" (${item.firestoreId}) wird gelöscht.`);

        } else if (item._syncStatus === 'deleted' && !item.firestoreId) {
            console.warn(`Sync (${collectionName}): Item "${item.name || item.teamname || item.localId}" war 'deleted', hatte aber keine Firestore ID. Wird lokal entfernt.`);
            updatedItems[index]._toBeRemoved = true;

        } else if (item._syncStatus === 'modified' && !item.firestoreId) {
             console.error(`Sync (${collectionName}): Inkonsistenter Status für "${item.name || item.teamname || item.localId}". Status 'modified' aber keine Firestore ID.`);
             changesDetected = false; // Diese Änderung kann nicht durchgeführt werden
        }
    });

    return { updatedItems, changesDetected };
}


// --- Sync-Funktion für Teilnehmer ---
async function syncTeilnehmer(batch) {
    console.log("SyncManager: Prüfe Teilnehmer...");
    const lokaleDaten = getLocalData(TEILNEHMER_KEY);
    const { updatedItems, changesDetected } = processItemsForSync(lokaleDaten, "teilnehmer", batch);
    return { updatedItems, changesDetected };
}

// --- Sync-Funktion für Teams ---
async function syncTeams(batch, teilnehmerIdMap) {
    console.log("SyncManager: Prüfe Teams...");
    const lokaleDaten = getLocalData(TEAMS_KEY);
    const { updatedItems, changesDetected } = processItemsForSync(lokaleDaten, "teams", batch, teilnehmerIdMap);
    return { updatedItems, changesDetected };
}

// --- Sync-Funktion für Ergebnisse ---
async function syncErgebnisse(batch, teilnehmerIdMap, teamIdMap) {
    console.log("SyncManager: Prüfe Ergebnisse...");
    const lokaleDaten = getLocalData(ERGEBNISSE_KEY);
    const { updatedItems, changesDetected } = processItemsForSync(lokaleDaten, "ergebnisse", batch, teilnehmerIdMap, teamIdMap);
    return { updatedItems, changesDetected };
}

// --- Sync-Funktion für Scheiben ---
async function syncScheiben(batch, teilnehmerIdMap) {
    console.log("SyncManager: Prüfe Scheiben...");
    const lokaleDaten = getLocalData(SCHEIBEN_KEY);
    const { updatedItems, changesDetected } = processItemsForSync(lokaleDaten, "scheibenErgebnisse", batch, teilnehmerIdMap);
    return { updatedItems, changesDetected };
}

// --- Sync-Funktion für Abrechnung ---
async function syncAbrechnung(batch, teamIdMap) {
    console.log("SyncManager: Prüfe Abrechnung...");
    const paymentStatus = getLocalData(PAYMENT_STATUS_KEY) || {};
    let changesDetected = false;
    let updatedPaymentStatus = structuredClone(paymentStatus); // Kopie

    for (const teamLocalId in updatedPaymentStatus) {
        const status = updatedPaymentStatus[teamLocalId];
        if (status && status._syncStatus === 'modified') {
            const teamFirestoreId = teamIdMap.get(teamLocalId);

            if (teamFirestoreId) { // Nur synchronisieren, wenn das Team eine Firestore ID hat
                changesDetected = true; // Markieren, dass der Batch ausgeführt werden muss

                const docRef = doc(db, "teams", teamFirestoreId);
                // Daten filtern, die *nicht* nach Firestore sollen
                const paymentDataForFirestore = { ...status };
                delete paymentDataForFirestore._syncStatus;
                delete paymentDataForFirestore._lastModifiedLocal; // Falls verwendet
                delete paymentDataForFirestore._pendingSync; // Sicherstellen, dass es weg ist

                // Aktualisiere ein bestimmtes Feld im Team-Dokument, z.B. 'paymentInfo'
                batch.update(docRef, {
                    paymentInfo: paymentDataForFirestore,
                    paymentLastUpdated: serverTimestamp() // Zeitstempel für letzte Zahlungsänderung
                });
                console.log(`Sync (Abrechnung): Aktualisiere paymentInfo für Team mit FirestoreID ${teamFirestoreId}.`);

                // Markiere für lokales Update nach erfolgreichem Commit
                updatedPaymentStatus[teamLocalId]._pendingSync = true;

            } else {
                console.warn(`Sync (Abrechnung): Team ${teamLocalId} hat Zahlungsstatus 'modified', aber keine Firestore ID (wahrscheinlich noch 'new' oder gelöscht). Wird beim nächsten Mal synchronisiert.`);
                // Status NICHT ändern, damit es beim nächsten Sync erneut versucht wird.
            }
        }
    }
    return { updatedPaymentStatus, changesDetected };
}


// --- Zentrale Synchronisationsfunktion ---
export async function synchronizeAllData(showStatus = true) {
    const statusElement = getStatusElement(); // Element einmal holen
    if (showStatus) zeigeStatus("Starte Synchronisation...", 'info', statusElement, 5000); // Längere Anzeige
    console.log("SyncManager: Starte synchronizeAllData");

    // 0. Prüfen, ob online
    if (!navigator.onLine) {
        console.log("Offline, überspringe Synchronisation.");
        if (showStatus) zeigeStatus("Offline, Synchronisation übersprungen.", 'info', statusElement);
        return false;
    }

    const batch = writeBatch(db);
    let overallSuccess = true;
    let anyChangesMade = false;
    let syncErrors = [];

    let finalTeilnehmer = getLocalData(TEILNEHMER_KEY);
    let finalTeams = getLocalData(TEAMS_KEY);
    let finalErgebnisse = getLocalData(ERGEBNISSE_KEY);
    let finalScheiben = getLocalData(SCHEIBEN_KEY);
    let finalPaymentStatus = getLocalData(PAYMENT_STATUS_KEY) || {};

    try {
        // --- 1. Teilnehmer synchronisieren ---
        const { updatedItems: updatedTeilnehmer, changesDetected: teilnehmerChanges } = await syncTeilnehmer(batch);
        if (teilnehmerChanges) anyChangesMade = true;
        finalTeilnehmer = updatedTeilnehmer; // Zwischenspeichern für ID-Maps und Finalisierung

        // --- ID Map für Teilnehmer erstellen (wird für Teams, Ergebnisse, Scheiben benötigt) ---
        const teilnehmerIdMap = new Map(
            finalTeilnehmer
            .filter(t => t.localId && t.firestoreId) // Nur die mit beiden IDs
            .map(t => [t.localId, t.firestoreId])
        );

        // --- 2. Teams synchronisieren ---
        const { updatedItems: updatedTeams, changesDetected: teamChanges } = await syncTeams(batch, teilnehmerIdMap);
        if (teamChanges) anyChangesMade = true;
        finalTeams = updatedTeams; // Zwischenspeichern

        // --- ID Map für Teams erstellen (wird für Ergebnisse, Abrechnung benötigt) ---
        const teamIdMap = new Map(
            finalTeams
            .filter(t => t.localId && t.firestoreId)
            .map(t => [t.localId, t.firestoreId])
        );

        // --- 3. Ergebnisse synchronisieren ---
        const { updatedItems: updatedErgebnisse, changesDetected: ergebnisChanges } = await syncErgebnisse(batch, teilnehmerIdMap, teamIdMap);
        if (ergebnisChanges) anyChangesMade = true;
        finalErgebnisse = updatedErgebnisse;

        // --- 4. Scheiben synchronisieren ---
        const { updatedItems: updatedScheiben, changesDetected: scheibenChanges } = await syncScheiben(batch, teilnehmerIdMap);
        if (scheibenChanges) anyChangesMade = true;
        finalScheiben = updatedScheiben;

        // --- 5. Abrechnung synchronisieren ---
        const { updatedPaymentStatus, changesDetected: paymentChanges } = await syncAbrechnung(batch, teamIdMap);
        if (paymentChanges) anyChangesMade = true;
        finalPaymentStatus = updatedPaymentStatus;


        // --- 6. Batch ausführen, wenn Änderungen vorhanden sind ---
        if (anyChangesMade) {
            console.log("SyncManager: Führe Firestore Batch aus...");
            await batch.commit();
            console.log("SyncManager: Batch erfolgreich ausgeführt.");

            // --- 7. Lokale Daten finalisieren (Status 'synced' setzen, IDs speichern, Gelöschte entfernen) ---
            const successTeilnehmer = setLocalData(TEILNEHMER_KEY, finalizeLocalItems(finalTeilnehmer));
            const successTeams = setLocalData(TEAMS_KEY, finalizeLocalItems(finalTeams));
            const successErgebnisse = setLocalData(ERGEBNISSE_KEY, finalizeLocalItems(finalErgebnisse));
            const successScheiben = setLocalData(SCHEIBEN_KEY, finalizeLocalItems(finalScheiben));

            // Abrechnung finalisieren (Status 'synced' setzen)
            let paymentStatusFinalized = false;
            for (const teamLocalId in finalPaymentStatus) {
                const status = finalPaymentStatus[teamLocalId];
                if (status && status._pendingSync) {
                    status._syncStatus = 'synced';
                    delete status._pendingSync;
                    paymentStatusFinalized = true;
                }
            }
            const successPayment = paymentStatusFinalized ? setLocalData(PAYMENT_STATUS_KEY, finalPaymentStatus) : true; // Nur speichern, wenn was geändert wurde

            if (!successTeilnehmer || !successTeams || !successErgebnisse || !successScheiben || !successPayment) {
                console.error("SyncManager: Fehler beim Speichern finalisierter lokaler Daten!");
                syncErrors.push("Fehler beim lokalen Speichern nach Sync.");
                overallSuccess = false; // Markieren als fehlgeschlagen
            }

            // Zeitstempel für letzten Sync speichern (nur bei Erfolg)
            if (overallSuccess) {
                 setLocalData(LAST_SYNC_KEY, new Date().toISOString());
            }

        } else {
            console.log("SyncManager: Keine Änderungen zum Synchronisieren gefunden.");
        }

        // --- 8. Gesamtergebnis verarbeiten ---
        if (overallSuccess) {
            console.log("SyncManager: Synchronisation erfolgreich abgeschlossen.");
            if (showStatus) {
                if (anyChangesMade) {
                     zeigeStatus("Synchronisation erfolgreich abgeschlossen!", 'erfolg', statusElement);
                } else {
                     zeigeStatus("Keine Änderungen zum Synchronisieren gefunden.", 'info', statusElement);
                }
            }
            // Event auslösen, damit andere Seiten ggf. neu laden können
            window.dispatchEvent(new CustomEvent('datasync-complete', { detail: { success: true, changesMade: anyChangesMade } }));
            return true;
        } else {
            // Fehlerfall wurde schon oben behandelt oder durch lokalen Speicherfehler ausgelöst
            console.error("SyncManager: Synchronisation fehlgeschlagen.", syncErrors);
            if (showStatus) zeigeStatus(`Synchronisation fehlgeschlagen. ${syncErrors.join(' ')}`, 'fehler', statusElement, 5000);
             window.dispatchEvent(new CustomEvent('datasync-complete', { detail: { success: false, error: syncErrors.join('; ') } }));
            return false;
        }

    } catch (error) {
        // Fängt Fehler im Batch-Commit oder in der Hauptlogik ab
        console.error("SyncManager: Schwerwiegender Fehler während der Synchronisation:", error);
        syncErrors.push(error.message || "Unbekannter Fehler");
        if (showStatus) zeigeStatus(`Synchronisationsfehler: ${error.message}`, 'fehler', statusElement, 5000);
        window.dispatchEvent(new CustomEvent('datasync-complete', { detail: { success: false, error: error.message } }));
        return false;
    }
}
