// L'écran de l'essai du compte. Toute la logique est dans client.mjs ; ici, seulement les boutons, les messages
// et le stockage de l'appareil.

import * as K from './contrat.mjs';
import { client } from './client.mjs';
import { REGLAGES } from './reglages.mjs';

const $ = (id) => document.getElementById(id);
const VUES = ['v-accueil', 'v-coffre'];
const journal = [];
let fiche = null, occupe = false, armeOublier = null;

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
  DejaUnCoffre: 'Un coffre est déjà gardé sur cet appareil.',
  ReseauCoupe: 'Le serveur ne répond pas.',
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
};
const expliquer = (e) => MESSAGES[e && e.name] || ('Refusé (' + ((e && e.name) || 'erreur') + '). Rien n\'a été changé sur cet appareil.');
const detail = (e) => (e && e.name ? e.name : 'erreur') + (e && e.detail ? ' (' + e.detail + ')' : '');

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
    throw new K.Refus(refus);
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
  dire(fiche ? 's-coffre' : 's-accueil', 'Code enregistré pour cet onglet. Recommence ton geste.', 'ok');
}
const appareil = {
  creer: (o) => navigator.credentials.create({ publicKey: o }),
  demander: (o) => navigator.credentials.get({ publicKey: o }),
};
const c = client({ api, appareil, stock, noter,
  reglages: { origine: location.origin, rpId: REGLAGES.rpId, environnement: REGLAGES.environnement, projet: REGLAGES.projet, langue: REGLAGES.langue } });

// ---------- L'écran
async function afficher(message, sorte) {
  try { fiche = (await stock.lire()) || null; }
  catch (e) { fiche = null; noter('[page] stockage indisponible : ' + detail(e)); }
  $('resultat').value = texteResultat();
  if (!fiche) { montrer('v-accueil'); dire('s-accueil', message, sorte); return; }
  $('adresse').textContent = fiche.coffre.adresse;
  dire('garde', fiche.garde ? 'Gardé chez nous : oui. Tu le retrouveras sur tes autres appareils.' : 'Gardé chez nous : non. Il n\'existe que sur cet appareil.', fiche.garde ? 'ok' : 'ko');
  $('b-renvoyer').hidden = fiche.garde;
  $('b-reconnecter').hidden = !fiche.garde;
  desarmer();
  montrer('v-coffre');
  dire('s-coffre', message, sorte);
}
const seul = (fn) => async () => { if (occupe) return; occupe = true; try { await fn(); } finally { occupe = false; } };
const ATTENTE = 'Ton appareil te demande de confirmer…';

async function creer() {
  dire('s-accueil', ATTENTE, 'wait');
  try {
    const r = await c.creer('Mon coffre (essai) ' + new Date().toLocaleString('fr-FR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }));
    await afficher(r.garde ? 'Coffre créé, et confié au serveur.' : 'Coffre créé, mais pas encore confié au serveur : ' + (MESSAGES[r.raison] || r.raison), r.garde ? 'ok' : 'ko');
  } catch (e) { noter('[creer] echec : ' + detail(e)); await afficher(expliquer(e), 'ko'); }
}
async function connecter() {
  const cible = fiche ? 's-coffre' : 's-accueil';
  dire(cible, ATTENTE, 'wait');
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
    await afficher(r.garde ? 'Ton coffre est maintenant confié au serveur.' : 'Toujours pas confié au serveur : ' + (MESSAGES[r.raison] || r.raison), r.garde ? 'ok' : 'ko');
  } catch (e) { noter('[renvoyer] echec : ' + detail(e)); await afficher(expliquer(e), 'ko'); }
}
async function ouvrir() {
  dire('s-coffre', ATTENTE, 'wait');
  try {
    const s = await c.ouvrirLocal(); s.fermer();
    noter('[ouvrir] ok sans le serveur : adresse ' + s.adresse);
    dire('s-coffre', 'Coffre ouvert sans le serveur, puis refermé.', 'ok');
  } catch (e) { noter('[ouvrir] echec : ' + detail(e)); dire('s-coffre', expliquer(e), 'ko'); }
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
  crypto.subtle.generateKey({ name: 'Ed25519' }, false, ['sign', 'verify']).then(() => afficher(), () => bloquer('Ce navigateur ne sait pas encore faire les signatures de Solana. Mets-le à jour, puis reviens.'));
}
