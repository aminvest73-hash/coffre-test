// Le faux jeu de démonstration. Il fait ce que ferait un vrai jeu, à une différence près : le « serveur du jeu »
// (serveur-jeu.mjs : le défi tiré pour une tentative, la preuve vérifiée puis le défi consommé une seule fois)
// tourne ici dans la page, pour pouvoir l'essayer sans serveur. Dans la page, il ne protège rien : c'est une démonstration.
// Deux portes : « Se connecter » (la fenêtre du coffre) et « Connecter mon wallet » (un wallet Solana que le joueur a
// déjà : il signe dans cette page, sans coffre et sans fenêtre). La fenêtre du coffre propose aussi « Connecter mon
// wallet » : elle rend alors la main à cette page, qui attend que le joueur touche son bouton du wallet. Le wallet
// n'est jamais appelé à la réception d'un message.

import * as K from './contrat.mjs';
import { connexionCoffre, walletsPresents, connexionWallet, gesteDuJoueur } from './coffre-jeu.mjs';
import { connexionServeurJeu, connexionWalletServeurJeu, stockageEnMemoire } from './serveur-jeu.mjs';
import { DEMO } from './reglages-demo.mjs';

const $ = (id) => document.getElementById(id);
const journal = [];
function dire(texte, sorte) { const e = $('s-jeu'); e.textContent = texte || ''; e.className = 'status' + (sorte ? ' ' + sorte : ''); }
function texteResultat() {
  return ['RESULTAT FAUX JEU v2', 'date : ' + new Date().toISOString(), 'navigateur : ' + navigator.userAgent, 'jeu : ' + location.origin, 'coffre : ' + DEMO.coffre, '---'].concat(journal).join('\n');
}
function noter(ligne) { journal.push(ligne); $('resultat').value = texteResultat(); }
const MESSAGES = {
  FenetreBloquee: 'Le navigateur a bloqué la fenêtre du coffre. Autorise les fenêtres pour ce site, puis réessaie.',
  FenetreFermee: 'Tu as fermé la fenêtre du coffre avant la fin.',
  AutreWallet: 'Ce n\'est pas le wallet lié à ce compte de jeu. Tu n\'es pas connecté.',
  ConnexionRefusee: 'La connexion n\'a pas abouti dans la fenêtre du coffre.',
  DelaiDepasse: 'Trop de temps a passé. Réessaie.',
  CoffreTropAncien: 'La page du coffre est trop ancienne pour cette demande.',
  WalletRefuse: 'Ton wallet a refusé, ou tu as annulé. Tu n\'es pas connecté.',
  WalletAbsent: 'Ce wallet ne sait pas faire cette connexion. Tu n\'es pas connecté.',
};
const CHOIX_WALLET = 'Tu as choisi ton wallet. Touche « Connecter mon wallet », juste ici, pour continuer.';
let enCours = false, adresseLiee = null;
const stockage = stockageEnMemoire();
const serveurDuJeu = connexionServeurJeu({ contrat: K, service: new URL(DEMO.coffre).origin, jeu: location.origin, stockage });
// La même chose pour un wallet que le joueur a déjà : le serveur du jeu prépare le texte à signer, puis le vérifie.
const serveurWallet = connexionWalletServeurJeu({ contrat: K, jeu: location.origin, stockage });
// Les wallets installés dans ce navigateur s'annoncent à la page (protocole du Wallet Standard).
const presents = walletsPresents();

// Le défi doit être prêt AVANT le clic : la fenêtre du coffre s'ouvre dans le geste du joueur, sans rien attendre,
// sinon le navigateur la bloque. Le jeu le demande donc à son serveur à l'avance, et le renouvelle avant qu'il expire.
let prochaine = null;
const FRAIS = 240000;   // millisecondes : passé ce délai, le défi préparé est trop près de sa fin (il vit 300 secondes)
async function preparer() {
  // Une tentative : dans un vrai jeu, l'identifiant de la session d'avant connexion, donné par le serveur du jeu.
  const tentative = K.b64u(crypto.getRandomValues(new Uint8Array(24)));
  const { defi } = await serveurDuJeu.nouveauDefi(tentative);
  // Ce que le wallet devra signer est préparé à l'avance lui aussi : le wallet s'appelle dans le geste du joueur.
  const tentativeWallet = K.b64u(crypto.getRandomValues(new Uint8Array(24)));
  const { entree } = await serveurWallet.preparer(tentativeWallet, { but: 'connexion' });
  prochaine = { tentative, defi, tentativeWallet, entree, pret: Date.now() };
}
const perime = () => !prochaine || Date.now() - prochaine.pret > FRAIS;
// Un onglet laissé en arrière-plan dort, et son minuteur avec lui : au retour, le défi préparé peut être trop vieux.
// On en prépare donc un neuf dès que la page redevient visible, pour qu'il soit prêt avant le clic.
function auRetour() { if (!enCours && document.visibilityState === 'visible' && perime()) preparer().catch(() => {}); }

// `existant` : le joueur a touché « J'ai déjà mon coffre ». Le jeu ne connaît pas encore son wallet ; la fenêtre
// ne lui proposera pas d'en créer un. Une fois le wallet connu du jeu, c'est lui qui est annoncé à la fenêtre.
async function seConnecter(existant) {
  if (enCours) return;
  // Jamais de fenêtre ouverte avec un défi trop vieux : on en redemande un, et le joueur retouche le bouton.
  if (perime()) {
    prochaine = null;
    dire('Un instant…', 'wait');
    preparer().then(() => dire('C\'est prêt. Touche de nouveau le bouton.'), () => dire('Le jeu ne répond pas. Réessaie dans un instant.', 'ko'));
    return;
  }
  enCours = true;
  const { tentative, defi } = prochaine;
  prochaine = null;
  dire('La fenêtre du coffre s\'ouvre…', 'wait');
  try {
    // `wallet: true` : ce jeu sait aussi connecter un wallet existant, la fenêtre peut donc proposer ce choix.
    const recu = await connexionCoffre({ coffre: DEMO.coffre, defi, adresse: adresseLiee || undefined, existant: existant && !adresseLiee, wallet: true }).resultat;
    // Ce que fait le serveur du jeu : tout vérifier avec ce qu'il sait lui-même, puis consommer son défi.
    // Le wallet attendu vient de ce que le jeu a gardé, pas de ce que la fenêtre annonce.
    const v = await serveurDuJeu.conclure(tentative, recu, { walletAttendu: adresseLiee });
    noter('[connexion] ok : porte coffre | wallet ' + v.adresse + ' | preuve verifiee par le jeu' + (existant && !adresseLiee ? ' | demande sans creation' : '') + (adresseLiee ? (adresseLiee === v.adresse ? ' | meme wallet que la fois precedente' : ' | AUTRE WALLET que la fois precedente') : ''));
    adresseLiee = v.adresse;
    $('titre').textContent = 'Tu es connecté';
    $('etat').textContent = 'Ton wallet : ' + v.adresse.slice(0, 4) + '…' + v.adresse.slice(-4);
    $('b-connexion').textContent = 'Me reconnecter';
    $('b-existant').hidden = true;
    dire('Connexion vérifiée par le jeu.', 'ok');
  } catch (e) {
    if (e && e.name === 'ChoixWallet') {
      // Dans la fenêtre du coffre, le joueur a choisi son propre wallet. Ce message ne donne aucun droit : le jeu
      // abandonne la tentative « coffre » chez son serveur, puis attend que le joueur touche le bouton du wallet de
      // CETTE page. La tentative du wallet sera une tentative neuve (préparée juste en dessous, dans `finally`).
      // « Retiré » ne s'écrit que si le serveur du jeu confirme la suppression du défi. Sinon le relevé dit que ce
      // n'est pas confirmé : le défi s'éteindra de lui-même à son échéance, cinq minutes au plus après son tirage.
      const retire = (await serveurDuJeu.abandonner(tentative).catch(() => false)) === true;
      noter('[connexion] choix : le joueur veut son wallet (choisi dans la fenetre du coffre) | defi de la tentative coffre : ' + (retire ? 'retire, confirme par le serveur du jeu' : 'retrait NON confirme, il s\'eteindra a son echeance') + ' | rien de signe, le wallet n\'est pas appele sans un toucher ici');
      $('b-wallet').className = 'porte';   // le bouton du wallet devient le bouton principal de l'écran
      dire(CHOIX_WALLET, 'ok');
      return;
    }
    noter('[connexion] echec : porte coffre | ' + (e && e.name) + (e && e.detail ? ' (' + e.detail + ')' : '') + (existant && !adresseLiee ? ' | demande sans creation' : ''));
    dire(MESSAGES[e && e.name] || 'La preuve reçue n\'est pas valable. Tu n\'es pas connecté.', 'ko');
  } finally { enCours = false; preparer(); }
}
// « Connecter mon wallet » : le joueur a déjà un wallet Solana. Aucun coffre n'est créé, aucune fenêtre ne s'ouvre :
// le wallet signe ici le texte préparé par le serveur du jeu, qui le vérifie. Un seul wallet trouvé : il est utilisé ;
// plusieurs : le joueur choisit dans la liste ; aucun : la page le dit et propose le coffre.
function choisirWallet() {
  if (enCours) return;
  const liste = presents.liste();
  $('z-wallets').hidden = true;
  if (!liste.length) {
    noter('[connexion] echec : porte wallet | aucun wallet compatible dans ce navigateur');
    dire('Aucun wallet Solana compatible n\'a été trouvé dans ce navigateur. Ouvre cette page dans le navigateur de ton wallet, ou sur un ordinateur où il est installé. Sinon, touche « Se connecter » : ton coffre te donne un wallet.', 'ko');
    return;
  }
  if (liste.length === 1) { parWallet(liste[0]); return; }
  const zone = $('l-wallets');
  zone.textContent = '';
  for (const choix of liste) {
    const b = document.createElement('button');
    b.className = 'second';
    b.textContent = choix.nom;   // le nom que le wallet annonce, écrit comme du texte : jamais interprété
    b.addEventListener('click', () => parWallet(choix));
    zone.appendChild(b);
  }
  $('z-wallets').hidden = false;
  dire('');
}
async function parWallet(choix) {
  if (enCours) return;
  if (perime()) {
    prochaine = null;
    dire('Un instant…', 'wait');
    preparer().then(() => dire('C\'est prêt. Touche de nouveau « Connecter mon wallet ».'), () => dire('Le jeu ne répond pas. Réessaie dans un instant.', 'ko'));
    return;
  }
  enCours = true;
  $('z-wallets').hidden = true;
  $('b-wallet').className = 'second porte';
  const { tentativeWallet, entree } = prochaine;
  prochaine = null;
  dire('Ton wallet te demande de confirmer…', 'wait');
  // Cette fonction n'est appelée que par un toucher sur un bouton de cette page. Ce que le navigateur dit du geste
  // est seulement noté au relevé (oui, non, inconnu) : c'est une mesure pour les essais, pas un refus.
  const geste = gesteDuJoueur();
  const vu = ' | geste vu par le navigateur : ' + (geste === true ? 'oui' : geste === false ? 'non' : 'inconnu');
  try {
    const sortie = await connexionWallet({ wallet: choix.wallet, entree });
    // Ce que fait le serveur du jeu : reconstruire le texte attendu, exiger les mêmes octets, vérifier la signature,
    // puis consommer la tentative. Le wallet attendu vient de ce que le jeu a gardé.
    const v = await serveurWallet.conclureConnexion(tentativeWallet, sortie, { walletAttendu: adresseLiee });
    noter('[connexion] ok : porte wallet (' + choix.nom + ') | wallet ' + v.adresse + ' | texte signe verifie par le jeu | aucun coffre' + (adresseLiee ? (adresseLiee === v.adresse ? ' | meme wallet que la fois precedente' : ' | AUTRE WALLET que la fois precedente') : '') + vu);
    adresseLiee = v.adresse;
    $('titre').textContent = 'Tu es connecté';
    $('etat').textContent = 'Ton wallet : ' + v.adresse.slice(0, 4) + '…' + v.adresse.slice(-4);
    $('b-existant').hidden = true;
    dire('Connexion vérifiée par le jeu, avec ton wallet.', 'ok');
  } catch (e) {
    noter('[connexion] echec : porte wallet (' + choix.nom + ') | ' + (e && e.name) + (e && e.detail ? ' (' + e.detail + ')' : '') + vu);
    dire(MESSAGES[e && e.name] || 'Ce que ton wallet a signé n\'est pas ce que le jeu attendait. Tu n\'es pas connecté.', 'ko');
  } finally { enCours = false; preparer(); }
}
async function copier() {
  try { await navigator.clipboard.writeText(texteResultat()); $('s-resultat').textContent = 'Copié.'; }
  catch (_) { $('resultat').select(); $('s-resultat').textContent = 'Sélectionné : copie-le à la main.'; }
}
$('b-connexion').addEventListener('click', () => seConnecter(false));
$('b-existant').addEventListener('click', () => seConnecter(true));
$('b-wallet').addEventListener('click', choisirWallet);
$('b-copier').addEventListener('click', copier);
$('resultat').value = texteResultat();
preparer();
setInterval(() => { if (!enCours) preparer(); }, FRAIS);
document.addEventListener('visibilitychange', auRetour);
window.addEventListener('pageshow', auRetour);
