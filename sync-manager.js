// sync-manager.js
import { db } from './firebase-config.js';
import { collection, doc, serverTimestamp, writeBatch } from "https://www.gstatic.com/firebasejs/11.4.0/firebase-firestore.js";
import {
    getLocalData,
    setLocalData,
    finalizeLocalItems,
    TEILNEHMER_KEY,
    TEAMS_KEY,
    ERGEBNISSE_KEY,
    LAST_SYNC_KEY
} from './local-storage-utils.js';
import { zeigeStatus } from './ui-utils.js'; // Annahme: Statusmeldungen sollen global angezeigt werden können

// Hilfsfunktion, um den Status-Container zu finden (kann angepasst werden)
function getStatusElement() {
    // Versucht, das Status-Element auf der aktuellen Seite zu finden
    return document.getElementById('statusMeldung') || document.body; // Fallback auf body
}

// --- Sync-Funktion für Teilnehmer (angepasst aus teilnehmer.html) ---
async function syncTeilnehmer() {
    console.log("SyncManager: Prüfe Teilnehmer...");
    const lokaleTeilnehmer = getLocalData(TEILNEHMER_KEY);
    const hatAenderungen = lokaleTeilnehmer.some(item => item._syncStatus && item._syncStatus !== 'synced');
    if (!hatAenderungen) return { success: true, changesMade: false }; // Nichts zu tun

    console.log("SyncManager: Synchronisiere Teilnehmer...");
    const batch = writeBatch(db);
    let changesInBatch = false;
    let zuAktualisierendeLokaleTeilnehmer = structuredClone(lokaleTeilnehmer);
    let firestoreError = null;

    try {
        zuAktualisierendeLokaleTeilnehmer.forEach((teilnehmer, index) => {
            if (!teilnehmer._syncStatus || teilnehmer._syncStatus === 'synced') return;

            if (teilnehmer._syncStatus === 'new') {
                const docRef = doc(collection(db, "teilnehmer"));
                batch.set(docRef, {
                    vorname: teilnehmer.vorname,
                    name: teilnehmer.name,
                    timestamp: serverTimestamp()
                });
                zuAktualisierendeLokaleTeilnehmer[index].firestoreId = docRef.id;
                zuAktualisierendeLokaleTeilnehmer[index]._pendingSync = true;
                changesInBatch = true;
            } else if (teilnehmer._syncStatus === 'modified' && teilnehmer.firestoreId) {
                const docRef = doc(db, "teilnehmer", teilnehmer.firestoreId);
                batch.update(docRef, { vorname: teilnehmer.vorname, name: teilnehmer.name });
                zuAktualisierendeLokaleTeilnehmer[index]._pendingSync = true;
                changesInBatch = true;
            } else if (teilnehmer._syncStatus === 'deleted' && teilnehmer.firestoreId) {
                const docRef = doc(db, "teilnehmer", teilnehmer.firestoreId);
                batch.delete(docRef);
                zuAktualisierendeLokaleTeilnehmer[index]._toBeRemoved = true;
                changesInBatch = true;
            } else if (teilnehmer._syncStatus === 'deleted' && !teilnehmer.firestoreId) {
                zuAktualisierendeLokaleTeilnehmer[index]._toBeRemoved = true; // Lokal entfernen
            } else if (teilnehmer._syncStatus === 'modified' && !teilnehmer.firestoreId) {
                 console.error(`SyncManager: Inkonsistenter Teilnehmer-Status für "${teilnehmer.name}". Status 'modified' aber keine Firestore ID.`);
            }
        });

        if (changesInBatch) {
            await batch.commit();
            console.log("SyncManager: Firestore Batch-Commit für Teilnehmer erfolgreich.");
        }

        // Lokale Daten finalisieren (Status aktualisieren, Gelöschte entfernen)
        const finaleLokaleTeilnehmer = finalizeLocalItems(zuAktualisierendeLokaleTeilnehmer);
        const wasChangedLocally = finaleLokaleTeilnehmer.length !== lokaleTeilnehmer.length || changesInBatch;

        if (wasChangedLocally) {
            const success = setLocalData(TEILNEHMER_KEY, finaleLokaleTeilnehmer);
            if (!success) {
                 console.error("SyncManager: Fehler beim Speichern der finalen lokalen Teilnehmerdaten!");
                 // Hier könnte man entscheiden, den Gesamt-Sync als fehlgeschlagen zu markieren
            }
        }
        return { success: true, changesMade: changesInBatch || wasChangedLocally };

    } catch (error) {
        console.error("SyncManager: Fehler während der Teilnehmer-Synchronisation:", error);
        firestoreError = error;
        return { success: false, changesMade: false, error: firestoreError };
    }
}

// --- Sync-Funktion für Teams (angepasst aus teams.html) ---
async function syncTeams() {
    console.log("SyncManager: Prüfe Teams...");
    const lokaleTeams = getLocalData(TEAMS_KEY);
    const hatAenderungen = lokaleTeams.some(item => item._syncStatus && item._syncStatus !== 'synced');
    if (!hatAenderungen) return { success: true, changesMade: false };

    console.log("SyncManager: Synchronisiere Teams...");
    const batch = writeBatch(db);
    let changesInBatch = false;
    let zuAktualisierendeLokaleTeams = structuredClone(lokaleTeams);
    let firestoreError = null;

     // WICHTIG: Wir brauchen die Teilnehmer-Map, um localIds in firestoreIds umzuwandeln!
    const teilnehmerMapFirestoreId = new Map(
        getLocalData(TEILNEHMER_KEY)
        .filter(t => t.firestoreId) // Nur die, die schon eine Firestore ID haben
        .map(t => [t.localId, t.firestoreId])
    );

    try {
        zuAktualisierendeLokaleTeams.forEach((team, index) => {
            if (!team._syncStatus || team._syncStatus === 'synced') return;

             // Konvertiere Mitglieder-localIds zu firestoreIds für Firestore
             const mitgliederFirestoreIds = (team.mitglieder || [])
                .map(localId => teilnehmerMapFirestoreId.get(localId))
                .filter(firestoreId => !!firestoreId); // Nur gültige IDs übernehmen

            if (team._syncStatus === 'new') {
                const docRef = doc(collection(db, "teams"));
                batch.set(docRef, {
                    teamname: team.teamname,
                    mitglieder: mitgliederFirestoreIds, // Firestore IDs verwenden
                    timestamp: serverTimestamp()
                });
                zuAktualisierendeLokaleTeams[index].firestoreId = docRef.id;
                zuAktualisierendeLokaleTeams[index]._pendingSync = true;
                changesInBatch = true;
            } else if (team._syncStatus === 'modified' && team.firestoreId) {
                const docRef = doc(db, "teams", team.firestoreId);
                batch.update(docRef, {
                    teamname: team.teamname, // Falls Name änderbar
                    mitglieder: mitgliederFirestoreIds // Firestore IDs verwenden
                });
                zuAktualisierendeLokaleTeams[index]._pendingSync = true;
                changesInBatch = true;
            } else if (team._syncStatus === 'deleted' && team.firestoreId) {
                const docRef = doc(db, "teams", team.firestoreId);
                batch.delete(docRef);
                zuAktualisierendeLokaleTeams[index]._toBeRemoved = true;
                changesInBatch = true;
            } else if (team._syncStatus === 'deleted' && !team.firestoreId) {
                zuAktualisierendeLokaleTeams[index]._toBeRemoved = true;
            } else if (team._syncStatus === 'modified' && !team.firestoreId) {
                 console.error(`SyncManager: Inkonsistenter Team-Status für "${team.teamname}". Status 'modified' aber keine Firestore ID.`);
            }
        });

        if (changesInBatch) {
            await batch.commit();
            console.log("SyncManager: Firestore Batch-Commit für Teams erfolgreich.");
        }

        const finaleLokaleTeams = finalizeLocalItems(zuAktualisierendeLokaleTeams);
        const wasChangedLocally = finaleLokaleTeams.length !== lokaleTeams.length || changesInBatch;

        if(wasChangedLocally) {
            const success = setLocalData(TEAMS_KEY, finaleLokaleTeams);
             if (!success) console.error("SyncManager: Fehler beim Speichern der finalen lokalen Teamdaten!");
        }
        return { success: true, changesMade: changesInBatch || wasChangedLocally };

    } catch (error) {
        console.error("SyncManager: Fehler während der Team-Synchronisation:", error);
        firestoreError = error;
        return { success: false, changesMade: false, error: firestoreError };
    }
}

// --- NEUE Sync-Funktion für Ergebnisse ---
async function syncErgebnisse() {
    console.log("SyncManager: Prüfe Ergebnisse...");
    const lokaleErgebnisse = getLocalData(ERGEBNISSE_KEY);
    const hatAenderungen = lokaleErgebnisse.some(item => item._syncStatus && item._syncStatus !== 'synced');
    if (!hatAenderungen) return { success: true, changesMade: false };

    console.log("SyncManager: Synchronisiere Ergebnisse...");
    const batch = writeBatch(db);
    let changesInBatch = false;
    let zuAktualisierendeLokaleErgebnisse = structuredClone(lokaleErgebnisse);
    let firestoreError = null;

    // Maps für ID-Konvertierung (localId -> firestoreId)
    const teilnehmerMapFirestoreId = new Map(
        getLocalData(TEILNEHMER_KEY)
        .filter(t => t.firestoreId)
        .map(t => [t.localId, t.firestoreId])
    );
     const teamMapFirestoreId = new Map(
        getLocalData(TEAMS_KEY)
        .filter(t => t.firestoreId)
        .map(t => [t.localId, t.firestoreId])
    );

    try {
        zuAktualisierendeLokaleErgebnisse.forEach((ergebnis, index) => {
            if (!ergebnis._syncStatus || ergebnis._syncStatus === 'synced') return;

            // Konvertiere IDs für Firestore
            const teilnehmerFirestoreId = teilnehmerMapFirestoreId.get(ergebnis.teilnehmerLocalId);
            const teamFirestoreId = ergebnis.teamLocalId ? teamMapFirestoreId.get(ergebnis.teamLocalId) : null;

            // Überspringe Sync, wenn eine benötigte ID fehlt (außer beim Löschen)
            if (!teilnehmerFirestoreId && ergebnis._syncStatus !== 'deleted') {
                 console.warn(`SyncManager: Überspringe Ergebnis ${ergebnis.localId}, da Teilnehmer-FirestoreID fehlt.`);
                 return; // Nächstes Ergebnis
            }
             if (ergebnis.teamLocalId && !teamFirestoreId && ergebnis._syncStatus !== 'deleted') {
                 console.warn(`SyncManager: Überspringe Ergebnis ${ergebnis.localId}, da Team-FirestoreID fehlt.`);
                 return; // Nächstes Ergebnis
            }

            const firestoreData = {
                // Wichtig: Firestore IDs speichern!
                teilnehmerId: teilnehmerFirestoreId,
                teamId: teamFirestoreId, // Ist null, wenn kein Team
                ergebnis: ergebnis.ergebnis,
                // Konvertiere ISO-String zurück zu Firestore Timestamp für neue Einträge
                timestamp: ergebnis._syncStatus === 'new' ? serverTimestamp() : (ergebnis.createdAt ? new Date(ergebnis.createdAt) : serverTimestamp())
                // Beachte: serverTimestamp() nur bei .set() oder .add() verwenden, nicht bei .update()
                // Wenn du das exakte lokale Datum behalten willst, nutze new Date(ergebnis.createdAt)
            };

            if (ergebnis._syncStatus === 'new') {
                const docRef = doc(collection(db, "ergebnisse"));
                // Stelle sicher, dass timestamp korrekt gesetzt wird
                firestoreData.timestamp = serverTimestamp();
                batch.set(docRef, firestoreData);
                zuAktualisierendeLokaleErgebnisse[index].firestoreId = docRef.id;
                zuAktualisierendeLokaleErgebnisse[index]._pendingSync = true;
                changesInBatch = true;
            } else if (ergebnis._syncStatus === 'modified' && ergebnis.firestoreId) {
                const docRef = doc(db, "ergebnisse", ergebnis.firestoreId);
                 // Entferne timestamp für Update, wenn serverTimestamp nicht verwendet werden soll
                 // oder setze es explizit auf das lokale Datum, falls das gewünscht ist.
                 // delete firestoreData.timestamp; // Wenn das Datum nicht geändert werden soll
                 firestoreData.timestamp = new Date(ergebnis.createdAt); // Lokales Datum beibehalten
                batch.update(docRef, firestoreData);
                zuAktualisierendeLokaleErgebnisse[index]._pendingSync = true;
                changesInBatch = true;
            } else if (ergebnis._syncStatus === 'deleted' && ergebnis.firestoreId) {
                const docRef = doc(db, "ergebnisse", ergebnis.firestoreId);
                batch.delete(docRef);
                zuAktualisierendeLokaleErgebnisse[index]._toBeRemoved = true;
                changesInBatch = true;
            } else if (ergebnis._syncStatus === 'deleted' && !ergebnis.firestoreId) {
                zuAktualisierendeLokaleErgebnisse[index]._toBeRemoved = true;
            } else if (ergebnis._syncStatus === 'modified' && !ergebnis.firestoreId) {
                 console.error(`SyncManager: Inkonsistenter Ergebnis-Status für ${ergebnis.localId}. Status 'modified' aber keine Firestore ID.`);
            }
        });

        if (changesInBatch) {
            await batch.commit();
            console.log("SyncManager: Firestore Batch-Commit für Ergebnisse erfolgreich.");
        }

        const finaleLokaleErgebnisse = finalizeLocalItems(zuAktualisierendeLokaleErgebnisse);
        const wasChangedLocally = finaleLokaleErgebnisse.length !== lokaleErgebnisse.length || changesInBatch;

        if(wasChangedLocally) {
            const success = setLocalData(ERGEBNISSE_KEY, finaleLokaleErgebnisse);
             if (!success) console.error("SyncManager: Fehler beim Speichern der finalen lokalen Ergebnisdaten!");
        }
         return { success: true, changesMade: changesInBatch || wasChangedLocally };

    } catch (error) {
        console.error("SyncManager: Fehler während der Ergebnis-Synchronisation:", error);
        firestoreError = error;
        return { success: false, changesMade: false, error: firestoreError };
    }
}


// --- Zentrale Synchronisationsfunktion ---
export async function synchronizeAllData(showStatus = true) {
    if (showStatus) zeigeStatus("Starte Synchronisation...", 'info', getStatusElement());
    console.log("SyncManager: Starte synchronizeAllData");

    let teilnehmerResult = { success: true, changesMade: false };
    let teamsResult = { success: true, changesMade: false };
    let ergebnisseResult = { success: true, changesMade: false };
    let overallSuccess = true;
    let anyChangesMade = false;

    try {
        // 1. Teilnehmer synchronisieren (wichtig wegen IDs für Teams/Ergebnisse)
        teilnehmerResult = await syncTeilnehmer();
        if (!teilnehmerResult.success) overallSuccess = false;
        if (teilnehmerResult.changesMade) anyChangesMade = true;

        // 2. Teams synchronisieren (braucht aktuelle Teilnehmer-IDs)
        if (overallSuccess) { // Nur weitermachen, wenn bisher erfolgreich
             teamsResult = await syncTeams();
             if (!teamsResult.success) overallSuccess = false;
             if (teamsResult.changesMade) anyChangesMade = true;
        }

        // 3. Ergebnisse synchronisieren (braucht aktuelle Teilnehmer/Team-IDs)
         if (overallSuccess) { // Nur weitermachen, wenn bisher erfolgreich
            ergebnisseResult = await syncErgebnisse();
            if (!ergebnisseResult.success) overallSuccess = false;
            if (ergebnisseResult.changesMade) anyChangesMade = true;
         }

        // 4. Gesamtergebnis verarbeiten
        if (overallSuccess) {
            const now = new Date().toISOString();
            setLocalData(LAST_SYNC_KEY, now); // Zeitstempel nur bei komplettem Erfolg setzen
            console.log("SyncManager: Synchronisation erfolgreich abgeschlossen.");
            if (showStatus) {
                if (anyChangesMade) {
                     zeigeStatus("Synchronisation erfolgreich abgeschlossen!", 'erfolg', getStatusElement());
                } else {
                     zeigeStatus("Keine Änderungen zum Synchronisieren gefunden.", 'info', getStatusElement());
                }
            }
            // Optional: UI auf allen Seiten aktualisieren (z.B. durch Event oder Neuladen der lokalen Daten)
            // window.dispatchEvent(new CustomEvent('datasync-complete'));
            return true;
        } else {
            console.error("SyncManager: Synchronisation fehlgeschlagen.");
             if (showStatus) zeigeStatus("Synchronisation fehlgeschlagen. Details siehe Konsole.", 'fehler', getStatusElement());
            // Fehlerdetails ausgeben
            if (!teilnehmerResult.success) console.error("Fehler bei Teilnehmer-Sync:", teilnehmerResult.error);
            if (!teamsResult.success) console.error("Fehler bei Team-Sync:", teamsResult.error);
            if (!ergebnisseResult.success) console.error("Fehler bei Ergebnis-Sync:", ergebnisseResult.error);
            return false;
        }

    } catch (error) {
        // Fängt unerwartete Fehler in der synchronizeAllData Logik selbst ab
        console.error("SyncManager: Unerwarteter Fehler in synchronizeAllData:", error);
        if (showStatus) zeigeStatus("Ein unerwarteter Fehler ist während der Synchronisation aufgetreten.", 'fehler', getStatusElement());
        return false;
    }
}
