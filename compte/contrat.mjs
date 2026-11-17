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
export const PROTOCOLE_CONNEXION = 'coffre-connexion/1';
export const DUREE_CONNEXION = 300;    // secondes : ce que vaut une preuve de connexion à un jeu
export const TAILLE_CONTENU = 4096;   // contenu d'un message signé
export const TAILLE_ETAT = 32768;     // état autorisé, sous sa forme canonique
const ACTIONS = ['creer', 'ajouter-acces', 'attester-secours', 'regler-adresse'];
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

// Le coffre fermé. Version 2 : un numéro de version et plusieurs accès passkey possibles. Version 3 : la même,
// et l'accès de secours porte en plus son vérifieur, la clé publique de la clé de récupération (RECUPERATION.md).
// Le vérifieur est donc dans l'état autorisé dès la création, et ne circule jamais sans le coffre fermé.
// Le secours est toujours le dernier accès.
export function validerCoffre(c, limites) {
  const maxPasskeys = (limites && limites.accesPasskey) || 8;
  objetExact(c, ['format', 'v', 'id', 'adresse', 'version', 'cle', 'acces', 'rappel'], 'coffre');
  if (c.format !== 'coffre' || (c.v !== 2 && c.v !== 3)) refuser('SchemaRefuse', 'coffre : format');
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
      objetExact(a, c.v === 3 ? ['type', 'langue', 'sel', 'iv', 'ct', 'verifieur'] : ['type', 'langue', 'sel', 'iv', 'ct'], 'secours');
      if (a.type !== 'secours' || (a.langue !== 'fr' && a.langue !== 'en')) refuser('SchemaRefuse', 'secours');
      if (c.v === 3) octets(a.verifieur, 32, 'secours : verifieur');
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
  'regler-adresse': ['rang', 'generation'],
};

// Le contenu d'un message de gestion. Un champ qui n'appartient pas à l'action doit être absent.
// Un seul champ est facultatif : `identite`, dans « attester-secours » et « regler-adresse ». C'est l'empreinte du
// jeton de la preuve d'identité que le joueur vient d'obtenir : la clé du wallet désigne ainsi elle-même l'identité
// qui pourra demander la remise du coffre.
//   attester-secours : présent quand le service a la récupération, absent sinon ;
//   regler-adresse   : présent pour inscrire cette identité comme adresse de secours au rang donné (1 ou 2), à la
//                      place de celle qui s'y trouve ; absent pour retirer l'adresse du rang 2. Le rang 1 ne se
//                      retire pas : il se remplace. `generation` est celle que la page connaît : l'opération ne
//                      vaut que pour elle, et la fait avancer d'un.
export function validerGestion(g) {
  if (!g || typeof g !== 'object' || Array.isArray(g)) refuser('SchemaRefuse', 'gestion');
  if (g.protocole !== PROTOCOLE_GESTION) refuser('SchemaRefuse', 'protocole');
  if (typeof g.action !== 'string' || !ACTIONS.includes(g.action)) refuser('SchemaRefuse', 'action');
  const lie = (g.action === 'attester-secours' || g.action === 'regler-adresse') && Object.prototype.hasOwnProperty.call(g, 'identite');
  objetExact(g, COMMUNS.concat(PAR_ACTION[g.action], lie ? ['identite'] : []), 'gestion');
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
  } else if (g.action === 'regler-adresse') {
    entier(g.rang, 1, 2, 'rang');
    entier(g.generation, 1, VERSION_MAX, 'generation');
    if (lie) octets(g.identite, 32, 'identite');
    else if (g.rang !== 2) refuser('SchemaRefuse', 'la premiere adresse ne se retire pas');
  } else {
    versionEtEmpreinte(g.avant, 'avant');
    objetExact(g.secours, ['acces', 'declaration'], 'secours');
    octets(g.secours.acces, 32, 'secours : acces');
    if (g.secours.declaration !== 'fait') refuser('SchemaRefuse', 'secours : declaration');
    if (lie) octets(g.identite, 32, 'identite');
  }
  return g;
}

// Le message de récupération : « je connais les 12 mots de ce coffre », signé par la clé de récupération (celle
// dont le vérifieur est inscrit dans l'accès de secours), jamais par la clé du wallet. Tous les champs sont
// explicites, et `operation` ne prend qu'une valeur : ce message ne sert qu'à se faire remettre le coffre fermé.
export const PROTOCOLE_RECUPERATION = 'coffre-recuperation/1';
export function validerRecuperation(r) {
  objetExact(r, ['protocole', 'service', 'environnement', 'projet', 'compte', 'coffre', 'generation', 'operation', 'defi', 'expire'], 'recuperation');
  if (r.protocole !== PROTOCOLE_RECUPERATION) refuser('SchemaRefuse', 'protocole');
  if (r.operation !== 'ouvrir') refuser('SchemaRefuse', 'operation');
  service(r.service);
  nomCourt(r.environnement, 'environnement');
  nomCourt(r.projet, 'projet');
  identifiant(r.compte, 'compte');
  identifiant(r.coffre, 'coffre');
  entier(r.generation, 1, VERSION_MAX, 'generation');
  octets(r.defi, 32, 'defi');
  entier(r.expire, 1, 100000000000, 'expire');
  return r;
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

// La preuve de connexion à un jeu : « ce wallet se connecte à ce jeu, pour ce défi, à cette heure ».
// `jeu` est l'origine complète du jeu, comme `service` est celle de la page du coffre. `defi` est choisi par le jeu.
const DEFI_JEU = /^[A-Za-z0-9_-]{16,128}$/;
function origineJeu(v) {
  if (typeof v !== 'string' || v.length > 255) refuser('SchemaRefuse', 'jeu');
  let u;
  try { u = new URL(v); } catch (_) { return refuser('SchemaRefuse', 'jeu'); }
  const local = u.protocol === 'http:' && u.hostname === 'localhost';
  if (u.origin !== v || (u.protocol !== 'https:' && !local)) refuser('SchemaRefuse', 'jeu');
}
export function validerConnexion(c) {
  objetExact(c, ['protocole', 'service', 'jeu', 'adresse', 'defi', 'emis', 'expire'], 'connexion');
  if (c.protocole !== PROTOCOLE_CONNEXION) refuser('SchemaRefuse', 'protocole');
  service(c.service);
  origineJeu(c.jeu);
  adresse(c.adresse, 'adresse');
  if (typeof c.defi !== 'string' || !DEFI_JEU.test(c.defi)) refuser('SchemaRefuse', 'defi');
  entier(c.emis, 1, 99999999999, 'emis');
  entier(c.expire, 1, 99999999999, 'expire');
  if (c.expire <= c.emis || c.expire - c.emis > DUREE_CONNEXION) refuser('SchemaRefuse', 'duree');
  return c;
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
export function contenuRecuperation(champs) {
  return te.encode(canoniser(validerRecuperation(Object.assign({ protocole: PROTOCOLE_RECUPERATION, operation: 'ouvrir' }, champs))));
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

// ---------- Se connecter à un jeu. La clé du wallet signe elle-même ; aucun serveur ne se porte garant.
// La preuve ne vaut que pour ce jeu (son origine est dans ce qui est signé), pour ce défi, et quelques minutes.
// Elle ne peut pas être une transaction : c'est un message hors chaîne, comme les autres.
export function contenuConnexion(champs) {
  return te.encode(canoniser(validerConnexion(Object.assign({ protocole: PROTOCOLE_CONNEXION }, champs))));
}
export async function faireConnexionJeu(clePrivee, { service: s, jeu, adresse: a, defi, maintenant }) {
  const message = messageHorsChaine(deBase58(a, 32), contenuConnexion({ service: s, jeu, adresse: a, defi, emis: maintenant, expire: maintenant + DUREE_CONNEXION }));
  return { message, signature: await signer(clePrivee, message) };
}
// Ce que le serveur d'un jeu vérifie avant de connecter un joueur. `attendu` vient du jeu lui-même, jamais de ce
// qu'il a reçu : { service (l'adresse de la page du coffre), jeu (sa propre origine), defi (celui qu'il a émis pour
// cette tentative, et qu'il ne doit accepter qu'une fois), maintenant }. Rend l'adresse du wallet : c'est
// l'identité du joueur. L'heure signée est celle de l'appareil du joueur : c'est le défi qui empêche le rejeu.
export async function verifierConnexionJeu(preuve, attendu) {
  const { signataire, contenu } = lireMessageHorsChaine(preuve.message, TAILLE_CONTENU);
  const c = validerConnexion(lireCanonique(contenu, TAILLE_CONTENU));
  if (typeof attendu.service !== 'string' || c.service !== attendu.service) refuser('ConnexionRefusee', 'service');
  if (typeof attendu.jeu !== 'string' || c.jeu !== attendu.jeu) refuser('ConnexionRefusee', 'jeu');
  if (typeof attendu.defi !== 'string' || c.defi !== attendu.defi) refuser('ConnexionRefusee', 'defi');
  if (base58(signataire) !== c.adresse) refuser('ConnexionRefusee', 'signataire');
  if (!Number.isSafeInteger(attendu.maintenant) || c.expire <= attendu.maintenant - TOLERANCE_HORLOGE || c.emis > attendu.maintenant + TOLERANCE_HORLOGE) refuser('ConnexionRefusee', 'heure');
  if (!(await verifierSignature(signataire, preuve.signature, preuve.message))) refuser('ConnexionRefusee', 'signature');
  return { adresse: c.adresse, emis: c.emis, expire: c.expire };
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

// ---------- Attester le secours. La mission est faite : la clé du wallet déclare que l'accès de secours en place
// a servi à une vraie restauration dans notre page. L'état gardé ne change pas : l'attestation se range à côté.
// Elle désigne l'accès de secours par son empreinte : si cet accès est remplacé un jour, elle ne vaut plus.
// Elle ne prouve pas qu'un papier est rangé quelque part.
export async function empreinteAccesSecours(coffre) {
  return empreinte(te.encode(canoniser(coffre.acces[coffre.acces.length - 1])));
}
// Ce que le serveur contrôle. `attendu` vient de sa configuration, de sa base et du défi qu'il a émis pour ce
// compte, jamais de la demande :
// { service, environnement, projet, compte, coffre, adresse, defi, expire, version, empreinte, acces, identite }.
// `identite` : l'empreinte du jeton de la preuve d'identité reçue avec la demande, ou `null` quand le service
// n'en attend pas (la déclaration ne doit alors pas en porter). Un autre jeton, même valable, donne une autre
// empreinte : la signature du wallet ne le couvre pas.
// Un champ oublié dans `attendu` fait refuser. L'appelant consomme ensuite le défi, dans l'écriture elle-même.
export async function controlerAttestation(corps, attendu) {
  const { signataire, contenu } = lireMessageHorsChaine(corps.message, TAILLE_CONTENU);
  const g = validerGestion(lireCanonique(contenu, TAILLE_CONTENU));
  if (g.action !== 'attester-secours') refuser('ContexteRefuse', 'action');
  for (const champ of ['service', 'environnement', 'projet', 'compte', 'coffre', 'adresse']) {
    if (typeof attendu[champ] !== 'string' || g[champ] !== attendu[champ]) refuser('ContexteRefuse', champ);
  }
  if (base58(signataire) !== g.adresse) refuser('SignataireRefuse');
  if (!(await verifierSignature(signataire, corps.signature, corps.message))) refuser('SignatureRefusee');
  if (typeof attendu.defi !== 'string' || g.defi !== attendu.defi) refuser('DefiRefuse');
  if (!Number.isSafeInteger(attendu.expire) || g.expire !== attendu.expire) refuser('ExpirationRefusee');
  if (!Number.isSafeInteger(attendu.version) || typeof attendu.empreinte !== 'string'
    || g.avant.version !== attendu.version || g.avant.empreinte !== attendu.empreinte) refuser('EtatRefuse', 'version');
  if (typeof attendu.acces !== 'string' || g.secours.acces !== attendu.acces) refuser('EtatRefuse', 'acces de secours');
  if (attendu.identite === null) { if (g.identite !== undefined) refuser('ContexteRefuse', 'identite inattendue'); }
  else if (typeof attendu.identite !== 'string' || g.identite !== attendu.identite) refuser('ContexteRefuse', 'identite');
  return { gestion: g, version: g.avant.version, identite: g.identite === undefined ? null : g.identite };
}
// Ce que la page relit quand une attestation lui revient (du serveur, ou de sa propre copie) : signée par le wallet
// de ce coffre, pour ce compte, et désignant l'accès de secours que ce coffre porte aujourd'hui. Le défi est consommé
// depuis longtemps : cela n'empêche pas de relire. `attendu` : { service, environnement, projet, compte, coffre },
// où `coffre` est le coffre fermé que la page vient d'accepter.
export async function relireAttestation(corps, attendu) {
  const { signataire, contenu } = lireMessageHorsChaine(corps.message, TAILLE_CONTENU);
  const g = validerGestion(lireCanonique(contenu, TAILLE_CONTENU));
  if (g.action !== 'attester-secours') refuser('ContexteRefuse', 'action');
  const c = attendu.coffre;
  if (g.service !== attendu.service || g.environnement !== attendu.environnement || g.projet !== attendu.projet) refuser('ContexteRefuse', 'service');
  if (typeof attendu.compte !== 'string' || g.compte !== attendu.compte) refuser('ContexteRefuse', 'compte');
  if (!c || g.coffre !== c.id || g.adresse !== c.adresse || base58(signataire) !== c.adresse) refuser('ContexteRefuse', 'coffre');
  if (g.avant.version > c.version) refuser('EtatRefuse', 'version');
  if (g.secours.acces !== (await empreinteAccesSecours(c))) refuser('EtatRefuse', 'acces de secours');
  if (!(await verifierSignature(signataire, corps.signature, corps.message))) refuser('SignatureRefusee');
  return { identite: g.identite !== undefined };   // la déclaration désigne-t-elle une identité de récupération ?
}

// ---------- Régler une adresse de secours (le serveur). La clé du wallet inscrit une identité à un rang, ou retire
// celle du rang 2. `attendu` vient de la configuration, de la base et du défi émis pour ce compte :
// { service, environnement, projet, compte, coffre, adresse, defi, expire, generation, identite }.
// `identite` : l'empreinte du jeton de la preuve d'identité reçue avec la demande, ou `null` si la demande n'en
// porte pas (le message ne doit alors pas en porter : c'est un retrait). Un champ oublié fait refuser.
export async function controlerReglage(corps, attendu) {
  const { signataire, contenu } = lireMessageHorsChaine(corps.message, TAILLE_CONTENU);
  const g = validerGestion(lireCanonique(contenu, TAILLE_CONTENU));
  if (g.action !== 'regler-adresse') refuser('ContexteRefuse', 'action');
  for (const champ of ['service', 'environnement', 'projet', 'compte', 'coffre', 'adresse']) {
    if (typeof attendu[champ] !== 'string' || g[champ] !== attendu[champ]) refuser('ContexteRefuse', champ);
  }
  if (base58(signataire) !== g.adresse) refuser('SignataireRefuse');
  if (!(await verifierSignature(signataire, corps.signature, corps.message))) refuser('SignatureRefusee');
  if (typeof attendu.defi !== 'string' || g.defi !== attendu.defi) refuser('DefiRefuse');
  if (!Number.isSafeInteger(attendu.expire) || g.expire !== attendu.expire) refuser('ExpirationRefusee');
  if (!Number.isSafeInteger(attendu.generation) || g.generation !== attendu.generation) refuser('GenerationRefusee');
  if (attendu.identite === null) { if (g.identite !== undefined) refuser('ContexteRefuse', 'identite inattendue'); }
  else if (typeof attendu.identite !== 'string' || g.identite !== attendu.identite) refuser('ContexteRefuse', 'identite');
  return { gestion: g, rang: g.rang, generation: g.generation, identite: g.identite === undefined ? null : g.identite };
}

// ---------- La remise du coffre fermé contre une preuve des 12 mots (le serveur). `attendu` vient de sa
// configuration et de l'ouverture qu'il a rangée en émettant le défi, jamais de la demande :
// { service, environnement, projet, compte, coffre, generation, defi, expire, verifieur }.
// `verifieur` est celui de l'accès de secours de l'état gardé : c'est lui qui doit avoir signé.
// L'appelant ne dit jamais laquelle de ces vérifications a échoué : un seul refus vers l'extérieur.
export async function controlerRecuperation(corps, attendu) {
  const { signataire, contenu } = lireMessageHorsChaine(corps.message, TAILLE_CONTENU);
  const r = validerRecuperation(lireCanonique(contenu, TAILLE_CONTENU));
  for (const champ of ['service', 'environnement', 'projet', 'compte', 'coffre', 'defi']) {
    if (typeof attendu[champ] !== 'string' || r[champ] !== attendu[champ]) refuser('ContexteRefuse', champ);
  }
  if (!Number.isSafeInteger(attendu.generation) || r.generation !== attendu.generation) refuser('ContexteRefuse', 'generation');
  if (!Number.isSafeInteger(attendu.expire) || r.expire !== attendu.expire) refuser('ExpirationRefusee');
  if (typeof attendu.verifieur !== 'string' || b64u(signataire) !== attendu.verifieur) refuser('SignataireRefuse');
  if (!(await verifierSignature(signataire, corps.signature, corps.message))) refuser('SignatureRefusee');
  return r;
}

// ---------- Ajouter un accès (le serveur). La clé du wallet autorise le passage d'un état au suivant, et le
// suivant doit être l'ancien, plus exactement un accès passkey : même identifiant, même adresse, même clé
// enveloppée, mêmes accès dans le même ordre, même accès de secours, numéro de version plus un.
// `attendu` vient de la configuration, de la base et du défi émis pour ce compte :
// { service, environnement, projet, compte, coffre, adresse, defi, expire, version, empreinte,
//   etat (l'état gardé, relu de la base), passkey: { cred, alg, cle } (celle que le serveur vient de vérifier) }.
// Le serveur ne constate pas que la nouvelle passkey sait rouvrir le coffre : seule la page le vérifie, avant de signer.
export async function controlerAjout(corps, attendu, limites) {
  const { signataire, contenu } = lireMessageHorsChaine(corps.message, TAILLE_CONTENU);
  const g = validerGestion(lireCanonique(contenu, TAILLE_CONTENU));
  if (g.action !== 'ajouter-acces') refuser('ContexteRefuse', 'action');
  for (const champ of ['service', 'environnement', 'projet', 'compte', 'coffre', 'adresse']) {
    if (typeof attendu[champ] !== 'string' || g[champ] !== attendu[champ]) refuser('ContexteRefuse', champ);
  }
  if (base58(signataire) !== g.adresse) refuser('SignataireRefuse');
  if (!(await verifierSignature(signataire, corps.signature, corps.message))) refuser('SignatureRefusee');
  if (typeof attendu.defi !== 'string' || g.defi !== attendu.defi) refuser('DefiRefuse');
  if (!Number.isSafeInteger(attendu.expire) || g.expire !== attendu.expire) refuser('ExpirationRefusee');
  if (!Number.isSafeInteger(attendu.version) || typeof attendu.empreinte !== 'string'
    || g.avant.version !== attendu.version || g.avant.empreinte !== attendu.empreinte) refuser('EtatRefuse', 'avant');
  const e = validerEtat(lireCanonique(corps.etat, TAILLE_ETAT), limites);
  if (e.coffre.version !== g.apres.version || g.apres.empreinte !== (await empreinte(corps.etat))) refuser('EtatRefuse', 'empreinte');
  const a = attendu.etat;
  if (!a || !a.coffre || !Array.isArray(a.coffre.acces) || !Array.isArray(a.passkeys) || a.coffre.version !== attendu.version) refuser('EtatRefuse', 'ancien');
  const meme = (x, y) => canoniser(x) === canoniser(y);
  const ancien = a.coffre, nouveau = e.coffre, n = a.passkeys.length;
  if (nouveau.version !== ancien.version + 1 || nouveau.acces.length !== ancien.acces.length + 1) refuser('EtatRefuse', 'un seul acces de plus');
  for (const champ of ['format', 'v', 'id', 'adresse', 'cle', 'rappel']) if (!meme(nouveau[champ], ancien[champ])) refuser('EtatRefuse', champ);
  for (let i = 0; i < n; i++) {
    if (!meme(nouveau.acces[i], ancien.acces[i]) || !meme(e.passkeys[i], a.passkeys[i])) refuser('EtatRefuse', 'acces existant');
  }
  if (!meme(nouveau.acces[n + 1], ancien.acces[n])) refuser('EtatRefuse', 'acces de secours');
  const p = attendu.passkey;
  for (const q of [g.passkey, e.passkeys[n]]) {
    if (!p || q.cred !== p.cred || q.alg !== p.alg || q.cle !== p.cle) refuser('PasskeyRefusee');
  }
  return { gestion: g, etat: e, version: nouveau.version, empreinte: g.apres.empreinte };
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
  if (g.action !== 'creer' && g.action !== 'ajouter-acces') refuser('ContexteRefuse', 'action');
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
