// load-nav.js
document.addEventListener('DOMContentLoaded', () => {
    const navPlaceholder = document.getElementById('navigation-placeholder');
    if (!navPlaceholder) {
        console.error('Navigation placeholder (<div id="navigation-placeholder">) not found on this page!');
        return;
    }

    fetch('navigation.html') // Lädt den Inhalt der Navigationsdatei
        .then(response => {
            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }
            return response.text(); // Gibt den HTML-Inhalt als Text zurück
        })
        .then(html => {
            navPlaceholder.innerHTML = html; // Fügt das HTML in den Platzhalter ein
            setActiveNavLink(); // Ruft die Funktion auf, um den aktiven Link zu markieren
        })
        .catch(error => {
            console.error('Error loading navigation:', error);
            navPlaceholder.innerHTML = '<p style="color: red;">Fehler beim Laden der Navigation.</p>'; // Fehlermeldung anzeigen
        });
});

function setActiveNavLink() {
    // Ermittelt den Dateinamen der aktuellen Seite (z.B. "index.html")
    const currentPage = window.location.pathname.split('/').pop();
    if (!currentPage) return; // Abbruch, falls kein Dateiname ermittelt werden kann

    // Sucht alle Links innerhalb der geladenen Navigation
    const navLinks = document.querySelectorAll('#navigation-placeholder nav ul li a');

    navLinks.forEach(link => {
        const linkPage = link.getAttribute('href').split('/').pop();
        // Vergleicht den href des Links mit der aktuellen Seite
        if (linkPage === currentPage) {
            link.classList.add('aktiv'); // Fügt die Klasse 'aktiv' hinzu, wenn sie übereinstimmen
        } else {
            link.classList.remove('aktiv'); // Entfernt die Klasse 'aktiv', falls sie nicht übereinstimmen
        }
    });
}
