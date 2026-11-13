// Le côté « coffre » du lien avec un jeu. Notre page a été ouverte par un jeu, dans sa propre fenêtre ; le jeu lui
// demande de connecter le joueur. Ce fichier ne fait que l'échange de messages : il ne signe rien et n'ouvre rien.
//
// Règles :
//   - seuls les jeux enregistrés (`jeux` : origine -> nom) sont écoutés, et seulement la fenêtre qui nous a ouverts ;
//   - une seule demande par fenêtre ; une demande retirée par le jeu ne reçoit plus de réponse ;
//   - une demande ne vit que cinq minutes, même si le jeu oublie de la retirer : après, rien ne part et le jeu
//     reçoit un refus ;
//   - la réponse n'est envoyée qu'à l'origine qui a fait la demande, jamais à « tout le monde ».
//
//   fenetre : notre fenêtre (addEventListener)   ouvreur : la fenêtre du jeu (postMessage)

const ID = /^[A-Za-z0-9_-]{8,64}$/;
const DEFI = /^[A-Za-z0-9_-]{16,128}$/;
const ADRESSE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export const DUREE_DEMANDE = 300000;   // millisecondes : la durée de la preuve de connexion elle-même

export function lienJeu({ fenetre, ouvreur, jeux, surDemande, surRetrait, noter, duree, horloge }) {
  const dire = noter || (() => {});
  const limite = duree || DUREE_DEMANDE, maintenant = horloge || (() => Date.now());
  let demande = null, repondu = false;
  const origines = Object.keys(jeux || {});
  // La demande a dépassé sa durée : elle est retirée d'ici, et le jeu est prévenu qu'il ne recevra rien.
  function expirer() {
    if (!demande || demande.retiree || repondu) return;
    demande.retiree = true; demande.expiree = true;
    try { ouvreur.postMessage({ type: 'coffre-refus', id: demande.id, raison: 'expiree' }, demande.jeu); } catch (_) { /* fenêtre fermée */ }
    dire('[jeu] demande expiree');
    if (surRetrait) surRetrait(demande);
  }
  const depassee = () => !!demande && maintenant() - demande.recue >= limite;

  fenetre.addEventListener('message', (ev) => {
    if (ev.source !== ouvreur || !Object.prototype.hasOwnProperty.call(jeux, ev.origin)) return;
    const m = ev.data;
    if (!m || typeof m !== 'object') return;
    if (m.type === 'jeu-connexion') {
      if (demande) return;   // une seule demande par fenêtre
      if (typeof m.id !== 'string' || !ID.test(m.id) || typeof m.defi !== 'string' || !DEFI.test(m.defi)) return;
      if (m.adresse !== undefined && (typeof m.adresse !== 'string' || !ADRESSE.test(m.adresse))) return;
      demande = { jeu: ev.origin, nom: String(jeux[ev.origin]), id: m.id, defi: m.defi, attendue: m.adresse || null, retiree: false, expiree: false, recue: maintenant() };
      setTimeout(expirer, limite);
      dire('[jeu] demande de connexion de ' + ev.origin);
      if (surDemande) surDemande(demande);
    } else if (m.type === 'jeu-annule' && demande && m.id === demande.id && ev.origin === demande.jeu && !repondu) {
      demande.retiree = true;
      dire('[jeu] demande retiree par le jeu');
      if (surRetrait) surRetrait(demande);
    }
  });

  // Dire au jeu que la fenêtre est prête. Chaque envoi vise une origine enregistrée : un autre site ne reçoit rien.
  function annoncer() { for (const o of origines) { try { ouvreur.postMessage({ type: 'coffre-pret', v: 1 }, o); } catch (_) { /* fenêtre fermée */ } } }

  return {
    annoncer,
    demande: () => demande,
    // Envoyer la preuve. Refuse si la demande a été retirée ou a déjà reçu sa réponse : à revérifier ici, au dernier moment.
    repondre({ adresse, message, signature }) {
      if (depassee()) expirer();   // un minuteur peut dormir dans une fenêtre en arrière-plan : l'heure est relue ici
      if (!demande || demande.retiree || repondu) return false;
      repondu = true;
      ouvreur.postMessage({ type: 'coffre-connexion', id: demande.id, adresse, message, signature }, demande.jeu);
      dire('[jeu] preuve de connexion envoyee a ' + demande.jeu);
      return true;
    },
    // Dire au jeu que le joueur a renoncé, ou que la connexion n'a pas pu se faire. Aucune preuve n'est envoyée.
    renoncer(raison) {
      if (depassee()) expirer();
      if (!demande || demande.retiree || repondu) return false;
      repondu = true;
      ouvreur.postMessage({ type: 'coffre-refus', id: demande.id, raison: String(raison || 'renonce').slice(0, 40) }, demande.jeu);
      return true;
    },
  };
}
