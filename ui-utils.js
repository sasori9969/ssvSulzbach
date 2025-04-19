// --- ui-utils.js ---

let statusTimeout; // Variable, um laufende Timeouts zu speichern

/**
 * Zeigt eine Statusmeldung für eine bestimmte Dauer an.
 * @param {string} nachricht Die anzuzeigende Nachricht.
 * @param {'info' | 'erfolg' | 'fehler'} [typ='info'] Der Typ der Meldung (beeinflusst das Styling).
 * @param {number} [dauer=3000] Die Anzeigedauer in Millisekunden.
 */
export function zeigeStatus(nachricht, typ = 'info', dauer = 3000) {
    const statusElement = document.getElementById("statusMeldung");
    if (!statusElement) {
        console.error("Status-Element (#statusMeldung) nicht gefunden!");
        // Fallback auf alert, wenn das Element fehlt
        alert(`[${typ.toUpperCase()}] ${nachricht}`);
        return;
    }

    // Laufenden Timeout löschen, falls vorhanden, um Überlappung zu vermeiden
    clearTimeout(statusTimeout);

    statusElement.textContent = nachricht;
    // Klassen setzen: Basisklasse + Typklasse + 'show' für Sichtbarkeit/Transition
    statusElement.className = `status-meldung ${typ} show`;

    // Timeout zum Ausblenden setzen
    statusTimeout = setTimeout(() => {
        statusElement.classList.remove('show');
        // Optional: Nach der Transition die Typ-Klasse entfernen, damit sie nicht "hängen" bleibt
         setTimeout(() => {
             // Nur entfernen, wenn nicht zwischenzeitlich eine neue Nachricht kam
             if (!statusElement.classList.contains('show')) {
                statusElement.className = 'status-meldung';
             }
         }, 500); // Muss zur CSS Transition Dauer passen (0.5s = 500ms)
    }, dauer);
}


// --- Modal Logic ---
const confirmModal = document.getElementById('confirmModal');
const confirmModalText = document.getElementById('confirmModalText');
const confirmModalOk = document.getElementById('confirmModalOk');
const confirmModalCancel = document.getElementById('confirmModalCancel');
let confirmCallback = null; // Hier speichern wir, was bei "Ja" passieren soll

/**
 * Zeigt einen Bestätigungsdialog (Modal) an.
 * @param {string} nachricht Die Frage, die dem Benutzer gestellt wird.
 * @param {function} onConfirm Die Funktion, die ausgeführt wird, wenn der Benutzer "Ja" klickt.
 */
export function zeigeConfirm(nachricht, onConfirm) {
    // Prüfen, ob alle Modal-Elemente im DOM vorhanden sind
    if (!confirmModal || !confirmModalText || !confirmModalOk || !confirmModalCancel) {
         console.error("Modal-Elemente nicht gefunden! Stelle sicher, dass das HTML für #confirmModal korrekt eingebunden ist.");
         // Fallback auf das native window.confirm, wenn Modal nicht funktioniert
         if (window.confirm(nachricht)) {
             // Führe den Callback direkt aus, wenn der Benutzer im Fallback bestätigt
             if (typeof onConfirm === 'function') {
                 try {
                    onConfirm();
                 } catch (error) {
                    console.error("Fehler im Confirm-Callback (Fallback):", error);
                    // Hier könnten wir theoretisch zeigeStatus nutzen, aber wenn das Modal fehlt,
                    // fehlt vielleicht auch das Status-Element. Daher alert als sicherster Fallback.
                    alert("Ein Fehler ist aufgetreten.");
                 }
             }
         }
         return; // Funktion beenden, da das Modal nicht angezeigt werden kann
    }

    // Modal konfigurieren und anzeigen
    confirmModalText.textContent = nachricht;
    confirmCallback = onConfirm; // Callback für den OK-Button speichern
    confirmModal.style.display = 'block'; // Modal sichtbar machen
}

// --- Event Listener für das Modal (nur einmal hinzufügen!) ---

// Sicherstellen, dass die Elemente existieren, bevor Listener hinzugefügt werden
if (confirmModalOk) {
    confirmModalOk.onclick = () => {
        confirmModal.style.display = 'none'; // Modal ausblenden
        if (typeof confirmCallback === 'function') {
            try {
                confirmCallback(); // Gespeicherten Callback ausführen
            } catch (error) {
                console.error("Fehler im Confirm-Callback:", error);
                // Nutze die eigene Statusfunktion für Fehlermeldungen
                zeigeStatus("Ein Fehler ist bei der Bestätigungsaktion aufgetreten.", 'fehler');
            }
        }
        confirmCallback = null; // Callback zurücksetzen, um Mehrfachausführung zu verhindern
    };
} else {
    console.warn("Modal OK Button (#confirmModalOk) nicht gefunden.");
}

if (confirmModalCancel) {
    confirmModalCancel.onclick = () => {
        confirmModal.style.display = 'none'; // Modal ausblenden
        confirmCallback = null; // Callback zurücksetzen
    };
} else {
    console.warn("Modal Cancel Button (#confirmModalCancel) nicht gefunden.");
}

// Klick außerhalb des Modal-Inhalts schließt es auch (optional aber benutzerfreundlich)
window.addEventListener('click', (event) => {
    // Prüfen ob das Modal sichtbar ist UND ob direkt auf den Hintergrund geklickt wurde
    if (confirmModal && event.target == confirmModal) {
        confirmModal.style.display = 'none';
        confirmCallback = null; // Callback auch hier zurücksetzen
    }
});
