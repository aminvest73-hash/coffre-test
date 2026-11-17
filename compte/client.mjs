// Ce que fait la page, sans l'écran : créer un coffre et le confier au serveur, se connecter, et n'accepter
// ce que rend le serveur qu'après l'avoir réellement ouvert. Il ne dépend ni de l'écran ni du navigateur :
// on lui fournit l'accès au serveur, à l'appareil (les passkeys) et au stockage local.
//
//   api(chemin, objet)   -> la réponse du serveur, ou lève un refus
//   appareil.creer / appareil.demander   -> comme navigator.credentials.create / get, avec leur partie publicKey
//   stock.lire() / inscrire(fiche) / remplacer(ancienne, fiche) / effacer(ancienne)
//   reglages : { origine, rpId, environnement, projet, langue }   -> ce que la page sait d'elle-même
//              `identite: 'email'` si le service demande de dire qui on est avant de créer ;
//              `recuperation: 'email'` si un coffre se retrouve sans appareil, avec les 12 mots et un code reçu ;
//              `systeme: 'Windows'` si l'appareil est sous Windows (la forme d'une demande de clé en dépend) ;
//              `portes: ['google', …]` si le joueur peut dire qui il est par une autre porte que l'e-mail, et
//              `adresseIdentite`, l'origine où le service sert ces portes ;
//              `emetteur` : l'origine du service, quand des jeux reçoivent de lui une identité (à défaut :
//              `adresseIdentite`). C'est elle que la clé du wallet engage dans la preuve de connexion version 2 ;
//   rangement.lire() / garder(objet) / effacer()   -> un petit rangement propre à CETTE fenêtre (le stockage de session
//              de la page), pour la tentative en cours par une autre porte. Sans lui, aucune porte n'est proposée.
//              (et `horloge`, pour les essais seulement : l'heure de l'appareil, en secondes)
//
// Règle : tout ce que rend le serveur est un candidat. La copie de l'appareil n'est remplacée qu'après les
// contrôles, l'ouverture réelle et la preuve locale.

import * as K from './contrat.mjs';
import * as N from './noyau.mjs';
import * as O from './operation.mjs';

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
// Les drapeaux d'une réponse de passkey (un octet), ou null s'ils sont illisibles.
function drapeauxDe(reponse) {
  const r = reponse.response || {};
  const d = r.authenticatorData || (r.getAuthenticatorData ? r.getAuthenticatorData() : null);
  if (!d || d.byteLength < 37) return null;
  return octets(d)[32];
}
// L'appareil doit avoir vérifié la personne : on le relit dans sa réponse. Oui, non, ou illisible.
function personneVerifiee(reponse) {
  const d = drapeauxDe(reponse);
  return d === null ? null : (d & 0x04) !== 0;
}
// La clé est-elle « synchronisable » : rangée dans un gestionnaire de clés (celui de Google, d'Apple, de Microsoft…)
// et non dans le seul appareil. Oui, non, ou illisible.
function synchronisable(reponse) {
  const d = drapeauxDe(reponse);
  return d === null ? null : (d & 0x08) !== 0;
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

export function client({ api, appareil, stock, reglages, noter, rangement }) {
  const dire = noter || (() => {});
  const extensionPrf = { prf: { eval: { first: N.ENTREE_PRF } } };
  const maintenant = () => (reglages.horloge ? reglages.horloge() : Math.floor(Date.now() / 1000));
  // Quand le service demande au joueur de dire qui il est : la preuve d'identité reçue après le code. Elle ne sert
  // qu'à réserver une inscription, une seule, et ne quitte pas la mémoire de la page. Elle y reste jusqu'à ce que
  // le coffre soit rangé sur l'appareil : si la réponse à la réservation se perd, la redemander rend la même.
  const parEmail = reglages.identite === 'email';
  // Les autres portes d'identité (Google, Discord…). Dès qu'il y en a une, le service n'ouvre aucune inscription sans
  // preuve d'identité : la page n'en demande donc pas sans.
  const portes = Array.isArray(reglages.portes) ? reglages.portes.filter((p) => typeof p === 'string' && /^[a-z][a-z0-9]{1,15}$/.test(p)) : [];
  const identiteExigee = parEmail || portes.length > 0;
  const avecRecuperation = reglages.recuperation === 'email';
  // La réponse n'est pas arrivée, ou le serveur a eu une panne en cours de route (« Erreur ») : on ne sait pas si
  // l'écriture a eu lieu. La demande exacte est alors gardée, pour repartir telle quelle : jamais jetée, jamais refaite.
  const coupure = (e) => !!e && ['ReseauCoupe', 'Indisponible', 'Erreur'].includes(e.name);
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

  // Par où une clé d'accès se joint, d'après ce que l'appareil a déclaré à sa création (« internal », « hybrid »…).
  // Une liste fermée de mots : ce qui vient du navigateur n'est gardé que s'il en fait partie.
  const TRANSPORTS = ['ble', 'hybrid', 'internal', 'nfc', 'smart-card', 'usb'];
  function transportsDe(c) {
    try {
      const t = c && c.response && c.response.getTransports ? Array.from(c.response.getTransports() || []) : [];
      const connus = TRANSPORTS.filter((x) => t.includes(x));
      return connus.length ? connus : null;
    } catch (_) { return null; }
  }
  // `ailleurs` : la clé demandée vit sur un autre appareil (elle a répondu ainsi la dernière fois). C'est un indice
  // donné au navigateur pour qu'il propose d'emblée l'autre appareil ; un navigateur qui ne le connaît pas l'ignore.
  // `transports` : ce que la clé a déclaré à sa création sur CET appareil, redit au navigateur à chaque demande. Sans
  // cela, il ne sait pas où la chercher. Ce sont des aides : rien n'en dépend.
  // `ouverte` : la demande part SANS désigner la clé, et le navigateur affiche sa propre liste. Sous Windows, deux
  // endroits peuvent garder une clé d'accès : Windows lui-même, et le gestionnaire du navigateur (celui de Google
  // dans Chrome). Quand la page désigne la clé, Chrome peut ouvrir d'abord la fenêtre de Windows, qui ne la contient
  // pas (essai du 15/11 sous Windows 11 et Chrome 157 : « la première fenêtre est toujours un échec »). D'après le code
  // de Chrome lu le 15/11, ni les « transports » ni les indices n'y changent rien ; une demande sans clé désignée,
  // elle, lui fait afficher sa liste, où se trouve la clé du gestionnaire. Effet non mesuré sur un vrai Windows.
  // Dans tous les cas, quand une clé est attendue, seule sa réponse est acceptée.
  const demandeOuverte = (synchro, distante) => reglages.systeme === 'Windows' && synchro === true && !distante;
  const aidePour = (fiche) => ({ ailleurs: !!fiche.distante, transports: fiche.transports, ouverte: demandeOuverte(fiche.synchro, fiche.distante) });
  const aidePourNeuve = (c) => ({ transports: transportsDe(c), ouverte: demandeOuverte(synchronisable(c), false) });
  async function demander(defi, cred, geste, aide) {
    const { ailleurs, transports, ouverte } = aide || {};
    const voulue = cred && !ouverte ? { type: 'public-key', id: K.deB64u(cred) } : null;
    if (voulue && Array.isArray(transports) && transports.length) voulue.transports = TRANSPORTS.filter((x) => transports.includes(x));
    const options = { challenge: defi, rpId: reglages.rpId, userVerification: 'required', timeout: 120000,
      allowCredentials: voulue ? [voulue] : [], extensions: extensionPrf };
    if (ailleurs) options.hints = ['hybrid'];
    const a = await appareil.demander(options);
    dire('[' + geste + '] ' + await decrire(a) + (cred && ouverte ? ' | demande ouverte' : ''));
    // Une autre clé du même site a répondu (possible quand la demande est ouverte) : ce n'est pas celle de ce coffre.
    if (cred && K.b64u(octets(a.rawId)) !== cred) refuser('AutreCle');
    if (personneVerifiee(a) !== true) refuser('VerificationAbsente');
    const sortie = sortiePrf(a);
    if (!sortie) refuser('PrfAbsent');
    return { a, sortie };
  }

  // ---------- Dire qui on est par une autre porte (Google, Discord…). Le joueur quitte la page pour le fournisseur,
  // puis y revient : la page se recharge entre les deux. Ce qui lie le retour à CETTE fenêtre est un vérifieur tiré
  // ici, gardé dans son rangement, et dont seule l'empreinte part (S256, RFC 7636). Le code de remise que le service
  // renvoie ne s'échange qu'avec lui : le code d'un autre, ouvert ici, ne vaut rien. La limite, dite : un onglet
  // dupliqué après le départ emporte une copie du vérifieur ; le code ne sert qu'une fois, un seul des deux réussit.
  const FORME_43 = /^[A-Za-z0-9_-]{43}$/;
  const VIE_TENTATIVE = 900;   // secondes : dix minutes chez le fournisseur, deux pour la remise, et un peu de marge
  // Le départ. Rend l'adresse où envoyer la fenêtre. `options.parUnJeu` : un jeu a ouvert cette fenêtre.
  async function partirParPorte(porte, options) {
    if (!portes.includes(porte) || !rangement || typeof reglages.adresseIdentite !== 'string') refuser('PorteEteinte');
    if (await stock.lire()) refuser('DejaUnCoffre');
    // Le service a-t-il cette porte ? Sur un service d'essai, c'est aussi cette demande qui fait demander le code
    // des testeurs maintenant : au retour, il serait trop tard.
    const r = await api('/identite/portes', {});
    if (!r || !Array.isArray(r.portes) || !r.portes.includes(porte)) refuser('PorteEteinte');
    const v = K.b64u(N.hasard(32));
    // Si la fenêtre ne peut rien garder, elle ne part pas : le retour ne pourrait pas aboutir.
    let garde = false;
    try { garde = rangement.garder({ v, porte, heure: maintenant(), jeu: !!(options && options.parUnJeu) }) === true; } catch (_) { /* refusé ci-dessous */ }
    if (!garde) refuser('RangementRefuse');
    dire('[identite] depart par ' + porte);
    return reglages.adresseIdentite + '/identite/depart?f=' + porte + '&e=' + await K.empreinte(te.encode(v));
  }
  // Le retour. `fragment` : ce que la page a lu dans son adresse, et déjà retiré (`i=<code>` ou `i-refus=<mot>`).
  // La tentative de cette fenêtre est lue puis effacée, quoi qu'il arrive : elle ne sert qu'une fois. Sans elle,
  // rien ne part au serveur. Rend { coffre, porte, parUnJeu } : la preuve d'identité, elle, reste dans la mémoire
  // de la page, à la même place que celle du code par e-mail.
  async function revenirDePorte(fragment) {
    const code = /^i=([A-Za-z0-9_-]{43})$/.exec(typeof fragment === 'string' ? fragment : '');
    const refus = /^i-refus=(annule|fournisseur|erreur)$/.exec(typeof fragment === 'string' ? fragment : '');
    if (!code && !refus) refuser('RetourRefuse');   // pas un retour : la tentative en cours, s'il y en a une, n'est pas touchée
    let t = null;
    try { t = rangement ? rangement.lire() : null; } catch (_) { t = null; }
    try { if (rangement) rangement.effacer(); } catch (_) { /* rien à effacer */ }
    const age = t && Number.isSafeInteger(t.heure) ? maintenant() - t.heure : -1;
    if (!t || typeof t.v !== 'string' || !FORME_43.test(t.v) || !portes.includes(t.porte) || age < -60 || age > VIE_TENTATIVE) refuser('ConnexionAilleurs');
    if (refus) refuser({ annule: 'ConnexionAnnulee', fournisseur: 'FournisseurRefuse', erreur: 'ConnexionEchouee' }[refus[1]]);
    const r = await api('/identite/echanger', { code: code[1], verifieur: t.v });
    if (!r || typeof r.preuve !== 'string') refuser('RemiseRefusee');
    preuveIdentite = r.preuve;
    reservation = null;   // comme après un code par e-mail : une réservation d'avant n'appartient pas à cette identité
    dire('[identite] confirmee par ' + t.porte + ' | coffre existant ' + (r.coffre === true ? 'oui' : 'non'));
    return { coffre: r.coffre === true, porte: t.porte, parUnJeu: t.jeu === true };
  }
  // Un retour dont la page ne veut pas (un coffre est déjà sur l'appareil) : la tentative est seulement effacée.
  function oublierPorte() { try { if (rangement) rangement.effacer(); } catch (_) { /* rien */ } }

  // ---------- L'identité rendue au jeu. Quand la demande d'un jeu porte un contexte d'identité (`identite` :
  // { client, nonce, e, adresseRequise }, tel que lien-jeu.mjs l'a lu), la clé du wallet signe la preuve de connexion
  // VERSION 2, qui engage ce contexte ; puis la page demande au service la remise : un code à usage unique, qu'elle
  // rend au jeu avec la preuve. C'est le serveur du jeu qui l'échangera contre l'identité signée.
  // Le jeton de continuation : rendu par le service à la création d'un coffre (quand le joueur venait de dire qui il
  // est), ou à la connexion quand il vient de le dire et ouvre un coffre qui existait. Il ne sert qu'à UNE remise,
  // pour ce wallet, et ne quitte pas la mémoire de la page. Sans lui, la remise se fait quand même : le jeu saura
  // seulement quel wallet et quel joueur, pas par quelle porte ni avec quelle adresse.
  let continuation = null;   // { jeton, adresse }
  const retenirContinuation = (jeton, adresse) => { if (typeof jeton === 'string' && FORME_43.test(jeton)) continuation = { jeton, adresse }; };
  // Ce que la clé du wallet engagera, à partir de la demande du jeu et de ce que la page sait d'elle-même.
  function contexteIdentite(i) {
    const emetteur = typeof reglages.emetteur === 'string' ? reglages.emetteur : reglages.adresseIdentite;
    if (!i || typeof i !== 'object' || typeof emetteur !== 'string') refuser('IdentiteEteinte');
    return { emetteur, client: i.client, nonce: i.nonce, e: i.e, intention: 'identite', portee: i.adresseRequise === true ? 'identite-adresse' : 'identite' };
  }
  // Demander la remise. Les refus du service remontent sous leur nom. Celui que la page doit savoir traiter :
  // `AdresseRequise` (ce jeu exige une adresse qui vient d'être prouvée : faire confirmer son adresse au joueur, par
  // Google ou par un code, puis recommencer). Une continuation que le service ne reconnaît plus est oubliée, et la
  // même preuve est représentée une fois sans elle (rien n'avait été écrit).
  async function remettre(preuve, adresse) {
    const corps = { message: K.b64u(preuve.message), signature: K.b64u(preuve.signature) };
    const suite = continuation && continuation.adresse === adresse ? continuation.jeton : null;
    let r;
    try { r = await api('/jeu/remise', suite ? Object.assign({ continuation: suite }, corps) : corps); }
    catch (e) {
      if (!suite || !e || e.name !== 'ContinuationRefusee') throw e;
      continuation = null;
      dire('[jeu] continuation refusee : remise demandee sans elle');
      r = await api('/jeu/remise', corps);
    }
    if (suite) continuation = null;   // elle a servi
    if (!r || typeof r.code !== 'string' || !FORME_43.test(r.code)) refuser('RemiseJeuRefusee');
    dire('[jeu] remise obtenue pour le jeu');
    return r.code;
  }

  // ---------- Créer : réserver, créer la passkey, fabriquer le coffre, le ranger sur l'appareil, l'envoyer.
  // `options.connexion`, s'il est donné : { jeu, defi }. La preuve de connexion au jeu est alors signée dans le
  // même geste, et rendue seulement si le coffre est bien gardé par le serveur.
  // Avec `options.connexion.identite` (le contexte d'identité de la demande du jeu), c'est la preuve version 2 qui est
  // signée ; une fois le coffre gardé, la remise est demandée, et le résultat porte `preuve` ET `remise`. Si la remise
  // est refusée, le coffre existe quand même : le résultat porte `remiseRefusee` (le nom du refus, par exemple
  // `AdresseRequise`), sans preuve ni remise : rien ne part au jeu, et la page reprendra par `prouver`.
  // `options.encorePermis`, s'il est donné : une fonction que la page tient à jour (par exemple « le jeu qui attend
  // ne demande pas un coffre existant »). Le geste du joueur prend du temps, et ce qui autorisait la création au
  // départ peut ne plus être vrai à la fin : la question est reposée après le geste, juste avant de fabriquer le
  // coffre, puis juste avant de le ranger. Si la réponse n'est pas oui : `CreationRetiree`, rien n'est conservé ni
  // envoyé : aucune fiche sur l'appareil, rien au serveur, la réservation reste. Au second contrôle, une paire de
  // clés a déjà pu être calculée en mémoire : elle est abandonnée là, jamais rangée. Limite dite : la clé d'accès
  // que l'appareil vient de créer peut y rester, sans coffre ; elle ne sert à rien.
  async function creer(nom, options) {
    const connexion = options && options.connexion;
    const pourIdentite = connexion && connexion.identite ? contexteIdentite(connexion.identite) : null;
    const permis = () => { if (options && typeof options.encorePermis === 'function' && options.encorePermis() !== true) refuser('CreationRetiree'); };
    if (await stock.lire()) refuser('DejaUnCoffre');
    let r = reservation;
    if (r && !(Number.isSafeInteger(r.expire) && r.expire >= maintenant() + 60)) r = reservation = null;
    if (!r) {
      if (identiteExigee && !preuveIdentite) refuser('IdentiteRequise');
      try { r = await api('/reserver', identiteExigee ? { preuve: preuveIdentite } : {}); }
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
      sortie = (await demander(N.hasard(32), cred, 'creer, second geste', aidePourNeuve(c))).sortie;
    }
    const alg = ALGORITHMES[c.response.getPublicKeyAlgorithm()];
    if (!alg) refuser('PasskeyRefusee', 'algorithme');
    const cle = await K.empreinte(octets(c.response.getPublicKey()));
    let fait;
    try {
      permis();
      K.controlerDuree(r.expire, maintenant());   // une seconde fois, juste avant de signer : le geste a pris du temps
      fait = await N.creer({ sortiePrf: sortie, passkey: { cred: octets(c.rawId), alg, cle }, langue: reglages.langue, contexte: {
        service: reglages.origine, environnement: reglages.environnement, projet: reglages.projet,
        compte: r.compte, inscription: r.inscription, defi: r.defi, expire: r.expire },
        connexion: connexion ? Object.assign({ jeu: connexion.jeu, defi: connexion.defi, maintenant: maintenant() }, pourIdentite ? { identite: pourIdentite } : {}) : undefined });
    } finally { sortie.fill(0); }
    const envoi = { inscription: r.inscription, passkey: pourCreation(c), etat: new TextDecoder().decode(fait.etat),
      message: K.b64u(fait.message), signature: K.b64u(fait.signature) };
    const fiche = { compte: r.compte, cred, coffre: fait.coffre, etat: envoi.etat, message: envoi.message, signature: envoi.signature,
      version: 1, empreinte: fait.empreinte, garde: false, envoi };
    if (transportsDe(c)) fiche.transports = transportsDe(c);
    if (synchronisable(c) === true) fiche.synchro = true;
    permis();
    await stock.inscrire(fiche);   // d'abord sur l'appareil : si l'envoi échoue, le coffre existe et la page le dit
    reservation = null; preuveIdentite = null;   // elles ont servi
    dire('[creer] coffre fabrique et range sur l\'appareil | adresse ' + fait.coffre.adresse + ' | cle du coffre des la creation ' + (direct ? 'oui' : 'non'));
    const resultat = await envoyer(fiche);
    // Un coffre qui n'existe que sur cet appareil n'entre pas dans un jeu : la preuve n'est rendue que s'il est gardé.
    if (fait.preuve && resultat.garde && !pourIdentite) resultat.preuve = fait.preuve;
    if (fait.preuve && resultat.garde && pourIdentite) {
      // La preuve version 2 ne part jamais sans son code de remise.
      try { resultat.remise = await remettre(fait.preuve, resultat.adresse); resultat.preuve = fait.preuve; }
      catch (e) { resultat.remiseRefusee = (e && typeof e.name === 'string' && e.name) || 'Erreur'; dire('[jeu] remise refusee apres la creation : ' + resultat.remiseRefusee); }
    }
    return resultat;
  }

  // L'envoi se rejoue tel quel : la même demande rend la même réponse, que l'accusé précédent soit arrivé ou non.
  // `fiche.vers` dit où elle part : la création (par défaut), ou l'ajout d'un accès après une récupération.
  // Un ajout refusé pour de bon (défi expiré, état changé entre-temps) ne se rattrape pas : la copie de l'appareil
  // est une version que le serveur n'a pas. Elle est effacée, et la récupération reprend au début ; le coffre gardé
  // par le serveur, lui, n'a pas bougé. Une création refusée, elle, reste sur l'appareil : c'est la seule copie.
  async function envoyer(fiche) {
    const ajout = fiche.vers === '/acces/ajouter', geste = ajout ? '[garder]' : '[creer]';
    let accuse;
    try { accuse = await api(ajout ? '/acces/ajouter' : '/creer', fiche.envoi); }
    catch (e) {
      dire(geste + ' NON GARDE chez nous : ' + (e && e.name));
      const attendre = coupure(e) || ['Complet', 'AdmissionRefusee'].includes(e && e.name);
      if (ajout && !attendre) {
        // Un refus. S'il suit un envoi dont le résultat n'a jamais été connu, il ne prouve rien : l'ajout a pu aboutir
        // la première fois. La fiche reste alors ; c'est la prochaine connexion avec cette clé qui tranchera.
        if (fiche.incertain) return { adresse: fiche.coffre.adresse, garde: false, raison: e && e.name, inconnu: true };
        await stock.effacer(fiche);
        dire('[garder] ajout refuse pour de bon : la copie de cet appareil est effacee, le coffre garde chez nous n\'a pas change');
        return { adresse: fiche.coffre.adresse, garde: false, raison: e && e.name, efface: true };
      }
      // Le résultat de cet envoi est inconnu : la fiche le retient, pour qu'un refus ultérieur ne soit pas pris pour un échec.
      if (ajout && coupure(e) && !fiche.incertain) await stock.remplacer(fiche, Object.assign({}, fiche, { incertain: true }));
      return { adresse: fiche.coffre.adresse, garde: false, raison: e && e.name };
    }
    if (accuse.empreinte !== fiche.empreinte || accuse.adresse !== fiche.coffre.adresse || accuse.coffre !== fiche.coffre.id || accuse.version !== fiche.version) refuser('AccuseRefuse');
    if (!ajout) retenirContinuation(accuse.continuation, fiche.coffre.adresse);
    const gardee = Object.assign({}, fiche, { garde: true });
    delete gardee.envoi; delete gardee.vers; delete gardee.incertain;
    await stock.remplacer(fiche, gardee);
    dire(geste + ' garde chez nous : oui');
    return { adresse: fiche.coffre.adresse, garde: true };
  }
  async function renvoyer() {
    const fiche = await stock.lire();
    if (!fiche) refuser('PasDeCoffre');
    if (fiche.ajout) return envoyerAjout(fiche);
    if (fiche.garde) return { adresse: fiche.coffre.adresse, garde: true };
    return envoyer(fiche);
  }

  // ---------- Se connecter : un geste. L'assertion part au serveur, la sortie qui ouvre reste ici.
  // `options.pourJeu` : la connexion sert à entrer dans un jeu qui attend une identité. Si le joueur vient de dire
  // qui il est dans cette fenêtre (une preuve d'identité est en mémoire), elle accompagne la demande : le service
  // rend alors, s'il rapproche cette identité de ce compte, un jeton de continuation. La preuve a servi à cela.
  async function connecter(options) {
    const fiche = await stock.lire();
    const d = await api('/connexion/defi', {});
    const { a, sortie } = await demander(K.deB64u(d.defi, 32), fiche ? fiche.cred : null, 'connecter', fiche ? aidePour(fiche) : null);
    try {
      const corps = pourConnexion(a);
      const fraiche = options && options.pourJeu === true && preuveIdentite ? preuveIdentite : null;
      let rendu;
      try { rendu = await api('/connexion', fraiche ? { defi: d.defi, passkey: corps, identite: fraiche } : { defi: d.defi, passkey: corps }); }
      catch (e) {
        // Une clé créée après une récupération, encore en attente d'ajout, et que le serveur ne connaît pas : l'ajout
        // n'a jamais abouti. La copie de cet appareil est une version que le serveur n'a pas : elle est effacée.
        if (fiche && fiche.vers === '/acces/ajouter' && !fiche.garde && e && e.name === 'PasskeyRefusee') {
          await stock.effacer(fiche);
          dire('[garder] cette cle n\'a jamais ete ajoutee : la copie de cet appareil est effacee, le coffre garde chez nous n\'a pas change');
          refuser('AjoutRefuse');
        }
        throw e;
      }
      const session = await accepter(rendu, { cred: corps.id, compte: corps.response.userHandle, sortie, fiche, distante: a.authenticatorAttachment === 'cross-platform', synchro: synchronisable(a) });
      if (fraiche && rendu && typeof rendu.continuation === 'string' && FORME_43.test(rendu.continuation)) {
        retenirContinuation(rendu.continuation, session.adresse);
        preuveIdentite = null;   // elle a servi à cette continuation
      }
      return session;
    } finally { sortie.fill(0); }
  }

  // Ce que le serveur dit des adresses de secours d'un compte : la génération, et pour chaque rang occupé la date
  // d'inscription. Ce n'est pas signé : la page s'en sert pour afficher, et pour dire sur quelle génération porte un
  // réglage (une génération fausse fait seulement refuser le réglage). Toute autre forme est écartée.
  function lireAdresses(r) {
    if (!r || typeof r !== 'object' || !Number.isSafeInteger(r.generation) || r.generation < 1 || !Array.isArray(r.adresses) || r.adresses.length > 2) return null;
    const adresses = [];
    for (const a of r.adresses) {
      if (!a || (a.rang !== 1 && a.rang !== 2) || !Number.isSafeInteger(a.cree) || adresses.some((x) => x.rang === a.rang)) return null;
      adresses.push({ rang: a.rang, cree: a.cree });
    }
    return { generation: r.generation, adresses };
  }

  // Une déclaration de secours, relue : signée par le wallet de ce coffre, pour ce compte, et désignant son accès de
  // secours actuel. `lie` dit si elle désigne aussi une identité de récupération (sans quoi le coffre ne se retrouve
  // pas sans appareil).
  async function relireSecours(s, attendu) {
    const r = await K.relireAttestation({ message: K.deB64u(s.message), signature: K.deB64u(s.signature, 64) }, attendu);
    return { message: s.message, signature: s.signature, lie: r.identite === true };
  }

  // Le seul chemin par lequel une réponse du serveur peut devenir la copie de l'appareil, quand une passkey a répondu.
  // (Après une récupération par les mots, c'est `retrouver` puis `garder`.)
  // `distante` : la passkey a répondu depuis un autre appareil (un téléphone, par QR code). La fiche le retient, pour
  // que la page propose de donner sa propre clé à cet appareil. Aucun contrôle n'en dépend.
  async function accepter(rendu, { cred, compte, sortie, fiche, distante, synchro }) {
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
    if (distante) nouvelle.distante = true;
    if (fiche && fiche.cred === cred && fiche.transports) nouvelle.transports = fiche.transports;
    // « Synchronisable » : ce que la réponse vient de dire ; si elle ne le dit pas, ce que l'appareil savait de cette clé.
    if (synchro === true || (synchro == null && fiche && fiche.cred === cred && fiche.synchro === true)) nouvelle.synchro = true;
    const adresses = lireAdresses(rendu.recuperation);
    if (adresses) nouvelle.recuperation = adresses;
    // Une clé de cet appareil était en attente d'ajout. L'état gardé par le serveur, signé par la clé du wallet, tranche :
    //   - il la contient : l'ajout avait abouti (son accusé s'était perdu). C'est elle que cet appareil utilisera ;
    //   - il a atteint ou dépassé la version que cet ajout aurait produite, sans elle : l'ajout n'aura jamais lieu
    //     (un coffre ne perd pas d'accès, et cette version existe sans cette clé). Il est retiré ;
    //   - sinon il peut encore aboutir : il reste en attente.
    if (fiche && fiche.ajout) {
      if (lu.etat.passkeys.some((x) => x.cred === fiche.ajout.cred)) {
        nouvelle.cred = fiche.ajout.cred; delete nouvelle.distante; delete nouvelle.transports; delete nouvelle.synchro;
        if (fiche.ajout.transports) nouvelle.transports = fiche.ajout.transports;
        if (fiche.ajout.synchro === true) nouvelle.synchro = true;
      }
      else if (lu.version < fiche.ajout.version) nouvelle.ajout = fiche.ajout;
    }
    // « Secours fait » suit le compte. L'attestation rendue par le serveur est un candidat comme le reste : elle doit
    // être signée par le wallet de ce coffre et désigner son accès de secours actuel. Si le serveur n'en rend pas,
    // celle que l'appareil connaît reste, tant qu'elle vaut encore pour ce coffre.
    const pourSecours = { service: reglages.origine, environnement: reglages.environnement, projet: reglages.projet, compte, coffre: lu.etat.coffre };
    const relire = (s) => relireSecours(s, pourSecours);
    try {
      if (rendu.secours !== undefined) {
        if (!rendu.secours || typeof rendu.secours.message !== 'string' || typeof rendu.secours.signature !== 'string') refuser('CandidatRefuse', 'secours');
        nouvelle.secours = await relire(rendu.secours);
      } else if (fiche && fiche.secours) {
        try { nouvelle.secours = await relire(fiche.secours); } catch (_) { /* elle ne vaut plus pour ce coffre */ }
      }
    } catch (e) { session.fermer(); throw e; }
    const appris = !!nouvelle.secours && JSON.stringify(nouvelle.secours) !== JSON.stringify(fiche && fiche.secours);
    if (!fiche) { await stock.inscrire(nouvelle); dire('[connecter] coffre recu du serveur et range sur cet appareil | adresse ' + session.adresse); }
    else if (lu.version > fiche.version || !fiche.garde || appris || nouvelle.cred !== fiche.cred || !!nouvelle.distante !== !!fiche.distante || !!nouvelle.synchro !== !!fiche.synchro
      || !!nouvelle.ajout !== !!fiche.ajout || JSON.stringify(nouvelle.recuperation) !== JSON.stringify(fiche.recuperation)) { await stock.remplacer(fiche, nouvelle); dire('[connecter] copie de l\'appareil mise a jour | version ' + lu.version); }
    else dire('[connecter] ok : meme version que sur l\'appareil | adresse ' + session.adresse);
    return session;
  }

  // ---------- Ouvrir la copie de l'appareil, sans le serveur.
  async function ouvrirLocal() {
    const fiche = await stock.lire();
    if (!fiche) refuser('PasDeCoffre');
    const { sortie } = await demander(N.hasard(32), fiche.cred, 'ouvrir', aidePour(fiche));
    try { return await N.ouvrirParPasskey(fiche.coffre, fiche.cred, sortie); } finally { sortie.fill(0); }
  }

  // ---------- Entrer dans un jeu avec un coffre existant : l'ouvrir, puis signer la preuve de connexion.
  // Le serveur d'abord (il rend la dernière version du coffre) ; s'il ne répond pas, la copie de l'appareil suffit.
  // Avec `identite` (le contexte d'identité de la demande du jeu) : la preuve est en version 2, la remise est demandée
  // au service, et le résultat est { adresse, preuve, remise }. Ici, pas de repli sur la copie de l'appareil : la
  // remise demande le service. Un refus de la remise remonte sous son nom (`AdresseRequise`, `RemiseDejaFaite`…) :
  // rien n'est alors rendu, et rien ne doit partir au jeu.
  async function prouver({ jeu, defi, identite }) {
    const fiche = await stock.lire();
    if (fiche && !fiche.garde) refuser('NonGarde');
    if (identite) {
      const contexte = contexteIdentite(identite);
      const ouverte = await connecter({ pourJeu: true });
      try {
        const preuve = await ouverte.prouverConnexion2(Object.assign({ service: reglages.origine, jeu, defi, maintenant: maintenant() }, contexte));
        return { adresse: ouverte.adresse, preuve, remise: await remettre(preuve, ouverte.adresse) };
      } finally { ouverte.fermer(); }
    }
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

  // ---------- Signer une opération demandée par un jeu. `octets` : ce que le jeu a envoyé (le message, ou, pour une
  // opération nommée, la transaction partiellement signée) ; `lecture` : le texte unique du jugement que la page a
  // montré au joueur (`cle` de `lireDemande`) ; `adresse` : le wallet que le jeu attend ; `contexte` : voir
  // `lireDemande` (rien, { jeu, fiche }, ou { jeu, fiche, operation, version }). Les octets sont copiés puis rejugés
  // ici avant le geste, et le coffre ouvert les rejuge encore juste avant de signer (noyau) : si le jugement n'est
  // pas exactement celui montré, rien n'est signé (`OperationChangee`).
  // Un seul geste : la connexion (le serveur d'abord ; s'il ne répond pas, la copie de l'appareil). La session est
  // refermée aussitôt. Rien n'est envoyé au réseau d'ici : c'est le jeu qui diffuse.
  // `encoreValide`, s'il est donné : une fonction que la page tient à jour (« cette demande du jeu est-elle encore
  // celle qui vit, ni expirée, ni retirée, ni remplacée ? »). Le geste peut durer des minutes : elle est appelée
  // une fois, après l'ouverture du coffre et juste avant la signature (dans le coffre ouvert, noyau.mjs). Si elle
  // ne rend pas exactement `true` : `OperationExpiree`, rien n'est signé. La page n'a alors rien à rendre au jeu
  // que son refus « expiree ».
  async function signerOperation({ octets, lecture, adresse, contexte, encoreValide }) {
    const fiche = await stock.lire();
    if (!fiche) refuser('PasDeCoffre');
    if (!fiche.garde) refuser('NonGarde');
    if (!(octets instanceof Uint8Array) || typeof lecture !== 'string') refuser('OperationRefusee', 'demande');
    if (encoreValide !== undefined && typeof encoreValide !== 'function') refuser('OperationRefusee', 'encoreValide');
    if (typeof adresse !== 'string' || fiche.coffre.adresse !== adresse) refuser('AutreWallet');
    const copie = Uint8Array.from(octets);   // nos propres octets : ce qui sera signé ne peut plus changer d'ailleurs
    if ((await O.lireDemande(copie, { wallet: adresse, contexte })).cle !== lecture) refuser('OperationChangee');
    let session;
    try { session = await connecter(); }
    catch (e) {
      if (!['ReseauCoupe', 'Indisponible'].includes(e && e.name)) throw e;
      dire('[operation] serveur injoignable : ouverture de la copie de cet appareil');
      session = await ouvrirLocal();
    }
    try {
      if (session.adresse !== adresse) refuser('AutreWallet');
      const signature = await session.signerOperation(copie, lecture, contexte, encoreValide);
      dire('[operation] signee par le coffre | wallet ' + session.adresse);
      return { adresse: session.adresse, signature };
    } finally { session.fermer(); }
  }

  // ---------- La mission des 12 mots. Un geste (la connexion) : les mots sont lus dans le coffre ouvert, et cette
  // session-là est refermée aussitôt. `valider(mots)` reçoit les mots dans l'ordre que le joueur a donné. C'est une
  // vraie restauration : le coffre fermé de l'appareil est rouvert par ces mots seuls, et c'est la clé retrouvée
  // ainsi, et aucune autre, qui signe la déclaration « secours fait » avant qu'elle parte au serveur. Si les mots
  // n'ouvrent pas, rien n'est envoyé et rien n'est dit de plus que « non ».
  // Ce que le serveur range est une déclaration du détenteur de la clé du wallet, liée à l'accès de secours en
  // place. Elle ne prouve pas qu'un papier existe.
  async function mission() {
    const avant = await stock.lire();
    if (!avant) refuser('PasDeCoffre');
    if (!avant.garde) refuser('NonGarde');
    const session = await connecter();
    let mots, langue;
    try { mots = await session.lireMots(); langue = session.langue; } finally { session.fermer(); }
    // Avec la récupération, sur un coffre qui porte un vérifieur : la déclaration désigne aussi l'identité qui pourra
    // demander la remise du coffre. Le joueur donne donc son e-mail et son code (demanderCode, validerCode) entre la
    // vérification des mots et la déclaration. L'empreinte du jeton reçu est dans ce que la clé du wallet signe.
    const exige = avecRecuperation && avant.coffre.v === 3;
    // Une déclaration déjà partie, dont la réponse s'est peut-être perdue : elle repart telle quelle avant toute autre.
    let partie = null;
    const lire = async () => {
      const fiche = await stock.lire();
      if (!fiche || fiche.compte !== avant.compte) refuser('StockChange');
      return fiche;
    };
    const ranger = async (fiche, secours) => {
      await stock.remplacer(fiche, Object.assign({}, fiche, { secours }));
      partie = null;
      dire('[mission] secours atteste par la cle du wallet, et range chez nous' + (secours.lie ? ' | identite de recuperation liee' : ''));
      return true;
    };
    return {
      mots, langue, identiteRequise: exige,
      // Les mots, dans l'ordre donné par le joueur, rouvrent-ils vraiment le coffre ? Rien ne part.
      async verifier(donnes) {
        const fiche = await lire();
        try { (await N.ouvrirParSecours(fiche.coffre, donnes)).fermer(); }
        catch (_) { refuser('MotsRefuses'); }   // un seul refus, quel que soit ce qui cloche : aucun indice
        return true;
      },
      async valider(donnes) {
        const fiche = await lire();
        let ouvert;
        try { ouvert = await N.ouvrirParSecours(fiche.coffre, donnes); }
        catch (_) { refuser('MotsRefuses'); }
        try {
          if (partie) {
            try { await api('/secours/attester', partie.demande); return await ranger(fiche, partie.secours); }
            catch (e) { if (coupure(e)) throw e; partie = null; }
          }
          if (exige && !preuveIdentite) refuser('IdentiteRequise');
          const d = await api('/secours/defi', { compte: fiche.compte });
          K.controlerDuree(d.expire, maintenant());
          const contexte = { service: reglages.origine, environnement: reglages.environnement, projet: reglages.projet,
            compte: fiche.compte, defi: d.defi, expire: d.expire, avant: { version: fiche.version, empreinte: fiche.empreinte } };
          if (exige) contexte.identite = await K.empreinte(te.encode(preuveIdentite));
          const a = await ouvert.attesterSecours(contexte);
          const secours = { message: K.b64u(a.message), signature: K.b64u(a.signature), lie: exige };
          const demande = { compte: fiche.compte, defi: d.defi, message: secours.message, signature: secours.signature };
          if (exige) demande.preuve = preuveIdentite;
          partie = { demande, secours };
          try { await api('/secours/attester', demande); }
          catch (e) {
            if (coupure(e)) throw e;
            partie = null;
            // La confirmation de l'adresse a expiré, ou cette adresse ne convient pas : la page en redemande une.
            if (e && ['IdentiteRefusee', 'IdentiteDejaLiee', 'AutreIdentite'].includes(e.name)) preuveIdentite = null;
            throw e;
          }
          if (exige) preuveIdentite = null;   // elle a servi
          return await ranger(await lire(), secours);
        } finally { ouvert.fermer(); }
      },
      fermer() { for (let i = 0; i < mots.length; i++) mots[i] = ''; },
    };
  }

  // ---------- Retrouver son coffre sans appareil : les 12 mots et un code reçu par e-mail.
  // Avant : demanderCode puis validerCode (la preuve d'identité reste en mémoire). Puis `retrouver(mots)` :
  //   1. un défi contre la preuve d'identité ; le serveur annonce le compte, le coffre, la génération et la langue ;
  //   2. les mots sont décodés ici, la clé de récupération dérivée, le message de récupération signé. Rien des mots
  //      ne part : seulement cette signature ;
  //   3. le serveur remet le coffre fermé. C'est un candidat : son autorisation signée par le wallet est relue, puis
  //      il est RÉELLEMENT rouvert avec les mots (adresse, preuve locale, vérifieur). Tout écart : rien n'est gardé.
  // Ce qui est retrouvé reste en mémoire, jamais dans le stockage : il n'y a pas encore de passkey pour le fermer
  // sur cet appareil. `garder(nom)` crée cette passkey et l'ajoute au coffre.
  // Un seul refus pour les mots (« MotsRefuses »), que le serveur ait refusé ou que les mots ne s'écrivent pas.
  let retrouve = null;
  let remise = null;   // la dernière demande de remise partie : si sa réponse s'est perdue, elle repart telle quelle
  let defiLibre = null;   // un défi reçu mais pas utilisé (les mots ne s'écrivaient pas) : il ressert, au lieu d'en redemander un
  const oublierRetrouve = () => { if (retrouve) { retrouve.mots.fill(''); retrouve = null; } };
  async function retrouver(mots) {
    if (!avecRecuperation) refuser('RecuperationEteinte');
    if (await stock.lire()) refuser('DejaUnCoffre');
    if (!preuveIdentite) refuser('IdentiteRequise');
    if (!Array.isArray(mots) || mots.length !== 12) refuser('MotsRefuses');
    const donnes = mots.map((m) => String(m));
    oublierRetrouve();
    if (!(remise && remise.preuve === preuveIdentite && remise.mots.join(' ') === donnes.join(' '))) {
      remise = null;
      let d = defiLibre && defiLibre.preuve === preuveIdentite && defiLibre.d.expire > maintenant() + 30 ? defiLibre.d : null;
      defiLibre = null;
      if (!d) {
        try { d = await api('/secours/ouvrir/defi', { preuve: preuveIdentite }); }
        catch (e) { if (e && e.name === 'IdentiteRefusee') preuveIdentite = null; throw e; }
        if (!d || typeof d.defi !== 'string' || typeof d.compte !== 'string' || typeof d.coffre !== 'string'
          || !Number.isSafeInteger(d.generation) || !N.LANGUES.includes(d.langue)) refuser('CandidatRefuse', 'defi');
        K.controlerDuree(d.expire, maintenant());
      }
      let signe;
      try {
        signe = await N.signerRecuperation(donnes, d.langue, { service: reglages.origine, environnement: reglages.environnement, projet: reglages.projet,
          compte: d.compte, coffre: d.coffre, generation: d.generation, defi: d.defi, expire: d.expire });
      } catch (e) {
        // Ces mots ne s'écrivent pas dans cette langue : rien n'est parti, et le défi, intact, resservira.
        if (e && e.name === 'MotsInvalides') { defiLibre = { preuve: preuveIdentite, d }; refuser('MotsRefuses'); }
        throw e;
      }
      remise = { preuve: preuveIdentite, mots: donnes.slice(), d,
        demande: { preuve: preuveIdentite, defi: d.defi, message: K.b64u(signe.message), signature: K.b64u(signe.signature) } };
    }
    const d = remise.d;
    let rendu;
    try { rendu = await api('/secours/ouvrir', remise.demande); }
    catch (e) {
      if (coupure(e)) throw e;   // la demande est gardée : elle repartira telle quelle, sans essai de plus
      remise.mots.fill(''); remise = null;
      if (e && e.name === 'RecuperationRefusee') refuser('MotsRefuses');
      throw e;
    }
    remise.mots.fill(''); remise = null;
    preuveIdentite = null;   // le serveur l'a consommée avec la remise
    if (!rendu || typeof rendu.etat !== 'string' || typeof rendu.message !== 'string' || typeof rendu.signature !== 'string') refuser('CandidatRefuse', 'forme');
    const attendu = { service: reglages.origine, environnement: reglages.environnement, projet: reglages.projet, compte: d.compte, coffre: d.coffre };
    const lu = await K.relireEtat({ message: K.deB64u(rendu.message), signature: K.deB64u(rendu.signature, 64), etat: te.encode(rendu.etat) }, attendu);
    if (lu.gestion.compte !== d.compte || rendu.compte !== d.compte) refuser('CandidatRefuse', 'compte');
    if (rendu.version !== lu.version || rendu.empreinte !== lu.empreinte) refuser('CandidatRefuse', 'annonce');
    if (lu.etat.coffre.v !== 3) refuser('CandidatRefuse', 'format');
    // L'ouverture réelle par les mots : l'adresse, la preuve locale, et le vérifieur recalculé.
    try { (await N.ouvrirParSecours(lu.etat.coffre, donnes)).fermer(); }
    catch (_) { refuser('CandidatRefuse', 'ce coffre ne s ouvre pas avec ces mots'); }
    let secours = null;
    if (rendu.secours !== undefined) {
      if (!rendu.secours || typeof rendu.secours.message !== 'string' || typeof rendu.secours.signature !== 'string') refuser('CandidatRefuse', 'secours');
      secours = await relireSecours(rendu.secours, Object.assign({}, attendu, { coffre: lu.etat.coffre }));
    }
    retrouve = { compte: d.compte, etat: lu.etat, version: lu.version, empreinte: lu.empreinte, secours, recuperation: lireAdresses(rendu.recuperation), mots: donnes.slice() };
    dire('[retrouver] coffre remis par le serveur et rouvert par les 12 mots | adresse ' + lu.etat.coffre.adresse + ' | acces deja inscrits ' + lu.etat.passkeys.length);
    return { adresse: lu.etat.coffre.adresse, acces: lu.etat.passkeys.length };
  }

  // Garder le coffre retrouvé sur cet appareil : une nouvelle passkey, ajoutée au coffre. Deux gestes.
  //   1. créer la passkey, sur un défi du serveur. Les passkeys déjà inscrites sont exclues : si le gestionnaire de
  //      cet appareil en possède une, il refuse de créer (sinon, pour un même compte, il pourrait REMPLACER l'ancienne
  //      avant que le serveur ait rien accepté). La page propose alors de se connecter avec elle ;
  //   2. la faire répondre, sur le même défi : cela prouve au serveur qu'elle répond vraiment, et donne la sortie
  //      qui fermera l'accès : celle d'une vraie demande, comme à la prochaine connexion.
  // Puis le noyau fabrique le nouvel état et la clé du wallet l'autorise ; la fiche est rangée sur l'appareil AVANT
  // l'envoi. La passkey de l'appareil perdu n'est pas retirée : elle ouvre toujours ce coffre.
  async function garder(nom) {
    if (!retrouve) refuser('RienARetrouver');
    if (await stock.lire()) refuser('DejaUnCoffre');
    const r = retrouve, etat = r.etat;
    if (etat.passkeys.length >= 8) refuser('TropDAcces');   // avant d'inviter à créer une passkey qui serait refusée
    const d = await api('/acces/defi', { compte: r.compte });
    K.controlerDuree(d.expire, maintenant());
    const defi = K.deB64u(d.defi, 32);
    let c;
    try {
      c = await appareil.creer({
        challenge: defi, rp: { name: nom, id: reglages.rpId }, user: { id: K.deB64u(r.compte, 16), name: nom, displayName: nom },
        pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
        excludeCredentials: etat.passkeys.map((x) => ({ type: 'public-key', id: K.deB64u(x.cred) })),
        authenticatorSelection: { residentKey: 'required', requireResidentKey: true, userVerification: 'required' },
        attestation: 'none', timeout: 120000, extensions: extensionPrf,
      });
    } catch (e) { if (e && e.name === 'InvalidStateError') refuser('DejaUneCle'); throw e; }
    const cred = K.b64u(octets(c.rawId));
    dire('[garder] ' + await decrire(c));
    if (personneVerifiee(c) === false) refuser('VerificationAbsente');
    const alg = ALGORITHMES[c.response.getPublicKeyAlgorithm()];
    if (!alg) refuser('PasskeyRefusee', 'algorithme');
    const cle = await K.empreinte(octets(c.response.getPublicKey()));
    const { a, sortie } = await demander(defi, cred, 'garder, second geste', aidePourNeuve(c));
    let fait;
    try {
      K.controlerDuree(d.expire, maintenant());   // juste avant de signer : les deux gestes ont pris du temps
      fait = await N.ajouterAcces({ coffre: etat.coffre, par: { mots: r.mots }, sortiePrf: sortie, passkey: { cred: octets(c.rawId), alg, cle }, passkeys: etat.passkeys,
        contexte: { service: reglages.origine, environnement: reglages.environnement, projet: reglages.projet,
          compte: r.compte, defi: d.defi, expire: d.expire, avant: { version: r.version, empreinte: r.empreinte } } });
    } finally { sortie.fill(0); }
    const texte = new TextDecoder().decode(fait.etat);
    const envoi = { compte: r.compte, defi: d.defi, passkey: pourCreation(c), possession: pourConnexion(a), etat: texte,
      message: K.b64u(fait.message), signature: K.b64u(fait.signature) };
    const fiche = { compte: r.compte, cred, coffre: fait.coffre, etat: texte, message: envoi.message, signature: envoi.signature,
      version: fait.coffre.version, empreinte: fait.empreinte, garde: false, envoi, vers: '/acces/ajouter' };
    if (r.secours) fiche.secours = r.secours;
    if (r.recuperation) fiche.recuperation = r.recuperation;
    if (transportsDe(c)) fiche.transports = transportsDe(c);
    if (synchronisable(c) === true) fiche.synchro = true;
    await stock.inscrire(fiche);   // d'abord sur l'appareil, comme à la création
    oublierRetrouve();
    dire('[garder] nouvel acces fabrique et range sur l\'appareil | adresse ' + fait.coffre.adresse + ' | version ' + fait.coffre.version);
    return envoyer(fiche);
  }
  // ---------- Donner sa propre clé à cet appareil. Le coffre s'ouvre ici avec la clé d'un autre appareil (un
  // téléphone, par QR code) : à chaque connexion, il faut donc l'autre appareil. Une fois cette clé ajoutée, cet
  // appareil suffit. Trois gestes, une seule fois :
  //   1. une connexion avec la clé existante : elle rend l'état courant du serveur, et la sortie qui ouvre le coffre ;
  //   2. créer la clé de cet appareil (les clés déjà inscrites sont exclues, comme dans `garder`) ;
  //   3. la faire répondre : la preuve qu'elle répond, et la sortie qui fermera son accès.
  // La fiche de l'appareil ne change pas tant que le serveur n'a pas accepté : l'ajout attend à côté d'elle
  // (`fiche.ajout`). Refusé pour de bon, il est retiré et le coffre s'ouvre comme avant, avec l'autre appareil.
  async function ajouterCetAppareil(nom) {
    const avant = await stock.lire();
    if (!avant) refuser('PasDeCoffre');
    if (!avant.garde) refuser('NonGarde');
    if (avant.ajout) return envoyerAjout(avant);
    const d0 = await api('/connexion/defi', {});
    const { a, sortie } = await demander(K.deB64u(d0.defi, 32), avant.cred, 'ajouter cet appareil, cle existante', aidePour(avant));
    try {
      const corps = pourConnexion(a);
      const rendu = await api('/connexion', { defi: d0.defi, passkey: corps });
      (await accepter(rendu, { cred: corps.id, compte: corps.response.userHandle, sortie, fiche: avant, distante: a.authenticatorAttachment === 'cross-platform', synchro: synchronisable(a) })).fermer();
      const fiche = await stock.lire();
      if (!fiche || fiche.compte !== avant.compte || fiche.cred !== corps.id) refuser('StockChange');
      const etat = K.validerEtat(K.lireCanonique(te.encode(fiche.etat), K.TAILLE_ETAT));
      if (etat.passkeys.length >= 8) refuser('TropDAcces');
      const d = await api('/acces/defi', { compte: fiche.compte });
      K.controlerDuree(d.expire, maintenant());
      const defi = K.deB64u(d.defi, 32);
      let c;
      try {
        c = await appareil.creer({
          challenge: defi, rp: { name: nom, id: reglages.rpId }, user: { id: K.deB64u(fiche.compte, 16), name: nom, displayName: nom },
          pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
          excludeCredentials: etat.passkeys.map((x) => ({ type: 'public-key', id: K.deB64u(x.cred) })),
          // La clé doit vivre sur CET appareil : c'est tout l'objet du geste.
          authenticatorSelection: { authenticatorAttachment: 'platform', residentKey: 'required', requireResidentKey: true, userVerification: 'required' },
          attestation: 'none', timeout: 120000, extensions: extensionPrf,
        });
      } catch (e) { if (e && e.name === 'InvalidStateError') refuser('DejaUneCle'); throw e; }
      const cred = K.b64u(octets(c.rawId));
      dire('[ajouter cet appareil] ' + await decrire(c));
      if (personneVerifiee(c) === false) refuser('VerificationAbsente');
      const alg = ALGORITHMES[c.response.getPublicKeyAlgorithm()];
      if (!alg) refuser('PasskeyRefusee', 'algorithme');
      const cle = await K.empreinte(octets(c.response.getPublicKey()));
      const neuve = await demander(defi, cred, 'ajouter cet appareil, nouvelle cle', aidePourNeuve(c));
      let fait;
      try {
        K.controlerDuree(d.expire, maintenant());
        fait = await N.ajouterAcces({ coffre: etat.coffre, par: { cred: fiche.cred, sortiePrf: sortie }, sortiePrf: neuve.sortie,
          passkey: { cred: octets(c.rawId), alg, cle }, passkeys: etat.passkeys,
          contexte: { service: reglages.origine, environnement: reglages.environnement, projet: reglages.projet,
            compte: fiche.compte, defi: d.defi, expire: d.expire, avant: { version: fiche.version, empreinte: fiche.empreinte } } });
      } finally { neuve.sortie.fill(0); }
      const texte = new TextDecoder().decode(fait.etat);
      const ajout = { cred, transports: transportsDe(c) || undefined, synchro: synchronisable(c) === true || undefined, coffre: fait.coffre, etat: texte, message: K.b64u(fait.message), signature: K.b64u(fait.signature), version: fait.coffre.version, empreinte: fait.empreinte,
        envoi: { compte: fiche.compte, defi: d.defi, passkey: pourCreation(c), possession: pourConnexion(neuve.a), etat: texte, message: K.b64u(fait.message), signature: K.b64u(fait.signature) } };
      const enAttente = Object.assign({}, fiche, { ajout });
      await stock.remplacer(fiche, enAttente);   // l'ajout attend à côté de la fiche, qui reste valable
      dire('[ajouter cet appareil] nouvelle cle fabriquee | version ' + fait.coffre.version);
      return await envoyerAjout(enAttente);
    } finally { sortie.fill(0); }
  }
  async function envoyerAjout(fiche) {
    const ajout = fiche.ajout;
    let accuse;
    try { accuse = await api('/acces/ajouter', ajout.envoi); }
    catch (e) {
      dire('[ajouter cet appareil] pas encore garde chez nous : ' + (e && e.name));
      const attendre = coupure(e) || ['Complet', 'AdmissionRefusee'].includes(e && e.name);
      if (!attendre) {
        // Un refus après un envoi au résultat inconnu ne prouve rien : l'ajout a pu aboutir la première fois. Il reste
        // en attente ; la prochaine connexion, qui lit l'état signé par la clé du wallet, tranchera.
        if (ajout.incertain) return { adresse: fiche.coffre.adresse, garde: false, raison: e && e.name, inconnu: true };
        const sans = Object.assign({}, fiche); delete sans.ajout;
        await stock.remplacer(fiche, sans);
        dire('[ajouter cet appareil] ajout refuse pour de bon : rien ne change, le coffre s\'ouvre comme avant');
        return { adresse: fiche.coffre.adresse, garde: false, raison: e && e.name, annule: true };
      }
      if (coupure(e) && !ajout.incertain) await stock.remplacer(fiche, Object.assign({}, fiche, { ajout: Object.assign({}, ajout, { incertain: true }) }));
      return { adresse: fiche.coffre.adresse, garde: false, raison: e && e.name };
    }
    if (accuse.empreinte !== ajout.empreinte || accuse.adresse !== fiche.coffre.adresse || accuse.coffre !== fiche.coffre.id || accuse.version !== ajout.version) refuser('AccuseRefuse');
    const nouvelle = { compte: fiche.compte, cred: ajout.cred, coffre: ajout.coffre, etat: ajout.etat, message: ajout.message, signature: ajout.signature,
      version: ajout.version, empreinte: ajout.empreinte, garde: true };
    if (fiche.secours) nouvelle.secours = fiche.secours;
    if (fiche.recuperation) nouvelle.recuperation = fiche.recuperation;
    if (ajout.transports) nouvelle.transports = ajout.transports;
    if (ajout.synchro === true) nouvelle.synchro = true;
    await stock.remplacer(fiche, nouvelle);
    dire('[ajouter cet appareil] garde chez nous : oui | cet appareil a maintenant sa propre cle');
    return { adresse: fiche.coffre.adresse, garde: true };
  }

  // ---------- Régler ses adresses de secours, coffre ouvert. Un geste (la connexion : le coffre ouvert, et l'état
  // courant des adresses), puis la clé du wallet signe le réglage : inscrire à un rang l'adresse dont le code vient
  // d'être validé (demanderCode, validerCode), ou retirer la seconde. L'ancienne adresse n'est jamais demandée.
  // `rang` : 1 (l'adresse principale, qui se remplace mais ne se retire pas) ou 2 (la seconde).
  // Un réglage dont la réponse s'est peut-être perdue : { demande, preuve, rang, retirer, attendue }. Tant qu'il n'est
  // pas tranché, lui seul peut repartir, tel quel. Une AUTRE intention ne reçoit jamais son résultat à sa place :
  // sinon la page annoncerait « cette adresse est enregistrée » pour une adresse qui n'est jamais partie.
  let reglageParti = null;
  const reglageEnAttente = () => (reglageParti ? { rang: reglageParti.rang, retirer: reglageParti.retirer } : null);
  async function retenirAdresses(etat) {
    const adresses = lireAdresses(etat);
    if (!adresses) refuser('CandidatRefuse', 'adresses');
    const fiche = await stock.lire();
    if (fiche && JSON.stringify(fiche.recuperation) !== JSON.stringify(adresses)) await stock.remplacer(fiche, Object.assign({}, fiche, { recuperation: adresses }));
    return adresses;
  }
  // Ce que le serveur répond à un réglage, relu contre ce qui a été signé. `fait` est la génération produite par
  // CETTE opération ; le reste est l'état courant. Si les adresses ont encore été réglées depuis (`depasse`), l'état
  // courant n'est plus celui de cette opération : la page le dit, sans promettre que cette adresse sert encore.
  // Rend l'état courant ({ generation, adresses }), avec ce qui vient d'être conclu : { rang, retire, depasse }.
  async function conclureReglage(r, op) {
    const adresses = lireAdresses(r);
    if (!adresses || r.fait !== op.attendue || adresses.generation < op.attendue) refuser('CandidatRefuse', 'reglage');
    const depasse = adresses.generation !== op.attendue;
    if (!depasse && adresses.adresses.some((a) => a.rang === op.rang) === op.retirer) refuser('CandidatRefuse', 'reglage');
    await retenirAdresses(r);
    dire('[adresses] ' + (op.retirer ? 'seconde adresse retiree' : 'adresse inscrite au rang ' + op.rang) + (depasse ? ' | adresses reglees de nouveau depuis' : ''));
    return Object.assign({}, adresses, { rang: op.rang, retire: op.retirer, depasse });
  }
  // Le serveur a répondu oui. Le réglage ne cesse d'attendre qu'une fois sa réponse validée ET la copie de l'appareil
  // enregistrée : une réponse incohérente, ou un stockage qui refuse, ne prouvent pas qu'il n'a pas été écrit (le
  // serveur l'a peut-être bien fait). Il reste alors en attente, « à confirmer » : la même demande repartira, et son
  // reçu répondra. La page ne conclut jamais « non enregistré » là-dessus.
  async function confirmerReglage(r, op) {
    let resultat;
    try { resultat = await conclureReglage(r, op); }
    catch (e) { return refuser('ReglageAConfirmer', e && e.name); }
    if (reglageParti === op) reglageParti = null;
    if (op.preuve && op.preuve === preuveIdentite) preuveIdentite = null;   // elle a servi
    return resultat;
  }
  // Renvoyer tel quel le réglage dont la réponse s'était perdue. Aucun geste : la demande est déjà signée.
  async function reprendreReglage() {
    const op = reglageParti;
    if (!op) refuser('RienEnAttente');
    let r;
    try { r = await api('/adresse/regler', op.demande); }
    catch (e) {
      if (coupure(e)) throw e;
      // Le serveur refuse cette demande pour de bon : elle ne sera jamais acceptée, et elle n'attend plus. Cela ne
      // prouve pas à soi seul que rien n'avait été écrit (un reçu trop ancien a pu disparaître) : la page dit que le
      // serveur ne confirme pas, et la connexion suivante montre l'état réel des adresses.
      reglageParti = null;
      if (op.preuve && op.preuve === preuveIdentite && e && ['IdentiteRefusee', 'IdentiteDejaLiee', 'AdresseDejaInscrite'].includes(e.name)) preuveIdentite = null;
      throw e;
    }
    return confirmerReglage(r, op);
  }
  async function reglerAdresse(rang, options) {
    const retirer = !!(options && options.retirer);
    if (!avecRecuperation) refuser('RecuperationEteinte');
    if (reglageParti) {
      if (reglageParti.rang !== rang || reglageParti.retirer !== retirer || (!retirer && reglageParti.preuve !== preuveIdentite)) refuser('ReglageEnAttente');
      // La même intention : la demande repart telle quelle. Si le serveur ne l'a jamais reçue et que son défi a
      // expiré, ou si les adresses ont changé entre-temps, rien n'avait été écrit : elle est refaite, avec un geste.
      try { return await reprendreReglage(); }
      catch (e) { if (!e || (e.name !== 'DefiRefuse' && e.name !== 'GenerationRefusee')) throw e; }
    }
    if (!retirer && !preuveIdentite) refuser('IdentiteRequise');
    const session = await connecter();
    try {
      const fiche = await stock.lire();
      if (!fiche || !fiche.recuperation) refuser('RecuperationAbsente');
      const d = await api('/adresse/defi', { compte: fiche.compte });
      K.controlerDuree(d.expire, maintenant());
      const champs = { service: reglages.origine, environnement: reglages.environnement, projet: reglages.projet, compte: fiche.compte,
        defi: d.defi, expire: d.expire, rang, generation: fiche.recuperation.generation };
      if (!retirer) champs.identite = await K.empreinte(te.encode(preuveIdentite));
      const a = await session.reglerAdresse(champs);
      const demande = { compte: fiche.compte, defi: d.defi, message: K.b64u(a.message), signature: K.b64u(a.signature) };
      if (!retirer) demande.preuve = preuveIdentite;
      const op = { demande, preuve: retirer ? null : preuveIdentite, rang, retirer, attendue: fiche.recuperation.generation + 1 };
      reglageParti = op;
      let r;
      try { r = await api('/adresse/regler', demande); }
      catch (e) {
        if (coupure(e)) throw e;
        reglageParti = null;
        if (e && ['IdentiteRefusee', 'IdentiteDejaLiee', 'AdresseDejaInscrite'].includes(e.name)) preuveIdentite = null;
        throw e;
      }
      return await confirmerReglage(r, op);
    } finally { session.fermer(); }
  }

  // Abandonner une récupération en cours : ce qui était en mémoire est effacé. Rien n'était sur l'appareil.
  function abandonner() { oublierRetrouve(); defiLibre = null; if (remise) { remise.mots.fill(''); remise = null; } }

  return { creer, renvoyer, connecter, ouvrirLocal, accepter, prouver, signerOperation, demanderCode, validerCode, mission, retrouver, garder, abandonner, ajouterCetAppareil, reglerAdresse, reglageEnAttente, reprendreReglage,
    partirParPorte, revenirDePorte, oublierPorte };
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
