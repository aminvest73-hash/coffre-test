// Le faux jeu de démonstration. Il fait ce que ferait un vrai jeu, à une différence près : le « serveur du jeu »
// (serveur-jeu.mjs : le défi tiré pour une tentative, la preuve vérifiée puis le défi consommé une seule fois)
// tourne ici dans la page, pour pouvoir l'essayer sans serveur. Dans la page, il ne protège rien : c'est une démonstration.

import * as K from './contrat.mjs';
import { connexionCoffre } from './coffre-jeu.mjs';
import { connexionServeurJeu, stockageEnMemoire } from './serveur-jeu.mjs';
import { DEMO } from './reglages-demo.mjs';

const $ = (id) => document.getElementById(id);
const journal = [];
function dire(texte, sorte) { const e = $('s-jeu'); e.textContent = texte || ''; e.className = 'status' + (sorte ? ' ' + sorte : ''); }
function texteResultat() {
  return ['RESULTAT FAUX JEU v1', 'date : ' + new Date().toISOString(), 'navigateur : ' + navigator.userAgent, 'jeu : ' + location.origin, 'coffre : ' + DEMO.coffre, '---'].concat(journal).join('\n');
}
function noter(ligne) { journal.push(ligne); $('resultat').value = texteResultat(); }
const MESSAGES = {
  FenetreBloquee: 'Le navigateur a bloqué la fenêtre du coffre. Autorise les fenêtres pour ce site, puis réessaie.',
  FenetreFermee: 'Tu as fermé la fenêtre du coffre avant la fin.',
  AutreWallet: 'Ce n\'est pas le wallet lié à ce compte de jeu. Tu n\'es pas connecté.',
  ConnexionRefusee: 'La connexion n\'a pas abouti dans la fenêtre du coffre.',
  DelaiDepasse: 'Trop de temps a passé. Réessaie.',
};
let enCours = false, adresseLiee = null;
const serveurDuJeu = connexionServeurJeu({ contrat: K, service: new URL(DEMO.coffre).origin, jeu: location.origin, stockage: stockageEnMemoire() });

// Le défi doit être prêt AVANT le clic : la fenêtre du coffre s'ouvre dans le geste du joueur, sans rien attendre,
// sinon le navigateur la bloque. Le jeu le demande donc à son serveur à l'avance, et le renouvelle avant qu'il expire.
let prochaine = null;
async function preparer() {
  // Une tentative : dans un vrai jeu, l'identifiant de la session d'avant connexion, donné par le serveur du jeu.
  const tentative = K.b64u(crypto.getRandomValues(new Uint8Array(24)));
  const { defi } = await serveurDuJeu.nouveauDefi(tentative);
  prochaine = { tentative, defi };
}

async function seConnecter() {
  if (enCours) return;
  if (!prochaine) { dire('Un instant, puis réessaie.', 'wait'); return; }
  enCours = true;
  const { tentative, defi } = prochaine;
  prochaine = null;
  dire('La fenêtre du coffre s\'ouvre…', 'wait');
  try {
    const recu = await connexionCoffre({ coffre: DEMO.coffre, defi, adresse: adresseLiee || undefined }).resultat;
    // Ce que fait le serveur du jeu : tout vérifier avec ce qu'il sait lui-même, puis consommer son défi.
    // Le wallet attendu vient de ce que le jeu a gardé, pas de ce que la fenêtre annonce.
    const v = await serveurDuJeu.conclure(tentative, recu, { walletAttendu: adresseLiee });
    noter('[connexion] ok : wallet ' + v.adresse + ' | preuve verifiee par le jeu' + (adresseLiee ? (adresseLiee === v.adresse ? ' | meme wallet que la fois precedente' : ' | AUTRE WALLET que la fois precedente') : ''));
    adresseLiee = v.adresse;
    $('titre').textContent = 'Tu es connecté';
    $('etat').textContent = 'Ton wallet : ' + v.adresse.slice(0, 4) + '…' + v.adresse.slice(-4);
    $('b-connexion').textContent = 'Me reconnecter';
    dire('Connexion vérifiée par le jeu.', 'ok');
  } catch (e) {
    noter('[connexion] echec : ' + (e && e.name) + (e && e.detail ? ' (' + e.detail + ')' : ''));
    dire(MESSAGES[e && e.name] || 'La preuve reçue n\'est pas valable. Tu n\'es pas connecté.', 'ko');
  } finally { enCours = false; preparer(); }
}
async function copier() {
  try { await navigator.clipboard.writeText(texteResultat()); $('s-resultat').textContent = 'Copié.'; }
  catch (_) { $('resultat').select(); $('s-resultat').textContent = 'Sélectionné : copie-le à la main.'; }
}
$('b-connexion').addEventListener('click', seConnecter);
$('b-copier').addEventListener('click', copier);
$('resultat').value = texteResultat();
preparer();
setInterval(() => { if (!enCours) preparer(); }, 240000);
