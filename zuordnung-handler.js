import { db } from "./firebase-config.js";
import { doc, getDoc, updateDoc } from "https://www.gstatic.com/firebasejs/11.4.0/firebase-firestore.js";

async function updateTeamParticipants(teamId, newParticipants) {
    try {
        const teamRef = doc(db, "teams", teamId);
        const teamSnap = await getDoc(teamRef);

        if (!teamSnap.exists()) {
            throw new Error(`Team mit ID ${teamId} existiert nicht.`);
        }

        const existingParticipants = teamSnap.data().participants || [];
        const updatedParticipants = [...new Set([...existingParticipants, ...newParticipants])]; // Duplikate vermeiden

        await updateDoc(teamRef, { participants: updatedParticipants });
        console.log(`Teilnehmer für Team ${teamId} erfolgreich aktualisiert.`);
    } catch (error) {
        console.error("Fehler beim Aktualisieren der Teilnehmer:", error);
    }
}