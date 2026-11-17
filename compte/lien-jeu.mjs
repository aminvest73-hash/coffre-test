// Le côté « coffre » du lien avec un jeu. Notre page a été ouverte par un jeu, dans sa propre fenêtre ; le jeu lui
// demande de connecter le joueur. Ce fichier ne fait que l'échange de messages : il ne signe rien et n'ouvre rien.
//
// Règles :
//   - seuls les jeux enregistrés (`jeux` : origine -> nom) sont écoutés, et seulement la fenêtre qui nous a ouverts ;
//   - une seule demande par fenêtre ; une demande retirée par le jeu ne reçoit plus de réponse ;
//   - le jeu peut dire que le joueur a déjà son coffre : le wallet lié à son compte (`adresse`), ou seulement
//     « il en a un » (`existant`). Dans les deux cas la page ne propose pas d'en créer un ;
//   - une demande ne vit que cinq minutes, même si le jeu oublie de la retirer : après, rien ne part et le jeu
//     reçoit un refus ;
//   - le jeu peut dire combien de temps vit encore ce qu'il attend (`vie`, en millisecondes : son défi pour une
//     connexion, sa transaction pour une opération). La demande vit alors la plus courte des deux durées : cinq
//     minutes, ou `vie` moins une marge (le temps que la réponse arrive chez le jeu et soit jugée). Sans cela, la
//     fenêtre pouvait faire confirmer le joueur pour un défi déjà mort chez le jeu (essai du 17/11/2026). Une `vie`
//     mal formée fait ignorer la demande, comme toute demande mal formée ; sans `vie`, rien ne change ;
//   - la réponse n'est envoyée qu'à l'origine qui a fait la demande, jamais à « tout le monde » ;
//   - le jeu peut proposer une autre méthode, « wallet » : le joueur qui a déjà un wallet Solana le dit ici, et la
//     page rend la main au jeu (`choisir`). Ce message-là ne porte aucun pouvoir : la méthode, une version et
//     l'identifiant de la demande, rien d'autre (ni adresse, ni texte à signer, ni lien). Il ne part que si CE jeu
//     l'a proposé dans sa demande encore vivante, une seule fois, et il termine la demande : plus aucune preuve du
//     coffre ne partira pour elle. C'est le jeu qui appellera le wallet, sur sa propre page, après un geste du joueur.
//   - le jeu peut demander une IDENTITÉ avec la connexion (`identite` : { client, e, nonce } et, s'il exige une
//     adresse e-mail prouvée, `adresse: true`). Ce sont les valeurs de la tentative de son serveur : son identifiant
//     chez nous, le défi S256 de son vérifieur, son `nonce`. La page les fait engager par la clé du wallet (preuve de
//     connexion version 2), demande la remise au service, et ne répond alors JAMAIS sans le code de remise ; dans
//     l'autre sens, une demande sans identité ne reçoit jamais de code. Ce fichier ne juge pas ces valeurs au-delà
//     de leur forme : c'est le service qui dit si ce jeu est enregistré et si cette origine est la sienne ;
//   - une fenêtre traite UNE demande, d'un seul genre : une connexion (`jeu-connexion`) ou une opération à signer
//     (`jeu-operation`). Une opération se demande de deux façons : en version 1, les octets d'un message de
//     transaction et le wallet attendu (un envoi ordinaire, que la page lit en entier) ; en version 2, une opération
//     NOMMÉE du jeu : son nom, la version pour laquelle le jeu l'a construite, et la transaction partiellement
//     signée (les signatures du studio, puis le message), que la page juge avec la fiche de ce jeu. Les deux genres ne se
//     mélangent jamais : une demande d'opération ne reçoit ni preuve de connexion ni choix de méthode, une demande
//     de connexion ne reçoit jamais de signature d'opération. Leurs réponses n'ont ni le même type ni les mêmes
//     champs (`coffre-connexion` et `coffre-refus` d'un côté, `coffre-operation` et `coffre-operation-refus` de
//     l'autre). Ce fichier ne lit pas les octets : c'est la page qui les lit, les montre, et fait signer.
//
//   fenetre : notre fenêtre (addEventListener)   ouvreur : la fenêtre du jeu (postMessage)

const ID = /^[A-Za-z0-9_-]{8,64}$/;
const DEFI = /^[A-Za-z0-9_-]{16,128}$/;
const ADRESSE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
// Le contexte d'identité d'une demande : les mêmes formes que dans la preuve de connexion version 2 (contrat.mjs).
const CLIENT = /^[a-z0-9]([a-z0-9-]{0,30}[a-z0-9])?$/;
const NONCE = /^[A-Za-z0-9_-]{22,128}$/;
const FORME_43 = /^[A-Za-z0-9_-]{43}$/;
// Rend { client, e, nonce, adresseRequise }, ou null si ce n'est pas exactement la forme attendue.
function lireIdentite(i) {
  if (!i || typeof i !== 'object' || Array.isArray(i)) return null;
  const cles = Object.keys(i).sort().join();
  if (cles !== 'client,e,nonce' && cles !== 'adresse,client,e,nonce') return null;
  if (i.adresse !== undefined && i.adresse !== true) return null;
  if (typeof i.client !== 'string' || !CLIENT.test(i.client) || typeof i.e !== 'string' || !FORME_43.test(i.e) || typeof i.nonce !== 'string' || !NONCE.test(i.nonce)) return null;
  return { client: i.client, e: i.e, nonce: i.nonce, adresseRequise: i.adresse === true };
}
// Les octets d'un message à signer, en base64url : au plus la taille d'une transaction entière (1 232 octets).
const MESSAGE = /^[A-Za-z0-9_-]{1,1643}$/;
// Le nom d'une opération d'un jeu, et sa version : les mêmes formes que dans la fiche (operation.mjs).
const NOM_OPERATION = /^[a-z0-9]([a-z0-9-]{0,38}[a-z0-9])?$/;
const versionValable = (n) => Number.isSafeInteger(n) && n >= 1 && n <= 999999;
// Ce que la page peut répondre à une demande d'opération qu'elle ne signe pas. Une liste fermée ; tout autre mot
// part comme « echec ».
export const RAISONS_OPERATION = Object.freeze(['refusee', 'illisible', 'autre-wallet', 'pas-de-coffre', 'non-garde', 'expiree', 'echec']);

export const DUREE_DEMANDE = 300000;   // millisecondes : la durée de la preuve de connexion elle-même
// `vie` : ce qu'il reste à vivre, chez le jeu, à ce qu'il attend (millisecondes, un entier). En dessous de VIE_MIN la
// demande ne laisserait pas au joueur le temps d'un geste ; au-dessus de VIE_MAX ce n'est pas une durée sérieuse.
export const VIE_MIN = 20000, VIE_MAX = 3600000;
// La marge retirée à `vie` : la réponse doit encore arriver à la page du jeu, partir à son serveur et y être jugée
// avant la fin.
export const MARGE_VIE = 15000;
const vieValable = (v) => Number.isSafeInteger(v) && v >= VIE_MIN && v <= VIE_MAX;

export function lienJeu({ fenetre, ouvreur, jeux, surDemande, surOperation, surRetrait, surAccuse, noter, duree, horloge }) {
  const dire = noter || (() => {});
  const limite = duree || DUREE_DEMANDE, maintenant = horloge || (() => Date.now());
  let demande = null, repondu = false, choisie = false, accuse = false;
  const origines = Object.keys(jeux || {});
  // La demande a dépassé sa durée : elle est retirée d'ici, et le jeu est prévenu qu'il ne recevra rien.
  function expirer() {
    if (!demande || demande.retiree || repondu) return;
    demande.retiree = true; demande.expiree = true;
    try {
      ouvreur.postMessage(demande.genre === 'operation' ? { type: 'coffre-operation-refus', v: 1, id: demande.id, raison: 'expiree' }
        : { type: 'coffre-refus', id: demande.id, raison: 'expiree' }, demande.jeu);
    } catch (_) { /* fenêtre fermée */ }
    dire('[jeu] demande expiree');
    if (surRetrait) surRetrait(demande);
  }
  const depassee = () => !!demande && maintenant() - demande.recue >= demande.limite;
  // La durée de cette demande-là : celle de la fenêtre, ou moins si le jeu annonce que ce qu'il attend meurt avant.
  const limiteDe = (vie) => (vie === undefined ? limite : Math.min(limite, vie - MARGE_VIE));

  fenetre.addEventListener('message', (ev) => {
    if (ev.source !== ouvreur || !Object.prototype.hasOwnProperty.call(jeux, ev.origin)) return;
    const m = ev.data;
    if (!m || typeof m !== 'object') return;
    if (m.type === 'jeu-connexion') {
      if (demande) return;   // une seule demande par fenêtre
      if (typeof m.id !== 'string' || !ID.test(m.id) || typeof m.defi !== 'string' || !DEFI.test(m.defi)) return;
      if (m.adresse !== undefined && (typeof m.adresse !== 'string' || !ADRESSE.test(m.adresse))) return;
      if (m.existant !== undefined && m.existant !== true) return;
      if (m.wallet !== undefined && m.wallet !== true) return;
      if (m.vie !== undefined && !vieValable(m.vie)) return;
      const identite = m.identite === undefined ? null : lireIdentite(m.identite);
      if (m.identite !== undefined && !identite) return;   // un contexte d'identité mal formé : la demande entière est ignorée
      demande = { genre: 'connexion', jeu: ev.origin, nom: String(jeux[ev.origin]), id: m.id, defi: m.defi, attendue: m.adresse || null, existant: m.existant === true, wallet: m.wallet === true, identite, retiree: false, expiree: false, recue: maintenant(), limite: limiteDe(m.vie) };
      setTimeout(expirer, demande.limite);
      dire('[jeu] demande de connexion de ' + ev.origin);
      if (surDemande) surDemande(demande);
    } else if (m.type === 'jeu-operation') {
      if (demande) return;   // une seule demande par fenêtre, d'un seul genre
      // La forme exacte, rien de plus. Le wallet attendu est obligatoire.
      //   version 1 : cinq champs (type, v, id, message, adresse), ou six avec `vie` ;
      //   version 2 : sept champs (type, v, id, transaction, adresse, operation, version), ou huit avec `vie`.
      const champs = Object.keys(m).length - (m.vie === undefined ? 0 : 1);
      if (typeof m.id !== 'string' || !ID.test(m.id) || typeof m.adresse !== 'string' || !ADRESSE.test(m.adresse)) return;
      if (m.vie !== undefined && !vieValable(m.vie)) return;
      let demandee;
      if (m.v === 1) {
        if (champs !== 5 || typeof m.message !== 'string' || !MESSAGE.test(m.message)) return;
        demandee = { message: m.message, transaction: null, operation: null, version: null };
      } else if (m.v === 2) {
        if (champs !== 7 || typeof m.transaction !== 'string' || !MESSAGE.test(m.transaction) || typeof m.operation !== 'string' || !NOM_OPERATION.test(m.operation) || !versionValable(m.version)) return;
        demandee = { message: null, transaction: m.transaction, operation: m.operation, version: m.version };
      } else return;
      demande = Object.assign({ genre: 'operation', jeu: ev.origin, nom: String(jeux[ev.origin]), id: m.id, attendue: m.adresse, retiree: false, expiree: false, recue: maintenant(), limite: limiteDe(m.vie) }, demandee);
      setTimeout(expirer, demande.limite);
      dire('[jeu] demande d\'operation de ' + ev.origin);
      if (surOperation) surOperation(demande);
    } else if (m.type === 'jeu-annule' && demande && m.id === demande.id && ev.origin === demande.jeu && !repondu) {
      demande.retiree = true;
      dire('[jeu] demande retiree par le jeu');
      if (surRetrait) surRetrait(demande);
    } else if (m.type === 'jeu-methode-recue' && demande && demande.genre === 'connexion' && choisie && !accuse && m.id === demande.id && ev.origin === demande.jeu) {
      // Le jeu a bien reçu le choix : la fenêtre peut se fermer. Sans cet accusé, la page le dit au joueur.
      accuse = true;
      dire('[jeu] choix recu par le jeu');
      if (surAccuse) surAccuse(demande);
    }
  });

  // Dire au jeu que la fenêtre est prête. Chaque envoi vise une origine enregistrée : un autre site ne reçoit rien.
  // v : 2 depuis que la page comprend `existant`, 3 depuis qu'elle sait rendre le choix « wallet », 4 depuis
  // qu'elle sait faire confirmer une opération (`jeu-operation`), 5 depuis qu'elle comprend `vie`, 6 depuis qu'elle
  // sait juger une opération nommée d'un jeu (`jeu-operation` en version 2).
  function annoncer() { for (const o of origines) { try { ouvreur.postMessage({ type: 'coffre-pret', v: 6 }, o); } catch (_) { /* fenêtre fermée */ } } }

  return {
    annoncer,
    // La demande de connexion de cette fenêtre, s'il y en a une ; une demande d'opération n'apparaît jamais ici.
    demande: () => (demande && demande.genre === 'connexion' ? demande : null),
    // La demande d'opération de cette fenêtre, s'il y en a une.
    operation: () => (demande && demande.genre === 'operation' ? demande : null),
    // Relire l'heure : un minuteur peut dormir dans une fenêtre en arrière-plan. La page l'appelle AVANT de demander
    // un geste au joueur : une demande qui a dépassé sa durée expire ici (le jeu reçoit son refus, la carte le dit),
    // et le joueur n'est pas dérangé pour rien. Rend vrai si la demande est encore vivante.
    relire() { if (depassee()) expirer(); return !!demande && !demande.retiree && !repondu; },
    // Envoyer la preuve. Refuse si la demande a été retirée ou a déjà reçu sa réponse : à revérifier ici, au dernier moment.
    // Une demande d'identité ne reçoit de réponse qu'avec le code de remise (`remise`) ; une demande sans identité
    // n'en reçoit jamais : dans les deux cas contraires, rien ne part et la demande reste entière.
    repondre({ adresse, message, signature, remise }) {
      if (depassee()) expirer();   // un minuteur peut dormir dans une fenêtre en arrière-plan : l'heure est relue ici
      if (!demande || demande.genre !== 'connexion' || demande.retiree || repondu) return false;
      if (demande.identite ? !(typeof remise === 'string' && FORME_43.test(remise)) : remise !== undefined) return false;
      repondu = true;
      ouvreur.postMessage(demande.identite ? { type: 'coffre-connexion', id: demande.id, adresse, message, signature, remise } : { type: 'coffre-connexion', id: demande.id, adresse, message, signature }, demande.jeu);
      dire('[jeu] preuve de connexion envoyee a ' + demande.jeu);
      return true;
    },
    // Dire au jeu que le joueur a renoncé, ou que la connexion n'a pas pu se faire. Aucune preuve n'est envoyée.
    renoncer(raison) {
      if (depassee()) expirer();
      if (!demande || demande.genre !== 'connexion' || demande.retiree || repondu) return false;
      repondu = true;
      ouvreur.postMessage({ type: 'coffre-refus', id: demande.id, raison: String(raison || 'renonce').slice(0, 40) }, demande.jeu);
      return true;
    },
    // Le joueur choisit d'entrer avec un wallet qu'il a déjà. Rien n'est signé ni appelé ici : le jeu reçoit ce seul
    // choix, pour la demande vivante, une fois. La demande est alors terminée pour le coffre.
    choisir(methode) {
      if (depassee()) expirer();
      if (methode !== 'wallet' || !demande || demande.genre !== 'connexion' || !demande.wallet || demande.retiree || repondu) return false;
      repondu = true; choisie = true;
      try { ouvreur.postMessage({ type: 'coffre-methode', v: 1, id: demande.id, methode: 'wallet' }, demande.jeu); } catch (_) { /* fenêtre du jeu fermée : pas d'accusé, la page le dira */ }
      dire('[jeu] choix de methode envoye a ' + demande.jeu + ' : wallet');
      return true;
    },
    accuse: () => accuse,
    // Rendre au jeu la signature de l'opération qu'il a demandée : l'adresse du wallet et la signature (base64url),
    // rien d'autre. Seulement pour une demande d'opération vivante, une seule fois, à l'origine qui a demandé.
    rendre({ adresse, signature }) {
      if (depassee()) expirer();
      if (!demande || demande.genre !== 'operation' || demande.retiree || repondu) return false;
      if (typeof adresse !== 'string' || adresse !== demande.attendue || typeof signature !== 'string' || !/^[A-Za-z0-9_-]{86}$/.test(signature)) return false;
      repondu = true;
      ouvreur.postMessage({ type: 'coffre-operation', v: 1, id: demande.id, adresse, signature }, demande.jeu);
      dire('[jeu] signature de l\'operation envoyee a ' + demande.jeu);
      return true;
    },
    // Dire au jeu que l'opération n'est pas signée, et pourquoi (un mot de RAISONS_OPERATION). Aucune signature ne part.
    refuserOperation(raison) {
      if (depassee()) expirer();
      if (!demande || demande.genre !== 'operation' || demande.retiree || repondu) return false;
      repondu = true;
      try { ouvreur.postMessage({ type: 'coffre-operation-refus', v: 1, id: demande.id, raison: RAISONS_OPERATION.includes(raison) ? raison : 'echec' }, demande.jeu); } catch (_) { /* fenêtre du jeu fermée */ }
      dire('[jeu] operation refusee : ' + (RAISONS_OPERATION.includes(raison) ? raison : 'echec'));
      return true;
    },
  };
}
