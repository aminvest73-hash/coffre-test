// L'écran du compte. Toute la logique est dans client.mjs ; ici, seulement les boutons, les messages
// et le stockage de l'appareil. Aucun texte pour le joueur n'est écrit dans ce fichier : chaque phrase est une clé
// de textes.mjs, rendue dans la langue choisie. Seul le relevé d'essai (et ses lignes) reste écrit ici, en français.

import * as K from './contrat.mjs';
import { client } from './client.mjs';
import { REGLAGES } from './reglages.mjs';
import { lienJeu } from './lien-jeu.mjs';
import { melanger } from './noyau.mjs';
import { lireDemande, enSol, totalJoueur } from './operation.mjs';
import { LANGUES, REGIONS, texte, existe, langueDuNavigateur } from './textes.mjs';

// Le retour d'une porte d'identité (Google, Discord…) arrive dans le fragment de l'adresse : `#i=<code>` ou
// `#i-refus=<mot>`. Il est lu puis retiré de l'adresse ici, avant toute autre chose : il ne doit rester ni dans la
// barre d'adresse, ni dans l'historique, ni dans une adresse recopiée. Seul, ce code ne vaut rien : il ne s'échange
// qu'avec le vérifieur resté dans le rangement de cette fenêtre (voir client.mjs).
const RETOUR_PORTE = (() => {
  let h = '';
  try { h = String(location.hash || ''); } catch (_) { return null; }
  if (!/^#i(-refus)?=/.test(h)) return null;
  try { history.replaceState(null, '', location.pathname + location.search); }
  catch (_) { try { location.hash = ''; } catch (_e) { /* l'adresse garde son fragment : le code n'y vaut rien seul */ } }
  return h.slice(1);
})();
// Le même fragment posé sur la page déjà chargée (une adresse recopiée dans le même onglet) : ce n'est pas un retour,
// la page ne le traite pas ; elle le retire seulement de l'adresse, comme au chargement.
try {
  window.addEventListener('hashchange', () => {
    let h = '';
    try { h = String(location.hash || ''); } catch (_) { return; }
    if (/^#i(-refus)?=/.test(h)) { try { history.replaceState(null, '', location.pathname + location.search); } catch (_) { /* rien */ } }
  });
} catch (_) { /* pas de fenêtre à écouter */ }

const $ = (id) => document.getElementById(id);
const VUES = ['v-accueil', 'v-coffre', 'v-mission', 'v-retrouver', 'v-adresses'];
const ETAPES_ADRESSES = ['a-liste', 'a-saisie'];
const ETAPES = ['m-intro', 'm-mots', 'm-cartes', 'm-email'];
const ETAPES_RETROUVER = ['r-email', 'r-mots', 'r-garder'];
const journal = [];
let fiche = null, occupe = false, armeOublier = null;
// Seulement pendant la mission : { m (la mission du client), cartes (les mots mélangés), poses (numéros des cartes posées),
// verifie (les mots dans l'ordre accepté, en attendant l'e-mail), confirme (le code e-mail est validé) }.
let mission = null;
let reglage = null;   // seulement pendant le réglage d'une adresse de secours : { rang, confirme (le code e-mail est validé) }
let armeRetirer = null, armeAjouter = null, armeDoublon = null;
let retrouvaille = null;   // seulement pendant une récupération : { confirme (le code e-mail est validé), trouve (le compte est revenu) }
let lien = null;   // présent seulement quand un jeu enregistré a ouvert cette fenêtre
// Quand le service demande au joueur de dire qui il est : rien, puis { coffre : oui ou non } une fois le code validé.
const PAR_EMAIL = REGLAGES.identite === 'email';
let identite = null;
// Les autres portes d'identité que cette page propose : celles de ses réglages, parmi celles qu'elle sait montrer.
// Le nom d'un service est une marque : il s'écrit pareil dans toutes les langues.
const NOMS_PORTES = { google: 'Google', discord: 'Discord' };
const BOUTONS_PORTES = { google: 'b-porte-google', discord: 'b-porte-discord' };
const PORTES = (Array.isArray(REGLAGES.portes) ? REGLAGES.portes : []).filter((p) => Object.prototype.hasOwnProperty.call(NOMS_PORTES, p));
const IDENTITE_EXIGEE = PAR_EMAIL || PORTES.length > 0;
// Vrai quand le joueur est revenu d'une porte où il était parti depuis une fenêtre ouverte par un jeu. La page ne
// crée alors un compte qu'avec la demande de ce jeu sous les yeux : c'est elle qui dit s'il faut en créer un, ou
// retrouver celui du joueur. Sans demande (le lien s'est perdu en route), rien n'est créé : la page dit de repartir
// du jeu. Attendre n'y change rien : un délai dépassé n'est jamais une autorisation de créer.
let venuDUnJeu = false;
let sansLeJeu = false;   // la page a dit « le jeu ne répond plus » : à retirer si sa demande arrive enfin
// Vrai dès que cette fenêtre a rendu la main au jeu : le joueur a choisi d'entrer avec son propre wallet, ou il a
// touché « Pas maintenant ». Elle ne propose alors plus rien.
let mainRendue = false;
// Présent dès qu'un jeu demande de confirmer une opération dans cette fenêtre : { d (la demande), octets (le message
// reçu), lecture, cle (le texte de la lecture montrée), fini }. La fenêtre ne propose alors rien d'autre.
let operation = null;
// L'adresse du wallet d'un compte fabriqué ici en double : le service a répondu que ce joueur en avait déjà un
// (il venait d'être créé par une autre façon de se connecter). Ce compte-là n'est gardé nulle part ailleurs : la
// page le dit, ne l'efface jamais d'elle-même, et propose de le retirer. Gardé en mémoire seulement.
let doublon = null;
// Quand un compte se retrouve sans appareil, avec les 12 mots et un code reçu par e-mail.
const RECUPERATION = REGLAGES.recuperation === 'email';
// Les fiches des jeux qui ont déclaré des opérations de leur programme : l'origine du jeu -> sa fiche. Tenues par
// nous, posées ici à l'assemblage ; jamais reçues d'un jeu. Chaque fiche est validée à chaque lecture (operation.mjs).
const FICHES = REGLAGES.operations && typeof REGLAGES.operations === 'object' ? REGLAGES.operations : null;

// ---------- La langue, et les phrases
// La langue de départ est celle du navigateur (le français s'il le dit, l'anglais sinon). Le bouton « FR / EN » la
// change tout de suite, pour tout ce qui est à l'écran, et le choix est gardé sur l'appareil ; si l'appareil refuse
// de le garder, il vaut pour la page ouverte.
const CLE_LANGUE = 'langue';
const langueConnue = (l) => typeof l === 'string' && Object.prototype.hasOwnProperty.call(LANGUES, l);
function langueGardee() { try { const l = localStorage.getItem(CLE_LANGUE); return langueConnue(l) ? l : null; } catch (_) { return null; } }
function langueDite() { try { return navigator.language; } catch (_) { return ''; } }
let langue = langueGardee() || langueDuNavigateur(langueDite(), REGLAGES.langue);
// « ton téléphone » sur un téléphone, « ton appareil » ailleurs (un ordinateur, une tablette).
const SUR_TELEPHONE = (() => { try { return /iPhone|iPod|Android.+Mobile|Windows Phone/i.test(navigator.userAgent || ''); } catch (_) { return false; } })();

// Une phrase n'est pas un texte : c'est une clé de textes.mjs et ses valeurs. La page garde la phrase posée dans
// chaque case, et la rend de nouveau quand la langue change. Une valeur peut être un texte brut (le nom du jeu, une
// adresse), une autre phrase, un montant ou une date ; une liste de phrases se lit à la suite.
const t = (cle, v) => ({ cle, v });
const suite = (liste, sep) => ({ suite: liste, sep });   // des lignes : chacune sa phrase
const sol = (lamports) => ({ sol: lamports });           // un montant en SOL, écrit à la façon de la langue
const jour = (secondes) => ({ jour: secondes });         // une date, sans ambiguïté entre le jour et le mois
// Un montant : `enSol` l'écrit à la française (« 1 234,5 »). En anglais, les mêmes chiffres s'écrivent « 1,234.5 ».
function montant(lamports) {
  const fr = enSol(lamports);
  if (langue === 'fr') return fr;
  const [entier, reste] = fr.split(',');
  return entier.replace(/\D/g, ',') + (reste ? '.' + reste : '');   // les milliers : une virgule, quel que soit le signe posé par `enSol`
}
function rendre(x) {
  if (x === null || x === undefined || x === false) return '';
  if (typeof x === 'string') return x;
  if (typeof x === 'number') return String(x);
  if (Array.isArray(x)) return x.map(rendre).filter((s) => s).join(' ');
  if (Array.isArray(x.suite)) return x.suite.map(rendre).filter((s) => s).join(x.sep);
  if (typeof x.sol === 'string') return montant(x.sol);
  if (typeof x.jour === 'number') return new Date(x.jour * 1000).toLocaleDateString(REGIONS[langue], { day: 'numeric', month: 'long', year: 'numeric' });
  if (typeof x.cle === 'string') {
    const v = {};
    if (x.v) for (const n of Object.keys(x.v)) v[n] = rendre(x.v[n]);
    return texte(langue, x.cle, v, SUR_TELEPHONE);
  }
  return '';
}
// Les clés d'une phrase, les siennes et celles de ses valeurs : posées sur la case (`data-cle`), elles disent ce qui
// y est écrit sans dépendre de la langue.
function cles(x, liste = []) {
  if (!x || typeof x !== 'object') return liste;
  if (Array.isArray(x)) { for (const y of x) cles(y, liste); return liste; }
  if (Array.isArray(x.suite)) { for (const y of x.suite) cles(y, liste); return liste; }
  if (typeof x.cle === 'string') { liste.push(x.cle); if (x.v) for (const n of Object.keys(x.v)) cles(x.v[n], liste); }
  return liste;
}
const ecrits = new Map();   // ce qui est écrit dans chaque case : la phrase, pas le texte
function poser(e, propriete, valeur) {
  if (propriete === 'ariaLabel' && typeof e.setAttribute === 'function') e.setAttribute('aria-label', valeur);
  else e[propriete] = valeur;
}
// Écrire une phrase dans une case (son texte, ou une autre propriété : l'invite d'un champ, son nom pour un lecteur
// d'écran). Rien, ou un texte vide, efface la case.
function ecrire(id, phrase, propriete) {
  const e = $(id), p = propriete || 'textContent';
  const vide = phrase === null || phrase === undefined || phrase === '' || phrase === false;
  if (vide) ecrits.delete(id + ' ' + p); else ecrits.set(id + ' ' + p, { id, p, phrase });
  poser(e, p, rendre(phrase));
  if (p === 'textContent' && e.dataset) e.dataset.cle = cles(phrase).join(' ');
  return e;
}
function dire(id, phrase, sorte) { ecrire(id, phrase).className = 'status' + (sorte ? ' ' + sorte : ''); }
function habillerLangue() {
  try { if (document.documentElement) document.documentElement.lang = langue; } catch (_) { /* pas de document à marquer */ }
  try { document.title = texte(langue, 'titre', null, SUR_TELEPHONE); } catch (_) { /* pas de titre à écrire */ }
  for (const l of Object.keys(LANGUES)) {
    const b = $('b-langue-' + l);
    b.textContent = LANGUES[l]; b.className = l === langue ? 'actif' : '';
    if (typeof b.setAttribute === 'function') b.setAttribute('aria-pressed', l === langue ? 'true' : 'false');
  }
}
function changerLangue(l) {
  if (!langueConnue(l)) return;
  try { localStorage.setItem(CLE_LANGUE, l); } catch (_) { /* pas gardée sur l'appareil : elle vaut pour la page ouverte */ }
  if (l === langue) return;
  langue = l;
  habillerLangue();
  for (const { id, p, phrase } of ecrits.values()) poser($(id), p, rendre(phrase));
}
// Le nom donné à la clé d'accès : c'est le système de l'appareil qui le montre au joueur, dans sa liste.
const nomCle = () => texte(langue, 'nom_cle', { date: new Date().toLocaleString(REGIONS[langue], { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) }, SUR_TELEPHONE);
// Les textes qui ne changent pas d'état : la case, sa clé, et la propriété quand ce n'est pas le texte.
const FIXES = [
  ['t-titre', 'titre'], ['t-essai', 'essai'], ['z-langue', 'langue', 'ariaLabel'],
  ['t-adm-titre', 'adm_titre'], ['t-adm-texte', 'adm_texte'], ['code-testeur', 'adm_titre', 'ariaLabel'], ['b-code', 'adm_bouton'],
  ['b-jeu', 'j_bouton'], ['b-jeu-refus', 'j_refus'], ['b-op-confirmer', 'op_confirmer'], ['b-op-refuser', 'op_refuser'],
  ['t-porte-google', 'a_google'], ['t-porte-discord', 'a_discord'], ['t-porte-email', 'a_email'], ['p-identite', 'a_identite'],
  ['email', 'ph_email', 'placeholder'], ['email', 'aria_email', 'ariaLabel'], ['b-envoyer-code', 'b_recevoir_code'],
  ['code-email', 'ph_code', 'placeholder'], ['code-email', 'ph_code', 'ariaLabel'], ['b-valider-code', 'b_valider_code'],
  ['b-creer', 'a_creer'], ['t-wallet', 'a_wallet'], ['p-wallet', 'a_wallet_note'], ['b-connecter', 'a_deja'], ['b-retrouver', 'a_perdu'], ['a-pied', 'a_pied'],
  ['t-r-email-titre', 'r_email_titre'], ['t-r-email-texte', 'r_email_texte'], ['r-adresse', 'ph_email', 'placeholder'], ['r-adresse', 'aria_email', 'ariaLabel'],
  ['b-r-code', 'b_recevoir_code'], ['r-code', 'ph_code', 'placeholder'], ['r-code', 'ph_code', 'ariaLabel'], ['b-r-valider', 'b_valider_code'], ['t-r-meme-compte', 'r_meme_compte'],
  ['t-r-mots-titre', 'r_mots_titre'], ['t-r-mots-texte', 'r_mots_texte'], ['b-r-retrouver', 'r_valider'], ['b-r-aide', 'r_aide'],
  ['t-r-garder-titre', 'r_garder_titre'], ['t-r-adresse', 'c_adresse'], ['t-r-garder-texte', 'r_garder_texte'], ['t-r-portee', 'r_portee'], ['t-r-ancien', 'r_ancien'],
  ['b-r-garder', 'r_garder'], ['b-r-annuler', 'b_annuler'],
  ['t-c-titre', 'c_titre'], ['t-c-adresse', 'c_adresse'], ['b-copier-adresse', 'c_copier'], ['b-doublon', 'c_doublon_retirer'], ['b-renvoyer', 'c_renvoyer'],
  ['b-adresses', 's_adresses'], ['t-ap-titre', 'ap_titre'],
  ['t-c-plus', 'c_plus'], ['t-c-adresse-entiere', 'c_adresse_entiere'], ['b-reconnecter', 'c_tester'], ['b-ouvrir', 'c_tester_local'], ['b-oublier', 'c_oublier'],
  ['t-ad-titre', 'ad_titre'], ['t-ad-texte', 'ad_texte'], ['t-ad-note', 'ad_note'], ['b-a-terminer', 'ad_terminer'], ['b-a-changer-1', 'ad_changer_1'],
  ['b-a-regler-2', 'ad_ajouter_2'], ['b-a-retirer-2', 'ad_retirer_2'], ['a-adresse', 'ph_email', 'placeholder'], ['a-adresse', 'aria_email', 'ariaLabel'],
  ['b-a-code', 'b_recevoir_code'], ['a-code', 'ph_code', 'placeholder'], ['a-code', 'ph_code', 'ariaLabel'], ['b-a-enregistrer', 'ad_enregistrer'],
  ['b-a-retour', 'ad_retour'], ['b-a-fermer', 'ad_fermer'],
  ['t-m-titre', 'm_titre'], ['t-m-intro', RECUPERATION ? 'm_intro' : 'm_intro_sans'], ['t-m-seul', 'm_seul'], ['t-m-pourquoi-titre', 'm_pourquoi_titre'], ['t-m-pourquoi', 'm_pourquoi'], ['b-m-voir', 'm_voir'],
  ['t-m-mots-titre', 'm_mots_titre'], ['t-m-mots-texte', 'm_mots_texte'], ['b-m-note', 'm_note'],
  ['t-m-cartes-titre', 'm_cartes_titre'], ['t-m-cartes-texte', 'm_cartes_texte'], ['b-m-valider', 'm_valider'], ['b-m-retirer', 'm_retirer'], ['b-m-revoir', 'm_revoir'],
  ['t-m-email-titre', 'm_email_titre'], ['t-m-email-ok', 'm_email_ok'], ['t-m-email-texte', 'm_email_texte'], ['m-adresse', 'ph_email', 'placeholder'], ['m-adresse', 'aria_email', 'ariaLabel'],
  ['b-m-code', 'b_recevoir_code'], ['m-code', 'ph_code', 'placeholder'], ['m-code', 'ph_code', 'ariaLabel'], ['b-m-finir', 'm_finir'], ['b-m-annuler', 'b_annuler'],
];
function poserLesTextes() {
  habillerLangue();
  for (const [id, cle, propriete] of FIXES) ecrire(id, t(cle), propriete);
  for (let i = 1; i <= 12; i++) ecrire('r-mot-' + i, t('aria_mot', { n: i }), 'ariaLabel');
}

function montrer(id) { for (const v of VUES) $(v).hidden = v !== id; }
// ---------- Le relevé d'essai. Il sert à ceux qui essaient la page : lui et ses lignes restent en français, quelle
// que soit la langue de la page.
function texteResultat() {
  return ['RESULTAT COMPTE temps 1', 'page : version ' + REGLAGES.version, 'date : ' + new Date().toISOString(), 'navigateur : ' + navigator.userAgent,
    'coffre sur cet appareil : ' + (fiche ? 'oui, adresse ' + fiche.coffre.adresse + ' | garde chez nous ' + (fiche.garde ? 'oui' : 'non') : 'non'), '---'].concat(journal).join('\n');
}
function noter(ligne) { journal.push(ligne); $('resultat').value = texteResultat(); }

// ---------- Les refus : une phrase par nom (les clés `e_…` de textes.mjs).
// « Trop d'essais » est le seul refus qui dit combien de temps attendre.
const attente = (e) => { const n = e && Number.isSafeInteger(e.attente) ? Math.max(1, Math.ceil(e.attente / 60)) : 30; return t(n > 1 ? 'e_trop_n' : 'e_trop_1', { n }); };
function phraseRefus(nom) {
  if (typeof nom !== 'string' || !nom) return null;
  if (nom === 'IdentiteRequise' && IDENTITE_EXIGEE && !PAR_EMAIL) return t('e_IdentiteRequise_portes');
  return existe('e_' + nom) ? t('e_' + nom) : null;
}
const expliquer = (e) => (e && e.name === 'TropDEssais' ? attente(e) : phraseRefus(e && e.name)) || t('e_inconnu', { nom: (e && e.name) || 'erreur' });
// La raison d'un envoi non abouti, quand elle se glisse dans une autre phrase : sa phrase, ou son nom tel quel.
const raison = (nom) => phraseRefus(nom) || (nom ? String(nom) : '');
const detail = (e) => (e && e.name ? e.name : 'erreur') + (e && e.detail ? ' (' + e.detail + ')' : '');
// Le résultat d'une demande est inconnu : la réponse n'est pas arrivée, ou le serveur a eu une panne en route.
// La logique de la page a gardé la demande : retoucher le bouton la renvoie telle quelle.
const incertain = (e) => !!e && ['ReseauCoupe', 'Indisponible', 'Erreur'].includes(e.name);
const formeEmail = (v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);

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
  lire: () => transaction('readonly', (m, rendu) => { const r = m.get('fiche'); r.onsuccess = () => rendu(r.result); }),
  inscrire: (f) => transaction('readwrite', (m, rendu, refuser) => { const r = m.add(f, 'fiche'); r.onerror = (ev) => { ev.preventDefault(); refuser('DejaUnCoffre'); }; }),
  remplacer: (ancienne, f) => transaction('readwrite', (m, rendu, refuser) => { const r = m.get('fiche'); r.onsuccess = () => { if (!meme(r.result, ancienne)) refuser('StockChange'); else m.put(f, 'fiche'); }; }),
  effacer: (ancienne) => transaction('readwrite', (m, rendu, refuser) => { const r = m.get('fiche'); r.onsuccess = () => { if (!meme(r.result, ancienne)) refuser('StockChange'); else m.delete('fiche'); }; }),
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
    const r = new K.Refus(refus);
    if (corps && Number.isSafeInteger(corps.attente)) r.attente = corps.attente;
    throw r;
  }
  return corps;
}
function demanderCode() { $('v-admission').hidden = false; dire('s-admission', codeTesteur.lire() ? t('adm_faux') : '', 'ko'); }
function validerCode() {
  const v = $('code-testeur').value.trim();
  if (!/^[\x21-\x7e]{1,200}$/.test(v)) { dire('s-admission', t('adm_forme'), 'ko'); return; }
  codeTesteur.garder(v);
  $('code-testeur').value = '';
  $('v-admission').hidden = true;
  noter('[page] code de testeur saisi');
  // Le message se pose à côté du bouton à retoucher, et il remplace le refus affiché juste avant : sinon le
  // testeur lit encore « cette version demande un code » sous le bouton et s'arrête là (essai du 13/11 sur iPhone).
  const retoucher = (cle) => t('adm_ok_bouton', { bouton: t(cle) });
  if (operation) dire('s-operation', operation.fini ? '' : retoucher('op_confirmer'), 'ok');
  else if (demandeJeu() && fiche) { dire('s-coffre', ''); dire('s-jeu', retoucher('j_bouton'), 'ok'); }
  else if (!$('v-mission').hidden) dire('s-mission', mission === null ? retoucher('m_voir') : t('adm_ok'), 'ok');
  else if (!$('v-retrouver').hidden) dire('s-retrouver', t('adm_ok'), 'ok');
  else if (!$('v-adresses').hidden) dire('s-adresses', t('adm_ok'), 'ok');
  else dire(fiche ? 's-coffre' : 's-accueil', t('adm_ok'), 'ok');
}
const appareil = {
  creer: (o) => navigator.credentials.create({ publicKey: o }),
  demander: (o) => navigator.credentials.get({ publicKey: o }),
};
// Le système de l'appareil, tel que le navigateur le dit. Il ne sert qu'à choisir la forme d'une demande de clé
// d'accès (voir `demander` dans client.mjs). Un navigateur qui ne le dit pas reçoit la forme habituelle.
function systeme() {
  try { const p = navigator.userAgentData && navigator.userAgentData.platform; if (typeof p === 'string' && p) return p; } catch (_) { /* pas dit */ }
  return /Windows NT/.test(navigator.userAgent || '') ? 'Windows' : '';
}
// Le rangement de cette fenêtre, pour la tentative en cours par une autre porte : le stockage de session, propre à
// l'onglet et à cette origine. Rien d'autre n'y va, et rien de durable. S'il est refusé, aucune porte ne part.
const CLE_TENTATIVE = 'tentative-porte';
const rangement = {
  lire() { try { const x = sessionStorage.getItem(CLE_TENTATIVE); return x ? JSON.parse(x) : null; } catch (_) { return null; } },
  garder(o) { try { sessionStorage.setItem(CLE_TENTATIVE, JSON.stringify(o)); return sessionStorage.getItem(CLE_TENTATIVE) === JSON.stringify(o); } catch (_) { return false; } },
  effacer() { try { sessionStorage.removeItem(CLE_TENTATIVE); } catch (_) { /* rien */ } },
};
// La langue des 12 mots d'un compte neuf est celle de la page au moment où il se crée : le client la lit à cet
// instant. Un compte qui existe déjà garde la sienne (elle est écrite dans le compte).
const c = client({ api, appareil, stock, noter, rangement,
  reglages: { origine: location.origin, rpId: REGLAGES.rpId, environnement: REGLAGES.environnement, projet: REGLAGES.projet, get langue() { return langue; }, identite: REGLAGES.identite,
    recuperation: REGLAGES.recuperation, systeme: systeme(), portes: PORTES, adresseIdentite: REGLAGES.adresseIdentite } });

// ---------- L'écran
// Une adresse en court : ses quatre premiers et ses quatre derniers caractères. Le signe invisible après les points
// de suspension empêche le navigateur de couper l'adresse en deux lignes à cet endroit.
const court = (adresse) => adresse.slice(0, 4) + '…⁠' + adresse.slice(-4);
const enDouble = () => !!fiche && !fiche.garde && doublon === fiche.coffre.adresse;
// Un message vient d'être écrit loin du bouton touché (une autre carte) : l'amener à l'écran, sans à-coup.
function amener(id) { const e = $(id); try { if (typeof e.scrollIntoView === 'function') e.scrollIntoView({ block: 'nearest' }); } catch (_) { /* tant pis */ } }
async function afficher(message, sorte) {
  try { fiche = (await stock.lire()) || null; }
  catch (e) { fiche = null; noter('[page] stockage indisponible : ' + detail(e)); }
  $('resultat').value = texteResultat();
  if (mainRendue || operation) return;   // la main est rendue au jeu, ou une opération est à confirmer : cette fenêtre ne montre plus que cette carte
  rafraichirJeu();
  rafraichirAccueil();
  dire('s-appareil', ''); dire('s-plus', '');
  if (!fiche) { doublon = null; montrer('v-accueil'); dire('s-accueil', message, sorte); return; }
  const d = demandeJeu(), double = enDouble();
  $('adresse').textContent = fiche.coffre.adresse;
  $('adresse-courte').textContent = court(fiche.coffre.adresse);
  // Un compte en attente après une récupération : il est bien sauvegardé, c'est cet appareil qui n'est pas encore enregistré.
  // Un compte fabriqué en double : il n'est sauvegardé nulle part, et la page ne laisse pas croire le contraire.
  dire('garde', fiche.garde ? t('c_sauve') : double ? [t('c_doublon'), t('c_doublon_suite')] : fiche.vers ? t('c_appareil_pas_enregistre') : t('c_pas_sauve'), fiche.garde ? 'ok' : 'ko');
  $('b-renvoyer').hidden = fiche.garde || double;
  $('b-doublon').hidden = !double;
  desarmerDoublon();
  $('b-reconnecter').hidden = !fiche.garde || !!d;   // un jeu attend : un seul bouton, celui de sa carte
  // La protection : faite ou à faire. Elle se fait hors de la demande d'un jeu, sur un compte déjà sauvegardé.
  const [phraseSecours, fait, boutonSecours, principal] = etatSecours(fiche);
  ecrire('t-s-titre', t(fait ? 's_titre_fait' : 's_titre')).className = fait ? 'fait' : '';
  ecrire('secours', phraseSecours);
  ecrire('b-mission', boutonSecours).className = principal ? '' : 'second';
  $('b-mission').hidden = !fiche.garde || !!d;
  $('c-protection').hidden = !fiche.garde || !!d;
  // La clé a répondu depuis ailleurs que cet appareil (un autre téléphone, ou une clé de sécurité : le navigateur ne
  // dit pas lequel) : la page propose d'ajouter cet appareil. Pas pendant la demande d'un jeu.
  const emprunt = fiche.garde && (!!fiche.distante || !!fiche.ajout);
  ecrire('appareil', !emprunt ? '' : fiche.ajout ? t('ap_en_attente') : t('ap_texte'));
  ecrire('b-ajouter', fiche.ajout ? t('ap_reessayer') : t('ap_ajouter'));
  $('b-ajouter').hidden = !emprunt || !!d;
  $('c-appareil').hidden = !emprunt || !!d;
  desarmerAjout();
  // Les adresses de secours se règlent une fois la protection faite avec une adresse. Pas pendant la demande d'un jeu.
  $('b-adresses').hidden = !(RECUPERATION && fiche.garde && fiche.secours && fiche.secours.lie === true) || !!d;
  desarmer();
  // Un jeu attend, et le compte est prêt : une seule carte à l'écran, celle du jeu. Le message s'écrit alors chez elle.
  const carteDuJeu = !!d && fiche.garde;
  montrer(carteDuJeu ? null : 'v-coffre');
  if (carteDuJeu) { dire('s-coffre', ''); if (message) dire('s-jeu', message, sorte); }
  else { dire('s-coffre', message, sorte); if (message) amener('s-coffre'); }
}
// Ce que la page dit de la protection : [la phrase, « c'est fait », le bouton, « c'est l'action à faire »]. Elle ne
// dit « protégé » sans réserve que si le wallet se retrouve vraiment sans appareil : avec la récupération, il faut
// un compte au format 3 et une déclaration qui désigne une adresse e-mail.
// Quand la récupération est éteinte, la page ne promet rien : les mots sont notés, le titre ne dit jamais
// « protégé », et chaque phrase dit que retrouver son compte sans appareil n'est pas encore possible ici.
function etatSecours(f) {
  if (!f.secours) return [t(RECUPERATION ? 's_a_faire' : 's_a_faire_sans'), false, t('s_commencer'), true];
  if (!RECUPERATION) return [t('s_fait_mots'), false, t('s_refaire'), false];
  if (f.coffre.v !== 3) return [t('s_ancien'), false, t('s_refaire'), false];
  if (f.secours.lie !== true) return [t('s_a_completer'), false, t('s_terminer'), true];
  return [t('s_fait'), true, t('s_refaire'), false];
}
// Une seule action à la fois. Et plus aucune une fois la main rendue au jeu, ni pendant qu'une opération est à
// confirmer : la règle est tenue ici, pas seulement par des boutons cachés.
const seul = (fn) => async () => { if (occupe || mainRendue || operation) return; occupe = true; try { await fn(); } finally { occupe = false; } };
// Les boutons qui ne font que changer d'écran (ouvrir la protection, les adresses, la récupération) : ils n'attendent
// rien, mais ils n'agissent pas pendant qu'une action est en cours. Changer d'écran, ou de choix, pendant qu'une
// action attend une réponse du service ou un geste changerait ce qu'elle va écrire à son retour (défaut reproduit le
// 17/11 : un code validé pour la seconde adresse de secours, appliqué à l'adresse principale). Même règle une fois
// la main rendue, ou pendant une opération. Chaque action tient en plus son propre objet (voir `tenir`).
const libre = (fn) => () => { if (occupe || mainRendue || operation) return; fn(); };
// La seconde barrière, dans chaque action qui attend : elle retient l'objet sur lequel elle a commencé (le réglage,
// la mission, la récupération en cours) et, après chaque attente, vérifie que c'est encore lui. Sinon elle s'arrête
// là : ni geste demandé, ni écriture, ni écran touché. `lire` rend l'objet courant.
const tenir = (lire, ou) => { const tenu = lire(); return { tenu, courant: () => { if (tenu && lire() === tenu) return true; noter('[' + ou + '] action abandonnee : l\'ecran a change pendant l\'attente, rien n\'est ecrit'); return false; } }; };
// Les deux boutons d'une opération à confirmer, eux, n'agissent que pendant une demande d'opération encore ouverte.
const seulOperation = (fn) => async () => { if (occupe || !operation || operation.fini || !operation.cle) return; occupe = true; try { await fn(); } finally { occupe = false; } };
// Quand la clé de ce compte n'est pas sur cet appareil. Si c'est celle d'un autre téléphone, certains appareils ne
// montrent pas le QR code d'emblée : la page le dit avant le geste. Elle ne sait pas de quelle sorte de clé il s'agit.
const attenteCle = () => (fiche && fiche.distante ? t('attente_ailleurs') : t('attente'));

// ---------- Un jeu a ouvert cette fenêtre pour connecter le joueur. La preuve ne part qu'à ce jeu, et seulement
// si le compte est gardé par le serveur. Si le jeu annonce le wallet déjà lié au joueur, ou dit seulement que le
// joueur a déjà son compte, on n'en crée pas d'autre.
const demandeJeu = () => { const d = lien && lien.demande(); return d && !d.retiree ? d : null; };
const sansCreation = (d) => !!(d && (d.attendue || d.existant));
// La carte du jeu dit toujours qui demande (son nom et son site, tels que cette page les tient) et ce qu'il verra.
// Sans compte ici, elle invite à en créer un ou à s'y connecter : la carte de l'accueil est juste en dessous.
function rafraichirJeu() {
  if (mainRendue) return;
  const d = demandeJeu();
  $('v-jeu').hidden = !d;
  if (fiche) {
    $('b-reconnecter').hidden = !fiche.garde || !!d; $('b-mission').hidden = !fiche.garde || !!d;
    if (d) {
      $('b-ajouter').hidden = true; $('b-adresses').hidden = true; $('c-protection').hidden = true; $('c-appareil').hidden = true;
      if (fiche.garde && !$('v-coffre').hidden) $('v-coffre').hidden = true;   // un jeu attend : une seule carte, la sienne
    }
  }
  if (!d) return;
  ecrire('jeu-titre', t('j_titre', { jeu: d.nom }));
  $('jeu-site').textContent = d.jeu;
  $('b-jeu').hidden = !fiche;
  $('b-jeu-refus').hidden = !fiche;
  ecrire('jeu-texte', !fiche ? t(d.attendue ? 'j_inv_attendue' : d.existant ? 'j_inv_existant' : 'j_inv')
    : fiche.garde ? t('j_texte') : enDouble() ? t('j_doublon') : t('j_non_garde'));
}
// « Créer mon compte » n'est proposé que si rien ne dit que ce joueur en a déjà un : ni le jeu, ni son identité.
// Et, quand le service demande de dire qui on est, seulement après le code validé.
// « Continuer avec mon e-mail » a été touché : la case de l'adresse est montrée à la place du bouton.
let emailOuvert = false;
function rafraichirAccueil() {
  const d = demandeJeu();
  // Le choix des portes (Google, Discord…) : seulement pour créer, donc ni après avoir dit qui on est, ni
  // quand le jeu attend un compte existant. Sans autre porte que l'e-mail, sa case est montrée directement.
  const choix = PORTES.length > 0 && !identite && !sansCreation(d);
  $('z-portes').hidden = !choix;
  for (const p of Object.keys(NOMS_PORTES)) $(BOUTONS_PORTES[p]).hidden = !PORTES.includes(p);
  $('b-porte-email').hidden = !PAR_EMAIL || emailOuvert;
  $('z-identite').hidden = !PAR_EMAIL || !!identite || sansCreation(d) || (choix && !emailOuvert);   // l'adresse ne sert qu'à créer
  // Revenu d'une porte où il était parti depuis un jeu : pas de création sans la demande de ce jeu.
  $('b-creer').hidden = sansCreation(d) || (venuDUnJeu && !d) || (IDENTITE_EXIGEE && (!identite || identite.coffre));
  $('b-retrouver').hidden = !RECUPERATION;
  // « J'ai déjà un wallet » : seulement quand le jeu qui attend ici le propose dans sa demande encore vivante.
  const parWallet = !!(d && d.wallet);
  $('b-wallet').hidden = !parWallet; $('p-wallet').hidden = !parWallet;
  // « J'ai déjà un compte » s'écrit comme un lien sous les autres choix ; quand c'est la seule action de l'écran, c'est
  // un vrai bouton.
  $('b-connecter').className = $('b-creer').hidden && !choix && $('z-identite').hidden && !parWallet ? '' : 'lien';
  // Le titre et la phrase d'accueil. Quand un jeu demande, c'est sa carte qui parle : ils se taisent. Ils ne
  // promettent pas de créer à qui a déjà un compte, ni quand le jeu en attend un qui existe.
  const toi = !!identite && !identite.coffre;
  ecrire('accueil-titre', t(toi ? 'a_titre_toi' : 'a_titre'));
  ecrire('p-accueil', t(toi ? 'a_texte_toi' : IDENTITE_EXIGEE ? 'a_texte' : 'a_texte_simple'));
  $('accueil-titre').hidden = !!d;
  $('p-accueil').hidden = !!d || (!!identite && !!identite.coffre);
}
// ---------- « J'ai déjà un wallet » : le joueur a déjà un wallet Solana et veut entrer avec lui. Cette page ne
// l'appelle pas et ne signe rien : elle dit au jeu « ce joueur choisit son wallet », pour la demande vivante, une
// seule fois, puis ne propose plus rien. C'est le jeu qui lui fera toucher son propre bouton, sur sa propre page.
// Le jeu accuse réception : la fenêtre se ferme. Sans accusé (la page du jeu a disparu), la page le dit et reste.
const ATTENTE_ACCUSE = 3000;   // millisecondes
function fermerBientot() { setTimeout(() => { try { window.close(); } catch (_) { /* le joueur fermera */ } }, 1500); }
// Cette fenêtre a rendu la main au jeu : il ne reste que sa carte, sans bouton.
function neGarderQueLeJeu() {
  for (const v of VUES) $(v).hidden = true;
  $('v-admission').hidden = true;
  $('v-jeu').hidden = false; $('b-jeu').hidden = true; $('b-jeu-refus').hidden = true;
  ecrire('jeu-texte', '');
}
function choisirWallet() {
  const d = demandeJeu();
  if (mainRendue || !d || !d.wallet) return;
  if (!lien.choisir('wallet')) { rafraichirAccueil(); return; }   // demande expirée ou retirée : sa carte le dit déjà
  mainRendue = true;
  noter('[jeu] le joueur choisit son wallet : la main est rendue au jeu, rien n\'est signe ici');
  neGarderQueLeJeu();
  dire('s-jeu', t('w_note', { jeu: d.nom }), 'wait');
  setTimeout(() => {
    if (lien.accuse()) return;
    noter('[jeu] le jeu n\'a pas accuse reception du choix');
    dire('s-jeu', t('w_sans_reponse', { jeu: d.nom }), 'ko');
  }, ATTENTE_ACCUSE);
}
function choixRecu(d) {
  dire('s-jeu', t('w_recu', { jeu: d.nom }), 'ok');
  fermerBientot();
}
// « Pas maintenant » : le joueur ne veut pas entrer dans ce jeu. Le jeu reçoit un refus, rien d'autre : ni adresse,
// ni preuve. La fenêtre ne propose plus rien pour cette demande, et se ferme.
function pasMaintenant() {
  const d = demandeJeu();
  if (mainRendue || !d) return;
  if (!lien.renoncer('pas maintenant')) return;   // demande expirée, retirée ou déjà servie : sa carte le dit déjà
  mainRendue = true;
  noter('[jeu] le joueur renonce : le jeu recoit un refus, aucune preuve ne part');
  neGarderQueLeJeu();
  dire('s-jeu', t('j_renonce'), 'wait');
  fermerBientot();
}
// ---------- Un jeu demande de confirmer une opération. Deux genres, jugés par la même porte (`lireDemande`) :
//   - un envoi ordinaire : la page lit elle-même les octets du message, dit au joueur ce qui sortirait de son
//     wallet, et ne fait signer que ce qu'elle comprend en entier (aujourd'hui, un envoi de SOL fait par le joueur) ;
//   - une opération NOMMÉE du jeu (une instruction de son propre programme) : la page exige la forme que la fiche de
//     ce jeu déclare pour ce nom, et vérifie les signatures du studio sur la transaction reçue. Elle ne comprend pas
//     ce que fait le programme : l'écran dit « opération du jeu », ce qui est lisible, et rien de plus.
// Les fiches des jeux sont dans les réglages de la page (`operations` : origine du jeu -> fiche) : elles ne viennent
// jamais du jeu. Un jeu qui a une fiche ne peut demander un envoi ordinaire que si sa fiche le lui permet.
// Tout le reste est refusé avant tout geste, et le jeu reçoit un refus.
// Pendant cette demande, la fenêtre ne propose rien d'autre : ni créer, ni se connecter, ni les réglages du compte.
// La page ne diffuse rien et ne dit jamais que l'envoi est fait : elle rend une signature au jeu, qui s'en charge.
// L'écran ne perd jamais, quelle que soit la langue : qui demande (son nom et son site), ce qui est demandé, à qui
// cela part, ce que cela coûte, et ce que la fenêtre a vérifié ou ne lit pas.
function cacherBoutonsOperation() { $('b-op-confirmer').hidden = true; $('b-op-refuser').hidden = true; }
// La demande est finie sans signature : le jeu reçoit le refus, la page dit pourquoi.
function finirOperation(motif, phrase, sorte) {
  if (!operation || operation.fini) return;
  operation.fini = true;
  cacherBoutonsOperation();
  lien.refuserOperation(motif);
  noter('[operation] pas de signature : ' + motif);
  dire('s-operation', phrase, sorte || 'ko');
}
// Quoi qu'il arrive pendant la lecture ou l'affichage, la demande finit par un refus : jamais un bouton sur une
// carte à moitié remplie, jamais une erreur laissée sans réponse au jeu.
async function operationArrivee(d) {
  // Une action de cette fenêtre est déjà en cours (ou la main est rendue) : la demande n'est pas prise.
  if (occupe || mainRendue || operation) { lien.refuserOperation('echec'); return; }
  operation = { d, fini: false, octets: null, lecture: null, cle: null };
  try { await montrerOperation(d); }
  catch (e) {
    noter('[operation] erreur pendant la lecture : ' + detail(e));
    operation.cle = null;
    finirOperation('echec', t('op_illisible'));
  }
}
async function montrerOperation(d) {
  const nommee = d.operation !== null && d.operation !== undefined;
  for (const v of VUES) $(v).hidden = true;
  $('v-jeu').hidden = true; $('v-admission').hidden = true;
  for (const id of ['op-sorties', 'op-destinataires', 'op-faits', 'op-frais', 'op-total', 'op-limite']) ecrire(id, '');
  $('op-limite').hidden = true;
  cacherBoutonsOperation();
  ecrire('op-titre', t(nommee ? 'op_titre_jeu' : 'op_titre_envoi'));
  ecrire('op-phrase', t(nommee ? 'op_phrase_jeu' : 'op_phrase_envoi'));
  $('op-nom').textContent = d.nom;
  $('op-site').textContent = d.jeu;
  $('v-operation').hidden = false;
  dire('s-operation', t('op_lecture'), 'wait');
  noter('[operation] demande de ' + d.jeu);
  let f = null;
  try { f = (await stock.lire()) || null; } catch (e) { noter('[page] stockage indisponible : ' + detail(e)); }
  fiche = f;
  $('resultat').value = texteResultat();
  if (operation.fini || d.retiree) return;   // retirée ou expirée pendant la lecture : sa carte le dit déjà
  if (!f) { finirOperation('pas-de-coffre', t('op_pas_de_compte')); return; }
  if (f.coffre.adresse !== d.attendue) { finirOperation('autre-wallet', t('op_autre_wallet')); return; }
  if (!f.garde) { finirOperation('non-garde', t('op_non_garde')); return; }
  // Le genre de demande, le jeu, sa fiche, l'opération et les octets sont jugés ensemble, ici, avant tout affichage ;
  // le client puis le compte ouvert referont exactement ce jugement avant de signer.
  const ficheDuJeu = FICHES && Object.prototype.hasOwnProperty.call(FICHES, d.jeu) ? FICHES[d.jeu] : undefined;
  let octets, contexte, jugement;
  try {
    if (nommee && !ficheDuJeu) throw new K.Refus('OperationInconnue', 'ce jeu n\'a aucune fiche');
    contexte = nommee ? { jeu: d.jeu, fiche: ficheDuJeu, operation: d.operation, version: d.version } : ficheDuJeu ? { jeu: d.jeu, fiche: ficheDuJeu } : undefined;
    octets = K.deB64u(nommee ? d.transaction : d.message);
    jugement = await lireDemande(octets, { wallet: f.coffre.adresse, contexte });
  } catch (e) {
    noter('[operation] refusee avant tout geste : ' + detail(e));
    finirOperation('illisible', t(nommee ? 'op_refus_nommee' : e && e.name === 'EnvoiLibreRefuse' ? 'op_refus_libre' : 'op_refus_incompris'));
    return;
  }
  if (operation.fini || d.retiree) return;   // retirée ou expirée pendant le jugement : sa carte le dit déjà
  const lecture = jugement.lecture;
  Object.assign(operation, { octets, lecture, cle: jugement.cle, contexte });
  if (jugement.genre === 'operation') { montrerOperationDuJeu(d, lecture); return; }
  ecrire('op-titre', t('op_titre_envoi'));
  ecrire('op-phrase', t('op_phrase_envoi'));
  $('op-limite').hidden = true;
  // Ce qui sort du wallet : une ligne par envoi, montant exact. L'adresse entière de chaque destinataire est en dessous.
  ecrire('op-sorties', suite(lecture.sorties.map((x) => t('op_sortie', { montant: sol(x.lamports), vers: court(x.vers) })), '\n'));
  ecrire('op-destinataires', suite(lecture.sorties.map((x, i) => (lecture.sorties.length > 1 ? t('op_destinataire_n', { n: i + 1, adresse: x.vers }) : t('op_destinataire', { adresse: x.vers }))), '\n'));
  const fraisMax = String(BigInt(lecture.frais.base) + BigInt(lecture.frais.prioriteMax));
  ecrire('op-frais', lecture.joueurPaie ? t('op_frais_joueur', { montant: sol(fraisMax) }) : t('op_frais_autre', { payeur: court(lecture.payeur) }));
  ecrire('op-total', t('op_total', { montant: sol(totalJoueur(lecture)) }));
  noter('[operation] lue : ' + lecture.sorties.length + ' envoi(s) de SOL | total au plus ' + totalJoueur(lecture) + ' lamports | frais payes par ' + (lecture.joueurPaie ? 'le joueur' : 'un autre compte'));
  $('b-op-confirmer').hidden = false; $('b-op-refuser').hidden = false;
  dire('s-operation', t('op_verifie'), 'wait');
}
// Une opération nommée d'un jeu. L'écran dit ce qui est lisible dans les octets, et rien de plus : le nom est celui
// que le jeu a déclaré dans sa fiche, pas une description vérifiée de ce que fera son programme.
function montrerOperationDuJeu(d, lecture) {
  ecrire('op-titre', t('op_titre_jeu'));
  ecrire('op-phrase', t('op_phrase_jeu'));
  ecrire('op-sorties', lecture.texte);
  // Sous le cadre, en petit : ce nom n'est pas une description vérifiée de ce que fera le programme.
  ecrire('op-destinataires', t('op_nom_declare'));
  const lignes = [];
  for (const a of lecture.avances) lignes.push(t('op_avance', { montant: sol(a.lamports) }));
  for (const x of lecture.sorties) lignes.push(t('op_envoi', { montant: sol(x.lamports), vers: court(x.vers), adresse: x.vers }));
  if (!lecture.sorties.length) lignes.push(t('op_aucun_envoi'));
  // Un compte en lecture seule qui ne paie pas les frais : cette transaction ne peut pas débiter ses SOL. La phrase
  // ne dit rien de plus : ni des jetons, ni des objets, ni du SOL enveloppé (voir la limite, juste en dessous).
  if (!lecture.walletInscriptible && !lecture.joueurPaie) lignes.push(t('op_sol_fixe'));
  ecrire('op-faits', suite(lignes, '\n'));
  const fraisMax = String(BigInt(lecture.frais.base) + BigInt(lecture.frais.prioriteMax));
  ecrire('op-frais', lecture.joueurPaie ? t('op_frais_joueur', { montant: sol(fraisMax) }) : t('op_frais_jeu'));
  ecrire('op-total', '');
  // Même en lecture seule, le wallet signe : le programme du jeu peut agir sur ses jetons et ses objets avec cette
  // signature. La page ne le lit pas, elle le dit.
  ecrire('op-limite', t(lecture.walletInscriptible ? 'op_limite_ecriture' : 'op_limite_lecture'));
  $('op-limite').hidden = false;
  noter('[operation] operation du jeu « ' + lecture.operation + ' » (version ' + lecture.revision + ', fiche ' + lecture.fiche + ', ' + lecture.reseau + ') : forme et cosignatures verifiees | '
    + lecture.signatures + ' signatures | frais payes par ' + (lecture.joueurPaie ? 'le joueur' : 'le jeu') + ' | envois lisibles : ' + lecture.sorties.length + ' | avances : ' + lecture.avances.length);
  $('b-op-confirmer').hidden = false; $('b-op-refuser').hidden = false;
  dire('s-operation', t('op_inattendue'), 'wait');
}
async function confirmerOperation() {
  const o = operation;
  lien.relire();   // l'heure est relue ici : une demande dont le minuteur dormait expire avant tout geste, et sa carte le dit
  if (o.d.retiree) return;
  dire('s-operation', attenteCle(), 'wait');
  try {
    // Le client relit les octets avant le geste, et le compte ouvert les relit encore juste avant de signer : la
    // lecture doit être exactement celle qui est à l'écran. `encoreValide` : la demande peut expirer, ou être
    // retirée, pendant que le joueur confirme sur son appareil ; le client repose la question juste avant de signer,
    // l'heure relue. Si la demande ne vit plus, rien n'est signé (`OperationExpiree`).
    const r = await c.signerOperation({ octets: o.octets, lecture: o.cle, adresse: o.d.attendue, contexte: o.contexte,
      encoreValide: () => lien.relire() === true && !o.fini && !o.d.retiree });
    if (o.fini) { noter('[operation] demande finie pendant le geste : la signature n\'est pas envoyee'); return; }
    o.fini = true;
    cacherBoutonsOperation();
    if (!lien.rendre({ adresse: r.adresse, signature: K.b64u(r.signature) })) {
      // La demande a dépassé sa durée à l'instant de répondre (sa carte vient de le dire : « aucune signature
      // envoyée »), ou le jeu l'a retirée : rien n'est parti.
      noter('[operation] la demande ne vit plus : la signature n\'est pas envoyee');
      if (!o.d.expiree) dire('s-operation', t('op_retire_rien'), 'wait');
      return;
    }
    noter('[operation] confirmee par le joueur, signature rendue au jeu (rien n\'est diffuse d\'ici)');
    dire('s-operation', t('op_confirme', { jeu: o.d.nom }), 'ok');
    fermerBientot();
  } catch (e) {
    noter('[operation] echec : ' + detail(e));
    if (o.fini) return;   // retirée ou expirée pendant le geste : sa carte le dit déjà
    // Geste annulé, ou code de testeur à donner : la demande reste ouverte, le joueur peut réessayer ou refuser.
    if (e && e.name === 'NotAllowedError') { dire('s-operation', t('op_annule'), 'wait'); return; }
    if (e && e.name === 'AdmissionRefusee') { dire('s-operation', t('e_AdmissionRefusee'), 'ko'); return; }
    // La demande est morte pendant le geste : la page ne sait pas dire « rien n'a été signé », elle dit ce qui est sûr.
    if (e && e.name === 'OperationExpiree') { finirOperation('expiree', t('e_OperationExpiree'), 'wait'); return; }
    finirOperation(e && e.name === 'AutreWallet' ? 'autre-wallet' : 'echec', [phraseRefus(e && e.name) || t('op_signature_echec'), t('op_rien_envoye')]);
  }
}
function refuserOperation() {
  finirOperation('refusee', t('op_refusee'), 'wait');
  fermerBientot();
}
// Le jeu a retiré sa demande, ou elle a dépassé sa durée : plus aucune signature ne partira pour elle. Cela peut
// arriver pendant que le joueur confirme sur son appareil : la page dit « aucune signature envoyée », jamais
// « rien n'a été signé ».
function operationRetiree(d) {
  if (!operation || operation.d !== d) return;
  operation.fini = true;
  cacherBoutonsOperation();
  $('v-admission').hidden = true;
  dire('s-operation', t(d.expiree ? 'op_expiree' : 'op_retiree'), 'wait');
}
// ---------- Dire qui on est par une autre porte (Google, Discord…). La fenêtre part chez le fournisseur et revient :
// la page se recharge entre les deux. Rien du code ni du vérifieur ne va au relevé, au stockage de l'appareil ou au jeu.
async function partirPar(porte) {
  dire('s-accueil', t('un_instant'), 'wait');
  try {
    const adresse = await c.partirParPorte(porte, { parUnJeu: !!lien });
    dire('s-accueil', t('a_depart', { service: NOMS_PORTES[porte] }), 'wait');
    location.assign(adresse);
  } catch (e) { noter('[identite] depart refuse : ' + detail(e)); dire('s-accueil', expliquer(e), 'ko'); }
}
async function retourDePorte() {
  if (RETOUR_PORTE === null || operation) return;
  // Un compte est déjà sur cet appareil : ce retour ne sert à rien. La tentative est effacée, rien n'est envoyé.
  if (fiche) { c.oublierPorte(); return; }
  dire('s-accueil', t('verification'), 'wait');
  try {
    const r = await c.revenirDePorte(RETOUR_PORTE);
    identite = { coffre: r.coffre };
    venuDUnJeu = r.parUnJeu;
    rafraichirAccueil();
    if (identite.coffre) { dire('s-accueil', [t('a_deja_compte'), RECUPERATION ? t('a_deja_perdu') : null], 'ok'); return; }
    dire('s-accueil', t('a_cest_toi'), 'ok');
  } catch (e) { noter('[identite] retour refuse : ' + detail(e)); rafraichirAccueil(); dire('s-accueil', expliquer(e), 'ko'); return; }
  // L'identité est confirmée et n'a pas de compte : la création s'enchaîne, sous le même garde que le bouton.
  await seul(() => enchainerCreation(venuDUnJeu))();
}
// ---------- Dire qui on est : une adresse e-mail, puis le code reçu. L'adresse n'est ni gardée ni écrite au relevé.
async function envoyerCode() {
  const email = $('email').value.trim();
  if (!formeEmail(email)) { dire('s-accueil', t('email_forme'), 'ko'); return; }
  dire('s-accueil', t('envoi'), 'wait');
  try {
    await c.demanderCode(email);
    $('z-code').hidden = false; $('b-envoyer-code').className = 'second';   // le code est parti : l'action à faire est de le valider
    noter('[identite] code demande');
    dire('s-accueil', t('code_parti'), 'ok');
  } catch (e) { noter('[identite] echec : ' + detail(e)); dire('s-accueil', expliquer(e), 'ko'); }
}
async function validerLeCode() {
  const email = $('email').value.trim(), code = $('code-email').value.replace(/\D/g, '');
  if (code.length !== 6) { dire('s-accueil', t('code_six'), 'ko'); return; }
  dire('s-accueil', t('verification'), 'wait');
  try {
    identite = await c.validerCode(email, code);
    $('code-email').value = ''; $('z-code').hidden = true;
    noter('[identite] adresse confirmee | coffre existant ' + (identite.coffre ? 'oui' : 'non'));
    rafraichirAccueil();
    if (identite.coffre) { dire('s-accueil', t('a_deja_compte'), 'ok'); return; }
  } catch (e) { noter('[identite] echec : ' + detail(e)); dire('s-accueil', expliquer(e), 'ko'); return; }
  // L'adresse est confirmée et n'a pas de compte : la création s'enchaîne (ce toucher-ci tient déjà le garde).
  await enchainerCreation(false);
}

function envoyerAuJeu(d, adresse, preuve) {
  if (d.attendue && adresse !== d.attendue) {
    lien.renoncer('autre coffre');
    noter('[jeu] ce coffre n\'est pas celui que le jeu attend : rien n\'est envoye');
    $('b-jeu-refus').hidden = true;
    dire('s-jeu', t('j_autre_compte', { jeu: d.nom }), 'ko');
    return;
  }
  if (!lien.repondre({ adresse, message: K.b64u(preuve.message), signature: K.b64u(preuve.signature) })) {
    dire('s-jeu', t('j_retire_rien_envoye'), 'wait');
    return;
  }
  $('b-jeu').hidden = true; $('b-jeu-refus').hidden = true;
  // La fenêtre a envoyé la preuve, rien de plus : c'est le jeu qui la vérifie et qui annonce la connexion.
  dire('s-jeu', t('j_envoye', { jeu: d.nom }), 'ok');
  fermerBientot();
}
async function entrerDansLeJeu() {
  if (lien) lien.relire();   // une demande dont le minuteur dormait expire ici, avant tout geste : sa carte le dit
  const d = demandeJeu();
  if (!d) return;
  dire('s-jeu', attenteCle(), 'wait');
  try {
    const r = await c.prouver({ jeu: d.jeu, defi: d.defi });
    await afficher();
    envoyerAuJeu(d, r.adresse, r.preuve);
  } catch (e) { noter('[jeu] echec : ' + detail(e)); await afficher(); dire('s-jeu', expliquer(e), 'ko'); }
}

// L'inscription mène au wallet : dès que le joueur a dit qui il est (une porte comme Google, ou son code e-mail), la
// page lance elle-même la création du compte, sans attendre un toucher de plus. Elle ne dit « créé » qu'après la
// création réelle et son rangement. Certains navigateurs refusent de créer une clé d'accès sans toucher, et un joueur
// peut annuler : le bouton « Créer mon compte » reste alors, avec une phrase calme (pas une erreur).
// `parUnJeu` : le joueur revient d'une porte où il était parti depuis la fenêtre d'un jeu. Ce jeu redonne sa demande
// à chaque annonce de la page : elle l'attend, et ne crée qu'avec elle (la création et la preuve se font alors dans
// le même geste). Le délai ne sert qu'à décider quoi écrire à l'écran : passé ce délai sans demande, la page ne crée
// rien et dit de repartir du jeu. Si la demande arrive plus tard, le bouton revient (voir `demandeArrivee`).
const ATTENTE_JEU = 1500;   // millisecondes
function direSansLeJeu() {
  sansLeJeu = true;
  noter('[creer] venu d\'un jeu, sans demande de ce jeu : rien n\'est cree');
  rafraichirAccueil();
  dire('s-accueil', t('a_sans_jeu'), 'wait');
}
// La demande du jeu arrive (ou change). Si la page avait dit « le jeu ne répond plus », cette phrase n'est plus vraie.
function demandeArrivee() {
  rafraichirJeu(); rafraichirAccueil();
  if (!sansLeJeu || !demandeJeu()) return;
  sansLeJeu = false;
  if (!fiche) dire('s-accueil', $('b-creer').hidden ? '' : t('a_jeu_revenu'), 'ok');
}
async function enchainerCreation(parUnJeu) {
  if (fiche || !identite || identite.coffre) return;
  if (parUnJeu) {
    const fin = Date.now() + ATTENTE_JEU;
    while (lien && !demandeJeu() && Date.now() < fin) await new Promise((ok) => setTimeout(ok, 100));
    if (!demandeJeu()) { direSansLeJeu(); return; }
  }
  rafraichirAccueil();
  if ($('b-creer').hidden) return;   // le jeu attend un compte qui existe déjà : rien à créer ici
  await creer({ enchaine: true });
}
// Le service a répondu « ce joueur a déjà un compte » à l'envoi d'un compte qui vient d'être fabriqué ici : deux
// façons de se connecter ont créé presque en même temps, et l'autre est arrivée la première. Le compte de cet
// appareil reste où il est (c'est sa seule copie, la page ne l'efface jamais d'elle-même) ; l'écran dit qu'il n'est
// pas sauvegardé et ne le sera pas, et propose de le retirer, puis de se connecter au compte qui existe.
function noterDoublon(adresse) {
  doublon = adresse;
  identite = { coffre: true };   // le service vient de le dire : ce joueur a déjà un compte, on ne lui propose plus d'en créer
  noter('[creer] ce joueur a deja un compte : celui de cet appareil est en double, il n\'est pas garde chez nous');
}
async function creer(options) {
  const enchaine = !!(options && options.enchaine);
  const d = demandeJeu();
  // Le bouton est caché dans ces deux cas ; la règle est tenue ici aussi.
  if (sansCreation(d)) { dire('s-accueil', t('a_existant_demande'), 'ko'); return; }
  if (venuDUnJeu && !d) { direSansLeJeu(); return; }
  // Sans jeu, le titre et la phrase de l'accueil disent déjà « c'est bien toi » ; avec un jeu, ils se taisent.
  dire('s-accueil', t(enchaine && d ? 'a_confirme' : 'attente'), 'wait');
  try {
    // `encorePermis` : la demande du jeu peut arriver, ou changer, pendant que le joueur confirme sur son appareil.
    // Le client repose la question après le geste, juste avant de fabriquer le compte puis juste avant de le ranger.
    const r = await c.creer(nomCle(), { connexion: d ? { jeu: d.jeu, defi: d.defi } : undefined, encorePermis: () => !sansCreation(demandeJeu()) });
    identite = null;   // la preuve d'identité a servi
    // Le joueur était parti chez un fournisseur depuis la fenêtre d'un jeu, et la demande de ce jeu, vivante au
    // départ de la création, ne l'est plus à la fin (retirée ou expirée pendant le geste) : la page le renvoie au
    // jeu. Elle ne le dit qu'ici, après la création réelle et son rangement sur l'appareil et chez nous ; rien n'est
    // envoyé au jeu sans une demande vivante.
    const versLeJeu = venuDUnJeu && !demandeJeu() && r.garde;
    if (r.garde) venuDUnJeu = false;
    const double = !r.garde && r.raison === 'DejaUnCoffre';
    if (double) noterDoublon(r.adresse);
    await afficher(versLeJeu ? t('c_cree_vers_jeu') : r.garde ? t('c_cree') : double ? '' : t('c_cree_pas_sauve', { raison: raison(r.raison) }), r.garde ? 'ok' : 'ko');
    if (d && r.preuve) envoyerAuJeu(d, r.adresse, r.preuve);
    else if (d) dire('s-jeu', '');   // pas de preuve sans sauvegarde : la carte du jeu dit déjà pourquoi (voir `rafraichirJeu`)
  } catch (e) {
    // La confirmation de l'adresse ne sert qu'une fois et ne dure pas : si elle manque, la page la redemande.
    if (e && (e.name === 'IdentiteRequise' || e.name === 'IdentiteRefusee')) identite = null;
    if (e && e.name === 'DejaUnCoffre' && identite) identite.coffre = true;   // le serveur vient de le dire
    // Le jeu a demandé un compte existant pendant le geste : rien n'a été fabriqué ni rangé. La clé d'accès que
    // l'appareil vient de créer ne sert à rien et peut y rester : la page ne sait pas la retirer.
    if (e && e.name === 'CreationRetiree') { noter('[creer] le jeu demande un coffre existant : rien n\'est cree (une cle d\'acces inutile a pu rester sur l\'appareil)'); await afficher(t('a_existant_demande'), 'wait'); return; }
    // Lancée sans toucher, la création peut être refusée par le navigateur, ou annulée par le joueur : rien n'est
    // perdu (la page garde sa réservation), le bouton reste, et la page dit simplement de le toucher.
    if (enchaine && e && e.name === 'NotAllowedError') { noter('[creer] pas de geste, ou annule : le bouton reste'); await afficher(t('a_toucher_creer'), 'ok'); return; }
    noter('[creer] echec : ' + detail(e)); await afficher(expliquer(e), 'ko');
  }
}
async function connecter() {
  if (demandeJeu()) return entrerDansLeJeu();
  const ici = !!fiche;
  dire(ici ? 's-plus' : 's-accueil', attenteCle(), 'wait');
  try {
    const s = await c.connecter();
    const adresse = s.adresse; s.fermer();
    noter('[connecter] ok : adresse ' + adresse + ' | coffre ouvert, preuve faite');
    await afficher(t(ici ? 'c_connecte' : 'c_retrouve'), 'ok');
  } catch (e) { noter('[connecter] echec : ' + detail(e)); await afficher(expliquer(e), 'ko'); }
}
async function renvoyer() {
  dire('s-coffre', t('envoi'), 'wait');
  try {
    const r = await c.renvoyer();
    // Même repli que dans `creer` : le compte vient d'être sauvegardé, et le jeu d'où le joueur était parti ne demande plus rien.
    const versLeJeu = r.garde && venuDUnJeu && !demandeJeu();
    if (r.garde) venuDUnJeu = false;
    const double = !r.garde && !r.inconnu && !r.efface && !r.annule && r.raison === 'DejaUnCoffre';
    if (double) noterDoublon(r.adresse);
    await afficher(versLeJeu ? t('c_sauve_vers_jeu')
      : r.garde ? t('c_sauve_fait')
      : r.inconnu ? t('c_inconnu')
      : r.efface ? t('c_appareil_refuse', { raison: raison(r.raison) })
      : r.annule ? t('ap_refuse', { raison: raison(r.raison) })
      : double ? ''
      : t('c_toujours_pas', { raison: raison(r.raison) }), r.garde ? 'ok' : r.inconnu ? 'wait' : 'ko');
  } catch (e) { noter('[renvoyer] echec : ' + detail(e)); await afficher(expliquer(e), 'ko'); }
}
async function ouvrir() {
  dire('s-plus', attenteCle(), 'wait');
  try {
    const s = await c.ouvrirLocal(); s.fermer();
    noter('[ouvrir] ok sans le serveur : adresse ' + s.adresse);
    dire('s-plus', t('c_teste_local'), 'ok');
  } catch (e) { noter('[ouvrir] echec : ' + detail(e)); dire('s-plus', expliquer(e), 'ko'); }
}
async function copierAdresse() {
  if (!fiche) return;
  try { await navigator.clipboard.writeText(fiche.coffre.adresse); dire('s-coffre', t('c_copie'), 'ok'); }
  catch (_) { try { $('c-plus').open = true; } catch (_e) { /* le joueur l'ouvrira */ } dire('s-coffre', t('c_copie_impossible'), 'wait'); }
}
// Ajouter cet appareil : une fois, puis il n'a plus besoin de l'autre. C'est un accès durable :
// la page le dit et demande de confirmer, avant tout geste. Cet ajout ne se retire pas encore.
function desarmerAjout() { if (armeAjouter) clearTimeout(armeAjouter); armeAjouter = null; }
async function ajouterAppareil() {
  if (fiche && !fiche.ajout && !armeAjouter) {
    ecrire('b-ajouter', t('ap_confirmer'));
    dire('s-appareil', t('ap_avant'), 'wait');
    armeAjouter = setTimeout(() => { desarmerAjout(); ecrire('b-ajouter', t('ap_ajouter')); dire('s-appareil', ''); }, 12000);
    return;
  }
  desarmerAjout();
  dire('s-appareil', t(fiche && fiche.ajout ? 'envoi' : 'ap_gestes'), 'wait');
  try {
    const r = await c.ajouterCetAppareil(nomCle());
    if (r.garde) { noter('[appareil] cet appareil a maintenant sa propre cle'); await afficher(t('ap_fait'), 'ok'); }
    else if (r.inconnu) await afficher(t('c_inconnu'), 'wait');
    else if (r.annule) await afficher(t('ap_refuse', { raison: raison(r.raison) }), 'ko');
    else await afficher(t('ap_pas_fini', { raison: raison(r.raison) }), 'ko');
  } catch (e) {
    noter('[appareil] echec : ' + detail(e));
    await afficher(e && e.name === 'DejaUneCle' ? t('ap_deja') : expliquer(e), 'ko');
  }
}
function desarmer() { if (armeOublier) clearTimeout(armeOublier); armeOublier = null; ecrire('b-oublier', t('c_oublier')); }
async function oublier() {
  if (!armeOublier) {
    ecrire('b-oublier', t('c_oublier_confirmer'));
    dire('s-plus', t(fiche.garde ? 'c_oublier_sauve' : 'c_oublier_danger'), fiche.garde ? 'wait' : 'ko');
    armeOublier = setTimeout(() => { desarmer(); dire('s-plus', ''); }, 8000);
    return;
  }
  desarmer();
  try { await stock.effacer(fiche); noter('[oublier] coffre retire de cet appareil'); await afficher(t('c_oublie'), 'ok'); }
  catch (e) { noter('[oublier] echec : ' + detail(e)); await afficher(expliquer(e), 'ko'); }
}
// Retirer de cet appareil le compte fabriqué en double : deux touchers, la page dit d'abord ce qui va partir.
// Rien n'est retiré sans ce geste du joueur. Ensuite, l'accueil ne propose plus que de se connecter au compte qui existe.
function desarmerDoublon() { if (armeDoublon) clearTimeout(armeDoublon); armeDoublon = null; ecrire('b-doublon', t('c_doublon_retirer')); }
async function retirerDoublon() {
  if (!enDouble()) return;
  if (!armeDoublon) {
    ecrire('b-doublon', t('c_oublier_confirmer'));
    dire('s-coffre', t('c_doublon_avant'), 'wait');
    armeDoublon = setTimeout(() => { desarmerDoublon(); dire('s-coffre', ''); }, 8000);
    return;
  }
  desarmerDoublon();
  try {
    await stock.effacer(fiche);
    noter('[oublier] coffre en double retire de cet appareil, a la demande du joueur');
    await afficher(t('c_doublon_retire'), 'ok');
  } catch (e) { noter('[oublier] echec : ' + detail(e)); await afficher(expliquer(e), 'ko'); }
}
// ---------- Protéger son compte, avec 12 mots : les voir une fois, puis les remettre dans l'ordre en touchant des cartes.
// Aucun indice en route : un mot touché va à la place suivante, sans que la page dise s'il est bien placé. Sinon il
// suffirait d'essayer les cartes une à une pour trouver l'ordre, sans avoir rien noté. La seule vérification vient
// à la fin : une vraie restauration du compte par les mots donnés. La réponse est oui ou non.
// Les étapes se comptent à partir des mots : les noter, les remettre dans l'ordre, puis l'adresse e-mail quand le
// compte se retrouve avec elle.
function avancerMission(n) {
  const total = mission && mission.m.identiteRequise ? 3 : 2;
  $('m-progres').hidden = !n;
  for (let i = 1; i <= 3; i++) { const e = $('m-pas-' + i); e.className = i <= n ? 'fait' : ''; e.hidden = i > total; }
  ecrire('m-etape', n ? t('etape', { n, total }) : '');
}
const etape = (id) => { for (const e of ETAPES) $(e).hidden = e !== id; avancerMission(ETAPES.indexOf(id)); };
function effacerMission() {
  for (let i = 1; i <= 12; i++) {
    $('m-mot-' + i).textContent = ''; $('m-place-' + i).textContent = '';
    const b = $('m-carte-' + i); b.textContent = ''; b.disabled = false; b.className = 'carte';
  }
  ecrire('m-avance', ''); $('b-m-valider').disabled = true; $('b-m-retirer').disabled = true;
  $('m-adresse').value = ''; $('m-code').value = ''; $('m-code').hidden = true; $('m-z-adresse').hidden = false; $('b-m-finir').hidden = true; $('b-m-code').className = '';
}
function quitterMission() { if (mission) { mission.m.fermer(); mission = null; } effacerMission(); }
function ouvrirMission() { quitterMission(); dire('s-mission', ''); etape('m-intro'); montrer('v-mission'); }
async function voirMots() {
  if (mission) { montrerMots(); return; }
  dire('s-mission', attenteCle(), 'wait');
  try {
    const m = await c.mission();
    mission = { m, cartes: [], poses: [] };
    noter('[mission] mots affiches');
    montrerMots();
    dire('s-mission', '');
  } catch (e) { noter('[mission] echec a l\'ouverture : ' + detail(e)); dire('s-mission', expliquer(e), 'ko'); }
}
function montrerMots() {
  if (!mission) return;
  effacerMission();
  mission.poses = [];
  for (let i = 0; i < 12; i++) $('m-mot-' + (i + 1)).textContent = mission.m.mots[i];
  dire('s-mission', '');
  etape('m-mots');
}
function lancerCartes() {
  if (!mission) return;
  effacerMission();   // les mots ne restent pas affichés pendant le jeu
  mission.poses = [];
  mission.cartes = melanger(mission.m.mots.slice());
  for (let i = 0; i < 12; i++) $('m-carte-' + (i + 1)).textContent = mission.cartes[i];
  dessinerPlaces();
  dire('s-mission', '');
  etape('m-cartes');
}
function dessinerPlaces() {
  for (let k = 0; k < 12; k++) $('m-place-' + (k + 1)).textContent = k < mission.poses.length ? mission.cartes[mission.poses[k]] : '';
  ecrire('m-avance', t('m_avance', { n: mission.poses.length }));
  $('b-m-valider').disabled = mission.poses.length !== 12;
  $('b-m-retirer').disabled = mission.poses.length === 0;
}
function toucher(i) {
  if (!mission || occupe || mission.poses.includes(i) || mission.poses.length >= 12 || !mission.cartes.length) return;
  mission.poses.push(i);
  const b = $('m-carte-' + (i + 1)); b.disabled = true; b.className = 'carte posee';
  dessinerPlaces();
}
function retirer() {
  if (!mission || occupe || !mission.poses.length) return;
  const b = $('m-carte-' + (mission.poses.pop() + 1)); b.disabled = false; b.className = 'carte';
  dessinerPlaces();
}
// Le mauvais ordre : tout repart de zéro. Aucune carte ne reste posée, rien ne dit laquelle était à sa place.
function ordreRefuse() {
  noter('[mission] ordre refuse');
  for (let i = 1; i <= 12; i++) { const b = $('m-carte-' + i); b.disabled = false; b.className = 'carte'; }
  mission.poses = []; mission.verifie = null;
  dessinerPlaces();
  etape('m-cartes');
  dire('s-mission', t('m_ordre_refuse'), 'ko');
}
async function missionReussie() {
  const lie = !!(mission && mission.m.identiteRequise);
  noter('[mission] secours fait');
  quitterMission();
  await afficher(t(lie ? 'm_reussie_lie' : 'm_reussie'), 'ok');
}
async function validerMission() {
  const { tenu: m0, courant } = tenir(() => mission, 'mission');
  if (!m0 || m0.poses.length !== 12) return;
  const donnes = m0.poses.map((i) => m0.cartes[i]);
  dire('s-mission', t('m_verif'), 'wait');
  try {
    if (m0.m.identiteRequise) {
      // D'abord les mots, par une vraie réouverture du compte, sans rien envoyer. L'adresse e-mail vient ensuite :
      // la déclaration ne part qu'avec elle.
      await m0.m.verifier(donnes);
      if (!courant()) return;
      m0.verifie = donnes;
      noter('[mission] ordre accepte, adresse e-mail demandee');
      dire('s-mission', '');
      etape('m-email');
      return;
    }
    await m0.m.valider(donnes);
    if (!courant()) return;
  } catch (e) {
    if (!courant()) return;
    if (e && e.name === 'MotsRefuses') { ordreRefuse(); return; }
    noter('[mission] echec : ' + detail(e));
    dire('s-mission', t('m_echec', { raison: expliquer(e) }), 'ko');
    return;
  }
  await missionReussie();
}
// L'adresse e-mail de la protection : un code, puis la déclaration. L'adresse n'est ni gardée ni écrite au relevé.
async function codeMission() {
  const { tenu: m0, courant } = tenir(() => mission, 'mission');
  if (!m0 || !m0.verifie) return;
  const email = $('m-adresse').value.trim();
  if (!formeEmail(email)) { dire('s-mission', t('email_forme'), 'ko'); return; }
  dire('s-mission', t('envoi'), 'wait');
  try {
    await c.demanderCode(email);
    if (!courant()) return;
    m0.confirme = false;
    $('m-code').hidden = false; $('b-m-finir').hidden = false; $('b-m-code').className = 'second';
    noter('[mission] code demande');
    dire('s-mission', t('code_parti'), 'ok');
  } catch (e) { noter('[mission] echec du code : ' + detail(e)); if (!courant()) return; dire('s-mission', expliquer(e), 'ko'); }
}
async function finirMission() {
  const { tenu: m0, courant } = tenir(() => mission, 'mission');
  if (!m0 || !m0.verifie) return;
  dire('s-mission', t('verification'), 'wait');
  try {
    if (!m0.confirme) {
      const code = $('m-code').value.replace(/\D/g, '');
      if (code.length !== 6) { dire('s-mission', t('code_six'), 'ko'); return; }
      await c.validerCode($('m-adresse').value.trim(), code);
      if (!courant()) return;
      m0.confirme = true;
      $('m-code').value = ''; $('m-code').hidden = true; $('m-z-adresse').hidden = true;
      noter('[mission] adresse confirmee');
    }
    await m0.m.valider(m0.verifie);
    if (!courant()) return;
  } catch (e) {
    if (!courant()) return;
    if (e && e.name === 'MotsRefuses') { ordreRefuse(); return; }
    noter('[mission] echec : ' + detail(e));
    if (incertain(e)) { dire('s-mission', [expliquer(e), t('retouche', { bouton: t('m_finir') })], 'ko'); return; }
    // Tout autre refus après le code : la confirmation de l'adresse ne vaut plus, ou cette adresse ne convient pas.
    if (e && e.name !== 'CodeRefuse') { m0.confirme = false; $('m-z-adresse').hidden = false; $('m-code').hidden = true; $('b-m-finir').hidden = true; }
    dire('s-mission', expliquer(e), 'ko');
    return;
  }
  await missionReussie();
}
async function annulerMission() { quitterMission(); await afficher(); }

// ---------- Retrouver son compte sans appareil, en trois étapes : l'adresse e-mail donnée en le protégeant et son
// code ; les 12 mots ; puis cet appareil, qu'il faut enregistrer.
// Aucun jugement pendant la saisie des mots : la page ne dit ni qu'un mot est inconnu, ni qu'il est mal placé. La
// réponse vient à la fin, d'un seul mot. Les mots ne partent jamais : ils signent ici, et rouvrent ici le compte remis.
function etapeR(id) {
  const n = ETAPES_RETROUVER.indexOf(id) + 1;
  for (const e of ETAPES_RETROUVER) $(e).hidden = e !== id;
  for (let i = 1; i <= 3; i++) $('r-pas-' + i).className = i <= n ? 'fait' : '';
  ecrire('r-etape', t('etape', { n, total: 3 }));
  ecrire('r-suite', n === 1 ? t('r_suite_1') : n === 2 ? t('r_suite_2') : '');
}
const motsSaisis = () => { const m = []; for (let i = 1; i <= 12; i++) m.push($('r-mot-' + i).value.trim().toLowerCase()); return m; };
function cacherCodeRetrouver() { $('r-code').value = ''; $('r-code').hidden = true; $('b-r-valider').hidden = true; $('b-r-code').className = ''; }
function effacerRetrouver() {
  for (let i = 1; i <= 12; i++) $('r-mot-' + i).value = '';
  $('r-adresse').value = ''; cacherCodeRetrouver();
  $('r-wallet').textContent = '';
}
function quitterRetrouver() { c.abandonner(); retrouvaille = null; effacerRetrouver(); }
function ouvrirRetrouver() { quitterRetrouver(); retrouvaille = { confirme: false, trouve: false }; dire('s-retrouver', ''); etapeR('r-email'); montrer('v-retrouver'); }
// La confirmation de l'adresse ne vaut plus, ou cette adresse ne retrouve rien : retour à la première étape. Les mots
// déjà tapés restent dans leurs cases, pour ne pas avoir à les retaper.
function revenirAdresse() { retrouvaille.confirme = false; cacherCodeRetrouver(); etapeR('r-email'); }
async function codeRetrouver() {
  const { tenu: x0, courant } = tenir(() => retrouvaille, 'retrouver');
  if (!x0 || x0.trouve) return;
  const email = $('r-adresse').value.trim();
  if (!formeEmail(email)) { dire('s-retrouver', t('email_forme'), 'ko'); return; }
  dire('s-retrouver', t('envoi'), 'wait');
  try {
    await c.demanderCode(email);
    if (!courant()) return;
    x0.confirme = false;
    $('r-code').hidden = false; $('b-r-valider').hidden = false; $('b-r-code').className = 'second';
    noter('[retrouver] code demande');
    dire('s-retrouver', t('code_parti'), 'ok');
  } catch (e) { noter('[retrouver] echec du code : ' + detail(e)); if (!courant()) return; dire('s-retrouver', expliquer(e), 'ko'); }
}
async function validerRetrouver() {
  const { tenu: x0, courant } = tenir(() => retrouvaille, 'retrouver');
  if (!x0 || x0.trouve || x0.confirme) return;
  const code = $('r-code').value.replace(/\D/g, '');
  if (code.length !== 6) { dire('s-retrouver', t('code_six'), 'ko'); return; }
  dire('s-retrouver', t('verification'), 'wait');
  try {
    await c.validerCode($('r-adresse').value.trim(), code);
    if (!courant()) return;
    x0.confirme = true;
    cacherCodeRetrouver();
    noter('[retrouver] adresse confirmee');
    dire('s-retrouver', '');
    etapeR('r-mots');
  } catch (e) { noter('[retrouver] echec du code : ' + detail(e)); if (!courant()) return; dire('s-retrouver', expliquer(e), 'ko'); }
}
async function retrouver() {
  const { tenu: x0, courant } = tenir(() => retrouvaille, 'retrouver');
  if (!x0 || x0.trouve) return;
  if (!x0.confirme) { revenirAdresse(); dire('s-retrouver', ''); return; }
  if (motsSaisis().some((m) => !m)) { dire('s-retrouver', t('r_mots_manquants'), 'ko'); return; }
  dire('s-retrouver', t('verification'), 'wait');
  try {
    const r = await c.retrouver(motsSaisis());
    if (!courant()) return;
    x0.trouve = true;
    for (let i = 1; i <= 12; i++) $('r-mot-' + i).value = '';   // ils ne restent pas dans la page
    $('r-wallet').textContent = r.adresse;
    dire('s-retrouver', '');
    etapeR('r-garder');
  } catch (e) {
    noter('[retrouver] echec : ' + detail(e));
    if (!courant()) return;
    // Un seul non, quelle que soit la raison. Les mots restent dans leurs cases, pour être corrigés.
    if (e && e.name === 'MotsRefuses') { dire('s-retrouver', t('r_mots_refuses'), 'ko'); return; }
    if (incertain(e)) { dire('s-retrouver', [expliquer(e), t('retouche', { bouton: t('r_valider') })], 'ko'); return; }
    if (e && e.name === 'TropDEssais') { dire('s-retrouver', attente(e), 'ko'); return; }
    // La confirmation de l'adresse ne vaut plus (expirée, ou sans compte à retrouver) : la page la redemande.
    revenirAdresse();
    dire('s-retrouver', expliquer(e), 'ko');
  }
}
function aideRetrouver() { if (retrouvaille) dire('s-retrouver', t('r_aide_texte'), 'wait'); }
async function garderIci() {
  const { tenu: x0, courant } = tenir(() => retrouvaille, 'retrouver');
  if (!x0 || !x0.trouve) return;
  dire('s-retrouver', t('attente'), 'wait');
  try {
    const r = await c.garder(nomCle());
    if (!courant()) return;
    quitterRetrouver();
    if (r.garde) { noter('[retrouver] wallet garde sur cet appareil'); await afficher(t('r_retour'), 'ok'); }
    else if (r.inconnu) await afficher(t('c_inconnu'), 'wait');
    else if (r.efface) await afficher(t('c_appareil_refuse', { raison: raison(r.raison) }), 'ko');
    else await afficher(t('r_pas_fini', { raison: raison(r.raison) }), 'ko');
  } catch (e) {
    noter('[retrouver] echec en gardant : ' + detail(e));
    if (!courant()) return;
    if (e && e.name === 'RienARetrouver') { ouvrirRetrouver(); dire('s-retrouver', expliquer(e), 'ko'); return; }
    dire('s-retrouver', expliquer(e), 'ko');   // un geste annulé se retente : le compte retrouvé reste en mémoire
  }
}
async function annulerRetrouver() { quitterRetrouver(); await afficher(); }

// ---------- Mes adresses de secours : changer l'adresse principale, ajouter, changer ou retirer la seconde.
// Le compte s'ouvre pour chaque réglage (un geste) : c'est la clé du wallet qui le signe. L'ancienne adresse n'est
// jamais demandée. La page ne montre aucune adresse : le serveur ne les a pas, seulement leur date d'inscription.
const etapeA = (id) => { for (const e of ETAPES_ADRESSES) $(e).hidden = e !== id; };
function desarmerRetrait() { if (armeRetirer) clearTimeout(armeRetirer); armeRetirer = null; ecrire('b-a-retirer-2', t('ad_retirer_2')); }
function effacerSaisieAdresse() { $('a-adresse').value = ''; $('a-code').value = ''; $('a-code').hidden = true; $('a-z-adresse').hidden = false; $('b-a-enregistrer').hidden = true; $('b-a-code').className = ''; }
function dessinerAdresses() {
  const liste = (fiche && fiche.recuperation && fiche.recuperation.adresses) || [];
  const a1 = liste.find((a) => a.rang === 1), a2 = liste.find((a) => a.rang === 2);
  dire('a-rang-1', a1 ? t('ad_principale_le', { date: jour(a1.cree) }) : t('ad_principale'), 'ok');
  dire('a-rang-2', a2 ? t('ad_seconde_le', { date: jour(a2.cree) }) : t('ad_seconde_aucune'), a2 ? 'ok' : 'wait');
  ecrire('b-a-regler-2', t(a2 ? 'ad_changer_2' : 'ad_ajouter_2'));
  $('b-a-retirer-2').hidden = !a2;
  desarmerRetrait();
  // Un réglage dont la réponse s'est perdue : tant qu'il n'est pas terminé, lui seul peut repartir. Les autres
  // boutons sont retirés, pour qu'un nouveau réglage ne reçoive jamais la réponse de celui-là.
  const enAttente = c.reglageEnAttente();
  $('a-attente').hidden = !enAttente; $('b-a-terminer').hidden = !enAttente;
  $('b-a-changer-1').hidden = !!enAttente; $('b-a-regler-2').hidden = !!enAttente;
  if (enAttente) {
    $('b-a-retirer-2').hidden = true;
    dire('a-attente', t('ad_attente', { quoi: nomReglage(enAttente) }), 'wait');
  }
}
// Ce qu'un réglage voulait faire, et ce qu'il a fait, dit d'après ce que le client a réellement conclu : jamais
// d'après le dernier bouton touché.
const nomReglage = (r) => t(r.retirer ? 'ad_quoi_retirer' : r.rang === 1 ? 'ad_quoi_1' : 'ad_quoi_2');
function messageReglage(r) {
  if (r.depasse) return [t('ad_depasse'), 'wait'];
  return [t(r.retire ? 'ad_retiree' : r.rang === 1 ? 'ad_changee_1' : 'ad_enregistree_2'), 'ok'];
}
async function terminerReglage() {
  dire('s-adresses', t('envoi'), 'wait');
  try {
    const r = await c.reprendreReglage();
    noter('[adresses] reglage en attente termine');
    fiche = (await stock.lire()) || null;
    ouvrirAdresses(...messageReglage(r));
  } catch (e) {
    noter('[adresses] reglage en attente : ' + detail(e));
    if (incertain(e)) { dire('s-adresses', [expliquer(e), t('retouche', { bouton: t('ad_terminer') })], 'ko'); return; }
    // Pas confirmé sur cet appareil (réponse incohérente, ou stockage refusé) : il attend toujours, la liste le montre.
    if (e && e.name === 'ReglageAConfirmer') { ouvrirAdresses(expliquer(e), 'wait'); return; }
    // Le serveur refuse pour de bon. La page ne dit pas « non enregistré » : elle ne le sait pas.
    ouvrirAdresses(t('ad_non_confirme', { raison: expliquer(e) }), 'ko');
  }
}
function ouvrirAdresses(message, sorte) { reglage = null; effacerSaisieAdresse(); dessinerAdresses(); etapeA('a-liste'); dire('s-adresses', message || '', sorte); montrer('v-adresses'); }
function choisirRang(rang) {
  reglage = { rang, confirme: false };
  effacerSaisieAdresse();
  ecrire('a-titre', t(rang === 1 ? 'ad_saisie_1' : 'ad_saisie_2'));
  dire('s-adresses', '');
  etapeA('a-saisie');
}
async function codeAdresse() {
  const { tenu: r0, courant } = tenir(() => reglage, 'adresses');
  if (!r0) return;
  const email = $('a-adresse').value.trim();
  if (!formeEmail(email)) { dire('s-adresses', t('email_forme'), 'ko'); return; }
  dire('s-adresses', t('envoi'), 'wait');
  try {
    await c.demanderCode(email);
    if (!courant()) return;
    r0.confirme = false;
    $('a-code').hidden = false; $('b-a-enregistrer').hidden = false; $('b-a-code').className = 'second';
    noter('[adresses] code demande');
    dire('s-adresses', t('code_parti'), 'ok');
  } catch (e) { noter('[adresses] echec du code : ' + detail(e)); if (!courant()) return; dire('s-adresses', expliquer(e), 'ko'); }
}
// Le rang réglé est celui du réglage sur lequel cette action a commencé, jamais celui qui serait à l'écran à son
// retour : le code confirme une adresse POUR un rang, et c'est ce rang-là que la clé du wallet signe.
async function enregistrerAdresse() {
  const { tenu: r0, courant } = tenir(() => reglage, 'adresses');
  if (!r0) return;
  dire('s-adresses', t('verification'), 'wait');
  try {
    if (!r0.confirme) {
      const code = $('a-code').value.replace(/\D/g, '');
      if (code.length !== 6) { dire('s-adresses', t('code_six'), 'ko'); return; }
      await c.validerCode($('a-adresse').value.trim(), code);
      if (!courant()) return;
      r0.confirme = true;
      $('a-code').value = ''; $('a-code').hidden = true; $('a-z-adresse').hidden = true;
      noter('[adresses] adresse confirmee');
    }
    dire('s-adresses', attenteCle(), 'wait');
    const r = await c.reglerAdresse(r0.rang);
    noter('[adresses] adresse enregistree au rang ' + r.rang);
    fiche = (await stock.lire()) || null;
    ouvrirAdresses(...messageReglage(r));
  } catch (e) {
    noter('[adresses] echec : ' + detail(e));
    if (!courant()) return;
    if (incertain(e)) { dire('s-adresses', [expliquer(e), t('retouche', { bouton: t('ad_enregistrer') })], 'ko'); return; }
    // Un autre réglage attend sa réponse : retour à la liste, qui le montre et ne propose que de le terminer.
    if (e && e.name === 'ReglageEnAttente') { ouvrirAdresses(expliquer(e), 'ko'); return; }
    if (e && e.name === 'ReglageAConfirmer') { ouvrirAdresses(expliquer(e), 'wait'); return; }
    // Un geste annulé se retente sans redemander de code ; tout autre refus après le code fait redemander l'adresse.
    if (e && !['CodeRefuse', 'NotAllowedError', 'AdmissionRefusee'].includes(e.name)) { r0.confirme = false; $('a-z-adresse').hidden = false; $('a-code').hidden = true; $('b-a-enregistrer').hidden = true; }
    dire('s-adresses', expliquer(e), 'ko');
  }
}
async function retirerSeconde() {
  if (!armeRetirer) {
    ecrire('b-a-retirer-2', t('ad_retirer_confirmer'));
    dire('s-adresses', t('ad_retirer_avant'), 'wait');
    armeRetirer = setTimeout(() => { desarmerRetrait(); dire('s-adresses', ''); }, 8000);
    return;
  }
  desarmerRetrait();
  dire('s-adresses', attenteCle(), 'wait');
  try {
    const r = await c.reglerAdresse(2, { retirer: true });
    noter('[adresses] seconde adresse retiree');
    fiche = (await stock.lire()) || null;
    ouvrirAdresses(...messageReglage(r));
  } catch (e) {
    noter('[adresses] echec du retrait : ' + detail(e));
    // Réponse perdue : le retrait attend. La liste le montre, et ne propose que de le terminer.
    if (incertain(e) || (e && (e.name === 'ReglageEnAttente' || e.name === 'ReglageAConfirmer'))) { ouvrirAdresses(expliquer(e), e.name === 'ReglageAConfirmer' ? 'wait' : 'ko'); return; }
    dire('s-adresses', expliquer(e), 'ko');
  }
}
async function fermerAdresses() { reglage = null; effacerSaisieAdresse(); desarmerRetrait(); await afficher(); }

// Le relevé d'essai se copie : ses deux messages restent en français, comme lui.
async function copier() {
  try { await navigator.clipboard.writeText(texteResultat()); dire('s-resultat', 'Copié.', 'ok'); }
  catch (_) { $('resultat').select(); dire('s-resultat', 'Sélectionné : copie-le à la main.', 'wait'); }
}

// La page ne peut pas servir ici : elle le dit dans la langue du joueur ; le relevé, lui, le note en français.
function bloquer(cle) { for (const v of VUES) $(v).hidden = true; ecrire('blocage', t(cle)); $('blocage').hidden = false; noter('[page] bloquee : ' + texte('fr', cle, null, false)); }
poserLesTextes();
for (const l of Object.keys(LANGUES)) $('b-langue-' + l).addEventListener('click', () => changerLangue(l));
$('b-copier').addEventListener('click', copier);
$('b-code').addEventListener('click', validerCode);
if (window.top !== window.self) bloquer('bloc_cadre');
else if (!window.isSecureContext || !window.PublicKeyCredential || !window.crypto || !crypto.subtle || !window.indexedDB) bloquer('bloc_navigateur');
else {
  $('b-creer').addEventListener('click', seul(creer));
  $('b-connecter').addEventListener('click', seul(connecter));
  $('b-reconnecter').addEventListener('click', seul(connecter));
  $('b-renvoyer').addEventListener('click', seul(renvoyer));
  $('b-doublon').addEventListener('click', seul(retirerDoublon));
  $('b-copier-adresse').addEventListener('click', libre(copierAdresse));
  $('b-ouvrir').addEventListener('click', seul(ouvrir));
  $('b-oublier').addEventListener('click', seul(oublier));
  $('b-jeu').addEventListener('click', seul(entrerDansLeJeu));
  $('b-jeu-refus').addEventListener('click', seul(async () => pasMaintenant()));
  $('b-op-confirmer').addEventListener('click', seulOperation(confirmerOperation));
  $('b-op-refuser').addEventListener('click', seulOperation(async () => refuserOperation()));
  $('b-mission').addEventListener('click', libre(ouvrirMission));
  $('b-m-voir').addEventListener('click', seul(voirMots));
  $('b-m-note').addEventListener('click', libre(lancerCartes));
  $('b-m-revoir').addEventListener('click', libre(montrerMots));
  $('b-m-retirer').addEventListener('click', libre(retirer));
  $('b-m-valider').addEventListener('click', seul(validerMission));
  $('b-m-annuler').addEventListener('click', seul(annulerMission));
  $('b-ajouter').addEventListener('click', seul(ajouterAppareil));
  $('b-adresses').addEventListener('click', libre(() => ouvrirAdresses()));
  $('b-a-changer-1').addEventListener('click', libre(() => choisirRang(1)));
  $('b-a-regler-2').addEventListener('click', libre(() => choisirRang(2)));
  $('b-a-retirer-2').addEventListener('click', seul(retirerSeconde));
  $('b-a-terminer').addEventListener('click', seul(terminerReglage));
  $('b-a-code').addEventListener('click', seul(codeAdresse));
  $('b-a-enregistrer').addEventListener('click', seul(enregistrerAdresse));
  $('b-a-retour').addEventListener('click', libre(() => ouvrirAdresses()));
  $('b-a-fermer').addEventListener('click', seul(fermerAdresses));
  $('b-m-code').addEventListener('click', seul(codeMission));
  $('b-m-finir').addEventListener('click', seul(finirMission));
  $('b-retrouver').addEventListener('click', libre(() => { if (!fiche) ouvrirRetrouver(); }));   // un compte est déjà ici : rien à retrouver
  $('b-r-code').addEventListener('click', seul(codeRetrouver));
  $('b-r-valider').addEventListener('click', seul(validerRetrouver));
  $('b-r-retrouver').addEventListener('click', seul(retrouver));
  $('b-r-aide').addEventListener('click', libre(aideRetrouver));
  $('b-r-garder').addEventListener('click', seul(garderIci));
  $('b-r-annuler').addEventListener('click', seul(annulerRetrouver));
  for (let i = 0; i < 12; i++) $('m-carte-' + (i + 1)).addEventListener('click', () => toucher(i));
  $('b-envoyer-code').addEventListener('click', seul(envoyerCode));
  $('b-valider-code').addEventListener('click', seul(validerLeCode));
  for (const p of Object.keys(NOMS_PORTES)) $(BOUTONS_PORTES[p]).addEventListener('click', seul(() => partirPar(p)));
  $('b-wallet').addEventListener('click', seul(async () => choisirWallet()));
  $('b-porte-email').addEventListener('click', libre(() => { emailOuvert = true; rafraichirAccueil(); dire('s-accueil', ''); const e = $('email'); if (e && typeof e.focus === 'function') e.focus(); }));
  // Ouverte par un autre site, dans sa propre fenêtre : on n'écoute que les jeux enregistrés.
  if (window.opener && REGLAGES.jeux && Object.keys(REGLAGES.jeux).length) {
    lien = lienJeu({ fenetre: window, ouvreur: window.opener, jeux: REGLAGES.jeux, noter,
      surDemande: demandeArrivee,
      surOperation: operationArrivee,
      surAccuse: choixRecu,
      surRetrait: (d) => { if (d && d.genre === 'operation') { operationRetiree(d); return; }
        $('v-jeu').hidden = false; $('b-jeu').hidden = true; $('b-jeu-refus').hidden = true;
        ecrire('jeu-texte', '');
        dire('s-jeu', t(d && d.expiree ? 'j_expire' : 'j_retire'), 'wait');
        // La carte du compte avait laissé la place à celle du jeu : elle revient, sous le message.
        if (fiche && !mainRendue && VUES.every((v) => $(v).hidden)) $('v-coffre').hidden = false; } });
    lien.annoncer();
    // Au retour d'arrière-plan, l'heure est relue : les minuteurs y dorment, et une demande qui a dépassé sa durée
    // doit le dire tout de suite, avant que le joueur ne touche un bouton pour rien.
    const auRetour = () => { lien.relire(); };
    window.addEventListener('pageshow', auRetour);
    window.addEventListener('focus', auRetour);
    if (typeof document.addEventListener === 'function') document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') auRetour(); });
  }
  crypto.subtle.generateKey({ name: 'Ed25519' }, false, ['sign', 'verify']).then(async () => { await afficher(); await retourDePorte(); }, () => bloquer('bloc_signatures'));
}
