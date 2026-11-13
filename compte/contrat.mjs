// Le contrat des écritures signées et de la preuve locale. Sa description est dans CONTRAT.md.
// Le même fichier sert à la page et au serveur. Aucune dépendance : WebCrypto, TextEncoder, URL, atob et btoa.

const te = new TextEncoder();

export class Refus extends Error {
  constructor(nom, detail) { super(detail ? nom + ' (' + detail + ')' : nom); this.name = nom; this.detail = detail || ''; }
}
const refuser = (nom, detail) => { throw new Refus(nom, detail); };

// ---------- Encodages. Tous refusent une écriture qui n'est pas la seule écriture possible de ses octets.

export const hex = (octets) => Array.from(octets, (x) => x.toString(16).padStart(2, '0')).join('');
export function deHex(texte) {
  if (typeof texte !== 'string' || texte.length % 2 || !/^[0-9a-f]*$/.test(texte)) refuser('EncodageRefuse', 'hex');
  const o = new Uint8Array(texte.length / 2);
  for (let i = 0; i < o.length; i++) o[i] = parseInt(texte.slice(i * 2, i * 2 + 2), 16);
  return o;
}

export function b64u(octets) {
  let s = '';
  for (const x of octets) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
export function deB64u(texte, longueur) {
  if (typeof texte !== 'string' || !/^[A-Za-z0-9_-]*$/.test(texte) || texte.length % 4 === 1) refuser('EncodageRefuse', 'base64url');
  const brut = atob(texte.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (texte.length % 4)) % 4));
  const o = Uint8Array.from(brut, (c) => c.charCodeAt(0));
  if (b64u(o) !== texte) refuser('EncodageRefuse', 'base64url non canonique');
  if (longueur !== undefined && o.length !== longueur) refuser('EncodageRefuse', 'longueur');
  return o;
}

const ALPHABET58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
export function base58(octets) {
  let zeros = 0;
  while (zeros < octets.length && octets[zeros] === 0) zeros++;
  let n = 0n;
  for (const x of octets) n = n * 256n + BigInt(x);
  let s = '';
  while (n > 0n) { s = ALPHABET58[Number(n % 58n)] + s; n /= 58n; }
  return '1'.repeat(zeros) + s;
}
export function deBase58(texte, longueur) {
  if (typeof texte !== 'string' || !texte.length || texte.length > 64) refuser('EncodageRefuse', 'base58');
  let n = 0n;
  for (const c of texte) {
    const i = ALPHABET58.indexOf(c);
    if (i < 0) refuser('EncodageRefuse', 'base58');
    n = n * 58n + BigInt(i);
  }
  let zeros = 0;
  while (zeros < texte.length && texte[zeros] === '1') zeros++;
  const corps = [];
  while (n > 0n) { corps.unshift(Number(n % 256n)); n /= 256n; }
  const o = new Uint8Array(zeros + corps.length);
  o.set(corps, zeros);
  if (o.length !== longueur || base58(o) !== texte) refuser('EncodageRefuse', 'base58');
  return o;
}

// ---------- Forme canonique : RFC 8785, sur un domaine fermé.
// Clés en minuscules, chaînes ASCII d'un alphabet sans guillemet ni barre oblique inverse, entiers positifs sûrs,
// tableaux, objets. Ni nul, ni booléen, ni décimal. Dans ce domaine, la forme canonique est : clés triées par
// unités de code, aucun espace, aucune séquence d'échappement.

const CLE = /^[a-z]{1,16}$/;
const CHAINE = /^[A-Za-z0-9_.:\/-]*$/;
const PROFONDEUR = 6;

export function canoniser(valeur, niveau) {
  const n = niveau || 0;
  if (n > PROFONDEUR) refuser('NonCanonique', 'profondeur');
  if (typeof valeur === 'string') {
    if (!CHAINE.test(valeur)) refuser('NonCanonique', 'chaine');
    return '"' + valeur + '"';
  }
  if (typeof valeur === 'number') {
    if (!Number.isSafeInteger(valeur) || valeur < 0 || Object.is(valeur, -0)) refuser('NonCanonique', 'nombre');
    return String(valeur);
  }
  if (Array.isArray(valeur)) {
    const morceaux = [];
    for (let i = 0; i < valeur.length; i++) morceaux.push(canoniser(valeur[i], n + 1));
    return '[' + morceaux.join(',') + ']';
  }
  if (valeur && typeof valeur === 'object') {
    const proto = Object.getPrototypeOf(valeur);
    if (proto !== Object.prototype && proto !== null) refuser('NonCanonique', 'type');
    const cles = Object.keys(valeur).sort();
    for (const k of cles) if (!CLE.test(k)) refuser('NonCanonique', 'cle');
    return '{' + cles.map((k) => '"' + k + '":' + canoniser(valeur[k], n + 1)).join(',') + '}';
  }
  return refuser('NonCanonique', 'type');
}

// On compare les octets reçus, tels quels, à la forme canonique de ce qu'ils décrivent. Un doublon de clé,
// un espace, un ordre différent, une autre écriture d'un nombre ou d'un caractère : refus.
export function lireCanonique(octets, tailleMax) {
  if (!(octets instanceof Uint8Array) || octets.length === 0 || octets.length > tailleMax) refuser('TailleRefusee');
  let texte = '';
  for (const x of octets) {
    if (x < 0x20 || x > 0x7e) refuser('NonCanonique', 'octet');
    texte += String.fromCharCode(x);
  }
  let objet;
  try { objet = JSON.parse(texte); } catch (_) { refuser('NonCanonique', 'json'); }
  if (canoniser(objet) !== texte) refuser('NonCanonique', 'forme');
  return objet;
}

// ---------- Schémas fermés

export const PROTOCOLE_GESTION = 'coffre-gestion/1';
export const PROTOCOLE_PREUVE = 'coffre-preuve/1';
export const TAILLE_CONTENU = 4096;   // contenu d'un message signé
export const TAILLE_ETAT = 32768;     // état autorisé, sous sa forme canonique
const ACTIONS = ['creer', 'ajouter-acces', 'attester-secours'];
const ALGORITHMES = ['ES256', 'RS256'];
const IDENTIFIANT = /^[A-Za-z0-9_-]{22}$/;
const NOM = /^[a-z0-9-]{1,32}$/;
const VERSION_MAX = 1000000000;

function objetExact(o, cles, nom) {
  if (!o || typeof o !== 'object' || Array.isArray(o)) refuser('SchemaRefuse', nom);
  if (Object.keys(o).sort().join(',') !== cles.slice().sort().join(',')) refuser('SchemaRefuse', nom + ' : champs');
}
function octets(v, longueur, nom) {
  try { return deB64u(v, longueur); } catch (_) { return refuser('SchemaRefuse', nom); }
}
function entier(v, min, max, nom) {
  if (!Number.isSafeInteger(v) || v < min || v > max) refuser('SchemaRefuse', nom);
}
function identifiant(v, nom) {
  if (typeof v !== 'string' || !IDENTIFIANT.test(v)) refuser('SchemaRefuse', nom);
  octets(v, 16, nom);
}
function nomCourt(v, nom) { if (typeof v !== 'string' || !NOM.test(v)) refuser('SchemaRefuse', nom); }
function adresse(v, nom) { try { deBase58(v, 32); } catch (_) { refuser('SchemaRefuse', nom); } }
function credential(v, nom) {
  const o = octets(v, undefined, nom);
  if (o.length < 1 || o.length > 1023) refuser('SchemaRefuse', nom);
}
// L'origine complète de la page du coffre : schéma, hôte, port s'il n'est pas celui par défaut. Rien d'autre.
function service(v) {
  if (typeof v !== 'string' || v.length > 255) refuser('SchemaRefuse', 'service');
  let u;
  try { u = new URL(v); } catch (_) { return refuser('SchemaRefuse', 'service'); }
  const local = u.protocol === 'http:' && u.hostname === 'localhost';
  if (u.origin !== v || (u.protocol !== 'https:' && !local)) refuser('SchemaRefuse', 'service');
}
function passkey(p, nom) {
  objetExact(p, ['cred', 'alg', 'cle'], nom);
  credential(p.cred, nom + ' : cred');
  if (!ALGORITHMES.includes(p.alg)) refuser('SchemaRefuse', nom + ' : alg');
  octets(p.cle, 32, nom + ' : cle');
}
function versionEtEmpreinte(x, nom) {
  objetExact(x, ['version', 'empreinte'], nom);
  entier(x.version, 1, VERSION_MAX, nom + ' : version');
  octets(x.empreinte, 32, nom + ' : empreinte');
}

// Le coffre fermé, version 2 : la version 1, plus un numéro de version et plusieurs accès passkey possibles.
// Le secours est toujours le dernier accès.
export function validerCoffre(c, limites) {
  const maxPasskeys = (limites && limites.accesPasskey) || 8;
  objetExact(c, ['format', 'v', 'id', 'adresse', 'version', 'cle', 'acces', 'rappel'], 'coffre');
  if (c.format !== 'coffre' || c.v !== 2) refuser('SchemaRefuse', 'coffre : format');
  identifiant(c.id, 'coffre : id');
  adresse(c.adresse, 'coffre : adresse');
  entier(c.version, 1, VERSION_MAX, 'coffre : version');
  objetExact(c.cle, ['iv', 'ct'], 'coffre : cle');
  octets(c.cle.iv, 12, 'cle : iv');
  octets(c.cle.ct, 64, 'cle : ct');
  if (!Array.isArray(c.acces) || c.acces.length < 2 || c.acces.length > maxPasskeys + 1) refuser('SchemaRefuse', 'coffre : acces');
  const vus = new Set();
  for (let i = 0; i < c.acces.length; i++) {
    const a = c.acces[i];
    if (i === c.acces.length - 1) {
      objetExact(a, ['type', 'langue', 'sel', 'iv', 'ct'], 'secours');
      if (a.type !== 'secours' || (a.langue !== 'fr' && a.langue !== 'en')) refuser('SchemaRefuse', 'secours');
    } else {
      objetExact(a, ['type', 'cred', 'sel', 'iv', 'ct'], 'acces');
      if (a.type !== 'passkey') refuser('SchemaRefuse', 'acces : type');
      credential(a.cred, 'acces : cred');
      if (vus.has(a.cred)) refuser('SchemaRefuse', 'acces : doublon');
      vus.add(a.cred);
    }
    octets(a.sel, 32, 'acces : sel');
    octets(a.iv, 12, 'acces : iv');
    octets(a.ct, 48, 'acces : ct');
  }
  objetExact(c.rappel, ['iv', 'ct'], 'coffre : rappel');
  octets(c.rappel.iv, 12, 'rappel : iv');
  octets(c.rappel.ct, 32, 'rappel : ct');
  return c;
}

// L'état autorisé : le coffre fermé et les passkeys inscrites, une par accès passkey, dans le même ordre.
// Il ne contient ni sa propre empreinte ni aucune signature.
export function validerEtat(e, limites) {
  objetExact(e, ['coffre', 'passkeys'], 'etat');
  validerCoffre(e.coffre, limites);
  const n = e.coffre.acces.length - 1;
  if (!Array.isArray(e.passkeys) || e.passkeys.length !== n) refuser('SchemaRefuse', 'etat : passkeys');
  for (let i = 0; i < n; i++) {
    passkey(e.passkeys[i], 'etat : passkey');
    if (e.passkeys[i].cred !== e.coffre.acces[i].cred) refuser('SchemaRefuse', 'etat : ordre des passkeys');
  }
  return e;
}

const COMMUNS = ['protocole', 'service', 'environnement', 'action', 'projet', 'compte', 'coffre', 'adresse', 'defi', 'expire'];
const PAR_ACTION = {
  'creer': ['inscription', 'apres', 'passkey'],
  'ajouter-acces': ['avant', 'apres', 'passkey'],
  'attester-secours': ['avant', 'secours'],
};

// Le contenu d'un message de gestion. Un champ qui n'appartient pas à l'action doit être absent.
export function validerGestion(g) {
  if (!g || typeof g !== 'object' || Array.isArray(g)) refuser('SchemaRefuse', 'gestion');
  if (g.protocole !== PROTOCOLE_GESTION) refuser('SchemaRefuse', 'protocole');
  if (typeof g.action !== 'string' || !ACTIONS.includes(g.action)) refuser('SchemaRefuse', 'action');
  objetExact(g, COMMUNS.concat(PAR_ACTION[g.action]), 'gestion');
  service(g.service);
  nomCourt(g.environnement, 'environnement');
  nomCourt(g.projet, 'projet');
  identifiant(g.compte, 'compte');
  identifiant(g.coffre, 'coffre');
  adresse(g.adresse, 'adresse');
  octets(g.defi, 32, 'defi');
  entier(g.expire, 1, 100000000000, 'expire');
  if (g.action === 'creer') {
    identifiant(g.inscription, 'inscription');
    versionEtEmpreinte(g.apres, 'apres');
    if (g.apres.version !== 1) refuser('SchemaRefuse', 'apres : version');
    passkey(g.passkey, 'passkey');
  } else if (g.action === 'ajouter-acces') {
    versionEtEmpreinte(g.avant, 'avant');
    versionEtEmpreinte(g.apres, 'apres');
    if (g.apres.version !== g.avant.version + 1) refuser('SchemaRefuse', 'apres : version');
    passkey(g.passkey, 'passkey');
  } else {
    versionEtEmpreinte(g.avant, 'avant');
    objetExact(g.secours, ['acces', 'declaration'], 'secours');
    octets(g.secours.acces, 32, 'secours : acces');
    if (g.secours.declaration !== 'fait') refuser('SchemaRefuse', 'secours : declaration');
  }
  return g;
}

// Le contenu de la preuve locale (E5). Elle ne quitte jamais la page.
export function validerPreuve(p) {
  objetExact(p, ['protocole', 'coffre', 'adresse', 'alea'], 'preuve');
  if (p.protocole !== PROTOCOLE_PREUVE) refuser('SchemaRefuse', 'protocole');
  identifiant(p.coffre, 'coffre');
  adresse(p.adresse, 'adresse');
  octets(p.alea, 32, 'alea');
  return p;
}

// ---------- Le message signé : message hors chaîne de Solana, version 1, un seul signataire.
// 16 octets de domaine (0xFF puis « solana offchain »), version 01, nombre de signataires 01,
// clé publique du signataire, puis le contenu. Le premier octet interdit qu'il soit une transaction.

const DOMAINE = Uint8Array.of(0xff, 0x73, 0x6f, 0x6c, 0x61, 0x6e, 0x61, 0x20, 0x6f, 0x66, 0x66, 0x63, 0x68, 0x61, 0x69, 0x6e);
const PREAMBULE = 50;

export function messageHorsChaine(signataire, contenu) {
  if (!(signataire instanceof Uint8Array) || signataire.length !== 32) refuser('MessageRefuse', 'signataire');
  if (!(contenu instanceof Uint8Array) || contenu.length === 0) refuser('MessageRefuse', 'contenu');
  const m = new Uint8Array(PREAMBULE + contenu.length);
  m.set(DOMAINE, 0);
  m[16] = 1;
  m[17] = 1;
  m.set(signataire, 18);
  m.set(contenu, PREAMBULE);
  return m;
}
export function lireMessageHorsChaine(message, tailleContenu) {
  if (!(message instanceof Uint8Array) || message.length <= PREAMBULE || message.length > PREAMBULE + tailleContenu) refuser('TailleRefusee', 'message');
  for (let i = 0; i < 16; i++) if (message[i] !== DOMAINE[i]) refuser('MessageRefuse', 'domaine');
  if (message[16] !== 1) refuser('MessageRefuse', 'version');
  if (message[17] !== 1) refuser('MessageRefuse', 'signataires');
  return { signataire: message.slice(18, PREAMBULE), contenu: message.slice(PREAMBULE) };
}

// ---------- Empreintes et signatures

export async function empreinte(donnees) {
  return b64u(new Uint8Array(await crypto.subtle.digest('SHA-256', donnees)));
}
export async function signer(clePrivee, message) {
  return new Uint8Array(await crypto.subtle.sign({ name: 'Ed25519' }, clePrivee, message));
}
export async function verifierSignature(signataire, signature, message) {
  if (!(signature instanceof Uint8Array) || signature.length !== 64) return false;
  let cle;
  try { cle = await crypto.subtle.importKey('raw', signataire, { name: 'Ed25519' }, false, ['verify']); } catch (_) { return false; }
  return crypto.subtle.verify({ name: 'Ed25519' }, cle, signature, message);
}

// ---------- Fabriquer. La page construit elle-même ce qu'elle signe : elle ne signe jamais des octets reçus.

export function octetsEtat(etat, limites) {
  const t = canoniser(validerEtat(etat, limites));
  if (t.length > TAILLE_ETAT) refuser('TailleRefusee', 'etat');
  return te.encode(t);
}
export function contenuGestion(champs) {
  const t = canoniser(validerGestion(Object.assign({ protocole: PROTOCOLE_GESTION }, champs)));
  if (t.length > TAILLE_CONTENU) refuser('TailleRefusee', 'contenu');
  return te.encode(t);
}
export function contenuPreuve(champs) {
  return te.encode(canoniser(validerPreuve(Object.assign({ protocole: PROTOCOLE_PREUVE }, champs))));
}

// La preuve locale : la clé qui vient d'être retrouvée signe, et la signature est vérifiée avec l'adresse
// inscrite dans le coffre. Aucun défi du serveur, aucun envoi.
export async function fairePreuve(clePrivee, coffre) {
  const alea = b64u(crypto.getRandomValues(new Uint8Array(32)));
  const message = messageHorsChaine(deBase58(coffre.adresse, 32), contenuPreuve({ coffre: coffre.id, adresse: coffre.adresse, alea }));
  return { message, signature: await signer(clePrivee, message) };
}
export async function verifierPreuve(preuve, coffre) {
  const { signataire, contenu } = lireMessageHorsChaine(preuve.message, TAILLE_CONTENU);
  const p = validerPreuve(lireCanonique(contenu, TAILLE_CONTENU));
  if (p.coffre !== coffre.id || p.adresse !== coffre.adresse || base58(signataire) !== p.adresse) refuser('PreuveRefusee', 'contexte');
  if (!(await verifierSignature(signataire, preuve.signature, preuve.message))) refuser('PreuveRefusee', 'signature');
  return true;
}

// ---------- Contrôler une création (le serveur). Tout ce qui ne dépend ni de l'heure ni de la base.
// `attendu` vient de la configuration du serveur et de la réservation, jamais de la demande :
// { service, environnement, projet, compte, inscription, defi, expire, passkey: { cred, alg, cle } }.
// Le défi et l'expiration sont ceux que le serveur a fixés à la réservation : un message qui en annonce d'autres,
// même correctement signé, est refusé. Un champ oublié dans `attendu` fait refuser : on ne compare jamais à rien.
// L'appelant traite ensuite, dans cet ordre : la création déjà aboutie (mêmes octets du message : même accusé,
// aucune écriture), sinon la fraîcheur (controlerFraicheur, défi non consommé) et l'écriture atomique.
export async function controlerCreation(corps, attendu) {
  const { signataire, contenu } = lireMessageHorsChaine(corps.message, TAILLE_CONTENU);
  const g = validerGestion(lireCanonique(contenu, TAILLE_CONTENU));
  if (g.action !== 'creer') refuser('ContexteRefuse', 'action');
  if (g.service !== attendu.service || g.environnement !== attendu.environnement) refuser('ContexteRefuse', 'service');
  if (g.projet !== attendu.projet || g.compte !== attendu.compte || g.inscription !== attendu.inscription) refuser('ContexteRefuse', 'reservation');
  const e = validerEtat(lireCanonique(corps.etat, TAILLE_ETAT), { accesPasskey: 1 });
  if (g.adresse !== e.coffre.adresse || base58(signataire) !== g.adresse) refuser('SignataireRefuse');
  if (g.coffre !== e.coffre.id) refuser('EtatRefuse', 'identifiant');
  if (!(await verifierSignature(signataire, corps.signature, corps.message))) refuser('SignatureRefusee');
  if (typeof attendu.defi !== 'string' || g.defi !== attendu.defi) refuser('DefiRefuse');
  if (!Number.isSafeInteger(attendu.expire) || g.expire !== attendu.expire) refuser('ExpirationRefusee');
  if (e.coffre.version !== 1 || g.apres.empreinte !== (await empreinte(corps.etat))) refuser('EtatRefuse', 'empreinte');
  for (const p of [g.passkey, e.passkeys[0]]) {
    if (p.cred !== attendu.passkey.cred || p.alg !== attendu.passkey.alg || p.cle !== attendu.passkey.cle) refuser('PasskeyRefusee');
  }
  return { gestion: g, etat: e, adresse: g.adresse, coffre: g.coffre, version: 1, empreinte: g.apres.empreinte };
}
// L'heure se juge sur l'expiration de la réservation, celle que le serveur a fixée, jamais sur celle d'une demande.
// Ce contrôle ne remplace pas celui de la base : dans la transaction d'écriture, le serveur revérifie l'heure
// et que le défi n'a pas déjà servi.
export function controlerFraicheur(reservation, maintenant) {
  if (!reservation || !Number.isSafeInteger(reservation.expire) || !Number.isSafeInteger(maintenant) || reservation.expire <= maintenant) refuser('Expire');
}

// Les durées, communes à la page et au serveur.
export const DUREE_RESERVATION = 300;   // secondes : ce que vit une réservation, ou un défi de connexion
export const TOLERANCE_HORLOGE = 120;   // secondes d'écart admises entre l'horloge d'un appareil et celle du serveur

// Ce que la page vérifie avant le geste, puis avant de signer : l'expiration annoncée par le serveur n'est ni
// passée, ni plus lointaine que ce qu'une réservation peut durer. Au-delà de la tolérance, elle ne signe pas.
export function controlerDuree(expire, maintenant) {
  if (!Number.isSafeInteger(expire) || !Number.isSafeInteger(maintenant)) refuser('ExpirationRefusee');
  if (expire <= maintenant - TOLERANCE_HORLOGE || expire > maintenant + DUREE_RESERVATION + TOLERANCE_HORLOGE) refuser('ExpirationRefusee');
}

// ---------- Relire un état déjà accepté (la page, à chaque connexion). Le défi d'origine est consommé et
// l'expiration dépassée depuis longtemps : cela n'empêche pas de relire. `attendu` donne le service,
// l'environnement et le projet, et ce que l'appareil connaît déjà : compte, coffre, adresse, passkey du geste.
// Ce contrôle ne vaut pas ouverture : la copie de l'appareil n'est remplacée qu'après la preuve locale.
export async function relireEtat(corps, attendu) {
  const { signataire, contenu } = lireMessageHorsChaine(corps.message, TAILLE_CONTENU);
  const g = validerGestion(lireCanonique(contenu, TAILLE_CONTENU));
  if (g.action === 'attester-secours') refuser('ContexteRefuse', 'action');
  if (g.service !== attendu.service || g.environnement !== attendu.environnement || g.projet !== attendu.projet) refuser('ContexteRefuse', 'service');
  const e = validerEtat(lireCanonique(corps.etat, TAILLE_ETAT));
  if (g.adresse !== e.coffre.adresse || base58(signataire) !== g.adresse || g.coffre !== e.coffre.id) refuser('SignataireRefuse');
  for (const champ of ['compte', 'coffre', 'adresse']) {
    if (attendu[champ] !== undefined && attendu[champ] !== g[champ]) refuser('ContexteRefuse', champ);
  }
  if (attendu.cred !== undefined && !e.passkeys.some((p) => p.cred === attendu.cred)) refuser('PasskeyRefusee');
  if (!(await verifierSignature(signataire, corps.signature, corps.message))) refuser('SignatureRefusee');
  if (g.apres.version !== e.coffre.version || g.apres.empreinte !== (await empreinte(corps.etat))) refuser('EtatRefuse', 'empreinte');
  return { gestion: g, etat: e, version: e.coffre.version, empreinte: g.apres.empreinte };
}
