// L'écran de l'essai du compte. Toute la logique est dans client.mjs ; ici, seulement les boutons, les messages
// et le stockage de l'appareil.

import * as K from './contrat.mjs';
import { client } from './client.mjs';
import { REGLAGES } from './reglages.mjs';
import { lienJeu } from './lien-jeu.mjs';
import { melanger } from './noyau.mjs';

// Le retour d'une porte d'identité (Google, Discord…) arrive dans le fragment de l'adresse : `#i=<code>` ou
// `#i-refus=<mot>`. Il est lu puis retiré de l'adresse ici, avant toute autre chose : il ne doit rester ni dans la
// barre d'adresse, ni dans l'historique, ni dans une adresse recopiée. Seul, ce code ne vaut rien : il ne s'échange
// qu'avec le vérifieur resté dans le rangement de cette fenêtre (voir client.mjs).
const RETOUR_PORTE = (() => {
  let h = '';
  try { h = String(location.hash || ''); } catch (_) { return null; }
  if (!/^#i(-refus)?=/.test(h)) return null;
  try { history.replaceState(null, '', location.pathname + location.search); }
  catch (_) { try { location.hash = ''; } catch (_e) { /* l'adresse garde son fragment : le code n'y vaut rien seul */ } }
  return h.slice(1);
})();
// Le même fragment posé sur la page déjà chargée (une adresse recopiée dans le même onglet) : ce n'est pas un retour,
// la page ne le traite pas ; elle le retire seulement de l'adresse, comme au chargement.
try {
  window.addEventListener('hashchange', () => {
    let h = '';
    try { h = String(location.hash || ''); } catch (_) { return; }
    if (/^#i(-refus)?=/.test(h)) { try { history.replaceState(null, '', location.pathname + location.search); } catch (_) { /* rien */ } }
  });
} catch (_) { /* pas de fenêtre à écouter */ }

const $ = (id) => document.getElementById(id);
const VUES = ['v-accueil', 'v-coffre', 'v-mission', 'v-retrouver', 'v-adresses'];
const ETAPES_ADRESSES = ['a-liste', 'a-saisie'];
const ETAPES = ['m-intro', 'm-mots', 'm-cartes', 'm-email'];
const ETAPES_RETROUVER = ['r-mots', 'r-email', 'r-garder'];
const journal = [];
let fiche = null, occupe = false, armeOublier = null;
// Seulement pendant la mission : { m (la mission du client), cartes (les mots mélangés), poses (numéros des cartes posées),
// verifie (les mots dans l'ordre accepté, en attendant l'e-mail), confirme (le code e-mail est validé) }.
let mission = null;
let reglage = null;   // seulement pendant le réglage d'une adresse de secours : { rang, confirme (le code e-mail est validé) }
let armeRetirer = null, armeAjouter = null;
let retrouvaille = null;   // seulement pendant une récupération : { confirme (le code e-mail est validé), trouve (le coffre est revenu) }
let lien = null;   // présent seulement quand un jeu enregistré a ouvert cette fenêtre
// Quand le service demande au joueur de dire qui il est : rien, puis { coffre : oui ou non } une fois le code validé.
const PAR_EMAIL = REGLAGES.identite === 'email';
let identite = null;
// Les autres portes d'identité que cette page propose : celles de ses réglages, parmi celles qu'elle sait montrer.
const NOMS_PORTES = { google: 'Google', discord: 'Discord' };
const BOUTONS_PORTES = { google: 'b-porte-google', discord: 'b-porte-discord' };
const PORTES = (Array.isArray(REGLAGES.portes) ? REGLAGES.portes : []).filter((p) => Object.prototype.hasOwnProperty.call(NOMS_PORTES, p));
const IDENTITE_EXIGEE = PAR_EMAIL || PORTES.length > 0;
// Vrai quand le joueur est revenu d'une porte où il était parti depuis une fenêtre ouverte par un jeu. La page ne
// crée alors un coffre qu'avec la demande de ce jeu sous les yeux : c'est elle qui dit s'il faut en créer un, ou
// retrouver celui du compte. Sans demande (le lien s'est perdu en route), rien n'est créé : la page dit de repartir
// du jeu. Attendre n'y change rien : un délai dépassé n'est jamais une autorisation de créer.
let venuDUnJeu = false;
let sansLeJeu = false;   // la page a dit « le jeu ne répond plus » : à retirer si sa demande arrive enfin
// Vrai dès que le joueur a choisi « Connecter mon wallet » : cette fenêtre a rendu la main au jeu, elle ne propose plus rien.
let mainRendue = false;
// Quand un coffre se retrouve sans appareil, avec les 12 mots et un code reçu par e-mail.
const RECUPERATION = REGLAGES.recuperation === 'email';

function dire(id, texte, sorte) { const e = $(id); e.textContent = texte || ''; e.className = 'status' + (sorte ? ' ' + sorte : ''); }
function montrer(id) { for (const v of VUES) $(v).hidden = v !== id; }
function texteResultat() {
  return ['RESULTAT COMPTE temps 1', 'page : version ' + REGLAGES.version, 'date : ' + new Date().toISOString(), 'navigateur : ' + navigator.userAgent,
    'coffre sur cet appareil : ' + (fiche ? 'oui, adresse ' + fiche.coffre.adresse + ' | garde chez nous ' + (fiche.garde ? 'oui' : 'non') : 'non'), '---'].concat(journal).join('\n');
}
function noter(ligne) { journal.push(ligne); $('resultat').value = texteResultat(); }

const MESSAGES = {
  NotAllowedError: 'Tu as annulé, ou ton appareil a refusé.',
  VerificationAbsente: 'L\'appareil n\'a pas vérifié que c\'est bien toi. Refusé.',
  PrfAbsent: 'Cet appareil ne sait pas fermer un coffre avec sa clé d\'accès.',
  CreationRetiree: 'Ce jeu demande un coffre qui existe déjà. Rien n\'a été créé.',
  AutreCle: 'Ce n\'est pas la clé de ce coffre qui a répondu. Recommence, et choisis dans la liste la clé de ce coffre.',
  DejaUnCoffre: 'Tu as déjà un coffre. Retrouve-le avec « me connecter ».',
  ConnexionAnnulee: 'Tu as annulé la connexion. Rien n\'a été créé.',
  FournisseurRefuse: 'Ce service de connexion n\'a pas répondu comme il faut. Rien n\'a été créé. Réessaie, ou choisis une autre façon de dire qui tu es.',
  ConnexionEchouee: 'La connexion n\'a pas abouti. Rien n\'a été créé. Recommence.',
  ConnexionAilleurs: 'Cette connexion n\'a pas commencé dans cette fenêtre, ou elle est trop ancienne. Rien n\'a été envoyé. Recommence ici.',
  RemiseRefusee: 'Cette connexion a expiré, ou elle a déjà servi. Recommence.',
  PorteEteinte: 'Cette façon de se connecter n\'est pas disponible pour l\'instant.',
  RangementRefuse: 'Ce navigateur ne garde rien pour cette fenêtre : la connexion ne pourrait pas revenir. Essaie sans navigation privée, ou avec ton adresse e-mail.',
  CodeRefuse: 'Ce code n\'est pas le bon, ou il a expiré.',
  IdentiteRequise: IDENTITE_EXIGEE && !PAR_EMAIL ? 'Dis-nous d\'abord qui tu es, avec l\'un des boutons « Continuer avec… ».' : 'Dis-nous d\'abord qui tu es : ton adresse e-mail, puis ton code.',
  IdentiteRefusee: 'Ta confirmation a expiré. Redemande un code.',
  ReseauCoupe: 'Le serveur ne répond pas.',
  Indisponible: 'Le serveur ne répond pas pour l\'instant.',
  Erreur: 'Le serveur a eu un problème.',
  AjoutRefuse: 'Cette clé n\'a pas été ajoutée. Ton coffre est intact chez nous : recommence « retrouver mon coffre ».',
  NonGarde: 'Ce coffre n\'est pas encore gardé par le serveur. Confie-le d\'abord, juste en dessous.',
  AdmissionRefusee: 'Ce serveur d\'essai demande un code de testeur.',
  ExpirationRefusee: 'La demande du serveur n\'est pas valable, ou l\'heure de cet appareil est fausse. Rien n\'a été créé.',
  SignatureRefusee: 'Le serveur a refusé la signature. Rien n\'a été changé.',
  Complet: 'Le serveur d\'essai est plein pour l\'instant. Réessaie dans quelques minutes.',
  PasskeyRefusee: 'Le serveur n\'a pas reconnu cette clé d\'accès.',
  DefiRefuse: 'La demande a expiré. Recommence.',
  Expire: 'La demande a expiré. Recommence.',
  RetourEnArriere: 'Le serveur a rendu un coffre plus ancien que celui de cet appareil. Rien n\'a été changé ici.',
  Divergence: 'Le serveur a rendu un coffre différent de celui de cet appareil. Rien n\'a été changé ici.',
  OuvertureRefusee: 'Ce coffre ne s\'ouvre pas avec cette clé d\'accès. Rien n\'a été changé ici.',
  PasDeCoffre: 'Il n\'y a pas de coffre sur cet appareil.',
  StockChange: 'Le coffre gardé sur cet appareil a changé entre-temps. Recommence.',
  IdentiteDejaLiee: 'Cette adresse sert déjà au secours d\'un autre coffre. Donne une autre adresse.',
  AutreIdentite: 'Ce coffre a déjà une adresse de secours, et ce n\'est pas celle-ci. Donne l\'une de tes adresses de secours, ou change-la dans « Mes adresses de secours ».',
  AdresseDejaInscrite: 'Cette adresse est déjà l\'une de tes adresses de secours.',
  GenerationRefusee: 'Tes adresses de secours ont changé entre-temps. Recommence.',
  ReglageEnAttente: 'Un réglage précédent attend encore sa réponse. Termine-le d\'abord.',
  ReglageAConfirmer: 'Je n\'ai pas pu confirmer ce réglage sur cet appareil. Il est peut-être déjà enregistré. Touche « Terminer ce réglage ». Si rien ne change, recharge la page et reconnecte-toi : la liste dira ce qui est vrai.',
  AdresseAbsente: 'Il n\'y a pas de seconde adresse à retirer.',
  RecuperationAbsente: 'Aucun coffre ne se retrouve avec cette adresse. Vérifie-la : c\'est celle que tu as donnée pendant ta mission de secours.',
  DejaUneCle: 'Cet appareil a déjà une clé de ce coffre. Touche « Annuler », puis « J\'ai déjà un coffre : me connecter ».',
  TropDAcces: 'Ce coffre a déjà huit clés d\'accès : il ne peut pas en recevoir une de plus.',
  EtatRefuse: 'Ton coffre a changé entre-temps.',
  RienARetrouver: 'La récupération est à reprendre au début.',
  CandidatRefuse: 'Ce que le serveur a rendu n\'est pas ton coffre. Rien n\'a été gardé sur cet appareil.',
};
// « Trop d'essais » est le seul refus qui dit combien de temps attendre.
const attente = (e) => { const n = e && Number.isSafeInteger(e.attente) ? Math.max(1, Math.ceil(e.attente / 60)) : 30; return 'Trop d\'essais. Réessaie dans ' + n + ' minute' + (n > 1 ? 's' : '') + '.'; };
const expliquer = (e) => (e && e.name === 'TropDEssais' ? attente(e) : MESSAGES[e && e.name]) || ('Refusé (' + ((e && e.name) || 'erreur') + '). Rien n\'a été changé sur cet appareil.');
const detail = (e) => (e && e.name ? e.name : 'erreur') + (e && e.detail ? ' (' + e.detail + ')' : '');
// Le résultat d'une demande est inconnu : la réponse n'est pas arrivée, ou le serveur a eu une panne en route.
// La logique de la page a gardé la demande : retoucher le bouton la renvoie telle quelle.
const incertain = (e) => !!e && ['ReseauCoupe', 'Indisponible', 'Erreur'].includes(e.name);
const formeEmail = (v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);

// ---------- Le stockage de l'appareil. Inscrire refuse d'écraser ; remplacer et effacer n'agissent que sur la
// fiche que la page connaît, lecture et écriture dans la même transaction.
function base() {
  return new Promise((ok, non) => {
    let d;
    try { d = indexedDB.open('compte', 1); } catch (_) { non(new K.Refus('StockageRefuse')); return; }
    d.onupgradeneeded = () => d.result.createObjectStore('v1');
    d.onsuccess = () => ok(d.result);
    d.onerror = d.onblocked = () => non(new K.Refus('StockageRefuse'));
  });
}
async function transaction(mode, action) {
  const db = await base();
  try {
    return await new Promise((ok, non) => {
      const tx = db.transaction('v1', mode);
      let resultat, refus = null;
      action(tx.objectStore('v1'), (v) => { resultat = v; }, (nom) => { refus = nom; tx.abort(); });
      tx.oncomplete = () => ok(resultat);
      tx.onabort = tx.onerror = () => non(new K.Refus(refus || 'StockageRefuse'));
    });
  } finally { db.close(); }
}
const meme = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const stock = {
  lire: () => transaction('readonly', (m, rendre) => { const r = m.get('fiche'); r.onsuccess = () => rendre(r.result); }),
  inscrire: (f) => transaction('readwrite', (m, rendre, refuser) => { const r = m.add(f, 'fiche'); r.onerror = (ev) => { ev.preventDefault(); refuser('DejaUnCoffre'); }; }),
  remplacer: (ancienne, f) => transaction('readwrite', (m, rendre, refuser) => { const r = m.get('fiche'); r.onsuccess = () => { if (!meme(r.result, ancienne)) refuser('StockChange'); else m.put(f, 'fiche'); }; }),
  effacer: (ancienne) => transaction('readwrite', (m, rendre, refuser) => { const r = m.get('fiche'); r.onsuccess = () => { if (!meme(r.result, ancienne)) refuser('StockChange'); else m.delete('fiche'); }; }),
};

// ---------- Le serveur et l'appareil
// Le code des testeurs : tapé par le testeur, gardé pour l'onglet seulement, jamais écrit dans la page publiée.
const codeTesteur = {
  lire() { try { return sessionStorage.getItem('code-testeur') || ''; } catch (_) { return codeTesteur.memoire || ''; } },
  garder(v) { codeTesteur.memoire = v; try { sessionStorage.setItem('code-testeur', v); } catch (_) { /* gardé en mémoire */ } },
};
async function api(chemin, objet) {
  let reponse;
  const entetes = { 'content-type': 'application/json' };
  const code = codeTesteur.lire();
  if (code) entetes.authorization = 'Bearer ' + code;
  try {
    reponse = await fetch(REGLAGES.api + chemin, { method: 'POST', headers: entetes, body: JSON.stringify(objet),
      credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer' });
  } catch (_) { throw new K.Refus('ReseauCoupe'); }
  let corps = null;
  try { corps = await reponse.json(); } catch (_) { /* réponse illisible */ }
  if (!reponse.ok || !corps) {
    const refus = (corps && typeof corps.refus === 'string' && corps.refus) || 'ReseauCoupe';
    if (refus === 'AdmissionRefusee') demanderCode();
    const r = new K.Refus(refus);
    if (corps && Number.isSafeInteger(corps.attente)) r.attente = corps.attente;
    throw r;
  }
  return corps;
}
function demanderCode() { $('v-admission').hidden = false; dire('s-admission', codeTesteur.lire() ? 'Ce code n\'est pas le bon.' : '', 'ko'); }
function validerCode() {
  const v = $('code-testeur').value.trim();
  if (!/^[\x21-\x7e]{1,200}$/.test(v)) { dire('s-admission', 'Ce code n\'a pas la bonne forme.', 'ko'); return; }
  codeTesteur.garder(v);
  $('code-testeur').value = '';
  $('v-admission').hidden = true;
  noter('[page] code de testeur saisi');
  // Le message se pose à côté du bouton à retoucher, et il remplace le refus affiché juste avant : sinon le
  // testeur lit encore « ce serveur demande un code » sous le bouton et s'arrête là (essai du 13/11 sur iPhone).
  if (demandeJeu() && fiche) { dire('s-coffre', ''); dire('s-jeu', 'Code enregistré. Touche de nouveau « Me connecter à ce jeu ».', 'ok'); }
  else if (!$('v-mission').hidden) dire('s-mission', mission === null ? 'Code enregistré. Touche de nouveau « Voir mes 12 mots ».' : 'Code enregistré. Touche de nouveau le bouton que tu venais de toucher.', 'ok');
  else if (!$('v-retrouver').hidden) dire('s-retrouver', 'Code enregistré. Touche de nouveau le bouton que tu venais de toucher.', 'ok');
  else if (!$('v-adresses').hidden) dire('s-adresses', 'Code enregistré. Touche de nouveau le bouton que tu venais de toucher.', 'ok');
  else dire(fiche ? 's-coffre' : 's-accueil', 'Code enregistré pour cet onglet. Touche de nouveau le bouton que tu venais de toucher.', 'ok');
}
const appareil = {
  creer: (o) => navigator.credentials.create({ publicKey: o }),
  demander: (o) => navigator.credentials.get({ publicKey: o }),
};
// Le système de l'appareil, tel que le navigateur le dit. Il ne sert qu'à choisir la forme d'une demande de clé
// d'accès (voir `demander` dans client.mjs). Un navigateur qui ne le dit pas reçoit la forme habituelle.
function systeme() {
  try { const p = navigator.userAgentData && navigator.userAgentData.platform; if (typeof p === 'string' && p) return p; } catch (_) { /* pas dit */ }
  return /Windows NT/.test(navigator.userAgent || '') ? 'Windows' : '';
}
// Le rangement de cette fenêtre, pour la tentative en cours par une autre porte : le stockage de session, propre à
// l'onglet et à cette origine. Rien d'autre n'y va, et rien de durable. S'il est refusé, aucune porte ne part.
const CLE_TENTATIVE = 'tentative-porte';
const rangement = {
  lire() { try { const t = sessionStorage.getItem(CLE_TENTATIVE); return t ? JSON.parse(t) : null; } catch (_) { return null; } },
  garder(o) { try { sessionStorage.setItem(CLE_TENTATIVE, JSON.stringify(o)); return sessionStorage.getItem(CLE_TENTATIVE) === JSON.stringify(o); } catch (_) { return false; } },
  effacer() { try { sessionStorage.removeItem(CLE_TENTATIVE); } catch (_) { /* rien */ } },
};
const c = client({ api, appareil, stock, noter, rangement,
  reglages: { origine: location.origin, rpId: REGLAGES.rpId, environnement: REGLAGES.environnement, projet: REGLAGES.projet, langue: REGLAGES.langue, identite: REGLAGES.identite,
    recuperation: REGLAGES.recuperation, systeme: systeme(), portes: PORTES, adresseIdentite: REGLAGES.adresseIdentite } });

// ---------- L'écran
async function afficher(message, sorte) {
  try { fiche = (await stock.lire()) || null; }
  catch (e) { fiche = null; noter('[page] stockage indisponible : ' + detail(e)); }
  $('resultat').value = texteResultat();
  if (mainRendue) return;   // la main est rendue au jeu : cette fenêtre ne montre plus que sa carte
  rafraichirJeu();
  rafraichirAccueil();
  if (!fiche) { montrer('v-accueil'); dire('s-accueil', message, sorte); return; }
  $('adresse').textContent = fiche.coffre.adresse;
  // Une fiche en attente après une récupération : le coffre est chez nous, c'est la clé de cet appareil qui ne l'est pas encore.
  dire('garde', fiche.garde ? 'Gardé chez nous : oui. Tu le retrouveras sur tes autres appareils.'
    : fiche.vers ? 'La clé de cet appareil n\'est pas encore confiée au serveur. Ton coffre, lui, est intact chez nous.'
    : 'Gardé chez nous : non. Il n\'existe que sur cet appareil.', fiche.garde ? 'ok' : 'ko');
  $('b-renvoyer').hidden = fiche.garde;
  $('b-reconnecter').hidden = !fiche.garde || !!demandeJeu();   // un jeu attend : un seul bouton, celui de sa carte
  // Le secours : fait ou à faire. La mission se fait hors de la demande d'un jeu, sur un coffre déjà gardé.
  const [texteSecours, sorteSecours, boutonSecours] = etatSecours(fiche);
  dire('secours', texteSecours, sorteSecours);
  $('b-mission').textContent = boutonSecours;
  $('b-mission').hidden = !fiche.garde || !!demandeJeu();
  // La clé a répondu depuis ailleurs que cet appareil (un autre téléphone, ou une clé de sécurité : le navigateur ne
  // dit pas lequel) : la page propose de donner sa propre clé à cet appareil.
  // Pas pendant la demande d'un jeu : un seul bouton alors, celui du jeu.
  const emprunt = fiche.garde && (!!fiche.distante || !!fiche.ajout);
  dire('appareil', !emprunt ? '' : fiche.ajout ? 'La clé de cet appareil est créée, mais pas encore confiée au serveur.'
    : 'Ici, ton coffre s\'ouvre avec une clé qui n\'est pas sur cet appareil (un autre téléphone, ou une clé de sécurité). Il te la faut à chaque fois.', 'wait');
  $('b-ajouter').textContent = fiche.ajout ? 'Réessayer d\'ajouter cet appareil' : 'Ajouter cet appareil';
  $('b-ajouter').hidden = !emprunt || !!demandeJeu();
  desarmerAjout();
  // Les adresses de secours se règlent une fois la mission faite avec une adresse. Pas pendant la demande d'un jeu.
  $('b-adresses').hidden = !(RECUPERATION && fiche.garde && fiche.secours && fiche.secours.lie === true) || !!demandeJeu();
  desarmer();
  montrer('v-coffre');
  dire('s-coffre', message, sorte);
}
// Ce que la page dit du secours. Elle ne dit « fait » sans réserve que si le wallet se retrouve vraiment sans appareil :
// avec la récupération, il faut un coffre au format 3 et une déclaration qui désigne une adresse e-mail.
function etatSecours(f) {
  if (!f.secours) return ['Secours : à faire. Sans lui, perdre tes appareils, c\'est perdre ton wallet.', 'wait', 'Faire ma mission de secours'];
  if (!RECUPERATION) return ['Secours : fait. Tes 12 mots ouvrent ce coffre.', 'ok', 'Refaire ma mission de secours'];
  if (f.coffre.v !== 3) return ['Secours : fait sur cet appareil seulement. Ce coffre d\'essai est d\'un ancien format : sans appareil, il ne se retrouve pas.', 'wait', 'Refaire ma mission de secours'];
  if (f.secours.lie !== true) return ['Secours : à compléter. Refais ta mission, pour pouvoir retrouver ton wallet sans appareil.', 'wait', 'Compléter ma mission de secours'];
  return ['Secours : fait. Tes 12 mots et ton adresse e-mail te rendront ce wallet.', 'ok', 'Refaire ma mission de secours'];
}
// Une seule action à la fois. Et plus aucune une fois la main rendue au jeu (« Connecter mon wallet ») : la règle
// est tenue ici, pas seulement par des boutons cachés.
const seul = (fn) => async () => { if (occupe || mainRendue) return; occupe = true; try { await fn(); } finally { occupe = false; } };
const ATTENTE = 'Ton appareil te demande de confirmer…';
// Un ajout de clé dont on ne sait pas s'il a abouti : la page ne dit ni oui ni non. Une connexion le dira.
const INCONNU = 'Je ne sais pas encore si cette clé a bien été ajoutée. Touche « Me connecter » : si elle l\'a été, ton coffre s\'ouvre avec elle ; sinon la page te le dira.';
// Quand la clé de ce coffre n'est pas sur cet appareil. Si c'est celle d'un autre téléphone, certains appareils ne
// montrent pas le QR code d'emblée : la page le dit avant le geste. Elle ne sait pas de quelle sorte de clé il s'agit.
const attenteCle = () => (fiche && fiche.distante ? 'Ta clé n\'est pas sur cet appareil. Si c\'est celle d\'un autre téléphone et qu\'aucun QR code n\'apparaît, choisis « autre méthode » ou « autre appareil », puis scanne le QR code avec lui.' : ATTENTE);

// ---------- Un jeu a ouvert cette fenêtre pour connecter le joueur. La preuve ne part qu'à ce jeu, et seulement
// si le coffre est gardé par le serveur. Si le jeu annonce le wallet déjà lié au compte, ou dit seulement que le
// joueur a déjà son coffre, on n'en crée pas d'autre.
const demandeJeu = () => { const d = lien && lien.demande(); return d && !d.retiree ? d : null; };
const sansCreation = (d) => !!(d && (d.attendue || d.existant));
let inviteJeu = '';   // la phrase d'invitation posée sur la carte du jeu tant qu'il n'y a pas de coffre ici
function rafraichirJeu() {
  if (mainRendue) return;
  const d = demandeJeu();
  $('v-jeu').hidden = !d;
  if (fiche) { $('b-reconnecter').hidden = !fiche.garde || !!d; $('b-mission').hidden = !fiche.garde || !!d; if (d) { $('b-ajouter').hidden = true; $('b-adresses').hidden = true; } }
  if (!d) return;
  $('jeu-nom').textContent = d.nom;
  $('jeu-site').textContent = 'Site : ' + d.jeu;
  $('b-jeu').hidden = !fiche;
  if (!fiche) {
    inviteJeu = d.attendue ? 'Ce compte de jeu a déjà un wallet. Retrouve ton coffre juste en dessous : tu entreras ensuite dans le jeu.'
      : d.existant ? 'Retrouve ton coffre juste en dessous : tu entreras ensuite dans le jeu. Si tu n\'en as pas encore, ferme cette fenêtre et reviens au jeu.'
      : 'Crée ton coffre, ou retrouve-le, juste en dessous : tu entreras ensuite dans le jeu.';
    dire('s-jeu', inviteJeu, 'wait');
  } else if (inviteJeu && $('s-jeu').textContent === inviteJeu) {
    // Le coffre est là depuis (créé ou retrouvé pendant cette demande) : l'invitation à le créer n'a plus de sens.
    inviteJeu = '';
    if (fiche.garde) dire('s-jeu', 'Ton coffre est là. Touche « Me connecter à ce jeu » pour y entrer.', 'ok');
    else dire('s-jeu', 'Ton coffre est là, mais pas encore confié au serveur. Confie-le d\'abord, juste en dessous : tu entreras ensuite dans le jeu.', 'wait');
  }
}
// « Créer mon coffre » n'est proposé que si rien ne dit que ce joueur en a déjà un : ni le jeu, ni son identité.
// Et, quand le service demande de dire qui on est, seulement après le code validé.
// « Continuer avec mon e-mail » a été touché : la case de l'adresse est montrée à la place du bouton.
let emailOuvert = false;
function rafraichirAccueil() {
  const d = demandeJeu();
  // L'écran du choix des portes (Google, Discord…) : seulement pour créer, donc ni après avoir dit qui on est, ni
  // quand le jeu attend un coffre existant. Sans autre porte que l'e-mail, sa case est montrée directement.
  const choix = PORTES.length > 0 && !identite && !sansCreation(d);
  $('z-portes').hidden = !choix;
  $('p-accueil').hidden = choix;
  for (const p of Object.keys(NOMS_PORTES)) $(BOUTONS_PORTES[p]).hidden = !PORTES.includes(p);
  $('b-porte-email').hidden = !PAR_EMAIL || emailOuvert;
  $('p-identite').textContent = choix ? 'Ton adresse e-mail, puis le code que nous t\'envoyons.' : 'Pour commencer, dis-nous qui tu es : ton adresse e-mail, puis le code que nous t\'envoyons.';
  $('z-identite').hidden = !PAR_EMAIL || !!identite || sansCreation(d) || (choix && !emailOuvert);   // l'adresse ne sert qu'à créer
  // Revenu d'une porte où il était parti depuis un jeu : pas de création sans la demande de ce jeu.
  $('b-creer').hidden = sansCreation(d) || (venuDUnJeu && !d) || (IDENTITE_EXIGEE && (!identite || identite.coffre));
  $('b-retrouver').hidden = !RECUPERATION;
  // « Connecter mon wallet » : seulement quand le jeu qui attend ici le propose dans sa demande encore vivante.
  const parWallet = !!(d && d.wallet);
  $('b-wallet').hidden = !parWallet; $('p-wallet').hidden = !parWallet;
  // « J'ai déjà un coffre » s'écrit comme un lien sous les autres choix ; quand c'est la seule action de l'écran, c'est
  // un vrai bouton.
  $('b-connecter').className = $('b-creer').hidden && !choix && $('z-identite').hidden && !parWallet ? '' : 'lien';
}
// ---------- « Connecter mon wallet » : le joueur a déjà un wallet Solana et veut entrer avec lui. Cette page ne
// l'appelle pas et ne signe rien : elle dit au jeu « ce joueur choisit son wallet », pour la demande vivante, une
// seule fois, puis ne propose plus rien. C'est le jeu qui lui fera toucher son propre bouton, sur sa propre page.
// Le jeu accuse réception : la fenêtre se ferme. Sans accusé (la page du jeu a disparu), la page le dit et reste.
const ATTENTE_ACCUSE = 3000;   // millisecondes
function choisirWallet() {
  const d = demandeJeu();
  if (mainRendue || !d || !d.wallet) return;
  if (!lien.choisir('wallet')) { rafraichirAccueil(); return; }   // demande expirée ou retirée : sa carte le dit déjà
  mainRendue = true;
  noter('[jeu] le joueur choisit son wallet : la main est rendue au jeu, rien n\'est signe ici');
  for (const v of VUES) $(v).hidden = true;
  $('v-admission').hidden = true;
  $('v-jeu').hidden = false; $('b-jeu').hidden = true;
  dire('s-jeu', 'C\'est noté. Retourne sur ' + d.nom + ' : il te demandera de confirmer avec ton wallet.', 'wait');
  setTimeout(() => {
    if (lien.accuse()) return;
    noter('[jeu] le jeu n\'a pas accuse reception du choix');
    dire('s-jeu', d.nom + ' ne répond pas. Retourne sur sa page et touche « Connecter mon wallet ». Tu peux fermer cette fenêtre.', 'ko');
  }, ATTENTE_ACCUSE);
}
function choixRecu(d) {
  dire('s-jeu', 'C\'est noté. Retourne sur ' + d.nom + ' et touche « Connecter mon wallet ».', 'ok');
  setTimeout(() => { try { window.close(); } catch (_) { /* le joueur fermera */ } }, 1500);
}
// ---------- Dire qui on est par une autre porte (Google, Discord…). La fenêtre part chez le fournisseur et revient :
// la page se recharge entre les deux. Rien du code ni du vérifieur ne va au relevé, au stockage de l'appareil ou au jeu.
async function partirPar(porte) {
  dire('s-accueil', 'Un instant…', 'wait');
  try {
    const adresse = await c.partirParPorte(porte, { parUnJeu: !!lien });
    dire('s-accueil', 'Tu vas chez ' + NOMS_PORTES[porte] + '. Tu reviendras ici juste après.', 'wait');
    location.assign(adresse);
  } catch (e) { noter('[identite] depart refuse : ' + detail(e)); dire('s-accueil', expliquer(e), 'ko'); }
}
const DEJA_UN_COFFRE = 'Tu as déjà un coffre. Ouvre-le avec « me connecter » : avec cet appareil, ou avec ton téléphone.';
async function retourDePorte() {
  if (RETOUR_PORTE === null) return;
  // Un coffre est déjà sur cet appareil : ce retour ne sert à rien. La tentative est effacée, rien n'est envoyé.
  if (fiche) { c.oublierPorte(); return; }
  dire('s-accueil', 'Vérification…', 'wait');
  try {
    const r = await c.revenirDePorte(RETOUR_PORTE);
    identite = { coffre: r.coffre };
    venuDUnJeu = r.parUnJeu;
    rafraichirAccueil();
    if (identite.coffre) { dire('s-accueil', DEJA_UN_COFFRE + (RECUPERATION ? ' Si tu n\'as plus aucun appareil, touche « retrouver mon coffre ».' : ''), 'ok'); return; }
    dire('s-accueil', 'C\'est bien toi.', 'ok');
  } catch (e) { noter('[identite] retour refuse : ' + detail(e)); rafraichirAccueil(); dire('s-accueil', expliquer(e), 'ko'); return; }
  // L'identité est confirmée et n'a pas de coffre : la création s'enchaîne, sous le même garde que le bouton.
  await seul(() => enchainerCreation(venuDUnJeu))();
}
// ---------- Dire qui on est : une adresse e-mail, puis le code reçu. L'adresse n'est ni gardée ni écrite au relevé.
async function envoyerCode() {
  const email = $('email').value.trim();
  if (!formeEmail(email)) { dire('s-accueil', 'Cette adresse n\'a pas la forme d\'une adresse e-mail.', 'ko'); return; }
  dire('s-accueil', 'Envoi…', 'wait');
  try {
    await c.demanderCode(email);
    $('z-code').hidden = false;
    noter('[identite] code demande');
    dire('s-accueil', 'Si cette adresse est la bonne, un code vient de partir. Il est valable dix minutes.', 'ok');
  } catch (e) { noter('[identite] echec : ' + detail(e)); dire('s-accueil', expliquer(e), 'ko'); }
}
async function validerLeCode() {
  const email = $('email').value.trim(), code = $('code-email').value.replace(/\D/g, '');
  if (code.length !== 6) { dire('s-accueil', 'Le code a six chiffres.', 'ko'); return; }
  dire('s-accueil', 'Vérification…', 'wait');
  try {
    identite = await c.validerCode(email, code);
    $('code-email').value = ''; $('z-code').hidden = true;
    noter('[identite] adresse confirmee | coffre existant ' + (identite.coffre ? 'oui' : 'non'));
    rafraichirAccueil();
    if (identite.coffre) { dire('s-accueil', DEJA_UN_COFFRE, 'ok'); return; }
  } catch (e) { noter('[identite] echec : ' + detail(e)); dire('s-accueil', expliquer(e), 'ko'); return; }
  // L'adresse est confirmée et n'a pas de coffre : la création s'enchaîne (ce toucher-ci tient déjà le garde).
  await enchainerCreation(false);
}

function envoyerAuJeu(d, adresse, preuve) {
  if (d.attendue && adresse !== d.attendue) {
    lien.renoncer('autre coffre');
    noter('[jeu] ce coffre n\'est pas celui que le jeu attend : rien n\'est envoye');
    dire('s-jeu', 'Ce coffre n\'est pas celui qui est lié à ton compte de jeu. Rien n\'a été envoyé.', 'ko');
    return;
  }
  if (!lien.repondre({ adresse, message: K.b64u(preuve.message), signature: K.b64u(preuve.signature) })) {
    dire('s-jeu', 'Le jeu a retiré sa demande. Rien n\'a été envoyé.', 'wait');
    return;
  }
  $('b-jeu').hidden = true;
  // La fenêtre a envoyé la preuve, rien de plus : c'est le jeu qui la vérifie et qui annonce la connexion.
  dire('s-jeu', 'Envoyé à ' + d.nom + '. Reviens au jeu pour terminer.', 'ok');
  setTimeout(() => { try { window.close(); } catch (_) { /* le joueur fermera */ } }, 1500);
}
async function entrerDansLeJeu() {
  const d = demandeJeu();
  if (!d) return;
  dire('s-jeu', attenteCle(), 'wait');
  try {
    const r = await c.prouver({ jeu: d.jeu, defi: d.defi });
    await afficher();
    envoyerAuJeu(d, r.adresse, r.preuve);
  } catch (e) { noter('[jeu] echec : ' + detail(e)); await afficher(); dire('s-jeu', expliquer(e), 'ko'); }
}

// L'inscription mène au wallet : dès que le joueur a dit qui il est (une porte comme Google, ou son code e-mail), la
// page lance elle-même la création du coffre, sans attendre un toucher de plus. Elle ne dit « créé » qu'après la
// création réelle et son rangement. Certains navigateurs refusent de créer une clé d'accès sans toucher, et un joueur
// peut annuler : le bouton « Créer mon coffre » reste alors, avec une phrase calme (pas une erreur).
// `parUnJeu` : le joueur revient d'une porte où il était parti depuis la fenêtre d'un jeu. Ce jeu redonne sa demande
// à chaque annonce de la page : elle l'attend, et ne crée qu'avec elle (la création et la preuve se font alors dans
// le même geste). Le délai ne sert qu'à décider quoi écrire à l'écran : passé ce délai sans demande, la page ne crée
// rien et dit de repartir du jeu. Si la demande arrive plus tard, le bouton revient (voir `demandeArrivee`).
const ATTENTE_JEU = 1500;   // millisecondes
const TOUCHER_POUR_CREER = 'C\'est bien toi. Touche « Créer mon coffre » : ton appareil te demandera de confirmer, c\'est ce qui protège ton wallet.';
const SANS_LE_JEU = 'C\'est bien toi, mais le jeu ne répond plus à cette fenêtre. Rien n\'a été créé. Ferme-la, retourne sur le jeu et touche de nouveau « Se connecter ».';
const COFFRE_EXISTANT_DEMANDE = 'Ce jeu demande un coffre qui existe déjà. Rien n\'a été créé.';
function direSansLeJeu() {
  sansLeJeu = true;
  noter('[creer] venu d\'un jeu, sans demande de ce jeu : rien n\'est cree');
  rafraichirAccueil();
  dire('s-accueil', SANS_LE_JEU, 'wait');
}
// La demande du jeu arrive (ou change). Si la page avait dit « le jeu ne répond plus », cette phrase n'est plus vraie.
function demandeArrivee() {
  rafraichirJeu(); rafraichirAccueil();
  if (!sansLeJeu || !demandeJeu()) return;
  sansLeJeu = false;
  if (!fiche) dire('s-accueil', $('b-creer').hidden ? '' : TOUCHER_POUR_CREER, 'ok');
}
async function enchainerCreation(parUnJeu) {
  if (fiche || !identite || identite.coffre) return;
  if (parUnJeu) {
    const fin = Date.now() + ATTENTE_JEU;
    while (lien && !demandeJeu() && Date.now() < fin) await new Promise((ok) => setTimeout(ok, 100));
    if (!demandeJeu()) { direSansLeJeu(); return; }
  }
  rafraichirAccueil();
  if ($('b-creer').hidden) return;   // le jeu attend un coffre qui existe déjà : rien à créer ici
  await creer({ enchaine: true });
}
async function creer(options) {
  const enchaine = !!(options && options.enchaine);
  const d = demandeJeu();
  // Le bouton est caché dans ces deux cas ; la règle est tenue ici aussi.
  if (sansCreation(d)) { dire('s-accueil', COFFRE_EXISTANT_DEMANDE, 'ko'); return; }
  if (venuDUnJeu && !d) { direSansLeJeu(); return; }
  dire('s-accueil', enchaine ? 'C\'est bien toi. Ton appareil va te demander de confirmer : c\'est ce qui protège ton wallet.' : ATTENTE, 'wait');
  try {
    // `encorePermis` : la demande du jeu peut arriver, ou changer, pendant que le joueur confirme sur son appareil.
    // Le client repose la question après le geste, juste avant de fabriquer le coffre puis juste avant de le ranger.
    const r = await c.creer('Mon coffre (essai) ' + new Date().toLocaleString('fr-FR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }),
      { connexion: d ? { jeu: d.jeu, defi: d.defi } : undefined, encorePermis: () => !sansCreation(demandeJeu()) });
    identite = null;   // la preuve d'identité a servi
    // Le joueur était parti chez un fournisseur depuis la fenêtre d'un jeu, et la demande de ce jeu, vivante au
    // départ de la création, ne l'est plus à la fin (retirée ou expirée pendant le geste) : la page le renvoie au
    // jeu. Elle ne le dit qu'ici, après la création réelle et son rangement sur l'appareil et chez nous ; rien n'est
    // envoyé au jeu sans une demande vivante.
    const versLeJeu = venuDUnJeu && !demandeJeu() && r.garde;
    if (r.garde) venuDUnJeu = false;
    await afficher(versLeJeu ? 'Ton coffre est créé. Retourne au jeu et touche « Se connecter » : tu y entreras avec lui.'
      : r.garde ? 'Coffre créé, et confié au serveur.' : 'Coffre créé, mais pas encore confié au serveur : ' + (MESSAGES[r.raison] || r.raison), r.garde ? 'ok' : 'ko');
    if (d && r.preuve) envoyerAuJeu(d, r.adresse, r.preuve);
    else if (d) dire('s-jeu', 'Ton coffre n\'est pas encore confié au serveur. Réessaie de le confier, puis connecte-toi au jeu.', 'ko');
  } catch (e) {
    // La confirmation de l'adresse ne sert qu'une fois et ne dure pas : si elle manque, la page la redemande.
    if (e && (e.name === 'IdentiteRequise' || e.name === 'IdentiteRefusee')) identite = null;
    if (e && e.name === 'DejaUnCoffre' && identite) identite.coffre = true;   // le serveur vient de le dire
    // Le jeu a demandé un coffre existant pendant le geste : rien n'a été fabriqué ni rangé. La clé d'accès que
    // l'appareil vient de créer ne sert à rien et peut y rester : la page ne sait pas la retirer.
    if (e && e.name === 'CreationRetiree') { noter('[creer] le jeu demande un coffre existant : rien n\'est cree (une cle d\'acces inutile a pu rester sur l\'appareil)'); await afficher(COFFRE_EXISTANT_DEMANDE, 'wait'); return; }
    // Lancée sans toucher, la création peut être refusée par le navigateur, ou annulée par le joueur : rien n'est
    // perdu (la page garde sa réservation), le bouton reste, et la page dit simplement de le toucher.
    if (enchaine && e && e.name === 'NotAllowedError') { noter('[creer] pas de geste, ou annule : le bouton reste'); await afficher(TOUCHER_POUR_CREER, 'ok'); return; }
    noter('[creer] echec : ' + detail(e)); await afficher(expliquer(e), 'ko');
  }
}
async function connecter() {
  if (demandeJeu()) return entrerDansLeJeu();
  const cible = fiche ? 's-coffre' : 's-accueil';
  dire(cible, attenteCle(), 'wait');
  try {
    const s = await c.connecter();
    const adresse = s.adresse; s.fermer();
    noter('[connecter] ok : adresse ' + adresse + ' | coffre ouvert, preuve faite');
    await afficher('Connecté. Ton coffre s\'est ouvert, puis refermé.', 'ok');
  } catch (e) { noter('[connecter] echec : ' + detail(e)); await afficher(expliquer(e), 'ko'); }
}
async function renvoyer() {
  dire('s-coffre', 'Envoi…', 'wait');
  try {
    const r = await c.renvoyer();
    // Même repli que dans `creer` : le coffre vient d'être confié, et le jeu d'où le joueur était parti ne demande plus rien.
    const versLeJeu = r.garde && venuDUnJeu && !demandeJeu();
    if (r.garde) venuDUnJeu = false;
    await afficher(versLeJeu ? 'C\'est fait : ton coffre est confié au serveur. Retourne au jeu et touche « Se connecter ».'
      : r.garde ? 'C\'est fait : le serveur a bien cette clé.'
      : r.inconnu ? INCONNU
      : r.efface ? 'Le serveur a refusé cette clé d\'accès : ' + (MESSAGES[r.raison] || r.raison) + ' Ton coffre est intact chez nous. Recommence « retrouver mon coffre ».'
      : r.annule ? 'Le serveur a refusé cette clé : ' + (MESSAGES[r.raison] || r.raison) + ' Rien n\'a changé : ton coffre s\'ouvre comme avant.'
      : 'Toujours pas confié au serveur : ' + (MESSAGES[r.raison] || r.raison), r.garde ? 'ok' : r.inconnu ? 'wait' : 'ko');
  } catch (e) { noter('[renvoyer] echec : ' + detail(e)); await afficher(expliquer(e), 'ko'); }
}
async function ouvrir() {
  dire('s-coffre', attenteCle(), 'wait');
  try {
    const s = await c.ouvrirLocal(); s.fermer();
    noter('[ouvrir] ok sans le serveur : adresse ' + s.adresse);
    dire('s-coffre', 'Coffre ouvert sans le serveur, puis refermé.', 'ok');
  } catch (e) { noter('[ouvrir] echec : ' + detail(e)); dire('s-coffre', expliquer(e), 'ko'); }
}
// Donner sa propre clé à cet appareil : une fois, puis il n'a plus besoin de l'autre clé. C'est un accès durable :
// la page le dit et demande de confirmer, avant tout geste. Cet ajout ne se retire pas encore.
function desarmerAjout() { if (armeAjouter) clearTimeout(armeAjouter); armeAjouter = null; }
async function ajouterAppareil() {
  if (fiche && !fiche.ajout && !armeAjouter) {
    $('b-ajouter').textContent = 'Confirmer : ajouter cet appareil';
    dire('s-coffre', 'Cet appareil pourra ouvrir ton wallet à chaque fois, sans ton autre clé. Ne l\'ajoute que s\'il est à toi : cet ajout ne se retire pas encore.', 'wait');
    armeAjouter = setTimeout(() => { desarmerAjout(); $('b-ajouter').textContent = 'Ajouter cet appareil'; dire('s-coffre', ''); }, 12000);
    return;
  }
  desarmerAjout();
  dire('s-coffre', fiche && fiche.ajout ? 'Envoi…' : 'Ton appareil va te demander plusieurs confirmations : d\'abord avec ta clé actuelle, puis avec celui-ci.', 'wait');
  try {
    const r = await c.ajouterCetAppareil('Mon coffre (essai) ' + new Date().toLocaleString('fr-FR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }));
    if (r.garde) { noter('[appareil] cet appareil a maintenant sa propre cle'); await afficher('Cet appareil a maintenant sa propre clé. La prochaine fois, tu confirmes ici, sans ton autre clé.', 'ok'); }
    else if (r.inconnu) await afficher(INCONNU, 'wait');
    else if (r.annule) await afficher('Le serveur a refusé cette clé : ' + (MESSAGES[r.raison] || r.raison) + ' Rien n\'a changé : ton coffre s\'ouvre comme avant.', 'ko');
    else await afficher('Clé créée, mais pas encore confiée au serveur : ' + (MESSAGES[r.raison] || r.raison) + ' Touche « Réessayer d\'ajouter cet appareil ».', 'ko');
  } catch (e) {
    noter('[appareil] echec : ' + detail(e));
    await afficher(e && e.name === 'DejaUneCle' ? 'Cet appareil a déjà une clé de ce coffre. Dans « Autres actions », touche « Oublier ce coffre sur cet appareil », puis « J\'ai déjà un coffre : me connecter », et choisis la clé de cet appareil.' : expliquer(e), 'ko');
  }
}
function desarmer() { if (armeOublier) clearTimeout(armeOublier); armeOublier = null; $('b-oublier').textContent = 'Oublier ce coffre sur cet appareil'; }
async function oublier() {
  if (!armeOublier) {
    $('b-oublier').textContent = 'Confirmer : oublier ce coffre ici';
    dire('s-coffre', fiche.garde ? 'Il restera chez nous : tu le retrouveras avec « me connecter ».' : 'Attention : il n\'est pas chez nous. L\'oublier ici, c\'est le perdre.', fiche.garde ? 'wait' : 'ko');
    armeOublier = setTimeout(() => { desarmer(); dire('s-coffre', ''); }, 8000);
    return;
  }
  desarmer();
  try { await stock.effacer(fiche); noter('[oublier] coffre retire de cet appareil'); await afficher('Coffre oublié sur cet appareil.', 'ok'); }
  catch (e) { noter('[oublier] echec : ' + detail(e)); await afficher(expliquer(e), 'ko'); }
}
// ---------- La mission des 12 mots : les voir une fois, puis les remettre dans l'ordre en touchant des cartes.
// Aucun indice en route : un mot touché va à la place suivante, sans que la page dise s'il est bien placé. Sinon il
// suffirait d'essayer les cartes une à une pour trouver l'ordre, sans avoir rien noté. La seule vérification vient
// à la fin : une vraie restauration du coffre par les mots donnés. La réponse est oui ou non.
const etape = (id) => { for (const e of ETAPES) $(e).hidden = e !== id; };
function effacerMission() {
  for (let i = 1; i <= 12; i++) {
    $('m-mot-' + i).textContent = ''; $('m-place-' + i).textContent = '';
    const b = $('m-carte-' + i); b.textContent = ''; b.disabled = false; b.className = 'carte';
  }
  $('m-avance').textContent = ''; $('b-m-valider').disabled = true; $('b-m-retirer').disabled = true;
  $('m-adresse').value = ''; $('m-code').value = ''; $('m-code').hidden = true; $('m-z-adresse').hidden = false; $('b-m-finir').hidden = true;
}
function quitterMission() { if (mission) { mission.m.fermer(); mission = null; } effacerMission(); }
function ouvrirMission() { quitterMission(); dire('s-mission', ''); etape('m-intro'); montrer('v-mission'); }
async function voirMots() {
  if (mission) { montrerMots(); return; }
  dire('s-mission', attenteCle(), 'wait');
  try {
    const m = await c.mission();
    mission = { m, cartes: [], poses: [] };
    noter('[mission] mots affiches');
    montrerMots();
    dire('s-mission', '');
  } catch (e) { noter('[mission] echec a l\'ouverture : ' + detail(e)); dire('s-mission', expliquer(e), 'ko'); }
}
function montrerMots() {
  if (!mission) return;
  effacerMission();
  mission.poses = [];
  for (let i = 0; i < 12; i++) $('m-mot-' + (i + 1)).textContent = mission.m.mots[i];
  dire('s-mission', '');
  etape('m-mots');
}
function lancerCartes() {
  if (!mission) return;
  effacerMission();   // les mots ne restent pas affichés pendant le jeu
  mission.poses = [];
  mission.cartes = melanger(mission.m.mots.slice());
  for (let i = 0; i < 12; i++) $('m-carte-' + (i + 1)).textContent = mission.cartes[i];
  dessinerPlaces();
  dire('s-mission', '');
  etape('m-cartes');
}
function dessinerPlaces() {
  for (let k = 0; k < 12; k++) $('m-place-' + (k + 1)).textContent = k < mission.poses.length ? mission.cartes[mission.poses[k]] : '';
  $('m-avance').textContent = mission.poses.length + ' sur 12';
  $('b-m-valider').disabled = mission.poses.length !== 12;
  $('b-m-retirer').disabled = mission.poses.length === 0;
}
function toucher(i) {
  if (!mission || occupe || mission.poses.includes(i) || mission.poses.length >= 12 || !mission.cartes.length) return;
  mission.poses.push(i);
  const b = $('m-carte-' + (i + 1)); b.disabled = true; b.className = 'carte posee';
  dessinerPlaces();
}
function retirer() {
  if (!mission || occupe || !mission.poses.length) return;
  const b = $('m-carte-' + (mission.poses.pop() + 1)); b.disabled = false; b.className = 'carte';
  dessinerPlaces();
}
// Le mauvais ordre : tout repart de zéro. Aucune carte ne reste posée, rien ne dit laquelle était à sa place.
function ordreRefuse() {
  noter('[mission] ordre refuse');
  for (let i = 1; i <= 12; i++) { const b = $('m-carte-' + i); b.disabled = false; b.className = 'carte'; }
  mission.poses = []; mission.verifie = null;
  dessinerPlaces();
  etape('m-cartes');
  dire('s-mission', 'Ce n\'est pas le bon ordre. Regarde ton papier, puis recommence.', 'ko');
}
async function missionReussie() {
  const lie = !!(mission && mission.m.identiteRequise);
  noter('[mission] secours fait');
  quitterMission();
  await afficher(lie ? 'Mission réussie. Si tu perds tes appareils, tes 12 mots et ton adresse e-mail te rendront ton wallet. Garde ton papier en lieu sûr.'
    : 'Mission réussie : tes 12 mots ouvrent bien ton coffre. Garde ton papier en lieu sûr.', 'ok');
}
async function validerMission() {
  if (!mission || mission.poses.length !== 12) return;
  const donnes = mission.poses.map((i) => mission.cartes[i]);
  dire('s-mission', 'Vérification de ton secours…', 'wait');
  try {
    if (mission.m.identiteRequise) {
      // D'abord les mots, par une vraie réouverture du coffre, sans rien envoyer. L'adresse e-mail vient ensuite :
      // la déclaration ne part qu'avec elle.
      await mission.m.verifier(donnes);
      mission.verifie = donnes;
      noter('[mission] ordre accepte, adresse e-mail demandee');
      dire('s-mission', '');
      etape('m-email');
      return;
    }
    await mission.m.valider(donnes);
  } catch (e) {
    if (e && e.name === 'MotsRefuses') { ordreRefuse(); return; }
    noter('[mission] echec : ' + detail(e));
    dire('s-mission', 'Ton secours n\'a pas pu être enregistré. ' + expliquer(e), 'ko');
    return;
  }
  await missionReussie();
}
// L'adresse e-mail du secours : un code, puis la déclaration. L'adresse n'est ni gardée ni écrite au relevé.
async function codeMission() {
  if (!mission || !mission.verifie) return;
  const email = $('m-adresse').value.trim();
  if (!formeEmail(email)) { dire('s-mission', 'Cette adresse n\'a pas la forme d\'une adresse e-mail.', 'ko'); return; }
  dire('s-mission', 'Envoi…', 'wait');
  try {
    await c.demanderCode(email);
    mission.confirme = false;
    $('m-code').hidden = false; $('b-m-finir').hidden = false;
    noter('[mission] code demande');
    dire('s-mission', 'Si cette adresse est la bonne, un code vient de partir. Il est valable dix minutes.', 'ok');
  } catch (e) { noter('[mission] echec du code : ' + detail(e)); dire('s-mission', expliquer(e), 'ko'); }
}
async function finirMission() {
  if (!mission || !mission.verifie) return;
  dire('s-mission', 'Vérification…', 'wait');
  try {
    if (!mission.confirme) {
      const code = $('m-code').value.replace(/\D/g, '');
      if (code.length !== 6) { dire('s-mission', 'Le code a six chiffres.', 'ko'); return; }
      await c.validerCode($('m-adresse').value.trim(), code);
      mission.confirme = true;
      $('m-code').value = ''; $('m-code').hidden = true; $('m-z-adresse').hidden = true;
      noter('[mission] adresse confirmee');
    }
    await mission.m.valider(mission.verifie);
  } catch (e) {
    if (e && e.name === 'MotsRefuses') { ordreRefuse(); return; }
    noter('[mission] echec : ' + detail(e));
    if (incertain(e)) { dire('s-mission', expliquer(e) + ' Retouche « Terminer ma mission » : rien n\'est perdu.', 'ko'); return; }
    // Tout autre refus après le code : la confirmation de l'adresse ne vaut plus, ou cette adresse ne convient pas.
    if (e && e.name !== 'CodeRefuse') { mission.confirme = false; $('m-z-adresse').hidden = false; $('m-code').hidden = true; $('b-m-finir').hidden = true; }
    dire('s-mission', expliquer(e), 'ko');
    return;
  }
  await missionReussie();
}
async function annulerMission() { quitterMission(); await afficher(); }

// ---------- Retrouver son coffre sans appareil : les 12 mots, puis l'adresse e-mail de la mission et son code.
// Aucun jugement pendant la saisie des mots : la page ne dit ni qu'un mot est inconnu, ni qu'il est mal placé. La
// réponse vient à la fin, d'un seul mot. Les mots ne partent jamais : ils signent ici, et rouvrent ici le coffre remis.
const etapeR = (id) => { for (const e of ETAPES_RETROUVER) $(e).hidden = e !== id; };
const motsSaisis = () => { const m = []; for (let i = 1; i <= 12; i++) m.push($('r-mot-' + i).value.trim().toLowerCase()); return m; };
function effacerRetrouver() {
  for (let i = 1; i <= 12; i++) $('r-mot-' + i).value = '';
  $('r-adresse').value = ''; $('r-code').value = ''; $('r-code').hidden = true; $('r-z-adresse').hidden = false; $('b-r-retrouver').hidden = true;
  $('r-wallet').textContent = '';
}
function quitterRetrouver() { c.abandonner(); retrouvaille = null; effacerRetrouver(); }
function ouvrirRetrouver() { quitterRetrouver(); retrouvaille = { confirme: false, trouve: false }; dire('s-retrouver', ''); etapeR('r-mots'); montrer('v-retrouver'); }
function suiteRetrouver() {
  if (!retrouvaille) return;
  if (motsSaisis().some((m) => !m)) { dire('s-retrouver', 'Il faut les 12 mots.', 'ko'); return; }
  // L'adresse déjà confirmée (le code a été validé, puis les mots refusés) : pas de nouveau code à demander.
  $('r-z-adresse').hidden = retrouvaille.confirme; $('b-r-retrouver').hidden = !retrouvaille.confirme && $('r-code').hidden;
  dire('s-retrouver', '');
  etapeR('r-email');
}
function revoirMots() { if (!retrouvaille) return; dire('s-retrouver', ''); etapeR('r-mots'); }
async function codeRetrouver() {
  if (!retrouvaille) return;
  const email = $('r-adresse').value.trim();
  if (!formeEmail(email)) { dire('s-retrouver', 'Cette adresse n\'a pas la forme d\'une adresse e-mail.', 'ko'); return; }
  dire('s-retrouver', 'Envoi…', 'wait');
  try {
    await c.demanderCode(email);
    retrouvaille.confirme = false;
    $('r-code').hidden = false; $('b-r-retrouver').hidden = false;
    noter('[retrouver] code demande');
    dire('s-retrouver', 'Si cette adresse est la bonne, un code vient de partir. Il est valable dix minutes.', 'ok');
  } catch (e) { noter('[retrouver] echec du code : ' + detail(e)); dire('s-retrouver', expliquer(e), 'ko'); }
}
async function retrouver() {
  if (!retrouvaille) return;
  dire('s-retrouver', 'Vérification…', 'wait');
  try {
    if (!retrouvaille.confirme) {
      const code = $('r-code').value.replace(/\D/g, '');
      if (code.length !== 6) { dire('s-retrouver', 'Le code a six chiffres.', 'ko'); return; }
      await c.validerCode($('r-adresse').value.trim(), code);
      retrouvaille.confirme = true;
      $('r-code').value = ''; $('r-code').hidden = true; $('r-z-adresse').hidden = true;
      noter('[retrouver] adresse confirmee');
    }
    const r = await c.retrouver(motsSaisis());
    retrouvaille.trouve = true;
    for (let i = 1; i <= 12; i++) $('r-mot-' + i).value = '';   // ils ne restent pas dans la page
    $('r-wallet').textContent = r.adresse;
    dire('s-retrouver', '');
    etapeR('r-garder');
  } catch (e) {
    noter('[retrouver] echec : ' + detail(e));
    if (e && e.name === 'MotsRefuses') {
      // Un seul non, quelle que soit la raison. Les mots restent dans leurs cases, pour être corrigés.
      etapeR('r-mots');
      dire('s-retrouver', 'Ces 12 mots n\'ouvrent pas ton coffre. Vérifie ton papier : les mots, et leur ordre. Puis recommence.', 'ko');
      return;
    }
    if (incertain(e)) { dire('s-retrouver', expliquer(e) + ' Retouche « Retrouver mon coffre » : ta demande repartira telle quelle.', 'ko'); return; }
    if (e && e.name === 'TropDEssais') { dire('s-retrouver', attente(e), 'ko'); return; }
    // La confirmation de l'adresse ne vaut plus (expirée, ou sans coffre à retrouver) : la page la redemande.
    if (e && e.name !== 'CodeRefuse') { retrouvaille.confirme = false; $('r-z-adresse').hidden = false; $('r-code').hidden = true; $('b-r-retrouver').hidden = true; }
    dire('s-retrouver', expliquer(e), 'ko');
  }
}
async function garderIci() {
  if (!retrouvaille || !retrouvaille.trouve) return;
  dire('s-retrouver', ATTENTE, 'wait');
  try {
    const r = await c.garder('Mon coffre (essai) ' + new Date().toLocaleString('fr-FR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }));
    quitterRetrouver();
    if (r.garde) { noter('[retrouver] wallet garde sur cet appareil'); await afficher('Ton wallet est de retour sur cet appareil. La clé de ton ancien appareil l\'ouvre toujours.', 'ok'); }
    else if (r.inconnu) await afficher(INCONNU, 'wait');
    else if (r.efface) await afficher('Le serveur a refusé cette clé d\'accès : ' + (MESSAGES[r.raison] || r.raison) + ' Ton coffre est intact chez nous. Recommence « retrouver mon coffre ».', 'ko');
    else await afficher('Clé créée, mais pas encore confiée au serveur : ' + (MESSAGES[r.raison] || r.raison) + ' Touche « Réessayer de le confier au serveur ».', 'ko');
  } catch (e) {
    noter('[retrouver] echec en gardant : ' + detail(e));
    if (e && e.name === 'RienARetrouver') { ouvrirRetrouver(); dire('s-retrouver', expliquer(e), 'ko'); return; }
    dire('s-retrouver', expliquer(e), 'ko');   // un geste annulé se retente : le coffre retrouvé reste en mémoire
  }
}
async function annulerRetrouver() { quitterRetrouver(); await afficher(); }

// ---------- Mes adresses de secours : changer l'adresse principale, ajouter, changer ou retirer la seconde.
// Le coffre s'ouvre pour chaque réglage (un geste) : c'est la clé du wallet qui le signe. L'ancienne adresse n'est
// jamais demandée. La page ne montre aucune adresse : le serveur ne les a pas, seulement leur date d'inscription.
const etapeA = (id) => { for (const e of ETAPES_ADRESSES) $(e).hidden = e !== id; };
const dateCourte = (secondes) => new Date(secondes * 1000).toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit', year: 'numeric' });
function desarmerRetrait() { if (armeRetirer) clearTimeout(armeRetirer); armeRetirer = null; $('b-a-retirer-2').textContent = 'Retirer ma seconde adresse'; }
function effacerSaisieAdresse() { $('a-adresse').value = ''; $('a-code').value = ''; $('a-code').hidden = true; $('a-z-adresse').hidden = false; $('b-a-enregistrer').hidden = true; }
function dessinerAdresses() {
  const liste = (fiche && fiche.recuperation && fiche.recuperation.adresses) || [];
  const a1 = liste.find((a) => a.rang === 1), a2 = liste.find((a) => a.rang === 2);
  dire('a-rang-1', a1 ? 'Adresse principale : enregistrée le ' + dateCourte(a1.cree) + '.' : 'Adresse principale : enregistrée.', 'ok');
  dire('a-rang-2', a2 ? 'Seconde adresse : enregistrée le ' + dateCourte(a2.cree) + '.' : 'Seconde adresse : aucune.', a2 ? 'ok' : 'wait');
  $('b-a-regler-2').textContent = a2 ? 'Changer ma seconde adresse' : 'Ajouter une seconde adresse';
  $('b-a-retirer-2').hidden = !a2;
  desarmerRetrait();
  // Un réglage dont la réponse s'est perdue : tant qu'il n'est pas terminé, lui seul peut repartir. Les autres
  // boutons sont retirés, pour qu'un nouveau réglage ne reçoive jamais la réponse de celui-là.
  const attente = c.reglageEnAttente();
  $('a-attente').hidden = !attente; $('b-a-terminer').hidden = !attente;
  $('b-a-changer-1').hidden = !!attente; $('b-a-regler-2').hidden = !!attente;
  if (attente) {
    $('b-a-retirer-2').hidden = true;
    dire('a-attente', 'Un réglage attend encore sa réponse : ' + nomReglage(attente) + '. Je ne sais pas s\'il a été enregistré. Termine-le avant tout autre réglage.', 'wait');
  }
}
// Ce qu'un réglage voulait faire, et ce qu'il a fait, dit d'après ce que le client a réellement conclu : jamais
// d'après le dernier bouton touché.
const nomReglage = (r) => (r.retirer ? 'retirer ta seconde adresse' : r.rang === 1 ? 'changer ton adresse principale' : 'enregistrer ta seconde adresse');
function messageReglage(r) {
  if (r.depasse) return ['Ce réglage avait bien été enregistré. Mais tes adresses ont encore été réglées depuis, ailleurs : c\'est la liste ci-dessus qui compte.', 'wait'];
  return [r.retire ? 'Ta seconde adresse est retirée.' : r.rang === 1 ? 'Ton adresse principale est changée. L\'ancienne ne sert plus.' : 'Ta seconde adresse est enregistrée.', 'ok'];
}
async function terminerReglage() {
  dire('s-adresses', 'Envoi…', 'wait');
  try {
    const r = await c.reprendreReglage();
    noter('[adresses] reglage en attente termine');
    fiche = (await stock.lire()) || null;
    ouvrirAdresses(...messageReglage(r));
  } catch (e) {
    noter('[adresses] reglage en attente : ' + detail(e));
    if (incertain(e)) { dire('s-adresses', expliquer(e) + ' Retouche « Terminer ce réglage ».', 'ko'); return; }
    // Pas confirmé sur cet appareil (réponse incohérente, ou stockage refusé) : il attend toujours, la liste le montre.
    if (e && e.name === 'ReglageAConfirmer') { ouvrirAdresses(expliquer(e), 'wait'); return; }
    // Le serveur refuse pour de bon. La page ne dit pas « non enregistré » : elle ne le sait pas.
    ouvrirAdresses('Le serveur ne confirme pas ce réglage. ' + expliquer(e) + ' Ta prochaine connexion montrera l\'état réel de tes adresses ; recommence le réglage s\'il manque.', 'ko');
  }
}
function ouvrirAdresses(message, sorte) { reglage = null; effacerSaisieAdresse(); dessinerAdresses(); etapeA('a-liste'); dire('s-adresses', message || '', sorte); montrer('v-adresses'); }
function choisirRang(rang) {
  reglage = { rang, confirme: false };
  effacerSaisieAdresse();
  $('a-titre').textContent = rang === 1 ? 'Ta nouvelle adresse principale. Nous t\'y envoyons un code.' : 'Ta seconde adresse. Nous t\'y envoyons un code.';
  dire('s-adresses', '');
  etapeA('a-saisie');
}
async function codeAdresse() {
  if (!reglage) return;
  const email = $('a-adresse').value.trim();
  if (!formeEmail(email)) { dire('s-adresses', 'Cette adresse n\'a pas la forme d\'une adresse e-mail.', 'ko'); return; }
  dire('s-adresses', 'Envoi…', 'wait');
  try {
    await c.demanderCode(email);
    reglage.confirme = false;
    $('a-code').hidden = false; $('b-a-enregistrer').hidden = false;
    noter('[adresses] code demande');
    dire('s-adresses', 'Si cette adresse est la bonne, un code vient de partir. Il est valable dix minutes.', 'ok');
  } catch (e) { noter('[adresses] echec du code : ' + detail(e)); dire('s-adresses', expliquer(e), 'ko'); }
}
async function enregistrerAdresse() {
  if (!reglage) return;
  dire('s-adresses', 'Vérification…', 'wait');
  try {
    if (!reglage.confirme) {
      const code = $('a-code').value.replace(/\D/g, '');
      if (code.length !== 6) { dire('s-adresses', 'Le code a six chiffres.', 'ko'); return; }
      await c.validerCode($('a-adresse').value.trim(), code);
      reglage.confirme = true;
      $('a-code').value = ''; $('a-code').hidden = true; $('a-z-adresse').hidden = true;
      noter('[adresses] adresse confirmee');
    }
    dire('s-adresses', attenteCle(), 'wait');
    const r = await c.reglerAdresse(reglage.rang);
    noter('[adresses] adresse enregistree au rang ' + r.rang);
    fiche = (await stock.lire()) || null;
    ouvrirAdresses(...messageReglage(r));
  } catch (e) {
    noter('[adresses] echec : ' + detail(e));
    if (incertain(e)) { dire('s-adresses', expliquer(e) + ' Retouche « Enregistrer cette adresse » : rien n\'est perdu.', 'ko'); return; }
    // Un autre réglage attend sa réponse : retour à la liste, qui le montre et ne propose que de le terminer.
    if (e && e.name === 'ReglageEnAttente') { ouvrirAdresses(expliquer(e), 'ko'); return; }
    if (e && e.name === 'ReglageAConfirmer') { ouvrirAdresses(expliquer(e), 'wait'); return; }
    // Un geste annulé se retente sans redemander de code ; tout autre refus après le code fait redemander l'adresse.
    if (e && !['CodeRefuse', 'NotAllowedError', 'AdmissionRefusee'].includes(e.name)) { reglage.confirme = false; $('a-z-adresse').hidden = false; $('a-code').hidden = true; $('b-a-enregistrer').hidden = true; }
    dire('s-adresses', expliquer(e), 'ko');
  }
}
async function retirerSeconde() {
  if (!armeRetirer) {
    $('b-a-retirer-2').textContent = 'Confirmer : retirer ma seconde adresse';
    dire('s-adresses', 'Elle ne pourra plus servir à retrouver ton wallet. Ton adresse principale reste.', 'wait');
    armeRetirer = setTimeout(() => { desarmerRetrait(); dire('s-adresses', ''); }, 8000);
    return;
  }
  desarmerRetrait();
  dire('s-adresses', attenteCle(), 'wait');
  try {
    const r = await c.reglerAdresse(2, { retirer: true });
    noter('[adresses] seconde adresse retiree');
    fiche = (await stock.lire()) || null;
    ouvrirAdresses(...messageReglage(r));
  } catch (e) {
    noter('[adresses] echec du retrait : ' + detail(e));
    // Réponse perdue : le retrait attend. La liste le montre, et ne propose que de le terminer.
    if (incertain(e) || (e && (e.name === 'ReglageEnAttente' || e.name === 'ReglageAConfirmer'))) { ouvrirAdresses(expliquer(e), e.name === 'ReglageAConfirmer' ? 'wait' : 'ko'); return; }
    dire('s-adresses', expliquer(e), 'ko');
  }
}
async function fermerAdresses() { reglage = null; effacerSaisieAdresse(); desarmerRetrait(); await afficher(); }

async function copier() {
  try { await navigator.clipboard.writeText(texteResultat()); dire('s-resultat', 'Copié.', 'ok'); }
  catch (_) { $('resultat').select(); dire('s-resultat', 'Sélectionné : copie-le à la main.', 'wait'); }
}

function bloquer(texte) { for (const v of VUES) $(v).hidden = true; $('blocage').textContent = texte; $('blocage').hidden = false; noter('[page] bloquee : ' + texte); }
$('b-copier').addEventListener('click', copier);
$('b-code').addEventListener('click', validerCode);
if (window.top !== window.self) bloquer('Cette page refuse d\'être affichée à l\'intérieur d\'un autre site.');
else if (!window.isSecureContext || !window.PublicKeyCredential || !window.crypto || !crypto.subtle || !window.indexedDB) bloquer('Ce navigateur ne permet pas de créer un coffre ici.');
else {
  $('b-creer').addEventListener('click', seul(creer));
  $('b-connecter').addEventListener('click', seul(connecter));
  $('b-reconnecter').addEventListener('click', seul(connecter));
  $('b-renvoyer').addEventListener('click', seul(renvoyer));
  $('b-ouvrir').addEventListener('click', seul(ouvrir));
  $('b-oublier').addEventListener('click', seul(oublier));
  $('b-jeu').addEventListener('click', seul(entrerDansLeJeu));
  $('b-mission').addEventListener('click', ouvrirMission);
  $('b-m-voir').addEventListener('click', seul(voirMots));
  $('b-m-note').addEventListener('click', lancerCartes);
  $('b-m-revoir').addEventListener('click', montrerMots);
  $('b-m-retirer').addEventListener('click', retirer);
  $('b-m-valider').addEventListener('click', seul(validerMission));
  $('b-m-annuler').addEventListener('click', seul(annulerMission));
  $('b-ajouter').addEventListener('click', seul(ajouterAppareil));
  $('b-adresses').addEventListener('click', () => ouvrirAdresses());
  $('b-a-changer-1').addEventListener('click', () => choisirRang(1));
  $('b-a-regler-2').addEventListener('click', () => choisirRang(2));
  $('b-a-retirer-2').addEventListener('click', seul(retirerSeconde));
  $('b-a-terminer').addEventListener('click', seul(terminerReglage));
  $('b-a-code').addEventListener('click', seul(codeAdresse));
  $('b-a-enregistrer').addEventListener('click', seul(enregistrerAdresse));
  $('b-a-retour').addEventListener('click', () => ouvrirAdresses());
  $('b-a-fermer').addEventListener('click', seul(fermerAdresses));
  $('b-m-code').addEventListener('click', seul(codeMission));
  $('b-m-finir').addEventListener('click', seul(finirMission));
  $('b-retrouver').addEventListener('click', ouvrirRetrouver);
  $('b-r-suite').addEventListener('click', suiteRetrouver);
  $('b-r-revoir').addEventListener('click', revoirMots);
  $('b-r-code').addEventListener('click', seul(codeRetrouver));
  $('b-r-retrouver').addEventListener('click', seul(retrouver));
  $('b-r-garder').addEventListener('click', seul(garderIci));
  $('b-r-annuler').addEventListener('click', seul(annulerRetrouver));
  for (let i = 0; i < 12; i++) $('m-carte-' + (i + 1)).addEventListener('click', () => toucher(i));
  $('b-envoyer-code').addEventListener('click', seul(envoyerCode));
  $('b-valider-code').addEventListener('click', seul(validerLeCode));
  for (const p of Object.keys(NOMS_PORTES)) $(BOUTONS_PORTES[p]).addEventListener('click', seul(() => partirPar(p)));
  $('b-wallet').addEventListener('click', seul(async () => choisirWallet()));
  $('b-porte-email').addEventListener('click', () => { emailOuvert = true; rafraichirAccueil(); dire('s-accueil', ''); const e = $('email'); if (e && typeof e.focus === 'function') e.focus(); });
  // Ouverte par un autre site, dans sa propre fenêtre : on n'écoute que les jeux enregistrés.
  if (window.opener && REGLAGES.jeux && Object.keys(REGLAGES.jeux).length) {
    lien = lienJeu({ fenetre: window, ouvreur: window.opener, jeux: REGLAGES.jeux, noter,
      surDemande: demandeArrivee,
      surAccuse: choixRecu,
      surRetrait: (d) => { $('v-jeu').hidden = false; $('b-jeu').hidden = true;
        dire('s-jeu', d && d.expiree ? 'Cette demande de connexion a expiré. Rien ne sera envoyé. Ferme cette fenêtre et recommence depuis le jeu.'
          : 'Le jeu a retiré sa demande. Rien ne sera envoyé.', 'wait'); } });
    lien.annoncer();
  }
  crypto.subtle.generateKey({ name: 'Ed25519' }, false, ['sign', 'verify']).then(async () => { await afficher(); await retourDePorte(); }, () => bloquer('Ce navigateur ne sait pas encore faire les signatures de Solana. Mets-le à jour, puis reviens.'));
}
