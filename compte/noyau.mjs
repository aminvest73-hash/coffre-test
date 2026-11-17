// Le noyau du coffre : ce qui chiffre, ouvre et vérifie. Il ne touche ni à l'écran, ni au stockage,
// ni au réseau. Repris du noyau du premier morceau ; ce qui change :
//   - le coffre porte un numéro de version et peut recevoir plusieurs accès passkey (un seul à la création) ;
//   - à la création, la clé du wallet signe elle-même le message qui autorise l'état gardé par le serveur ;
//   - la preuve locale (la clé retrouvée va bien avec l'adresse) est un message hors chaîne, voir CONTRAT.md ;
//   - format 3 (les coffres créés ici) : l'accès de secours porte un vérifieur, la clé publique d'une clé de
//     récupération dérivée des 12 mots. Elle sert à prouver les mots à distance, sans le coffre (RECUPERATION.md).
//     Les coffres au format 2 s'ouvrent toujours ; ils n'ont pas de récupération.
// Briques : WebCrypto, et le module du contrat. Rien d'autre.

import * as K from './contrat.mjs';
import { LISTES, EMPREINTES } from './listes.mjs';

export { EMPREINTES };
export const Refus = K.Refus;
export const LANGUES = Object.keys(LISTES);

const te = new TextEncoder();
const PREFIXE = 'coffre/v2';
export const ENTREE_PRF = te.encode(PREFIXE + '/prf');
const INFO_PASSKEY = PREFIXE + '/kek/passkey', INFO_SECOURS = PREFIXE + '/kek/secours';
const INFO_RECUPERATION = 'coffre/v3/secours/recuperation';
const PKCS8_ED25519 = K.deHex('302e020100300506032b657004220420');   // l'en-tête d'une clé privée Ed25519, avant ses 32 octets
const refuser = (nom, detail) => { throw new K.Refus(nom, detail); };
export const hasard = (n) => crypto.getRandomValues(new Uint8Array(n));

// ---------- Les 12 mots : 128 bits et 4 bits de contrôle, en 12 paquets de 11 bits.
// Un encodage, pas une graine de wallet : ces mots tapés dans un autre wallet n'y retrouvent rien.
export const nu = (m) => String(m).normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().trim();
const INDEX = {};
for (const l of LANGUES) INDEX[l] = new Map(LISTES[l].map((m, i) => [nu(m), i]));
const langueConnue = (l) => Object.prototype.hasOwnProperty.call(LISTES, l);

export async function motsDepuisSecret(secret, langue) {
  const s = new Uint8Array(secret);
  if (s.length !== 16 || !langueConnue(langue)) refuser('MotsInvalides', 'secret');
  const controle = new Uint8Array(await crypto.subtle.digest('SHA-256', s))[0] >> 4;
  const n = (BigInt('0x' + K.hex(s)) << 4n) | BigInt(controle), mots = [];
  for (let i = 11; i >= 0; i--) mots.push(LISTES[langue][Number((n >> BigInt(11 * i)) & 2047n)]);
  return mots;
}
export async function secretDepuisMots(mots, langue) {
  if (!Array.isArray(mots) || mots.length !== 12 || !langueConnue(langue)) refuser('MotsInvalides', 'nombre');
  let n = 0n;
  for (const m of mots) {
    const i = INDEX[langue].get(nu(m));
    if (i === undefined) refuser('MotsInvalides', 'mot inconnu');
    n = (n << 11n) | BigInt(i);
  }
  const secret = K.deHex((n >> 4n).toString(16).padStart(32, '0'));
  const controle = new Uint8Array(await crypto.subtle.digest('SHA-256', secret))[0] >> 4;
  if (Number(n & 15n) !== controle) { secret.fill(0); refuser('MotsInvalides', 'controle'); }
  return secret;
}
export function completer(debut, langue, max) {
  const d = nu(debut);
  if (!d || !langueConnue(langue)) return [];
  const trouves = [];
  for (const m of LISTES[langue]) { if (nu(m).startsWith(d)) { trouves.push(m); if (trouves.length >= (max || 6)) break; } }
  return trouves;
}
export const estUnMot = (m, langue) => langueConnue(langue) && INDEX[langue].has(nu(m));

// ---------- La clé de récupération (format 3). Elle prouve « je connais les 12 mots de ce coffre » sans le coffre.
// Matière : le secret du secours (les 16 octets que les 12 mots écrivent, jamais la chaîne des mots).
// HKDF-SHA-256 (RFC 5869), sel : les 16 octets de l'identifiant du coffre, info : INFO_RECUPERATION, 32 octets,
// pris comme graine d'une clé Ed25519 (RFC 8032). Sa clé publique est le « vérifieur » inscrit dans l'accès de
// secours. Usages séparés : la clé qui enveloppe la DEK garde sa propre dérivation (sel au hasard, autre info) ;
// celle-ci ne signe que des messages coffre-recuperation/1.
// WebCrypto ne donne la clé publique d'une clé privée que par un export : la clé est donc importée deux fois, une
// fois exportable le temps de lire sa partie publique, puis une fois non exportable : c'est celle-là qui est rendue.
export async function cleRecuperation(secret, idCoffre) {
  const s = new Uint8Array(secret).slice();
  if (s.length !== 16) refuser('MotsInvalides', 'secret');
  const sel = K.deB64u(idCoffre, 16);
  const pkcs8 = new Uint8Array(48);
  try {
    const base = await crypto.subtle.importKey('raw', s, 'HKDF', false, ['deriveBits']);
    const graine = new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: sel, info: te.encode(INFO_RECUPERATION) }, base, 256));
    pkcs8.set(PKCS8_ED25519, 0); pkcs8.set(graine, 16);
    graine.fill(0);
    const lisible = await crypto.subtle.importKey('pkcs8', pkcs8, { name: 'Ed25519' }, true, ['sign']);
    const verifieur = (await crypto.subtle.exportKey('jwk', lisible)).x;
    K.deB64u(verifieur, 32);
    const cle = await crypto.subtle.importKey('pkcs8', pkcs8, { name: 'Ed25519' }, false, ['sign']);
    return { cle, verifieur };
  } finally { s.fill(0); pkcs8.fill(0); }
}
export function melanger(tableau) {
  const t = tableau.slice();
  for (let i = t.length - 1; i > 0; i--) {
    const borne = Math.floor(0x100000000 / (i + 1)) * (i + 1);
    let r;
    do { r = crypto.getRandomValues(new Uint32Array(1))[0]; } while (r >= borne);
    const j = r % (i + 1);
    [t[i], t[j]] = [t[j], t[i]];
  }
  return t;
}
export async function empreinteDeListe(langue) {
  const texte = (LISTES[langue].join('\n') + '\n').normalize(langue === 'fr' ? 'NFD' : 'NFC');
  return K.hex(new Uint8Array(await crypto.subtle.digest('SHA-256', te.encode(texte))));
}
export async function numeroDePasskey(credTexte) {
  return K.hex(new Uint8Array(await crypto.subtle.digest('SHA-256', K.deB64u(credTexte))).slice(0, 3)).toUpperCase();
}

// ---------- Chaque chiffrement est lié à sa place dans son coffre : un morceau déplacé ne se déchiffre pas.
// L'identifiant et l'adresse ne changent jamais ; le numéro de version, lui, n'est pas lié, puisqu'il augmente
// sans que les anciens accès soient rechiffrés.
const lie = (role, c, plus) => te.encode([PREFIXE, role, c.id, c.adresse].concat(plus || []).join('|'));
const gcm = (iv, aad) => ({ name: 'AES-GCM', iv, additionalData: aad, tagLength: 128 });
async function kek(matiere, sel, info) {
  const base = await crypto.subtle.importKey('raw', matiere, 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: sel, info: te.encode(info) },
    base, { name: 'AES-GCM', length: 256 }, false, ['wrapKey', 'unwrapKey']);
}

// La forme exacte du format (2 ou 3), et une copie que personne ne peut changer dans notre dos.
export function valider(objet) {
  try { K.validerCoffre(objet); } catch (e) { refuser('CoffreInvalide', e && e.detail); }
  return JSON.parse(JSON.stringify(objet));
}

// La clé du wallet d'un coffre ouvert ne sort pas de ce fichier : ce qu'une session offre à la page est une liste
// fermée de signatures (preuve de connexion, déclaration de secours). Le noyau, lui, la retrouve ici pour la seule
// autre signature qu'il fait lui-même : autoriser un nouvel accès (ajouterAcces).
const CLES = new WeakMap();

// ---------- Ouvrir : désenvelopper la DEK, puis la clé, puis prouver que cette clé va avec l'adresse inscrite.
async function ouvrir(c, kekAcces, acces, role, plus) {
  let dek, cle;
  try {
    dek = await crypto.subtle.unwrapKey('raw', K.deB64u(acces.ct), kekAcces, gcm(K.deB64u(acces.iv), lie(role, c, plus)),
      { name: 'AES-GCM', length: 256 }, false, ['unwrapKey', 'decrypt']);
    cle = await crypto.subtle.unwrapKey('pkcs8', K.deB64u(c.cle.ct), dek, gcm(K.deB64u(c.cle.iv), lie('cle', c)),
      { name: 'Ed25519' }, false, ['sign']);
  } catch (_) {
    refuser('OuvertureRefusee');
  }
  try { await K.verifierPreuve(await K.fairePreuve(cle, c), c); } catch (_) { refuser('PreuveEchouee'); }
  const secours = c.acces[c.acces.length - 1];
  const session = {
    adresse: c.adresse,
    langue: secours.langue,
    // Ce coffre porte-t-il un vérifieur (format 3) ? Sans lui, pas de récupération à distance.
    recuperable: c.v === 3,
    // Les 12 mots, relus dans le coffre ouvert. Ils ne sortent d'ici que pour être montrés au joueur.
    async lireMots() {
      if (!dek) refuser('OuvertureRefusee', 'coffre referme');
      let secret;
      try {
        secret = new Uint8Array(await crypto.subtle.decrypt(gcm(K.deB64u(c.rappel.iv), lie('rappel', c)), dek, K.deB64u(c.rappel.ct)));
      } catch (_) { refuser('OuvertureRefusee', 'rappel'); }
      const mots = await motsDepuisSecret(secret, secours.langue);
      secret.fill(0);
      return mots;
    },
    // Prouver à un jeu que ce wallet s'y connecte. La clé ne sort pas : elle signe ici.
    async prouverConnexion({ service, jeu, defi, maintenant }) {
      if (!cle) refuser('OuvertureRefusee', 'coffre referme');
      return K.faireConnexionJeu(cle, { service, jeu, adresse: c.adresse, defi, maintenant });
    },
    // Attester le secours : la clé du wallet signe « l'accès de secours en place a servi à une vraie restauration ».
    // `contexte` : { service, environnement, projet, compte, defi, expire, avant: { version, empreinte } }.
    // La page construit elle-même ce qu'elle signe ; l'appelant n'appelle ceci qu'après la restauration réussie.
    // `contexte.identite`, s'il est donné : l'empreinte du jeton de la preuve d'identité que le joueur vient d'obtenir.
    // La clé du wallet désigne ainsi elle-même l'identité qui pourra demander la remise de ce coffre.
    async attesterSecours(contexte) {
      if (!cle) refuser('OuvertureRefusee', 'coffre referme');
      const contenu = K.contenuGestion(Object.assign({}, contexte, { action: 'attester-secours', coffre: c.id, adresse: c.adresse,
        secours: { acces: await K.empreinteAccesSecours(c), declaration: 'fait' } }));
      const message = K.messageHorsChaine(K.deBase58(c.adresse, 32), contenu);
      return { message, signature: await K.signer(cle, message) };
    },
    // Régler une adresse de secours : la clé du wallet inscrit une identité à un rang (1 ou 2), ou retire celle du rang 2.
    // `contexte` : { service, environnement, projet, compte, defi, expire, rang, generation } et, pour inscrire,
    // `identite` : l'empreinte du jeton de la preuve d'identité de la nouvelle adresse.
    async reglerAdresse(contexte) {
      if (!cle) refuser('OuvertureRefusee', 'coffre referme');
      const contenu = K.contenuGestion(Object.assign({}, contexte, { action: 'regler-adresse', coffre: c.id, adresse: c.adresse }));
      const message = K.messageHorsChaine(K.deBase58(c.adresse, 32), contenu);
      return { message, signature: await K.signer(cle, message) };
    },
    fermer() { dek = null; cle = null; },
  };
  CLES.set(session, () => cle);
  return session;
}
// La passkey qui ouvre est désignée par son identifiant : un coffre peut en avoir plusieurs.
export async function ouvrirParPasskey(objet, credTexte, sortiePrf) {
  const c = valider(objet);
  const a = c.acces.slice(0, -1).find((x) => x.cred === credTexte);
  if (!a) refuser('OuvertureRefusee', 'passkey absente du coffre');
  if (new Uint8Array(sortiePrf).length !== 32) refuser('OuvertureRefusee', 'sortie de la passkey');
  return ouvrir(c, await kek(sortiePrf, K.deB64u(a.sel), INFO_PASSKEY), a, 'acces-passkey', [a.cred]);
}
// Par les 12 mots. Au format 3, le vérifieur est recalculé à partir des mots et comparé à celui du coffre :
// s'il diffère, ce coffre a été modifié, et l'ouverture est refusée même si la clé se retrouve.
export async function ouvrirParSecours(objet, mots) {
  const c = valider(objet), a = c.acces[c.acces.length - 1];
  const secret = await secretDepuisMots(mots, a.langue);
  try {
    const session = await ouvrir(c, await kek(secret, K.deB64u(a.sel), INFO_SECOURS), a, 'acces-secours', [a.langue]);
    if (c.v === 3) {
      let v = null;
      try { v = (await cleRecuperation(secret, c.id)).verifieur; } catch (_) { /* refusé juste en dessous */ }
      if (v !== a.verifieur) { session.fermer(); refuser('OuvertureRefusee', 'verifieur'); }
    }
    return session;
  } finally { secret.fill(0); }
}

// ---------- Prouver ses 12 mots à distance, sur un appareil qui n'a pas le coffre. La page décode les mots dans
// la langue que le serveur annonce avec son défi, dérive la clé de récupération (le sel est l'identifiant du coffre
// annoncé), et signe le message de récupération. Si les mots ne s'écrivent pas dans cette langue : MotsInvalides,
// et rien n'est signé. `contexte` : { service, environnement, projet, compte, coffre, generation, defi, expire }.
// Une mauvaise langue ou un mauvais identifiant donnent une autre clé : le serveur refusera, c'est tout.
export async function signerRecuperation(mots, langue, contexte) {
  const secret = await secretDepuisMots(mots, langue);
  try {
    const { cle, verifieur } = await cleRecuperation(secret, contexte.coffre);
    const message = K.messageHorsChaine(K.deB64u(verifieur, 32), K.contenuRecuperation(contexte));
    return { message, signature: await K.signer(cle, message) };
  } finally { secret.fill(0); }
}

// ---------- Ajouter un accès passkey. Il faut d'abord ouvrir le coffre : par les 12 mots (après une récupération),
// ou par une passkey qui l'ouvre déjà (pour donner sa propre clé à un appareil qui empruntait celle d'un autre).
// Une seule fonction : la DEK n'y existe sous forme exportable que le temps d'être enveloppée pour la nouvelle
// passkey ; la clé du wallet n'est jamais exportable.
// Dans l'ordre : une vraie ouverture par l'accès donné (adresse, preuve locale, et vérifieur si ce sont les mots) ;
// le nouvel accès ; le coffre suivant (version plus un, l'ancien plus exactement cet accès) ; sa réouverture par la
// nouvelle passkey ET par l'accès donné ; et seulement alors la clé du wallet signe le passage de l'ancien état au nouveau.
//   coffre     le coffre fermé d'aujourd'hui (celui que le serveur garde)
//   par        ce qui l'ouvre : { mots } (les 12 mots), ou { cred, sortiePrf } (une passkey déjà inscrite et sa sortie,
//              obtenue par un geste fait pour cela)
//   sortiePrf  la sortie de la nouvelle passkey, obtenue par une vraie demande (pas seulement à sa création)
//   passkey    { cred (octets), alg, cle (empreinte de sa clé publique) }
//   passkeys   les passkeys déjà inscrites dans l'état gardé, dans leur ordre
//   contexte   { service, environnement, projet, compte, defi, expire, avant: { version, empreinte } }
// Celui qui tient la sortie d'une passkey inscrite et le coffre fermé tient déjà la clé du wallet le temps de ce
// geste : ce chemin ne demande aucun secret de plus. Mais il rend l'accès durable (un appareil de plus ouvrira le
// wallet à chaque fois) : c'est à l'appelant de le dire au joueur et d'obtenir son accord avant le geste.
export async function ajouterAcces({ coffre, par, sortiePrf, passkey, passkeys, contexte }) {
  const c = valider(coffre), secours = c.acces[c.acces.length - 1];
  const prf = new Uint8Array(sortiePrf).slice();
  if (prf.length !== 32) refuser('CoffreInvalide', 'sortie de la passkey');
  const credTexte = K.b64u(passkey.cred);
  if (c.acces.some((a) => a.cred === credTexte)) refuser('CoffreInvalide', 'passkey deja dans le coffre');
  if (!contexte || !contexte.avant || contexte.avant.version !== c.version) refuser('CoffreInvalide', 'version');
  if (!Array.isArray(passkeys) || passkeys.length !== c.acces.length - 1) refuser('CoffreInvalide', 'passkeys inscrites');
  const parMots = !!(par && Array.isArray(par.mots));
  if (!parMots && !(par && typeof par.cred === 'string' && par.sortiePrf)) refuser('CoffreInvalide', 'acces qui ouvre');
  const ouvrirPar = (objet) => (parMots ? ouvrirParSecours(objet, par.mots) : ouvrirParPasskey(objet, par.cred, par.sortiePrf));
  (await ouvrirPar(c)).fermer();
  // La DEK, relue par le même accès, cette fois sous une forme qui peut être enveloppée de nouveau.
  let dek;
  const matiere = parMots ? await secretDepuisMots(par.mots, secours.langue) : new Uint8Array(par.sortiePrf).slice();
  try {
    const a = parMots ? secours : c.acces.slice(0, -1).find((x) => x.cred === par.cred);
    const aad = parMots ? lie('acces-secours', c, [secours.langue]) : lie('acces-passkey', c, [a.cred]);
    dek = await crypto.subtle.unwrapKey('raw', K.deB64u(a.ct), await kek(matiere, K.deB64u(a.sel), parMots ? INFO_SECOURS : INFO_PASSKEY),
      gcm(K.deB64u(a.iv), aad), { name: 'AES-GCM', length: 256 }, true, ['unwrapKey', 'decrypt']);
  } catch (_) { refuser('OuvertureRefusee'); } finally { matiere.fill(0); }
  const sel = hasard(32), iv = hasard(12);
  const acces = { type: 'passkey', cred: credTexte, sel: K.b64u(sel), iv: K.b64u(iv),
    ct: K.b64u(new Uint8Array(await crypto.subtle.wrapKey('raw', dek, await kek(prf, sel, INFO_PASSKEY), gcm(iv, lie('acces-passkey', c, [credTexte]))))) };
  dek = null;
  const suivant = valider(Object.assign({}, c, { version: c.version + 1, acces: c.acces.slice(0, -1).concat([acces, secours]) }));
  (await ouvrirParPasskey(suivant, credTexte, prf)).fermer();
  prf.fill(0);
  const inscrite = { cred: credTexte, alg: passkey.alg, cle: passkey.cle };
  const etat = K.octetsEtat({ coffre: suivant, passkeys: passkeys.concat([inscrite]) });
  const empreinte = await K.empreinte(etat);
  const session = await ouvrirPar(suivant);
  try {
    const contenu = K.contenuGestion(Object.assign({}, contexte, { action: 'ajouter-acces', coffre: suivant.id, adresse: suivant.adresse,
      apres: { version: suivant.version, empreinte }, passkey: inscrite }));
    const message = K.messageHorsChaine(K.deBase58(suivant.adresse, 32), contenu);
    return { coffre: suivant, etat, empreinte, message, signature: await K.signer(CLES.get(session)(), message) };
  } finally { session.fermer(); }
}

// ---------- Créer. La clé du wallet et la DEK n'existent sous forme exportable que le temps de cette fonction.
// `passkey` : { cred (octets), alg, cle (empreinte de sa clé publique) }.
// `contexte` : ce que le serveur a fixé à la réservation et ce que la page sait d'elle-même :
// { service, environnement, projet, compte, inscription, defi, expire }.
// Rend le coffre fermé, l'état autorisé (octets canoniques), et le message de création signé par la clé du wallet.
// `connexion`, s'il est donné : { jeu, defi, maintenant }. La clé signe alors aussi la preuve de connexion à ce jeu,
// pour qu'un nouveau joueur crée son coffre et entre dans le jeu d'un seul geste.
export async function creer({ sortiePrf, passkey, langue, contexte, connexion }) {
  if (!langueConnue(langue)) refuser('CoffreInvalide', 'langue');
  const prf = new Uint8Array(sortiePrf).slice();
  if (prf.length !== 32) refuser('CoffreInvalide', 'sortie de la passkey');
  const credTexte = K.b64u(passkey.cred);
  const paire = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
  const publique = new Uint8Array(await crypto.subtle.exportKey('raw', paire.publicKey));
  const c = { format: 'coffre', v: 3, id: K.b64u(hasard(16)), adresse: K.base58(publique), version: 1 };
  const dek = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['wrapKey', 'unwrapKey', 'encrypt', 'decrypt']);
  let iv = hasard(12), sel;
  c.cle = { iv: K.b64u(iv), ct: K.b64u(new Uint8Array(await crypto.subtle.wrapKey('pkcs8', paire.privateKey, dek, gcm(iv, lie('cle', c))))) };
  sel = hasard(32); iv = hasard(12);
  const accesPasskey = { type: 'passkey', cred: credTexte, sel: K.b64u(sel), iv: K.b64u(iv),
    ct: K.b64u(new Uint8Array(await crypto.subtle.wrapKey('raw', dek, await kek(prf, sel, INFO_PASSKEY), gcm(iv, lie('acces-passkey', c, [credTexte]))))) };
  const secret = hasard(16);
  sel = hasard(32); iv = hasard(12);
  const accesSecours = { type: 'secours', langue, sel: K.b64u(sel), iv: K.b64u(iv),
    ct: K.b64u(new Uint8Array(await crypto.subtle.wrapKey('raw', dek, await kek(secret, sel, INFO_SECOURS), gcm(iv, lie('acces-secours', c, [langue]))))),
    verifieur: (await cleRecuperation(secret, c.id)).verifieur };
  c.acces = [accesPasskey, accesSecours];
  iv = hasard(12);
  c.rappel = { iv: K.b64u(iv), ct: K.b64u(new Uint8Array(await crypto.subtle.encrypt(gcm(iv, lie('rappel', c)), dek, secret))) };
  const mots = await motsDepuisSecret(secret, langue);
  secret.fill(0);

  // On repart de l'objet fini, comme le fera une ouverture, et par les deux chemins.
  // S'il ne se rouvre pas par la passkey et par le secours, rien n'est rendu ni signé.
  // L'ouverture par le secours recalcule le vérifieur à partir des mots : il est donc revérifié ici aussi.
  const coffre = valider(c);
  (await ouvrirParPasskey(coffre, credTexte, prf)).fermer();
  (await ouvrirParSecours(coffre, mots)).fermer();
  prf.fill(0); mots.fill('');

  // L'état que le serveur gardera, et le message qui l'autorise, signé par la clé du wallet elle-même.
  const inscrite = { cred: credTexte, alg: passkey.alg, cle: passkey.cle };
  const etat = K.octetsEtat({ coffre, passkeys: [inscrite] }, { accesPasskey: 1 });
  const empreinte = await K.empreinte(etat);
  const contenu = K.contenuGestion(Object.assign({}, contexte, {
    action: 'creer', coffre: coffre.id, adresse: coffre.adresse, apres: { version: 1, empreinte }, passkey: inscrite,
  }));
  const message = K.messageHorsChaine(publique, contenu);
  const signature = await K.signer(paire.privateKey, message);
  const preuve = connexion
    ? await K.faireConnexionJeu(paire.privateKey, { service: contexte.service, jeu: connexion.jeu, adresse: coffre.adresse, defi: connexion.defi, maintenant: connexion.maintenant })
    : null;
  return { coffre, etat, empreinte, message, signature, preuve };
}
