// Le côté « jeu » : ce qu'un studio met dans sa page pour le bouton « Se connecter ». Aucune dépendance.
// (Plus bas dans ce fichier : « Connecter mon wallet », pour le joueur qui a déjà un wallet Solana.)
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
//   existant   facultatif : vrai quand le joueur dit qu'il a déjà son coffre et que le jeu ne connaît pas encore
//              son wallet. La fenêtre ne proposera pas d'en créer un. Une page du coffre trop ancienne pour le
//              comprendre ne reçoit pas la demande : le jeu reçoit l'erreur CoffreTropAncien.
//   wallet     facultatif : vrai quand le jeu sait aussi connecter un wallet que le joueur a déjà (plus bas :
//              « Connecter mon wallet »). La fenêtre montre alors ce choix. Si le joueur le prend, AUCUNE preuve
//              n'arrive : `resultat` échoue avec l'erreur ChoixWallet, et cette tentative est finie. Le jeu montre
//              alors son propre bouton du wallet et attend que le joueur le touche (voir demo.mjs). Le message de
//              la fenêtre ne porte aucun pouvoir (ni adresse, ni texte à signer, ni lien) : ne jamais appeler un
//              wallet à sa réception, toujours dans un geste du joueur sur la page du jeu, avec une tentative neuve
//              préparée par le serveur du jeu. Une page du coffre trop ancienne ne montre simplement pas ce choix.
//
// À appeler dans le geste du joueur (un clic), sans rien attendre avant : sinon le navigateur bloque l'ouverture
// de la fenêtre. Le défi se demande donc au serveur du jeu à l'avance (voir demo.mjs et serveur-jeu.mjs).
// Le jeu ne reçoit qu'une adresse et une preuve signée. C'est son serveur qui décide, après vérification.

const hasard = () => { const o = crypto.getRandomValues(new Uint8Array(18)); let s = ''; for (const x of o) s += String.fromCharCode(x); return btoa(s).replace(/\+/g, '-').replace(/\//g, '_'); };

export function connexionCoffre({ coffre, defi, adresse, existant, wallet, fenetre, delai }) {
  const moi = fenetre || window;
  const origineCoffre = new URL(coffre).origin;
  const id = hasard();
  let fini = false, minuteur = null, veille = null, ecoute = null, w = null, propose = false;
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
      // « Sans création » ne se demande qu'à une page qui le comprend : une plus ancienne proposerait de créer.
      if (existant && !(m.v >= 2)) { try { w.close(); } catch (_) { /* déjà fermée */ } finir(echouer, erreur('CoffreTropAncien')); return; }
      const demande = { type: 'jeu-connexion', id, defi };
      if (adresse) demande.adresse = adresse;
      if (existant) demande.existant = true;
      // Le choix « wallet » ne se propose qu'à une page qui sait le rendre (version 3).
      if (wallet === true && m.v >= 3) { demande.wallet = true; propose = true; }
      w.postMessage(demande, origineCoffre);
    } else if (m.type === 'coffre-connexion' && m.id === id) {
      if (typeof m.adresse !== 'string' || typeof m.message !== 'string' || typeof m.signature !== 'string') return;
      finir(reussir, { adresse: m.adresse, message: m.message, signature: m.signature });
    } else if (m.type === 'coffre-refus' && m.id === id) {
      finir(echouer, erreur('ConnexionRefusee'));
    } else if (m.type === 'coffre-methode' && m.id === id) {
      // Le joueur a choisi, dans la fenêtre du coffre, d'entrer avec son propre wallet. Écouté seulement si cette
      // tentative l'a proposé, et seulement sous sa forme exacte : quatre champs, rien de plus.
      if (!propose || m.v !== 1 || m.methode !== 'wallet' || Object.keys(m).length !== 4) return;
      try { w.postMessage({ type: 'jeu-methode-recue', id }, origineCoffre); } catch (_) { /* fenêtre fermée */ }
      finir(echouer, erreur('ChoixWallet'));
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

// ---------- Le joueur a déjà un wallet (Phantom, Solflare…) : « Connecter mon wallet ». Aucune dépendance.
//
//   import { walletsPresents, connexionWallet } from './coffre-jeu.mjs';
//   const presents = walletsPresents();                    // au chargement de la page
//   bouton.addEventListener('click', async () => {
//     const [choix] = presents.liste();                    // ou laisser le joueur choisir dans la liste
//     const sortie = await connexionWallet({ wallet: choix.wallet, entree });
//     // envoyer `sortie` au serveur du jeu, qui vérifie (serveur-jeu.mjs : connexionWalletServeurJeu)
//   });
//
//   entree     ce que le serveur du jeu a préparé pour cette tentative (domaine, phrase, adresse de la page, réseau,
//              nonce, heures) : la page le remet au wallet tel quel, sans rien y changer.
//
// Ce chemin n'ouvre pas la fenêtre du coffre et ne crée aucun coffre : c'est le wallet du joueur qui signe, dans la
// page du jeu. Les wallets se trouvent par le protocole du Wallet Standard (deux événements, voir plus bas) ; seuls
// sont proposés ceux qui annoncent la fonction `solana:signIn` et une chaîne Solana. Les fonctions annoncées sont
// lues, jamais un nom de marque. Pas de repli sur une autre fonction du wallet.
// La page ne juge rien : elle rapporte au serveur ce que le wallet a rendu. C'est le serveur du jeu qui décide.

const SIGN_IN = 'solana:signIn';
const enB64u = (octets) => { let s = ''; for (const x of octets) s += String.fromCharCode(x); return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); };
// Des octets rendus par un wallet : un tableau d'octets, de taille bornée. Sinon rien.
const octetsDe = (x, max) => {
  try {
    if (!ArrayBuffer.isView(x) || x.byteLength > max) return null;
    return new Uint8Array(x.buffer.slice(x.byteOffset, x.byteOffset + x.byteLength));
  } catch (_) { return null; }
};
// Un wallet qui convient : il annonce une chaîne Solana et la fonction `solana:signIn`. Un wallet mal formé, ou
// dont la lecture lève une erreur, ne convient pas.
function convient(w) {
  try {
    return !!w && typeof w === 'object' && typeof w.name === 'string' && Array.isArray(w.chains)
      && w.chains.some((c) => typeof c === 'string' && c.startsWith('solana:'))
      && !!w.features && typeof w.features === 'object' && !!w.features[SIGN_IN] && typeof w.features[SIGN_IN].signIn === 'function';
  } catch (_) { return false; }
}
// Le nom à montrer : celui que le wallet donne, réduit à des lettres, des chiffres et quelques signes, et borné.
const nomPropre = (nom) => String(nom).replace(/[^\p{L}\p{N} ._-]/gu, '').trim().slice(0, 40) || 'Wallet';

// Trouver les wallets de la page. Le protocole du Wallet Standard (wallet-standard/wallet-standard, côté application) :
//   - un wallet qui arrive envoie à la fenêtre l'événement « wallet-standard:register-wallet », dont le détail est une
//     fonction : l'application l'appelle avec { register } ;
//   - l'application, en démarrant, envoie « wallet-standard:app-ready », dont le détail est ce même { register } :
//     les wallets déjà là s'y inscrivent.
// Rend { liste(), surChangement(fn), arreter() }. `liste()` : [{ nom, wallet }], seulement ceux qui conviennent.
export function walletsPresents({ fenetre } = {}) {
  const moi = fenetre || window;
  const inscrits = new Set(), ecoutes = new Set();
  const prevenir = () => { for (const fn of [...ecoutes]) { try { fn(); } catch (_) { /* l'écoute d'un autre ne nous arrête pas */ } } };
  const register = (...wallets) => {
    for (const w of wallets) inscrits.add(w);
    prevenir();
    return () => { for (const w of wallets) inscrits.delete(w); prevenir(); };
  };
  const api = Object.freeze({ register });
  const surAnnonce = (ev) => { const rappel = ev && ev.detail; if (typeof rappel === 'function') { try { rappel(api); } catch (_) { /* un wallet défaillant ne casse pas la page */ } } };
  try { moi.addEventListener('wallet-standard:register-wallet', surAnnonce); } catch (_) { /* pas de fenêtre à écouter */ }
  try {
    const ev = typeof CustomEvent === 'function' ? new CustomEvent('wallet-standard:app-ready', { detail: api }) : Object.assign(new Event('wallet-standard:app-ready'), { detail: api });
    moi.dispatchEvent(ev);
  } catch (_) { /* aucun wallet ne sera prévenu : ceux qui arrivent ensuite s'annonceront eux-mêmes */ }
  return {
    liste: () => [...inscrits].filter(convient).map((w) => ({ nom: nomPropre(w.name), wallet: w })),
    surChangement(fn) { ecoutes.add(fn); return () => ecoutes.delete(fn); },
    arreter() { try { moi.removeEventListener('wallet-standard:register-wallet', surAnnonce); } catch (_) { /* rien */ } ecoutes.clear(); },
  };
}

// Ce que le navigateur dit d'un geste du joueur en cours sur cette page : vrai, faux, ou rien (`undefined`) quand il
// ne sait pas le dire. C'est un SIGNAL, pas une preuve et pas une règle : cette « activation » est temporaire, elle
// peut s'éteindre pendant un appel au serveur fait après le toucher, et elle ne dit rien du consentement du joueur à
// CETTE connexion. Le format de connexion des wallets ne la demande pas. Elle sert à écrire un relevé, ou à choisir
// un message ; pour en faire un refus, il faut le demander (`exigerGeste`, plus bas).
export function gesteDuJoueur(fenetre) {
  try {
    const nav = (fenetre || globalThis).navigator;
    const actif = nav && nav.userActivation ? nav.userActivation.isActive : undefined;
    return actif === true || actif === false ? actif : undefined;
  } catch (_) { return undefined; }
}

// Demander au wallet de signer la connexion préparée par le serveur du jeu. La règle, tenue par le jeu : n'appeler
// cette fonction que depuis un toucher du joueur sur la page du jeu, jamais à la réception d'un message d'une autre
// fenêtre. Par défaut, la fonction ne refuse pas d'elle-même quand le navigateur dit qu'aucun geste n'est en cours :
// ce signal a des faux « non » (voir `gesteDuJoueur`), et un refus à tort fermerait la porte du wallet à un vrai
// joueur. `exigerGeste: true` : pour un jeu qui a mesuré ses navigateurs et veut ce refus ; le wallet n'est alors
// pas appelé quand le navigateur dit « non » (erreur GesteRequis) ; il l'est quand il dit « oui » ou ne sait pas.
// Rend ce que le wallet a rendu, écrit en texte pour voyager jusqu'au serveur : { adresse, clePublique, messageSigne,
// signature } en base64url (sauf l'adresse), plus `type` et `format` si le wallet en annonce. Rien n'est interprété
// ici. Erreurs : WalletAbsent (ce wallet ne convient pas), GesteRequis (seulement avec `exigerGeste`),
// WalletRefuse (le wallet a refusé, le joueur a annulé, ou la réponse n'a pas la forme attendue : une seule
// connexion, un compte, des octets).
export async function connexionWallet({ wallet, entree, fenetre, exigerGeste }) {
  const erreur = (nom) => Object.assign(new Error(nom), { name: nom });
  if (!convient(wallet)) throw erreur('WalletAbsent');
  if (exigerGeste === true && gesteDuJoueur(fenetre) === false) throw erreur('GesteRequis');
  let sorties;
  try { sorties = await wallet.features[SIGN_IN].signIn(entree); } catch (_) { throw erreur('WalletRefuse'); }
  if (!Array.isArray(sorties) || sorties.length !== 1 || !sorties[0] || typeof sorties[0] !== 'object') throw erreur('WalletRefuse');
  const s = sorties[0];
  let compte, type, format;
  try { compte = s.account; type = s.signatureType; format = s.signedMessageFormat; } catch (_) { throw erreur('WalletRefuse'); }
  const cle = compte && octetsDe(compte.publicKey, 64), signe = octetsDe(s.signedMessage, 2000), signature = octetsDe(s.signature, 128);
  if (!compte || typeof compte.address !== 'string' || compte.address.length > 64 || !cle || !signe || !signature) throw erreur('WalletRefuse');
  const sortie = { adresse: compte.address, clePublique: enB64u(cle), messageSigne: enB64u(signe), signature: enB64u(signature) };
  // Ce que le wallet annonce en plus est rapporté tel quel (borné) : c'est le serveur qui l'accepte ou le refuse.
  if (type !== undefined) sortie.type = String(type).slice(0, 40);
  if (format !== undefined && format !== null) { try { sortie.format = JSON.stringify(format).slice(0, 200); } catch (_) { sortie.format = 'illisible'; } }
  return sortie;
}
