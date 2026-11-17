// Le faux jeu de démonstration. Il fait ce que ferait un vrai jeu, à une différence près : le « serveur du jeu »
// (serveur-jeu.mjs : le défi tiré pour une tentative, la preuve vérifiée puis le défi consommé une seule fois)
// tourne ici dans la page, pour pouvoir l'essayer sans serveur. Dans la page, il ne protège rien : c'est une démonstration.
// Deux portes : « Se connecter » (la fenêtre du coffre) et « Connecter mon wallet » (un wallet Solana que le joueur a
// déjà : il signe dans cette page, sans coffre et sans fenêtre). La fenêtre du coffre propose aussi « Connecter mon
// wallet » : elle rend alors la main à cette page, qui attend que le joueur touche son bouton du wallet. Le wallet
// n'est jamais appelé à la réception d'un message.
// Quand aucun wallet ne s'annonce (un téléphone, dans son navigateur ordinaire) : la page propose trois liens
// « Ouvrir dans … », qui l'ouvrent dans le navigateur de l'application du wallet. Le joueur les touche lui-même.
// Une fois connecté avec un coffre : « Envoyer 0,001 SOL (essai) ». Le faux jeu construit un message de transaction,
// le fait confirmer dans la fenêtre du coffre, puis vérifie la signature sur ses propres octets. IL NE DIFFUSE RIEN :
// aucun appel au réseau Solana, le hachage récent du message est tiré au hasard et le destinataire est jetable.
// Et deux opérations d'essai de son « programme » (un faux) : « Ouvrir un coffre (essai) » et « Réclamer mon cadeau
// (essai) ». Le faux jeu construit la transaction comme le ferait le serveur d'un jeu, la signe d'abord avec les clés
// de son faux studio, la fait confirmer dans la fenêtre du coffre (qui la juge avec la fiche d'essai), puis vérifie la
// signature du joueur. Là non plus, rien n'est diffusé.

import * as K from './contrat.mjs';
import { connexionCoffre, operationCoffre, walletsPresents, connexionWallet, gesteDuJoueur, liensWallets } from './coffre-jeu.mjs';
import { connexionServeurJeu, connexionWalletServeurJeu, stockageEnMemoire } from './serveur-jeu.mjs';
import { DEMO } from './reglages-demo.mjs';
import { FICHE_ESSAI, GRAINES_DU_FAUX_STUDIO } from './fiche-essai.mjs';

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
  DefiIndisponible: 'Le jeu ne répond pas. Réessaie dans un instant.',
  CoffreTropAncien: 'La page du coffre est trop ancienne pour cette demande.',
  WalletRefuse: 'Ton wallet a refusé, ou tu as annulé. Tu n\'es pas connecté.',
  WalletAbsent: 'Ce wallet ne sait pas faire cette connexion. Tu n\'es pas connecté.',
};
const MESSAGES_ENVOI = {
  FenetreBloquee: 'Le navigateur a bloqué la fenêtre du coffre. Autorise les fenêtres pour ce site, puis réessaie.',
  FenetreFermee: 'Tu as fermé la fenêtre du coffre avant la fin. Rien n\'a été signé.',
  CoffreTropAncien: 'La page du coffre est trop ancienne pour confirmer un envoi.',
  OperationRefusee: 'Tu as refusé dans la fenêtre du coffre. Rien n\'a été signé.',
  OperationIllisible: 'La fenêtre du coffre n\'a pas voulu signer cette demande.',
  AutreWallet: 'Le coffre de cet appareil n\'est pas le wallet de ce compte de jeu. Rien n\'a été signé.',
  PasDeCoffre: 'Il n\'y a pas de coffre sur cet appareil. Reconnecte-toi d\'abord.',
  CoffreNonGarde: 'Ton coffre n\'est pas encore confié au serveur. Rien n\'a été signé.',
  OperationExpiree: 'Trop de temps a passé dans la fenêtre du coffre. Réessaie.',
  DelaiDepasse: 'Trop de temps a passé. Réessaie.',
  OperationEchouee: 'La signature n\'a pas pu se faire. Réessaie.',
  MessageIndisponible: 'Le jeu n\'a pas pu préparer cet envoi. Réessaie dans un instant.',
};
const CHOIX_WALLET = 'Tu as choisi ton wallet. Touche « Connecter mon wallet », juste ici, pour continuer.';
let enCours = false, adresseLiee = null;
let parCoffre = false;   // vrai quand ce compte de jeu est connecté par la porte du coffre (pas par un wallet extérieur)
const stockage = stockageEnMemoire();
const serveurDuJeu = connexionServeurJeu({ contrat: K, service: new URL(DEMO.coffre).origin, jeu: location.origin, stockage });
// La même chose pour un wallet que le joueur a déjà : le serveur du jeu prépare le texte à signer, puis le vérifie.
const serveurWallet = connexionWalletServeurJeu({ contrat: K, jeu: location.origin, stockage });
// Les wallets installés dans ce navigateur s'annoncent à la page (protocole du Wallet Standard).
const presents = walletsPresents();

// LE DÉFI DU COFFRE SE DEMANDE AU MOMENT DU TOUCHER. La fenêtre du coffre s'ouvre dans le geste du joueur, sans rien
// attendre (sinon le navigateur la bloque) ; le défi est demandé au serveur du jeu juste après, pendant qu'elle se
// charge, et lui est donné avec ce qu'il lui reste à vivre. Un défi préparé à l'avance pouvait avoir déjà vécu
// quatre minutes au moment du toucher : la fenêtre faisait alors confirmer le joueur pour un défi mort (essai du
// 17/11/2026). Et un défi ne se renouvelle jamais pendant qu'une fenêtre est ouverte pour lui.
//
// Ce que le wallet du joueur devra signer (« Connecter mon wallet ») reste préparé à l'avance : un wallet s'appelle
// dans le geste du joueur, et attendre le serveur à ce moment-là peut faire perdre ce geste au navigateur. Cette
// porte garde donc le même défaut, en plus étroit : une tentative de wallet préparée depuis près de quatre minutes
// ne laisse qu'une minute au joueur dans son wallet. Rien n'a été mesuré sur un vrai wallet.
let prochaine = null;
const FRAIS = 240000;   // millisecondes : passé ce délai, la tentative du wallet préparée est trop près de sa fin (elle vit 300 secondes)
async function preparer() {
  const tentativeWallet = K.b64u(crypto.getRandomValues(new Uint8Array(24)));
  const { entree } = await serveurWallet.preparer(tentativeWallet, { but: 'connexion' });
  prochaine = { tentativeWallet, entree, pret: Date.now() };
}
const perime = () => !prochaine || Date.now() - prochaine.pret > FRAIS;
// Un onglet laissé en arrière-plan dort, et son minuteur avec lui : au retour, la tentative du wallet peut être trop
// vieille. On en prépare donc une neuve dès que la page redevient visible, pour qu'elle soit prête avant le clic.
function auRetour() { if (!enCours && document.visibilityState === 'visible' && perime()) preparer().catch(() => {}); }

// `existant` : le joueur a touché « J'ai déjà mon coffre ». Le jeu ne connaît pas encore son wallet ; la fenêtre
// ne lui proposera pas d'en créer un. Une fois le wallet connu du jeu, c'est lui qui est annoncé à la fenêtre.
async function seConnecter(existant) {
  if (enCours) return;
  enCours = true;
  $('z-ouvrir').hidden = true;   // le joueur prend la porte du coffre : les liens vers les wallets n'ont plus lieu d'être
  // Une tentative : dans un vrai jeu, l'identifiant de la session d'avant connexion, donné par le serveur du jeu.
  const tentative = K.b64u(crypto.getRandomValues(new Uint8Array(24)));
  dire('La fenêtre du coffre s\'ouvre…', 'wait');
  try {
    // `defi` est une fonction : la fenêtre s'ouvre d'abord, puis le serveur du jeu tire le défi et rend { defi, vie }.
    // `wallet: true` : ce jeu sait aussi connecter un wallet existant, la fenêtre peut donc proposer ce choix.
    const recu = await connexionCoffre({ coffre: DEMO.coffre, defi: () => serveurDuJeu.nouveauDefi(tentative), adresse: adresseLiee || undefined, existant: existant && !adresseLiee, wallet: true }).resultat;
    // Ce que fait le serveur du jeu : tout vérifier avec ce qu'il sait lui-même, puis consommer son défi.
    // Le wallet attendu vient de ce que le jeu a gardé, pas de ce que la fenêtre annonce.
    const v = await serveurDuJeu.conclure(tentative, recu, { walletAttendu: adresseLiee });
    noter('[connexion] ok : porte coffre | wallet ' + v.adresse + ' | preuve verifiee par le jeu' + (existant && !adresseLiee ? ' | demande sans creation' : '') + (adresseLiee ? (adresseLiee === v.adresse ? ' | meme wallet que la fois precedente' : ' | AUTRE WALLET que la fois precedente') : ''));
    adresseLiee = v.adresse;
    $('titre').textContent = 'Tu es connecté';
    $('etat').textContent = 'Ton wallet : ' + v.adresse.slice(0, 4) + '…' + v.adresse.slice(-4);
    $('b-connexion').textContent = 'Me reconnecter';
    $('b-existant').hidden = true;
    parCoffre = true; $('z-envoi').hidden = false; $('z-operations').hidden = false;   // les essais de signature ne se proposent qu'avec un coffre
    dire('Connexion vérifiée par le jeu.', 'ok');
  } catch (e) {
    if (e && e.name === 'ChoixWallet') {
      // Dans la fenêtre du coffre, le joueur a choisi son propre wallet. Ce message ne donne aucun droit : le jeu
      // abandonne la tentative « coffre » chez son serveur, puis attend que le joueur touche le bouton du wallet de
      // CETTE page. La tentative du wallet est une autre tentative, préparée à part par le serveur du jeu.
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
  } finally { enCours = false; }
}
// « Connecter mon wallet » : le joueur a déjà un wallet Solana. Aucun coffre n'est créé, aucune fenêtre ne s'ouvre :
// le wallet signe ici le texte préparé par le serveur du jeu, qui le vérifie. Un seul wallet trouvé : il est utilisé ;
// plusieurs : le joueur choisit dans la liste ; aucun : la page propose de s'ouvrir dans l'application du wallet.
function choisirWallet() {
  if (enCours) return;
  const liste = presents.liste();
  $('z-wallets').hidden = true;
  $('z-ouvrir').hidden = true;
  if (!liste.length) { proposerOuverture(); return; }
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
// Aucun wallet ne s'annonce : sur un téléphone, c'est le cas dans le navigateur ordinaire. La page propose alors de
// s'ouvrir dans le navigateur de l'application du wallet, par le lien que son éditeur documente (liensWallets, dans
// coffre-jeu.mjs : trois wallets, une liste fermée). Ce sont de vrais liens, que le joueur touche lui-même : rien
// n'est ouvert par ce script, ces liens ne marchent que touchés. Le lien ne porte que l'adresse de cette page, sans
// paramètres ni fragment : rien de la tentative en cours n'y voyage, et la page repart de zéro dans le wallet.
// Pour les autres wallets, et pour un ordinateur, la page l'écrit en une phrase (demo.html).
function proposerOuverture() {
  let liens = [];
  try { liens = liensWallets({ adresse: location.href }); } catch (_) { liens = []; }
  const zone = $('l-ouvrir');
  zone.textContent = '';
  for (const { nom, lien } of liens) {
    const a = document.createElement('a');
    a.href = lien;
    a.rel = 'noreferrer';
    a.className = 'carte';
    a.textContent = 'Ouvrir dans ' + nom;
    // Le toucher n'est pas retenu : la page note seulement qu'il a eu lieu, pour le relevé d'un essai.
    a.addEventListener('click', () => noter('[connexion] lien touche : ouvrir dans ' + nom));
    zone.appendChild(a);
  }
  $('z-ouvrir-liens').hidden = !liens.length;
  $('z-ouvrir').hidden = false;
  dire('');
  noter('[connexion] porte wallet | aucun wallet compatible dans ce navigateur | '
    + (liens.length ? 'liens « ouvrir dans le wallet » proposes : ' + liens.map((l) => l.nom).join(', ') : 'aucun lien propose (cette page n\'est pas en https)'));
}
// Un wallet s'annonce après coup (son extension finit de charger, ou la page vient de s'ouvrir dans son navigateur) :
// les liens ne servent plus. La page le dit, et n'appelle rien : le joueur touche son bouton.
presents.surChangement(() => {
  if ($('z-ouvrir').hidden || !presents.liste().length) return;
  $('z-ouvrir').hidden = true;
  dire('Ton wallet est là. Touche « Connecter mon wallet ».', 'ok');
});
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
// ---------- « Envoyer 0,001 SOL (essai) » : un vrai jeu demanderait ce message à son serveur une fois la fenêtre du
// coffre prête (une transaction ne vit qu'une minute environ sur le réseau). Ici il est construit à ce moment-là, à la
// main, à l'ancien format : une signature (le joueur, qui paie aussi les frais), trois clés (le
// joueur, un destinataire jetable, le programme système), un hachage récent tiré au hasard (donc une transaction que
// le réseau refuserait), et une instruction : le transfert de 1 000 000 lamports. Rien n'est diffusé.
const ENVOI_ESSAI = 1000000;   // lamports : 0,001 SOL
function messageEnvoi(joueur, destinataire, hachage, lamports) {
  const o = [1, 0, 1, 3, ...joueur, ...destinataire, ...new Uint8Array(32), ...hachage, 1, 2, 2, 0, 1, 12, 2, 0, 0, 0];
  let v = BigInt(lamports);
  for (let k = 0; k < 8; k++) { o.push(Number(v & 255n)); v >>= 8n; }
  return Uint8Array.from(o);
}
function direEnvoi(texte, sorte) { const e = $('s-envoi'); e.textContent = texte || ''; e.className = 'status' + (sorte ? ' ' + sorte : ''); }
async function envoyerEssai() {
  if (enCours || !parCoffre || !adresseLiee) return;
  enCours = true;
  direEnvoi('La fenêtre du coffre s\'ouvre…', 'wait');
  try {
    // La fenêtre s'ouvre dans le geste du joueur, sans rien attendre ; le message est construit quand elle est prête
    // (`message` est une fonction). Le jeu garde ses propres octets : c'est sur eux qu'il vérifiera la signature.
    let message = null, vers = '';
    const construire = () => {
      const destinataire = crypto.getRandomValues(new Uint8Array(32));
      vers = K.base58(destinataire);
      message = messageEnvoi(K.deBase58(adresseLiee, 32), destinataire, crypto.getRandomValues(new Uint8Array(32)), ENVOI_ESSAI);
      return message;
    };
    const recu = await operationCoffre({ coffre: DEMO.coffre, message: construire, adresse: adresseLiee }).resultat;
    // Ce que fait le jeu : vérifier la signature lui-même, sur SES octets, avec le wallet qu'il a lié à ce compte.
    if (recu.adresse !== adresseLiee || !(await K.verifierSignature(K.deBase58(adresseLiee, 32), K.deB64u(recu.signature, 64), message))) throw Object.assign(new Error('SignatureRefusee'), { name: 'SignatureRefusee' });
    noter('[envoi] ok : essai de 0,001 SOL vers ' + vers.slice(0, 4) + '…' + vers.slice(-4) + ' | wallet ' + recu.adresse + ' | confirme dans la fenetre du coffre | signature verifiee par le jeu sur ses propres octets | RIEN N\'EST ENVOYE SUR LE RESEAU');
    direEnvoi('Confirmé dans ton coffre, et signature vérifiée par le jeu. Essai : rien n\'est envoyé sur le réseau.', 'ok');
  } catch (e) {
    noter('[envoi] echec : ' + (e && e.name) + ' | rien n\'est envoye sur le reseau');
    direEnvoi(MESSAGES_ENVOI[e && e.name] || 'La signature reçue n\'est pas valable. Rien n\'est envoyé.', 'ko');
  } finally { enCours = false; }
}
// ---------- Deux opérations d'essai du « programme » du faux jeu. Ce que ferait le serveur d'un vrai jeu se fait ici,
// dans la page (où cela ne protège rien) : construire la transaction à l'ancien format, la signer avec les clés du
// studio et la clé jetable de l'objet créé, laisser vide la case du joueur. La fenêtre du coffre reçoit la
// transaction entière, la juge avec la fiche d'essai, et ne rend que la signature du joueur.
// Les clés du faux studio se refont à partir de noms publics (fiche-essai.mjs) : elles ne protègent rien.
const encodeur = new TextEncoder();
const PKCS8_ED25519 = [0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20];
let clesDuStudio = null;
async function fauxStudio() {
  if (clesDuStudio) return clesDuStudio;
  const cles = {};
  for (const [nom, graine] of Object.entries(GRAINES_DU_FAUX_STUDIO)) {
    const g = new Uint8Array(await crypto.subtle.digest('SHA-256', encodeur.encode(graine)));
    cles[nom] = await crypto.subtle.importKey('pkcs8', Uint8Array.from([...PKCS8_ED25519, ...g]), { name: 'Ed25519' }, false, ['sign']);
  }
  clesDuStudio = cles;
  return cles;
}
const u64le = (n) => { const o = []; let v = BigInt(n); for (let k = 0; k < 8; k++) { o.push(Number(v & 255n)); v >>= 8n; } return o; };
const deHex = (t) => t.match(/../g).map((x) => parseInt(x, 16));
// Un message à l'ancien format : l'en-tête, les clés, un hachage récent tiré au hasard (le réseau le refuserait), les
// instructions ({ p: index du programme, c: index des comptes, d: octets }). Toutes les longueurs tiennent sur un octet.
function messageDuJeu(entete, cles, instructions) {
  const o = [...entete, cles.length];
  for (const c of cles) o.push(...c);
  o.push(...crypto.getRandomValues(new Uint8Array(32)), instructions.length);
  for (const i of instructions) o.push(i.p, i.c.length, ...i.c, i.d.length, ...i.d);
  return Uint8Array.from(o);
}
// La transaction partiellement signée : le nombre de signatures, une case de 64 octets par signataire dans l'ordre de
// l'en-tête (vide pour le joueur), puis le message.
async function transactionDuJeu(message, signataires) {
  const o = [signataires.length];
  for (const cle of signataires) o.push(...(cle ? await K.signer(cle, message) : new Uint8Array(64)));
  o.push(...message);
  return Uint8Array.from(o);
}
const A = (adresse) => K.deBase58(adresse, 32);
const jetable = () => crypto.getRandomValues(new Uint8Array(32));
async function construireOuverture() {
  const studio = await fauxStudio(), op = FICHE_ESSAI.operations['ouvrir-coffre-essai'], prog = op.instructions[1];
  // La clé jetable de l'objet créé : une vraie paire, parce qu'elle doit signer.
  const neuf = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
  const cleNeuf = new Uint8Array(await crypto.subtle.exportKey('raw', neuf.publicKey));
  // Signataires inscriptibles : le payeur (il paie les frais), le joueur, l'objet neuf ; en lecture : l'admin.
  // Puis un compte libre, et les comptes en lecture seule : les six comptes fixes de la fiche, et le programme.
  const cles = [A(FICHE_ESSAI.signataires.payeur), A(adresseLiee), cleNeuf, A(FICHE_ESSAI.signataires.admin), jetable(),
    A(prog.fixes[2]), A(prog.fixes[5]), A(prog.fixes[6]), A(prog.fixes[7]), A(prog.fixes[8]), A(prog.fixes[9]), A(prog.programme)];
  const message = messageDuJeu([4, 1, 7], cles, [
    { p: 8, c: [0, 1], d: [2, 0, 0, 0, ...u64le(2000000)] },                       // le payeur avance 0,002 SOL au joueur
    { p: 11, c: [1, 3, 5, 2, 4, 6, 7, 8, 9, 10], d: deHex(prog.debut) }]);          // l'instruction du programme
  return { message, transaction: await transactionDuJeu(message, [studio.payeur, null, neuf.privateKey, studio.admin]) };
}
async function construireCadeaux() {
  const studio = await fauxStudio(), prog = FICHE_ESSAI.operations['reclamer-cadeau-essai'].instructions[0];
  // Le payeur paie les frais ; le joueur signe en lecture seule ; deux cadeaux, donc deux fois l'instruction.
  const cles = [A(FICHE_ESSAI.signataires.payeur), A(adresseLiee), jetable(), jetable(), A(prog.programme)];
  const message = messageDuJeu([2, 1, 1], cles, [1, 2].map((numero) => ({ p: 4, c: [1, 1 + numero, 0], d: [...deHex(prog.debut), numero] })));
  return { message, transaction: await transactionDuJeu(message, [studio.payeur, null]) };
}
const MESSAGES_OPERATION = Object.assign({}, MESSAGES_ENVOI, {
  CoffreTropAncien: 'La page du coffre est trop ancienne pour une opération du jeu.',
  OperationIllisible: 'La fenêtre du coffre n\'a pas reconnu cette opération. Rien n\'a été signé.',
  MessageIndisponible: 'Le jeu n\'a pas pu préparer cette opération. Réessaie dans un instant.',
});
function direOperation(texte, sorte) { const e = $('s-operations'); e.textContent = texte || ''; e.className = 'status' + (sorte ? ' ' + sorte : ''); }
async function operationEssai(nom, construire) {
  if (enCours || !parCoffre || !adresseLiee) return;
  enCours = true;
  direOperation('La fenêtre du coffre s\'ouvre…', 'wait');
  const texte = FICHE_ESSAI.operations[nom].texte;
  try {
    // La transaction est construite et cosignée quand la fenêtre est prête ; le jeu garde son message pour vérifier.
    let message = null;
    const fournir = async () => { const t = await construire(); message = t.message; return t.transaction; };
    const recu = await operationCoffre({ coffre: DEMO.coffre, operation: nom, version: FICHE_ESSAI.operations[nom].version, transaction: fournir, adresse: adresseLiee }).resultat;
    // Ce que fait le jeu : vérifier la signature du joueur lui-même, sur SON message, avant de la poser dans sa case.
    if (recu.adresse !== adresseLiee || !message || !(await K.verifierSignature(K.deBase58(adresseLiee, 32), K.deB64u(recu.signature, 64), message))) throw Object.assign(new Error('SignatureRefusee'), { name: 'SignatureRefusee' });
    noter('[operation] ok : « ' + texte + ' » (' + nom + ') | wallet ' + recu.adresse + ' | cosignee par le faux studio, confirmee dans la fenetre du coffre | signature du joueur verifiee par le jeu sur son propre message | RIEN N\'EST ENVOYE SUR LE RESEAU');
    direOperation('Confirmé dans ton coffre, et signature vérifiée par le jeu. Essai : rien n\'est envoyé sur le réseau.', 'ok');
  } catch (e) {
    noter('[operation] echec : « ' + texte + ' » (' + nom + ') | ' + (e && e.name) + ' | rien n\'est envoye sur le reseau');
    direOperation(MESSAGES_OPERATION[e && e.name] || 'La signature reçue n\'est pas valable. Rien n\'est envoyé.', 'ko');
  } finally { enCours = false; }
}
async function copier() {
  try { await navigator.clipboard.writeText(texteResultat()); $('s-resultat').textContent = 'Copié.'; }
  catch (_) { $('resultat').select(); $('s-resultat').textContent = 'Sélectionné : copie-le à la main.'; }
}
$('b-connexion').addEventListener('click', () => seConnecter(false));
$('b-existant').addEventListener('click', () => seConnecter(true));
$('b-wallet').addEventListener('click', choisirWallet);
$('b-envoi').addEventListener('click', envoyerEssai);
$('b-ouvrir-essai').addEventListener('click', () => operationEssai('ouvrir-coffre-essai', construireOuverture));
$('b-cadeau-essai').addEventListener('click', () => operationEssai('reclamer-cadeau-essai', construireCadeaux));
$('b-copier').addEventListener('click', copier);
$('resultat').value = texteResultat();
preparer();
setInterval(() => { if (!enCours) preparer(); }, FRAIS);
document.addEventListener('visibilitychange', auRetour);
window.addEventListener('pageshow', auRetour);
