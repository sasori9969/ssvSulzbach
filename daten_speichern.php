<?php
// Datenbankverbindung herstellen
$servername = "database-5017250446.webspace-host.com";
$database = "dbs13846823";
$username = "dbu1278139";
$password = "Iwoiweis18+";

$conn = new mysqli($servername, $username, $password, $database);

// Überprüfen, ob die Verbindung erfolgreich war
if ($conn->connect_error) {
    die("Verbindung fehlgeschlagen: " . $conn->connect_error);
}

// Daten aus dem Formular empfangen
$vorname = $_POST['vorname'];
$nachname = $_POST['nachname'];

// SQL-Abfrage zum Einfügen der Daten
$sql = "INSERT INTO deine_tabelle (vorname, nachname) VALUES ('$vorname', '$nachname')";

if ($conn->query($sql) === TRUE) {
    echo "Daten erfolgreich gespeichert";
} else {
    echo "Fehler beim Speichern der Daten: " . $sql . "<br>" . $conn->error;
}

$conn->close();
?>