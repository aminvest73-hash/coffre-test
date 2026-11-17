// Le côté « jeu » : ce qu'un studio met dans sa page pour le bouton « Se connecter ». Aucune dépendance.
// (Plus bas dans ce fichier : faire confirmer une opération dans la fenêtre du coffre, puis « Connecter mon wallet »,
// pour le joueur qui a déjà un wallet Solana, et « Ouvrir dans mon wallet » pour le téléphone.)
//
//   import { connexionCoffre } from './coffre-jeu.mjs';
//   bouton.addEventListener('click', async () => {
//     const demanderLeDefi = () => fetch('/mon-jeu/defi', { method: 'POST' }).then((r) => r.json());   // rend { defi, vie }
//     const { adresse, message, signature } = await connexionCoffre({ coffre: 'https://…/', defi: demanderLeDefi }).resultat;
//     // envoyer adresse, message et signature au serveur du jeu, qui vérifie (verifierConnexionJeu de contrat.mjs)
//   });
//
//   coffre     l'adresse de la page du coffre
//   defi       un défi tiré par le serveur du jeu pour cette tentative (16 à 128 caractères parmi A-Z a-z 0-9 _ -),
//              qu'il n'acceptera qu'une fois. LA FAÇON RECOMMANDÉE : une fonction, appelée juste après l'ouverture de
//              la fenêtre, qui demande le défi au serveur du jeu et rend (ou promet) { defi, vie }. `vie` : ce qu'il
//              reste à vivre à ce défi chez le serveur, en millisecondes (serveur-jeu.mjs le rend avec le défi). Le
//              défi est ainsi tiré au moment du toucher, et la fenêtre du coffre sait quand il meurt : elle évite de
//              faire confirmer le joueur pour un défi déjà mort. `vie` n'est qu'une aide pour l'écran, pas une
//              garantie : c'est toujours le serveur du jeu qui juge son défi. La fonction n'est appelée qu'une fois
//              par tentative. Elle peut aussi rendre le défi seul (une chaîne). Si elle échoue, tarde plus de vingt secondes, ou rend autre chose : la fenêtre est refermée
//              et `resultat` échoue avec DefiIndisponible.
//              L'ancienne façon reste admise : le défi lui-même (une chaîne), demandé avant le clic. La fenêtre ne
//              sait alors pas quand il meurt : au jeu de ne jamais ouvrir la fenêtre avec un défi qui a déjà vécu.
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
//   identite   facultatif : demander aussi une IDENTITÉ (voir serveur-jeu.mjs, identiteServeurJeu). Le serveur du
//              jeu prépare la tentative et rend, avec le défi, le contexte à passer ici tel quel :
//              { client, e, nonce } et, s'il exige une adresse e-mail prouvée, `adresseRequise: true`. Deux façons :
//              `identite: true`, et la fonction `defi` rend { defi, vie, identite } (recommandé : tout est tiré au
//              moment du toucher) ; ou `identite: { … }` donné tout de suite, avec un défi donné lui aussi.
//              Le résultat porte alors en plus `remise` : le code que le serveur du jeu échangera contre l'identité
//              signée. Sans ce code, AUCUNE réponse n'est acceptée (erreur IdentiteAbsente) : une identité attendue
//              n'est jamais remplacée en silence par une simple preuve du wallet. Demandé seulement à une page du
//              coffre en version 7 au moins ; une plus ancienne : CoffreTropAncien. Si le joueur refuse de confirmer
//              son adresse alors que le jeu l'exige : AdresseRefusee (proposer alors la connexion habituelle du jeu).
//
// À appeler dans le geste du joueur (un clic), sans rien attendre avant : sinon le navigateur bloque l'ouverture
// de la fenêtre. C'est pour cela que le défi se donne comme une fonction : la fenêtre s'ouvre d'abord, dans le geste,
// et le défi est demandé au serveur du jeu pendant qu'elle se charge (voir demo.mjs et serveur-jeu.mjs).
// Le jeu ne reçoit qu'une adresse et une preuve signée. C'est son serveur qui décide, après vérification.
// Ne jamais renouveler le défi d'une tentative en cours : la fenêtre tient celui qu'elle a reçu, un autre le tuerait.

const hasard = () => { const o = crypto.getRandomValues(new Uint8Array(18)); let s = ''; for (const x of o) s += String.fromCharCode(x); return btoa(s).replace(/\+/g, '-').replace(/\//g, '_'); };

// Ce que le jeu attend (son défi, sa transaction) a une durée de vie chez lui. Quand il la donne (`vie`, en
// millisecondes), la fenêtre du coffre en est prévenue et la tentative ne dure pas plus qu'elle.
const VIE_UTILE = 30000;        // en dessous, il ne reste pas au joueur le temps d'un geste : rien n'est envoyé
const VIE_ANNONCEE_MAX = 3600000;   // la page du coffre n'accepte pas une durée plus longue ; elle garde de toute façon cinq minutes au plus
const ATTENTE_FOURNITURE = 20000;   // le plus que peut prendre la fonction qui fournit le défi, ou le message à signer
const FORME_DEFI = /^[A-Za-z0-9_-]{16,128}$/;
const vieLisible = (vie) => vie === undefined || (Number.isSafeInteger(vie) && vie >= VIE_UTILE);
// La version de la page du coffre à partir de laquelle une identité peut se demander.
export const VERSION_IDENTITE = 7;
const FORME_REMISE = /^[A-Za-z0-9_-]{43}$/;
// Le contexte d'identité, tel que le serveur du jeu l'a préparé : sa forme exacte, ou rien.
function contexteIdentite(i) {
  if (!i || typeof i !== 'object' || Array.isArray(i)) return null;
  if (typeof i.client !== 'string' || !/^[a-z0-9]([a-z0-9-]{0,30}[a-z0-9])?$/.test(i.client) || typeof i.e !== 'string' || !FORME_REMISE.test(i.e)
    || typeof i.nonce !== 'string' || !/^[A-Za-z0-9_-]{22,128}$/.test(i.nonce) || (i.adresseRequise !== undefined && typeof i.adresseRequise !== 'boolean')) return null;
  return i.adresseRequise === true ? { client: i.client, e: i.e, nonce: i.nonce, adresse: true } : { client: i.client, e: i.e, nonce: i.nonce };
}

export function connexionCoffre({ coffre, defi, adresse, existant, wallet, identite, fenetre, delai, attenteDefi }) {
  const moi = fenetre || window;
  const origineCoffre = new URL(coffre).origin;
  const id = hasard();
  // Une identité est demandée : `true` (son contexte viendra avec le défi), ou le contexte lui-même.
  const avecIdentite = identite !== undefined && identite !== null && identite !== false;
  const contexteDonne = avecIdentite && identite !== true ? contexteIdentite(identite) : null;
  let fini = false, minuteur = null, veille = null, ecoute = null, w = null, propose = false, attente = null;
  let reussir, echouer;
  const resultat = new Promise((ok, non) => { reussir = ok; echouer = non; });
  const erreur = (nom) => Object.assign(new Error(nom), { name: nom });
  const finir = (fn, valeur) => {
    if (fini) return;
    fini = true;
    if (minuteur) clearTimeout(minuteur);
    if (attente) clearTimeout(attente);
    if (veille) clearInterval(veille);
    if (ecoute) moi.removeEventListener('message', ecoute);
    fn(valeur);
  };

  // Un contexte d'identité donné tout de suite doit avoir sa forme, et accompagner un défi donné lui aussi ; « vrai »
  // demande une fonction `defi` qui le rendra. Sinon aucune fenêtre n'est ouverte.
  if (avecIdentite && (identite === true ? typeof defi !== 'function' : !contexteDonne)) { finir(echouer, erreur('DemandeRefusee')); return { resultat, annuler() {} }; }

  // Un nom de fenêtre par tentative : deux clics, ou deux onglets du jeu, ne se disputent jamais la même fenêtre.
  w = moi.open(coffre, 'coffre-' + id, 'popup,width=440,height=720');
  if (!w) { finir(echouer, erreur('FenetreBloquee')); return { resultat, annuler() {} }; }
  const fermer = () => { try { w.close(); } catch (_) { /* déjà fermée */ } };

  // La tentative finit au plus tard à `fin` : le délai du jeu, ou la mort du défi si elle vient avant.
  let fin = Date.now() + (delai || 300000);
  // Ne plus attendre, c'est retirer sa demande : la fenêtre du coffre doit le savoir, pour ne plus rien envoyer
  // ni annoncer au joueur une connexion que plus personne n'écoute.
  const retirer = () => { try { w.postMessage({ type: 'jeu-annule', id }, origineCoffre); } catch (_) { /* fenêtre fermée */ } };
  const armer = () => { if (minuteur) clearTimeout(minuteur); minuteur = setTimeout(() => { retirer(); finir(echouer, erreur('DelaiDepasse')); }, Math.max(0, fin - Date.now())); };

  // Le défi : donné tout de suite (l'ancienne façon), ou fourni par une fonction appelée maintenant que la fenêtre
  // est ouverte. `mort` : l'instant où il meurt chez le serveur du jeu, quand le jeu l'a dit.
  let pret = null;     // la version annoncée par la page du coffre ; rien tant qu'elle ne s'est pas annoncée
  let tenu = typeof defi === 'function' ? null : { defi, mort: null, identite: contexteDonne };
  // La demande part quand la page est prête ET que le défi est là. La page se réannonce quand elle se recharge
  // (un aller-retour chez Google, par exemple) : la même demande lui est alors redonnée, avec ce qu'il reste à vivre.
  const envoyer = () => {
    if (fini || pret === null || !tenu) return;
    const demande = { type: 'jeu-connexion', id, defi: tenu.defi };
    // L'identité ne se demande qu'avec son contexte, et la page annoncée la comprend (vérifié à son annonce).
    if (avecIdentite) { if (!tenu.identite) return; demande.identite = tenu.identite; }
    if (adresse) demande.adresse = adresse;
    if (existant) demande.existant = true;
    // Le choix « wallet » ne se propose qu'à une page qui sait le rendre (version 3).
    if (wallet === true && pret >= 3) { demande.wallet = true; propose = true; }
    if (tenu.mort !== null) {
      const reste = tenu.mort - Date.now();
      if (reste < VIE_UTILE) return;   // trop près de sa fin : rien ne part, et le minuteur finit la tentative à sa mort
      // `vie` ne se dit qu'à une page qui le comprend (version 5) ; une plus ancienne garde ses cinq minutes.
      if (pret >= 5) demande.vie = Math.min(reste, VIE_ANNONCEE_MAX);
    }
    w.postMessage(demande, origineCoffre);
  };

  ecoute = (ev) => {
    // Seule la fenêtre que nous avons ouverte, et seulement depuis l'adresse du coffre.
    if (fini || ev.source !== w || ev.origin !== origineCoffre) return;
    const m = ev.data;
    if (!m || typeof m !== 'object') return;
    if (m.type === 'coffre-pret') {
      // « Sans création » ne se demande qu'à une page qui le comprend : une plus ancienne proposerait de créer.
      if (existant && !(m.v >= 2)) { fermer(); finir(echouer, erreur('CoffreTropAncien')); return; }
      // Une identité ne se demande qu'à une page qui sait la rendre : une plus ancienne répondrait par une simple
      // preuve du wallet, que ce mode n'accepte jamais.
      if (avecIdentite && !(m.v >= VERSION_IDENTITE)) { fermer(); finir(echouer, erreur('CoffreTropAncien')); return; }
      pret = typeof m.v === 'number' ? m.v : 0;
      envoyer();
    } else if (m.type === 'coffre-connexion' && m.id === id) {
      if (typeof m.adresse !== 'string' || typeof m.message !== 'string' || typeof m.signature !== 'string') return;
      if (avecIdentite) {
        // Une identité était attendue : la réponse doit porter son code de remise. Sinon la tentative échoue, net.
        if (typeof m.remise !== 'string' || !FORME_REMISE.test(m.remise)) { finir(echouer, erreur('IdentiteAbsente')); return; }
        finir(reussir, { adresse: m.adresse, message: m.message, signature: m.signature, remise: m.remise });
        return;
      }
      finir(reussir, { adresse: m.adresse, message: m.message, signature: m.signature });
    } else if (m.type === 'coffre-refus' && m.id === id) {
      finir(echouer, erreur(avecIdentite && m.raison === 'adresse-refusee' ? 'AdresseRefusee' : 'ConnexionRefusee'));
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
  armer();

  if (typeof defi === 'function') {
    // La fenêtre est ouverte : le défi peut maintenant se demander au serveur du jeu, sans risquer qu'elle soit bloquée.
    const indisponible = () => { fermer(); finir(echouer, erreur('DefiIndisponible')); };
    attente = setTimeout(indisponible, attenteDefi || ATTENTE_FOURNITURE);
    // La fonction n'est appelée qu'UNE fois par tentative : une page qui se réannonce reçoit le même défi, jamais un
    // second. `vie` se compte depuis cet appel, pas depuis la réponse : le temps du trajet est ainsi retiré d'office
    // (le défi a été tiré après l'appel, il meurt donc au plus tôt à `appel + vie`).
    const appel = Date.now();
    let promesse;
    try { promesse = Promise.resolve(defi()); } catch (e) { promesse = Promise.reject(e); }
    promesse.then((r) => {
      if (fini) return;
      clearTimeout(attente); attente = null;
      // Quoi que la fonction ait rendu, rien ne s'échappe d'ici : une réponse inattendue finit la tentative proprement.
      try {
        const d = typeof r === 'string' ? r : r && typeof r === 'object' ? r.defi : undefined;
        const vie = r && typeof r === 'object' ? r.vie : undefined;
        if (typeof d !== 'string' || !FORME_DEFI.test(d) || !vieLisible(vie)) { indisponible(); return; }
        // Le contexte d'identité vient avec le défi (ou a été donné tout de suite) ; attendu et absent, ou mal formé : rien ne part.
        const contexte = !avecIdentite ? null : contexteDonne || contexteIdentite(r && typeof r === 'object' ? r.identite : null);
        if (avecIdentite && !contexte) { indisponible(); return; }
        tenu = { defi: d, mort: vie === undefined ? null : appel + vie, identite: contexte };
        if (tenu.mort !== null && tenu.mort < fin) { fin = tenu.mort; armer(); }   // un défi mort ne connectera personne : inutile d'attendre plus
        envoyer();
      } catch (_) { indisponible(); }
    }, () => { if (!fini) indisponible(); });
  }

  return {
    resultat,
    annuler() { retirer(); finir(echouer, erreur('Annule')); },
  };
}

// ---------- Faire confirmer une opération par le joueur, dans la fenêtre du coffre. Aucune dépendance.
//
//   import { operationCoffre } from './coffre-jeu.mjs';
//   bouton.addEventListener('click', async () => {
//     let octets;
//     const construire = async () => { octets = await demanderLaTransactionAuServeurDuJeu(); return octets; };
//     const { adresse, signature } = await operationCoffre({ coffre: 'https://…/', message: construire, adresse: walletDuJoueur }).resultat;
//     // vérifier la signature sur SES PROPRES octets (Ed25519, clé publique = l'adresse), puis diffuser soi-même
//   });
//
//   coffre     l'adresse de la page du coffre
//   message    les octets du message de transaction à signer (un Uint8Array, 1 232 octets au plus) : le message,
//              pas la transaction (sans les signatures). C'est le jeu, ou son serveur, qui le construit.
//              LA FAÇON RECOMMANDÉE : une fonction, appelée une seule fois, quand la fenêtre du coffre est prête, qui
//              rend (ou promet) les octets, ou { message, vie }. Une transaction ne vit qu'environ une minute sur le
//              réseau : la construire à ce moment-là laisse au joueur le plus de temps pour confirmer. `vie` : ce
//              qu'il lui reste à vivre, en millisecondes ; la fenêtre en est prévenue et n'en fait pas confirmer une
//              morte. Si la fonction échoue ou tarde plus de vingt secondes : la fenêtre est refermée et `resultat`
//              échoue avec MessageIndisponible ; si elle rend autre chose que des octets : DemandeRefusee.
//   adresse    le wallet du joueur, celui que le jeu a lié à son compte : la fenêtre refuse si le coffre de
//              l'appareil n'est pas celui-là.
//
//   UNE OPÉRATION NOMMÉE DU JEU (une instruction de son propre programme), à la place de `message` :
//   operation    le nom de l'opération, tel qu'il est écrit dans la fiche du jeu tenue par le service ;
//   version      la version de cette opération pour laquelle le jeu a construit sa transaction (un entier) ;
//   transaction  la transaction PARTIELLEMENT SIGNÉE, entière (un Uint8Array : les signatures, puis le message), déjà
//                signée par les clés du jeu, la case du joueur laissée vide (64 zéros). Ou une fonction qui la rend
//                (ou { transaction, vie }), appelée quand la fenêtre est prête, comme pour `message`.
//                La fenêtre vérifie elle-même les signatures du jeu sur le message, exige la forme déclarée dans la
//                fiche, et ne rend que la signature du joueur, sur le message inchangé : au jeu de la poser dans sa
//                case. Un jeu qui a une fiche ne peut plus demander un envoi ordinaire (`message`), sauf si sa fiche
//                le lui permet. Une page du coffre trop ancienne pour cela : CoffreTropAncien.
//
// À appeler dans le geste du joueur, comme `connexionCoffre`. La fenêtre lit elle-même les octets, montre au joueur
// ce qui sortirait de son wallet, et ne signe que ce qu'elle comprend en entier : aujourd'hui, un envoi de SOL fait
// par le joueur, à l'ancien format ou en version 0 sans table d'adresses (le reste est refusé : OperationIllisible).
// Le jeu ne reçoit qu'une adresse et une signature de 64 octets (en base64url). La fenêtre ne diffuse rien et ne
// dit pas que la transaction a réussi : c'est le jeu qui vérifie la signature sur ses propres octets, qui cosigne
// s'il paie les frais, et qui diffuse. Une demande d'opération ne rend jamais une preuve de connexion.
// Une page du coffre trop ancienne pour cette demande ne la reçoit pas : CoffreTropAncien.
//
// Les erreurs de `resultat`, une liste fermée :
export const ERREURS_OPERATION = Object.freeze([
  'DemandeRefusee',       // `message` ou `adresse` n'ont pas la forme attendue : aucune fenêtre n'est ouverte (ou, si le
                          // message vient d'une fonction qui rend autre chose que des octets : la fenêtre est refermée)
  'MessageIndisponible',  // la fonction qui fournit le message a échoué, ou a trop tardé : la fenêtre est refermée
  'FenetreBloquee',       // le navigateur a bloqué la fenêtre
  'CoffreTropAncien',     // la page du coffre ne sait pas encore faire confirmer cette demande (un envoi : version 4 ;
                          // une opération nommée : version 6)
  'OperationRefusee',     // le joueur a touché « Refuser »
  'OperationIllisible',   // la fenêtre ne comprend pas ce message en entier, ou ne le signe pas encore ; pour une
                          // opération nommée : elle ne correspond pas à la fiche du jeu, ou une signature du jeu est fausse
  'AutreWallet',          // le coffre de l'appareil n'est pas le wallet attendu
  'PasDeCoffre',          // aucun coffre sur cet appareil
  'CoffreNonGarde',       // le coffre de l'appareil n'est pas encore confié au serveur
  'OperationExpiree',     // la demande a dépassé cinq minutes dans la fenêtre
  'OperationEchouee',     // la signature n'a pas pu se faire (geste impossible, panne)
  'ReponseRefusee',       // la fenêtre a rendu autre chose qu'une signature de la forme attendue pour ce wallet
  'FenetreFermee', 'DelaiDepasse', 'Annule',
]);
const RAISONS = { refusee: 'OperationRefusee', illisible: 'OperationIllisible', 'autre-wallet': 'AutreWallet', 'pas-de-coffre': 'PasDeCoffre',
  'non-garde': 'CoffreNonGarde', expiree: 'OperationExpiree' };
const b64uDe = (octets) => { let t = ''; for (const x of octets) t += String.fromCharCode(x); return btoa(t).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); };

export function operationCoffre({ coffre, message, transaction, operation, version, adresse, fenetre, delai, attenteMessage }) {
  const moi = fenetre || window;
  const erreur = (nom) => Object.assign(new Error(nom), { name: nom });
  let fini = false, minuteur = null, veille = null, ecoute = null, w = null, attente = null;
  let reussir, echouer;
  const resultat = new Promise((ok, non) => { reussir = ok; echouer = non; });
  const finir = (fn, valeur) => {
    if (fini) return;
    fini = true;
    if (minuteur) clearTimeout(minuteur);
    if (attente) clearTimeout(attente);
    if (veille) clearInterval(veille);
    if (ecoute) moi.removeEventListener('message', ecoute);
    fn(valeur);
  };
  const octetsValables = (o) => o instanceof Uint8Array && o.length >= 1 && o.length <= 1232;
  // Deux façons de demander, qui ne se mélangent pas : un envoi ordinaire (`message`), ou une opération nommée du
  // jeu (`operation`, `version` et `transaction`).
  const nommee = operation !== undefined || version !== undefined || transaction !== undefined;
  const source = nommee ? transaction : message;
  // La demande est contrôlée avant d'ouvrir quoi que ce soit ; les octets sont copiés : ce qui part est figé ici.
  // Quand ils sont fournis par une fonction, ils seront contrôlés de la même façon à leur arrivée.
  const parFonction = typeof source === 'function';
  const formeNommee = !nommee ? message !== undefined : (message === undefined && typeof operation === 'string' && /^[a-z0-9]([a-z0-9-]{0,38}[a-z0-9])?$/.test(operation) && Number.isSafeInteger(version) && version >= 1 && version <= 999999);
  if (!formeNommee || (!parFonction && !octetsValables(source)) || typeof adresse !== 'string' || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(adresse)) {
    finir(echouer, erreur('DemandeRefusee'));
    return { resultat, annuler() {} };
  }
  // Les octets : donnés tout de suite, ou fournis par une fonction appelée quand la fenêtre est prête. `mort` :
  // l'instant où la transaction ne vaudra plus rien sur le réseau, quand le jeu l'a dit.
  let tenu = parFonction ? null : { texte: b64uDe(Uint8Array.from(source)), mort: null };
  let demandee = false;   // la fonction n'est appelée qu'une fois, même si la page se réannonce
  const origineCoffre = new URL(coffre).origin;
  const id = hasard();

  w = moi.open(coffre, 'coffre-' + id, 'popup,width=440,height=720');
  if (!w) { finir(echouer, erreur('FenetreBloquee')); return { resultat, annuler() {} }; }
  const fermer = () => { try { w.close(); } catch (_) { /* déjà fermée */ } };

  let fin = Date.now() + (delai || 300000);
  const retirer = () => { try { w.postMessage({ type: 'jeu-annule', id }, origineCoffre); } catch (_) { /* fenêtre fermée */ } };
  const armer = () => { if (minuteur) clearTimeout(minuteur); minuteur = setTimeout(() => { retirer(); finir(echouer, erreur('DelaiDepasse')); }, Math.max(0, fin - Date.now())); };

  let pret = null;   // la version annoncée par la page du coffre
  const envoyer = () => {
    if (fini || pret === null || !tenu) return;
    const demande = nommee ? { type: 'jeu-operation', v: 2, id, transaction: tenu.texte, adresse, operation, version } : { type: 'jeu-operation', v: 1, id, message: tenu.texte, adresse };
    if (tenu.mort !== null) {
      const reste = tenu.mort - Date.now();
      if (reste < VIE_UTILE) return;   // trop près de sa fin : rien ne part, et le minuteur finit la demande à sa mort
      if (pret >= 5) demande.vie = Math.min(reste, VIE_ANNONCEE_MAX);
    }
    w.postMessage(demande, origineCoffre);
  };
  // La fenêtre est prête : c'est le moment de construire la transaction, pour que son hachage récent soit le plus
  // jeune possible quand le joueur la confirmera.
  const fournir = () => {
    if (demandee) return;
    demandee = true;
    const indisponible = () => { fermer(); finir(echouer, erreur('MessageIndisponible')); };
    attente = setTimeout(indisponible, attenteMessage || ATTENTE_FOURNITURE);
    const appel = Date.now();   // `vie` se compte depuis l'appel : le temps du trajet est retiré d'office
    let promesse;
    try { promesse = Promise.resolve(source()); } catch (e) { promesse = Promise.reject(e); }
    promesse.then((r) => {
      if (fini) return;
      clearTimeout(attente); attente = null;
      // Quoi que la fonction ait rendu, rien ne s'échappe d'ici : une réponse inattendue finit la demande proprement.
      try {
        const o = r instanceof Uint8Array ? r : r && typeof r === 'object' ? (nommee ? r.transaction : r.message) : undefined;
        const vie = r && typeof r === 'object' && !(r instanceof Uint8Array) ? r.vie : undefined;
        // Autre chose que des octets de la bonne taille : la même erreur que pour des octets donnés tout de suite.
        if (!octetsValables(o) || !vieLisible(vie)) { fermer(); finir(echouer, erreur('DemandeRefusee')); return; }
        tenu = { texte: b64uDe(Uint8Array.from(o)), mort: vie === undefined ? null : appel + vie };
        if (tenu.mort !== null && tenu.mort < fin) { fin = tenu.mort; armer(); }
        envoyer();
      } catch (_) { indisponible(); }
    }, () => { if (!fini) indisponible(); });
  };

  ecoute = (ev) => {
    // Seule la fenêtre que nous avons ouverte, et seulement depuis l'adresse du coffre.
    if (fini || ev.source !== w || ev.origin !== origineCoffre) return;
    const m = ev.data;
    if (!m || typeof m !== 'object') return;
    if (m.type === 'coffre-pret') {
      // Une page plus ancienne ne connaît pas cette demande (version 4 pour un envoi, 6 pour une opération nommée) :
      // elle ne la reçoit pas, et rien n'est construit pour elle.
      if (!(m.v >= (nommee ? 6 : 4))) { fermer(); finir(echouer, erreur('CoffreTropAncien')); return; }
      pret = m.v;
      if (parFonction && !tenu) fournir(); else envoyer();
    } else if (m.type === 'coffre-operation' && m.id === id) {
      // La forme exacte : cinq champs, le wallet demandé, une signature de 64 octets. Rien d'autre n'est une réussite.
      if (Object.keys(m).length !== 5 || m.v !== 1 || m.adresse !== adresse || typeof m.signature !== 'string' || !/^[A-Za-z0-9_-]{86}$/.test(m.signature)) { finir(echouer, erreur('ReponseRefusee')); return; }
      finir(reussir, { adresse: m.adresse, signature: m.signature });
    } else if (m.type === 'coffre-operation-refus' && m.id === id) {
      finir(echouer, erreur(Object.prototype.hasOwnProperty.call(RAISONS, m.raison) ? RAISONS[m.raison] : 'OperationEchouee'));
    }
    // Une preuve de connexion, un refus de connexion ou un choix de méthode ne répondent jamais à une opération :
    // ces messages ne sont pas écoutés ici.
  };
  moi.addEventListener('message', ecoute);
  veille = setInterval(() => { if (w.closed) { clearInterval(veille); veille = null; setTimeout(() => finir(echouer, erreur('FenetreFermee')), 400); } }, 500);
  armer();

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

// ---------- Sur un téléphone : « Ouvrir dans mon wallet ». Aucune dépendance.
//
// Dans le navigateur ordinaire d'un téléphone, aucun wallet ne s'annonce à la page : `walletsPresents().liste()` est
// vide. Le joueur, lui, a son wallet dans une application, qui a son propre navigateur. Trois éditeurs documentent un
// lien qui ouvre une page web dans ce navigateur-là : la page du jeu y retrouve le wallet, et « Connecter mon wallet »
// marche comme sur un ordinateur.
//
//   import { walletsPresents, liensWallets } from './coffre-jeu.mjs';
//   if (!presents.liste().length) {
//     for (const { nom, lien } of liensWallets({ adresse: location.href })) {
//       const a = document.createElement('a'); a.href = lien; a.textContent = 'Ouvrir dans ' + nom; ...
//     }
//   }
//
// LES SEULES FORMES ÉCRITES ICI sont celles lues dans la documentation de l'éditeur (relevé du 17/11/2026) :
//   Phantom    https://phantom.com/ul/browse/<adresse encodée>?ref=<origine encodée>
//              (docs.phantom.com/phantom-deeplinks/other-methods/browse)
//   Solflare   https://solflare.com/ul/v1/browse/<adresse encodée>?ref=<origine encodée>
//              (docs.solflare.com/solflare/technical/deeplinks/other-methods/browse)
//   Backpack   https://backpack.app/ul/v1/browse/<adresse encodée>?ref=<origine encodée>
//              (docs.backpack.app/deeplinks/other-methods/browse)
// Une liste fermée et figée : ne pas y ajouter un wallet sur la foi d'un forum ou d'une page archivée. Pour tout
// autre wallet, le jeu écrit seulement une phrase : ouvrir cette page dans le navigateur de l'application du wallet.
//
// Règles :
//   - CES LIENS NE MARCHENT QUE TOUCHÉS PAR LE JOUEUR. Les mettre dans de vrais liens (<a href>) que le joueur
//     touche lui-même. Jamais une navigation lancée par le script (`location = …`, `window.open`) : le téléphone
//     ouvrirait alors le site de l'éditeur, pas son application. Les trois éditeurs l'écrivent ;
//   - LE LIEN NE TRANSPORTE QUE L'ORIGINE ET LE CHEMIN DE LA PAGE. Les paramètres (`?…`) et le fragment (`#…`) de
//     l'adresse donnée sont retirés, ainsi qu'un nom ou un mot de passe écrits dans l'adresse : un lien passe par
//     l'éditeur du wallet et par le téléphone, et rien de secret ni de personnel ne doit y voyager (ni jeton, ni
//     identifiant de tentative, ni code). Ils sont retirés plutôt que refusés : le jeu donne en général
//     `location.href`, qui peut en porter sans que le studio y pense, et un refus priverait le joueur du lien. Une page
//     qui ne s'affiche pas sans ses paramètres doit donc donner ici une adresse qui s'en passe ;
//   - l'adresse doit être une page en https. Sinon (http, autre schéma, adresse illisible ou trop longue) : une liste
//     vide. Le jeu montre alors seulement sa phrase ;
//   - dans le navigateur du wallet, la page repart de zéro : nouvelle session, rien de ce que le joueur avait
//     commencé ne suit. C'est voulu.
// Mesuré le 17/11/2026 sur un iPhone : le lien de Phantom, touché, ouvre l'application sur la page ; Phantom et SafePal
// signent la connexion dans leur navigateur intégré. Pas mesuré : Android, les liens de Solflare et de Backpack, un
// lien touché depuis une page web (celui de Phantom l'a été depuis une note).
//
// Rend une liste figée [{ nom, lien }], dans cet ordre : Phantom, Solflare, Backpack. Ou une liste vide.
const OUVRIR_DANS = Object.freeze([
  Object.freeze({ nom: 'Phantom', debut: 'https://phantom.com/ul/browse/' }),
  Object.freeze({ nom: 'Solflare', debut: 'https://solflare.com/ul/v1/browse/' }),
  Object.freeze({ nom: 'Backpack', debut: 'https://backpack.app/ul/v1/browse/' }),
]);
const PAGE_MAX = 1000;   // caractères : au-delà, ce n'est pas l'adresse d'une page de jeu
export function liensWallets({ adresse } = {}) {
  const aucun = Object.freeze([]);
  if (typeof adresse !== 'string' || !adresse || adresse.length > PAGE_MAX) return aucun;
  let u;
  try { u = new URL(adresse); } catch (_) { return aucun; }
  if (u.protocol !== 'https:' || !u.hostname) return aucun;
  // Seulement l'origine et le chemin : ni paramètres, ni fragment, ni nom, ni mot de passe.
  const page = u.origin + u.pathname;
  if (page.length > PAGE_MAX) return aucun;
  const cible = encodeURIComponent(page), ref = encodeURIComponent(u.origin);
  return Object.freeze(OUVRIR_DANS.map(({ nom, debut }) => Object.freeze({ nom, lien: debut + cible + '?ref=' + ref })));
}
