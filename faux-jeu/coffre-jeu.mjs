// Le côté « jeu » : ce qu'un studio met dans sa page pour le bouton « Se connecter ». Aucune dépendance.
//
//   import { connexionCoffre } from './coffre-jeu.mjs';
//   bouton.addEventListener('click', async () => {
//     const { adresse, message, signature } = await connexionCoffre({ coffre: 'https://…/', defi }).resultat;
//     // envoyer adresse, message et signature au serveur du jeu, qui vérifie (verifierConnexionJeu de contrat.mjs)
//   });
//
//   coffre     l'adresse de la page du coffre
//   defi       un défi tiré par le serveur du jeu pour cette tentative (16 à 128 caractères parmi A-Z a-z 0-9 _ -),
//              qu'il n'acceptera qu'une fois
//   adresse    facultatif : le wallet déjà lié à ce compte de jeu. La fenêtre refusera alors d'en créer un autre.
//
// À appeler dans le geste du joueur (un clic), sans rien attendre avant : sinon le navigateur bloque l'ouverture
// de la fenêtre. Le défi se demande donc au serveur du jeu à l'avance (voir demo.mjs et serveur-jeu.mjs).
// Le jeu ne reçoit qu'une adresse et une preuve signée. C'est son serveur qui décide, après vérification.

const hasard = () => { const o = crypto.getRandomValues(new Uint8Array(18)); let s = ''; for (const x of o) s += String.fromCharCode(x); return btoa(s).replace(/\+/g, '-').replace(/\//g, '_'); };

export function connexionCoffre({ coffre, defi, adresse, fenetre, delai }) {
  const moi = fenetre || window;
  const origineCoffre = new URL(coffre).origin;
  const id = hasard();
  let fini = false, minuteur = null, veille = null, ecoute = null, w = null;
  let reussir, echouer;
  const resultat = new Promise((ok, non) => { reussir = ok; echouer = non; });
  const erreur = (nom) => Object.assign(new Error(nom), { name: nom });
  const finir = (fn, valeur) => {
    if (fini) return;
    fini = true;
    if (minuteur) clearTimeout(minuteur);
    if (veille) clearInterval(veille);
    if (ecoute) moi.removeEventListener('message', ecoute);
    fn(valeur);
  };

  // Un nom de fenêtre par tentative : deux clics, ou deux onglets du jeu, ne se disputent jamais la même fenêtre.
  w = moi.open(coffre, 'coffre-' + id, 'popup,width=440,height=720');
  if (!w) { finir(echouer, erreur('FenetreBloquee')); return { resultat, annuler() {} }; }

  ecoute = (ev) => {
    // Seule la fenêtre que nous avons ouverte, et seulement depuis l'adresse du coffre.
    if (fini || ev.source !== w || ev.origin !== origineCoffre) return;
    const m = ev.data;
    if (!m || typeof m !== 'object') return;
    if (m.type === 'coffre-pret') {
      const demande = { type: 'jeu-connexion', id, defi };
      if (adresse) demande.adresse = adresse;
      w.postMessage(demande, origineCoffre);
    } else if (m.type === 'coffre-connexion' && m.id === id) {
      if (typeof m.adresse !== 'string' || typeof m.message !== 'string' || typeof m.signature !== 'string') return;
      finir(reussir, { adresse: m.adresse, message: m.message, signature: m.signature });
    } else if (m.type === 'coffre-refus' && m.id === id) {
      finir(echouer, erreur('ConnexionRefusee'));
    }
  };
  moi.addEventListener('message', ecoute);
  // La fenêtre fermée sans réponse : on laisse un instant à un dernier message, puis on renonce.
  veille = setInterval(() => { if (w.closed) { clearInterval(veille); veille = null; setTimeout(() => finir(echouer, erreur('FenetreFermee')), 400); } }, 500);
  // Ne plus attendre, c'est retirer sa demande : la fenêtre du coffre doit le savoir, pour ne plus rien envoyer
  // ni annoncer au joueur une connexion que plus personne n'écoute.
  const retirer = () => { try { w.postMessage({ type: 'jeu-annule', id }, origineCoffre); } catch (_) { /* fenêtre fermée */ } };
  minuteur = setTimeout(() => { retirer(); finir(echouer, erreur('DelaiDepasse')); }, delai || 300000);

  return {
    resultat,
    annuler() { retirer(); finir(echouer, erreur('Annule')); },
  };
}
