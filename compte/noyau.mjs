// Le noyau du coffre, format 2 : ce qui chiffre, ouvre et vérifie. Il ne touche ni à l'écran, ni au stockage,
// ni au réseau. Repris du noyau du premier morceau ; ce qui change :
//   - le coffre porte un numéro de version et peut recevoir plusieurs accès passkey (un seul à la création) ;
//   - à la création, la clé du wallet signe elle-même le message qui autorise l'état gardé par le serveur ;
//   - la preuve locale (la clé retrouvée va bien avec l'adresse) est un message hors chaîne, voir CONTRAT.md.
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

// La forme exacte du format 2, et une copie que personne ne peut changer dans notre dos.
export function valider(objet) {
  try { K.validerCoffre(objet); } catch (e) { refuser('CoffreInvalide', e && e.detail); }
  return JSON.parse(JSON.stringify(objet));
}

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
  return {
    adresse: c.adresse,
    langue: secours.langue,
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
    fermer() { dek = null; cle = null; },
  };
}
// La passkey qui ouvre est désignée par son identifiant : un coffre peut en avoir plusieurs.
export async function ouvrirParPasskey(objet, credTexte, sortiePrf) {
  const c = valider(objet);
  const a = c.acces.slice(0, -1).find((x) => x.cred === credTexte);
  if (!a) refuser('OuvertureRefusee', 'passkey absente du coffre');
  if (new Uint8Array(sortiePrf).length !== 32) refuser('OuvertureRefusee', 'sortie de la passkey');
  return ouvrir(c, await kek(sortiePrf, K.deB64u(a.sel), INFO_PASSKEY), a, 'acces-passkey', [a.cred]);
}
export async function ouvrirParSecours(objet, mots) {
  const c = valider(objet), a = c.acces[c.acces.length - 1];
  const secret = await secretDepuisMots(mots, a.langue);
  const k = await kek(secret, K.deB64u(a.sel), INFO_SECOURS);
  secret.fill(0);
  return ouvrir(c, k, a, 'acces-secours', [a.langue]);
}

// ---------- Créer. La clé du wallet et la DEK n'existent sous forme exportable que le temps de cette fonction.
// `passkey` : { cred (octets), alg, cle (empreinte de sa clé publique) }.
// `contexte` : ce que le serveur a fixé à la réservation et ce que la page sait d'elle-même :
// { service, environnement, projet, compte, inscription, defi, expire }.
// Rend le coffre fermé, l'état autorisé (octets canoniques), et le message de création signé par la clé du wallet.
export async function creer({ sortiePrf, passkey, langue, contexte }) {
  if (!langueConnue(langue)) refuser('CoffreInvalide', 'langue');
  const prf = new Uint8Array(sortiePrf).slice();
  if (prf.length !== 32) refuser('CoffreInvalide', 'sortie de la passkey');
  const credTexte = K.b64u(passkey.cred);
  const paire = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
  const publique = new Uint8Array(await crypto.subtle.exportKey('raw', paire.publicKey));
  const c = { format: 'coffre', v: 2, id: K.b64u(hasard(16)), adresse: K.base58(publique), version: 1 };
  const dek = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['wrapKey', 'unwrapKey', 'encrypt', 'decrypt']);
  let iv = hasard(12), sel;
  c.cle = { iv: K.b64u(iv), ct: K.b64u(new Uint8Array(await crypto.subtle.wrapKey('pkcs8', paire.privateKey, dek, gcm(iv, lie('cle', c))))) };
  sel = hasard(32); iv = hasard(12);
  const accesPasskey = { type: 'passkey', cred: credTexte, sel: K.b64u(sel), iv: K.b64u(iv),
    ct: K.b64u(new Uint8Array(await crypto.subtle.wrapKey('raw', dek, await kek(prf, sel, INFO_PASSKEY), gcm(iv, lie('acces-passkey', c, [credTexte]))))) };
  const secret = hasard(16);
  sel = hasard(32); iv = hasard(12);
  const accesSecours = { type: 'secours', langue, sel: K.b64u(sel), iv: K.b64u(iv),
    ct: K.b64u(new Uint8Array(await crypto.subtle.wrapKey('raw', dek, await kek(secret, sel, INFO_SECOURS), gcm(iv, lie('acces-secours', c, [langue]))))) };
  c.acces = [accesPasskey, accesSecours];
  iv = hasard(12);
  c.rappel = { iv: K.b64u(iv), ct: K.b64u(new Uint8Array(await crypto.subtle.encrypt(gcm(iv, lie('rappel', c)), dek, secret))) };
  const mots = await motsDepuisSecret(secret, langue);
  secret.fill(0);

  // On repart de l'objet fini, comme le fera une ouverture, et par les deux chemins.
  // S'il ne se rouvre pas par la passkey et par le secours, rien n'est rendu ni signé.
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
  return { coffre, etat, empreinte, message, signature };
}
