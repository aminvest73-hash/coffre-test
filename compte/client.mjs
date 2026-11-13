// Ce que fait la page, sans l'écran : créer un coffre et le confier au serveur, se connecter, et n'accepter
// ce que rend le serveur qu'après l'avoir réellement ouvert. Il ne dépend ni de l'écran ni du navigateur :
// on lui fournit l'accès au serveur, à l'appareil (les passkeys) et au stockage local.
//
//   api(chemin, objet)   -> la réponse du serveur, ou lève un refus
//   appareil.creer / appareil.demander   -> comme navigator.credentials.create / get, avec leur partie publicKey
//   stock.lire() / inscrire(fiche) / remplacer(ancienne, fiche) / effacer(ancienne)
//   reglages : { origine, rpId, environnement, projet, langue }   -> ce que la page sait d'elle-même
//              (et `horloge`, pour les essais seulement : l'heure de l'appareil, en secondes)
//
// Règle : tout ce que rend le serveur est un candidat. La copie de l'appareil n'est remplacée qu'après les
// contrôles, l'ouverture réelle et la preuve locale.

import * as K from './contrat.mjs';
import * as N from './noyau.mjs';

const te = new TextEncoder();
const refuser = (nom, detail) => { throw new K.Refus(nom, detail); };
const octets = (x) => new Uint8Array(x);
const ALGORITHMES = { [-7]: 'ES256', [-257]: 'RS256' };

// Ce qui part au serveur d'une réponse de passkey. Les résultats d'extension n'y sont jamais :
// c'est là que se trouve la sortie qui ouvre le coffre.
const pourCreation = (c) => {
  const id = K.b64u(octets(c.rawId));
  return { id, rawId: id, type: 'public-key', response: { clientDataJSON: K.b64u(octets(c.response.clientDataJSON)), attestationObject: K.b64u(octets(c.response.attestationObject)) } };
};
const pourConnexion = (a) => {
  const id = K.b64u(octets(a.rawId));
  return { id, rawId: id, type: 'public-key', response: { clientDataJSON: K.b64u(octets(a.response.clientDataJSON)),
    authenticatorData: K.b64u(octets(a.response.authenticatorData)), signature: K.b64u(octets(a.response.signature)), userHandle: K.b64u(octets(a.response.userHandle || new ArrayBuffer(0))) } };
};
// L'appareil doit avoir vérifié la personne : on le relit dans sa réponse. Oui, non, ou illisible.
function personneVerifiee(reponse) {
  const r = reponse.response || {};
  const d = r.authenticatorData || (r.getAuthenticatorData ? r.getAuthenticatorData() : null);
  if (!d || d.byteLength < 37) return null;
  return (octets(d)[32] & 0x04) !== 0;
}
function sortiePrf(reponse) {
  const ext = reponse.getClientExtensionResults ? reponse.getClientExtensionResults() : {};
  const s = ext && ext.prf && ext.prf.results && ext.prf.results.first;
  return s && s.byteLength === 32 ? octets(s) : null;
}

// Pour le relevé de l'essai : quelle passkey a répondu, depuis quel appareil, et où la clé est rangée.
// Purement descriptif. Rien de secret, rien n'en part au serveur, et aucune décision n'en dépend.
async function decrire(reponse) {
  try {
    const r = reponse.response || {};
    const brut = r.authenticatorData || (r.getAuthenticatorData ? r.getAuthenticatorData() : null);
    const d = brut ? octets(brut) : new Uint8Array(0);
    const drapeaux = d.length >= 37 ? d[32] : null;
    const lieu = { platform: 'cet appareil', 'cross-platform': 'un autre appareil ou une cle externe' }[reponse.authenticatorAttachment] || 'non dit par le navigateur';
    const lignes = ['passkey ' + await N.numeroDePasskey(K.b64u(octets(reponse.rawId))), 'reponse de : ' + lieu];
    if (drapeaux !== null) lignes.push('cle synchronisable ' + (drapeaux & 0x08 ? 'oui' : 'non') + ', sauvegardee ' + (drapeaux & 0x10 ? 'oui' : 'non'));
    const transports = r.getTransports ? Array.from(r.getTransports() || []) : [];
    if (transports.length) lignes.push('transports ' + transports.map((t) => String(t).replace(/[^a-z-]/g, '')).join(','));
    if (drapeaux !== null && (drapeaux & 0x40) && d.length >= 53) {
      const h = K.hex(d.slice(37, 53));
      lignes.push('fournisseur ' + (/^0+$/.test(h) ? 'non communique' : [h.slice(0, 8), h.slice(8, 12), h.slice(12, 16), h.slice(16, 20), h.slice(20)].join('-')));
    }
    return lignes.join(' | ');
  } catch (_) { return 'passkey : description impossible'; }
}

export function client({ api, appareil, stock, reglages, noter }) {
  const dire = noter || (() => {});
  const extensionPrf = { prf: { eval: { first: N.ENTREE_PRF } } };
  const maintenant = () => (reglages.horloge ? reglages.horloge() : Math.floor(Date.now() / 1000));
  // Quand le service demande au joueur de dire qui il est : la preuve d'identité reçue après le code. Elle ne sert
  // qu'à réserver une inscription, une seule, et ne quitte pas la mémoire de la page. Elle y reste jusqu'à ce que
  // le coffre soit rangé sur l'appareil : si la réponse à la réservation se perd, la redemander rend la même.
  const parEmail = reglages.identite === 'email';
  let preuveIdentite = null;
  // Une réservation obtenue et pas encore utilisée : si le joueur annule son geste puis recommence, elle ressert
  // tant qu'il lui reste au moins une minute. Il n'a donc pas à redemander un code pour un Face ID annulé.
  let reservation = null;
  async function demanderCode(email) { await api('/identite/code', { email }); }
  async function validerCode(email, code) {
    const r = await api('/identite/verifier', { email, code });
    if (!r || typeof r.preuve !== 'string') refuser('CodeRefuse');
    preuveIdentite = r.preuve;
    // Une identité vient d'être confirmée : une réservation gardée d'une confirmation précédente ne lui appartient
    // pas. Elle est oubliée, pour qu'un coffre ne soit jamais lié à une autre adresse que la dernière confirmée.
    reservation = null;
    return { coffre: r.coffre === true };
  }

  async function demander(defi, cred, geste) {
    const a = await appareil.demander({ challenge: defi, rpId: reglages.rpId, userVerification: 'required', timeout: 120000,
      allowCredentials: cred ? [{ type: 'public-key', id: K.deB64u(cred) }] : [], extensions: extensionPrf });
    dire('[' + geste + '] ' + await decrire(a));
    if (personneVerifiee(a) !== true) refuser('VerificationAbsente');
    const sortie = sortiePrf(a);
    if (!sortie) refuser('PrfAbsent');
    return { a, sortie };
  }

  // ---------- Créer : réserver, créer la passkey, fabriquer le coffre, le ranger sur l'appareil, l'envoyer.
  // `options.connexion`, s'il est donné : { jeu, defi }. La preuve de connexion au jeu est alors signée dans le
  // même geste, et rendue seulement si le coffre est bien gardé par le serveur.
  async function creer(nom, options) {
    const connexion = options && options.connexion;
    if (await stock.lire()) refuser('DejaUnCoffre');
    let r = reservation;
    if (r && !(Number.isSafeInteger(r.expire) && r.expire >= maintenant() + 60)) r = reservation = null;
    if (!r) {
      if (parEmail && !preuveIdentite) refuser('IdentiteRequise');
      try { r = await api('/reserver', parEmail ? { preuve: preuveIdentite } : {}); }
      catch (e) { if (e && (e.name === 'IdentiteRefusee' || e.name === 'DejaUnCoffre')) preuveIdentite = null; throw e; }
      // Le serveur ne choisit ni le service, ni l'environnement, ni le projet : la page les connaît déjà.
      if (r.service !== reglages.origine || r.environnement !== reglages.environnement || r.projet !== reglages.projet) refuser('ContexteRefuse', 'reservation');
      reservation = r;
    }
    // L'expiration annoncée sera signée par la clé du wallet : ni passée, ni trop lointaine, avant tout geste.
    K.controlerDuree(r.expire, maintenant());
    const defi = K.deB64u(r.defi, 32), utilisateur = K.deB64u(r.compte, 16);
    const c = await appareil.creer({
      challenge: defi, rp: { name: nom, id: reglages.rpId }, user: { id: utilisateur, name: nom, displayName: nom },
      pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
      authenticatorSelection: { residentKey: 'required', requireResidentKey: true, userVerification: 'required' },
      attestation: 'none', timeout: 120000, extensions: extensionPrf,
    });
    const cred = K.b64u(octets(c.rawId));
    dire('[creer] ' + await decrire(c));
    if (personneVerifiee(c) === false) refuser('VerificationAbsente');
    let sortie = personneVerifiee(c) === true ? sortiePrf(c) : null, direct = !!sortie;
    if (!sortie) {
      // La clé du coffre n'est pas sortie à la création : un second geste, avec un défi qui ne quitte pas la page.
      sortie = (await demander(N.hasard(32), cred, 'creer, second geste')).sortie;
    }
    const alg = ALGORITHMES[c.response.getPublicKeyAlgorithm()];
    if (!alg) refuser('PasskeyRefusee', 'algorithme');
    const cle = await K.empreinte(octets(c.response.getPublicKey()));
    let fait;
    try {
      K.controlerDuree(r.expire, maintenant());   // une seconde fois, juste avant de signer : le geste a pris du temps
      fait = await N.creer({ sortiePrf: sortie, passkey: { cred: octets(c.rawId), alg, cle }, langue: reglages.langue, contexte: {
        service: reglages.origine, environnement: reglages.environnement, projet: reglages.projet,
        compte: r.compte, inscription: r.inscription, defi: r.defi, expire: r.expire },
        connexion: connexion ? { jeu: connexion.jeu, defi: connexion.defi, maintenant: maintenant() } : undefined });
    } finally { sortie.fill(0); }
    const envoi = { inscription: r.inscription, passkey: pourCreation(c), etat: new TextDecoder().decode(fait.etat),
      message: K.b64u(fait.message), signature: K.b64u(fait.signature) };
    const fiche = { compte: r.compte, cred, coffre: fait.coffre, etat: envoi.etat, message: envoi.message, signature: envoi.signature,
      version: 1, empreinte: fait.empreinte, garde: false, envoi };
    await stock.inscrire(fiche);   // d'abord sur l'appareil : si l'envoi échoue, le coffre existe et la page le dit
    reservation = null; preuveIdentite = null;   // elles ont servi
    dire('[creer] coffre fabrique et range sur l\'appareil | adresse ' + fait.coffre.adresse + ' | cle du coffre des la creation ' + (direct ? 'oui' : 'non'));
    const resultat = await envoyer(fiche);
    // Un coffre qui n'existe que sur cet appareil n'entre pas dans un jeu : la preuve n'est rendue que s'il est gardé.
    if (fait.preuve && resultat.garde) resultat.preuve = fait.preuve;
    return resultat;
  }

  // L'envoi se rejoue tel quel : la même demande rend la même réponse, que l'accusé précédent soit arrivé ou non.
  async function envoyer(fiche) {
    let accuse;
    try { accuse = await api('/creer', fiche.envoi); }
    catch (e) {
      dire('[creer] NON GARDE chez nous : ' + (e && e.name));
      return { adresse: fiche.coffre.adresse, garde: false, raison: e && e.name };
    }
    if (accuse.empreinte !== fiche.empreinte || accuse.adresse !== fiche.coffre.adresse || accuse.coffre !== fiche.coffre.id || accuse.version !== 1) refuser('AccuseRefuse');
    const gardee = Object.assign({}, fiche, { garde: true });
    delete gardee.envoi;
    await stock.remplacer(fiche, gardee);
    dire('[creer] garde chez nous : oui');
    return { adresse: fiche.coffre.adresse, garde: true };
  }
  async function renvoyer() {
    const fiche = await stock.lire();
    if (!fiche) refuser('PasDeCoffre');
    if (fiche.garde) return { adresse: fiche.coffre.adresse, garde: true };
    return envoyer(fiche);
  }

  // ---------- Se connecter : un geste. L'assertion part au serveur, la sortie qui ouvre reste ici.
  async function connecter() {
    const fiche = await stock.lire();
    const d = await api('/connexion/defi', {});
    const { a, sortie } = await demander(K.deB64u(d.defi, 32), fiche ? fiche.cred : null, 'connecter');
    try {
      const corps = pourConnexion(a);
      const rendu = await api('/connexion', { defi: d.defi, passkey: corps });
      return await accepter(rendu, { cred: corps.id, compte: corps.response.userHandle, sortie, fiche });
    } finally { sortie.fill(0); }
  }

  // Le seul chemin par lequel une réponse du serveur peut devenir la copie de l'appareil.
  async function accepter(rendu, { cred, compte, sortie, fiche }) {
    if (!rendu || typeof rendu.etat !== 'string' || typeof rendu.message !== 'string' || typeof rendu.signature !== 'string') refuser('CandidatRefuse', 'forme');
    const attendu = { service: reglages.origine, environnement: reglages.environnement, projet: reglages.projet, compte, cred };
    if (fiche) {
      // Ce que l'appareil connaît déjà ne change jamais, quel que soit le numéro de version annoncé.
      if (fiche.compte !== compte) refuser('CandidatRefuse', 'compte');
      attendu.coffre = fiche.coffre.id;
      attendu.adresse = fiche.coffre.adresse;
    }
    const lu = await K.relireEtat({ message: K.deB64u(rendu.message), signature: K.deB64u(rendu.signature, 64), etat: te.encode(rendu.etat) }, attendu);
    if (lu.gestion.compte !== compte) refuser('CandidatRefuse', 'compte');
    if (rendu.version !== lu.version || rendu.empreinte !== lu.empreinte) refuser('CandidatRefuse', 'annonce');
    if (fiche) {
      if (lu.version < fiche.version) refuser('RetourEnArriere');
      if (lu.version === fiche.version && lu.empreinte !== fiche.empreinte) refuser('Divergence');
    }
    // L'ouverture réelle, preuve locale comprise. Si elle échoue, rien n'a été touché sur l'appareil.
    const session = await N.ouvrirParPasskey(lu.etat.coffre, cred, sortie);
    const nouvelle = { compte, cred, coffre: lu.etat.coffre, etat: rendu.etat, message: rendu.message, signature: rendu.signature,
      version: lu.version, empreinte: lu.empreinte, garde: true };
    if (!fiche) { await stock.inscrire(nouvelle); dire('[connecter] coffre recu du serveur et range sur cet appareil | adresse ' + session.adresse); }
    else if (lu.version > fiche.version || !fiche.garde) { await stock.remplacer(fiche, nouvelle); dire('[connecter] copie de l\'appareil mise a jour | version ' + lu.version); }
    else dire('[connecter] ok : meme version que sur l\'appareil | adresse ' + session.adresse);
    return session;
  }

  // ---------- Ouvrir la copie de l'appareil, sans le serveur.
  async function ouvrirLocal() {
    const fiche = await stock.lire();
    if (!fiche) refuser('PasDeCoffre');
    const { sortie } = await demander(N.hasard(32), fiche.cred, 'ouvrir');
    try { return await N.ouvrirParPasskey(fiche.coffre, fiche.cred, sortie); } finally { sortie.fill(0); }
  }

  // ---------- Entrer dans un jeu avec un coffre existant : l'ouvrir, puis signer la preuve de connexion.
  // Le serveur d'abord (il rend la dernière version du coffre) ; s'il ne répond pas, la copie de l'appareil suffit.
  async function prouver({ jeu, defi }) {
    const fiche = await stock.lire();
    if (fiche && !fiche.garde) refuser('NonGarde');
    let session;
    try { session = await connecter(); }
    catch (e) {
      if (!fiche || !['ReseauCoupe', 'Indisponible'].includes(e && e.name)) throw e;
      dire('[jeu] serveur injoignable : ouverture de la copie de cet appareil');
      session = await ouvrirLocal();
    }
    try {
      const preuve = await session.prouverConnexion({ service: reglages.origine, jeu, defi, maintenant: maintenant() });
      return { adresse: session.adresse, preuve };
    } finally { session.fermer(); }
  }

  return { creer, renvoyer, connecter, ouvrirLocal, accepter, prouver, demanderCode, validerCode };
}

// Un stockage en mémoire, pour les essais. La page a le sien, sur IndexedDB, avec les mêmes règles :
// inscrire refuse d'écraser, remplacer et effacer n'agissent que sur la fiche que l'appelant connaît.
export function stockEnMemoire() {
  let fiche;
  const meme = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  return {
    async lire() { return fiche === undefined ? undefined : JSON.parse(JSON.stringify(fiche)); },
    async inscrire(f) { if (fiche !== undefined) refuser('DejaUnCoffre'); fiche = JSON.parse(JSON.stringify(f)); },
    async remplacer(ancienne, f) { if (!meme(fiche, ancienne)) refuser('StockChange'); fiche = JSON.parse(JSON.stringify(f)); },
    async effacer(ancienne) { if (!meme(fiche, ancienne)) refuser('StockChange'); fiche = undefined; },
  };
}
