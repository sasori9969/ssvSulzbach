// /workspaces/ssvSulzbach/load-nav.js

document.addEventListener('DOMContentLoaded', function() {
    const navPlaceholder = document.getElementById('navigation-placeholder');
    if (navPlaceholder) {
        fetch('navigation.html') // Pfad zur Navigationsdatei
            .then(response => {
                if (!response.ok) {
                    throw new Error('Navigation konnte nicht geladen werden.');
                }
                return response.text();
            })
            .then(html => {
                navPlaceholder.innerHTML = html;

                // --- NEU: Admin-Link abfangen ---
                const adminLink = navPlaceholder.querySelector('a[href="adminOnly.html"]');
                const adminCode = "0009"; // Der geheime Code

                if (adminLink) {
                    adminLink.addEventListener('click', function(event) {
                        event.preventDefault(); // Standard-Navigation verhindern

                        const enteredCode = prompt("Bitte gib den Admin-Code ein:");

                        if (enteredCode === adminCode) {
                            // Code korrekt, zur Admin-Seite navigieren
                            console.log("Admin-Code korrekt, navigiere zu adminOnly.html");
                            window.location.href = adminLink.href;
                        } else if (enteredCode !== null) {
                            // Falscher Code eingegeben (und nicht abgebrochen)
                            console.log("Falscher Admin-Code eingegeben.");
                            alert("Falscher Code!");
                        } else {
                            // Eingabe abgebrochen (enteredCode === null)
                            console.log("Admin-Code Eingabe abgebrochen.");
                        }
                    });
                } else {
                    console.warn("Admin-Link in der Navigation nicht gefunden. Passwortschutz kann nicht angewendet werden.");
                }
                // --- Ende NEU ---

            })
            .catch(error => {
                console.error('Fehler beim Laden der Navigation:', error);
                if (navPlaceholder) { // Sicherstellen, dass das Element noch existiert
                   navPlaceholder.innerHTML = '<p>Fehler beim Laden der Navigation.</p>';
                }
            });
    } else {
        console.warn("Navigations-Platzhalter nicht gefunden.");
    }
});
