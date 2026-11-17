// Le côté « serveur du jeu » : ce que le serveur d'un studio fait d'une preuve de connexion. Aucune dépendance.
// Un exemple complet et court, fait pour être repris tel quel. Les règles qui comptent sont ici ; le stockage est
// une interface à trois fonctions, que le studio branche sur sa propre base.
//
//   import * as contrat from './contrat.mjs';
//   const connexion = connexionServeurJeu({ contrat, service: 'https://…', jeu: 'https://…', stockage });
//
//   1. Le joueur clique « Se connecter ». Le serveur tire un défi pour CETTE tentative (l'identifiant de la session
//      d'avant connexion, que le serveur a lui-même donné à ce navigateur) :
//        const { defi } = await connexion.nouveauDefi(tentative);            // connexion par le wallet seul
//        const { defi } = await connexion.nouveauDefi(tentative, { compte });  // pour un compte déjà reconnu
//   2. La page du jeu ouvre la fenêtre du coffre avec ce défi (coffre-jeu.mjs), puis renvoie la réponse au serveur.
//   3. Le serveur conclut. Alors seulement il ouvre la session du joueur :
//        const { adresse } = await connexion.conclure(tentative, reponse, { walletAttendu });
//      Ou, pour un compte que le jeu a déjà reconnu lui-même, avec le lien « compte → wallet » de sa base :
//        const { adresse, premierLien } = await connexion.conclurePourCompte(tentative, reponse, { compte, liens });
//      Si le joueur renonce (il choisit son propre wallet dans la fenêtre : erreur ChoixWallet côté page), le
//      serveur retire le défi sans attendre son échéance :
//        await connexion.abandonner(tentative);
//
// Les règles tenues ici :
//   - le défi est tiré par le serveur, au hasard, pour une tentative précise, et vit cinq minutes ;
//   - une preuve n'est acceptée que dans la tentative pour laquelle son défi a été tiré : la preuve d'un autre
//     joueur, ou d'une autre tentative, ne connecte personne ;
//   - la preuve est vérifiée en entier AVANT de toucher au défi, et le défi n'est consommé qu'une fois, même si deux
//     demandes arrivent ensemble : c'est `stockage.consommer` qui le garantit, par une suppression conditionnelle ;
//   - l'heure qui compte est celle de l'écriture : lire la base et vérifier une signature prennent du temps, et une
//     heure lue avant d'attendre est déjà vieille. Le stockage lit donc lui-même l'heure, dans l'instruction qui
//     supprime le défi, et il y juge les DEUX échéances : celle du défi et celle de la preuve ;
//   - un défi tiré pour un compte ne sert que pour ce compte : le serveur note le compte à l'émission du défi et
//     le compare au retour. Une session qui a changé entre-temps ne conclut pas la tentative d'une autre ;
//   - `walletAttendu` vient de la base du jeu (le wallet déjà lié à ce compte), jamais de la page ni de la preuve.
//     Une connexion ne remplace jamais le wallet lié à un compte.
//
// Ce que la preuve établit : celui qui répond tient la clé de ce wallet, maintenant, pour ce jeu et ce défi.
// Ce qu'elle n'établit pas : qui est le joueur (son e-mail), qu'il vient de faire Face ID, ni que son coffre est
// gardé par le service. C'est une preuve de possession du wallet, rien de plus : elle ne doit donner aucun droit
// de dépense à elle seule.
//
// Le stockage, à brancher sur la base du jeu. C'est LUI qui lit l'heure, à l'instant de chaque opération : on ne lui
// donne jamais d'heure. Avec une base SQL, c'est l'horloge de la base, dans l'instruction elle-même.
//   poser({ tentative, defi, duree, contexte })   garde le défi de cette tentative pendant `duree` secondes (un seul à
//                                       la fois par tentative), avec son contexte : rien, ou le compte pour lequel il
//                                       a été tiré. En SQL : … VALUES (?, ?, unixepoch() + ?, ?)
//   lire(tentative)                     rend { defi, contexte } s'il existe et n'est pas expiré, sinon rien.
//                                       En SQL : SELECT defi, contexte … WHERE tentative = ? AND expire > unixepoch()
//   consommer({ tentative, defi, avant })   supprime ce défi s'il est là, pour cette tentative, pas expiré À L'INSTANT
//                                       DE LA SUPPRESSION, et si l'échéance `avant` (la fin de validité de la preuve,
//                                       déjà vérifiée ; ou, pour un abandon, la valeur réservée
//                                       SANS_ECHEANCE_DE_PREUVE) n'est pas franchie non plus ; rend vrai UNE SEULE FOIS. En SQL,
//                                       une seule instruction, et l'on regarde si une ligne a été supprimée :
//                                       DELETE … WHERE tentative = ? AND defi = ? AND expire > unixepoch() AND ? > unixepoch()

export const DUREE_DEFI_JEU = 300;   // secondes
// L'échéance passée à `stockage.consommer` par `abandonner`, à la place de la fin de validité d'une preuve (il n'y
// a pas de preuve dans un abandon). Une valeur réservée, la même partout, qui ne dépend d'aucune horloge : le 31
// décembre 9999, en secondes. Elle ne prolonge rien : le stockage juge toujours l'expiration du défi lui-même, avec
// sa propre horloge, dans la même suppression. Elle tient dans un entier de 64 bits ; un stockage qui compare
// `avant` dans un entier de 32 bits doit l'élargir.
export const SANS_ECHEANCE_DE_PREUVE = 253402300799;
const TENTATIVE = /^[A-Za-z0-9_-]{16,128}$/;
const TEXTE = /^[A-Za-z0-9_-]{1,8000}$/;

export function connexionServeurJeu({ contrat, service, jeu, stockage, horloge, duree }) {
  const maintenant = horloge || (() => Math.floor(Date.now() / 1000));
  const vie = duree || DUREE_DEFI_JEU;
  const refuser = (detail) => { throw new contrat.Refus('ConnexionRefusee', detail); };

  const contexteDe = (compte) => 'compte:' + compte;

  // `options.compte` : le compte que le serveur a reconnu pour cette session, quand le défi sert à le connecter
  // (conclurePourCompte). Sans compte, le défi ne sert qu'à une connexion par le wallet seul (conclure).
  async function nouveauDefi(tentative, options) {
    if (typeof tentative !== 'string' || !TENTATIVE.test(tentative)) refuser('tentative');
    const compte = options && options.compte;
    if (compte !== undefined && compte !== null && (typeof compte !== 'string' || !compte)) refuser('compte');
    const defi = contrat.b64u(crypto.getRandomValues(new Uint8Array(32)));
    await stockage.poser({ tentative, defi, duree: vie, contexte: compte ? contexteDe(compte) : null });
    return { defi, duree: vie };
  }

  async function verifierPuisConsommer(tentative, reponse, contexte, walletAttendu) {
    if (typeof tentative !== 'string' || !TENTATIVE.test(tentative)) refuser('tentative');
    if (!reponse || typeof reponse !== 'object' || typeof reponse.message !== 'string' || !TEXTE.test(reponse.message)
      || typeof reponse.signature !== 'string' || !TEXTE.test(reponse.signature)) refuser('forme');
    const attente = await stockage.lire(tentative);
    if (!attente || typeof attente.defi !== 'string') refuser('defi');
    // Le défi ne sert qu'à ce pour quoi il a été tiré : ce compte-là, ou une connexion par le wallet seul.
    if ((attente.contexte || null) !== contexte) refuser('contexte');
    // 1. Tout vérifier, avec ce que le serveur sait lui-même : son adresse, celle du coffre, le défi de cette tentative.
    const v = await contrat.verifierConnexionJeu({ message: contrat.deB64u(reponse.message), signature: contrat.deB64u(reponse.signature, 64) },
      { service, jeu, defi: attente.defi, maintenant: maintenant() });
    if (reponse.adresse !== undefined && reponse.adresse !== v.adresse) refuser('adresse');
    if (walletAttendu !== undefined && walletAttendu !== null && v.adresse !== walletAttendu) throw new contrat.Refus('AutreWallet');
    // 2. Le temps a passé pendant ces attentes. La fin de validité de la preuve (une échéance vérifiée, pas une
    //    heure lue) est rejugée ici, puis une dernière fois par le stockage, à l'instant où il supprime le défi.
    const avant = v.expire + contrat.TOLERANCE_HORLOGE;
    if (!(avant > maintenant())) refuser('heure');
    // 3. Consommer le défi. Le stockage juge lui-même, dans la suppression, que ni le défi ni la preuve ne sont
    //    expirés ; une seule des demandes arrivées ensemble passe ici.
    if ((await stockage.consommer({ tentative, defi: attente.defi, avant })) !== true) refuser('expire ou deja utilise');
    return { adresse: v.adresse };
  }

  // Une connexion par le wallet seul. Au serveur du jeu d'ouvrir ensuite sa session pour ce wallet.
  async function conclure(tentative, reponse, options) {
    return verifierPuisConsommer(tentative, reponse, null, options && options.walletAttendu);
  }

  // La même chose pour un compte que le jeu a déjà reconnu LUI-MÊME (sa session, son propre contrôle de l'e-mail).
  // `compte` vient du serveur du jeu, jamais de la page, et doit être celui pour lequel le défi a été tiré
  // (nouveauDefi(tentative, { compte })). `liens` est le lien « compte → wallet » de sa base (stockage-sql.mjs).
  //   - le compte a déjà un wallet : seule une preuve de CE wallet le connecte ;
  //   - il n'en a pas : le wallet prouvé lui est lié, une fois pour toutes. Si une autre tentative a lié un autre
  //     wallet entre-temps, ou si ce wallet est déjà celui d'un autre compte, personne n'est connecté.
  // `premierLien` est vrai pour la seule demande dont l'écriture a créé le lien : deux demandes arrivées ensemble
  // avec le même wallet sont toutes deux connectées, mais une seule le voit vrai. Il ne doit pas pour autant
  // déclencher seul un envoi d'objets : si la réponse se perd, la demande suivante dira `false`. Une restitution
  // est une opération à part, que le jeu enregistre, identifie et sait reprendre sans la rejouer.
  async function conclurePourCompte(tentative, reponse, { compte, liens }) {
    if (typeof compte !== 'string' || !compte) refuser('compte');
    const deja = await liens.walletDe(compte);
    const { adresse } = await verifierPuisConsommer(tentative, reponse, contexteDe(compte), deja);
    if (deja) return { adresse, premierLien: false };
    const lie = await liens.lierUneFois(compte, adresse);
    if (!lie || lie.adresse !== adresse) throw new contrat.Refus('AutreWallet');
    return { adresse, premierLien: lie.ecrit === true };
  }

  // Le joueur renonce à cette tentative (il a choisi une autre méthode, ou fermé la fenêtre) : son défi est retiré
  // tout de suite, sans rien vérifier, pour que plus aucune preuve ne puisse conclure cette tentative. Rend vrai si
  // un défi encore vivant a été retiré, et seulement si le stockage le confirme : ne dire « abandonnée » au joueur ou
  // au journal que sur ce vrai. Sans cet appel, ou s'il rend faux, le défi s'éteint de lui-même à son échéance.
  // L'heure de ce programme n'entre pas dans la décision (elle peut être fausse, celle du stockage fait foi) : c'est
  // le défi lu à l'instant qui est supprimé, s'il est toujours celui-là (un défi renouvelé entre la lecture et la
  // suppression n'est pas touché) et s'il n'est pas expiré pour le stockage. C'est au serveur du jeu de n'accepter
  // cet appel que pour une tentative de la session qui le demande.
  async function abandonner(tentative) {
    if (typeof tentative !== 'string' || !TENTATIVE.test(tentative)) refuser('tentative');
    const attente = await stockage.lire(tentative);
    if (!attente || typeof attente.defi !== 'string') return false;
    return (await stockage.consommer({ tentative, defi: attente.defi, avant: SANS_ECHEANCE_DE_PREUVE })) === true;
  }

  return { nouveauDefi, conclure, conclurePourCompte, abandonner };
}

// ---------- Le joueur a déjà un wallet (Phantom, Solflare…) : « Sign In With Solana ».
//
// Ce chemin ne passe ni par la fenêtre du coffre ni par notre service, et ne crée aucun coffre : le wallet du joueur
// signe un texte de connexion dans la page du jeu, et le serveur du jeu le vérifie. Aucun format n'est inventé ici :
// le texte est celui de « Sign In With Solana » (publié par Phantom, repris par le Wallet Standard sous le nom
// `solana:signIn`).
//
//   const wallet = connexionWalletServeurJeu({ contrat, jeu: 'https://…', stockage });
//
//   1. Avant le clic, le serveur prépare la tentative et rend ce que le wallet devra signer :
//        const { entree } = await wallet.preparer(tentative, { but: 'connexion' });
//        const { entree } = await wallet.preparer(tentative, { but: 'association', compte });
//   2. La page appelle le wallet avec `entree` (coffre-jeu.mjs : connexionWallet) et renvoie sa sortie au serveur.
//   3. Le serveur conclut. Alors seulement il ouvre ou complète la session :
//        const { adresse } = await wallet.conclureConnexion(tentative, sortie, { walletAttendu });
//        const { adresse, premierLien } = await wallet.conclureAssociation(tentative, sortie, { compte, liens });
//
// Les règles tenues ici :
//   - tout ce qui sera signé est fixé par le serveur et rangé avec la tentative : le domaine, l'adresse de la page,
//     le réseau, la phrase, les heures, et un `nonce` de 128 bits tiré au hasard. Rien de cela ne vient de la page ;
//   - au retour, le serveur RECONSTRUIT le texte attendu à partir de ce qu'il a rangé et de l'adresse rendue, et
//     exige que les octets signés soient exactement ceux-là. Il ne lit pas le texte signé pour y chercher des champs :
//     il le compare, octet pour octet. Aucune mise en forme après la signature ;
//   - l'adresse rendue est une adresse Solana bien formée (base58, 32 octets, une seule écriture), la clé publique
//     annoncée est la même clé, et c'est elle qui vérifie la signature (Ed25519, 64 octets). Un type de signature
//     inattendu, ou une enveloppe « hors chaîne », est refusé : ce premier essai ne couvre que le texte brut ;
//   - tout est vérifié AVANT de toucher à la tentative, qui n'est consommée qu'une fois, même si deux demandes
//     arrivent ensemble ; c'est le stockage qui juge l'expiration, à l'instant où il supprime ;
//   - une tentative a un but, « connexion » ou « association », fixé à sa préparation : elle ne sert jamais à l'autre.
//     Les deux phrases signées sont différentes : une signature obtenue pour l'une ne vaut pas pour l'autre ;
//   - le wallet attendu vient de la base du jeu ; une connexion ne remplace jamais le wallet lié à un compte, et
//     aucun rapprochement n'est fait avec un coffre.
//
// Ce que cette preuve établit : celui qui répond tient la clé de ce wallet, pour ce jeu et cette tentative.
// **Ce qu'elle n'établit pas : la page où le joueur a signé.** Un faux site peut obtenir du vrai jeu un texte encore
// vivant et le faire signer au joueur : le serveur reçoit alors exactement les bons octets et ne peut pas le voir.
// La seule protection en plus est dans le wallet, qui compare le domaine du texte à la page qui demande (Phantom
// documente un refus ; d'autres seulement un avertissement). Aucune garantie universelle n'est donc promise ici.
//
// Le stockage, pour ces tentatives (trois fonctions de plus, mêmes règles que pour le défi : c'est LUI qui lit l'heure) :
//   poserWallet({ tentative, nonce, duree, champs })   garde la tentative pendant `duree` secondes (une seule à la fois
//                                       par tentative) ; rend { emis } : l'heure qu'IL a lue en l'écrivant, en secondes.
//                                       Elle sera écrite dans le texte à signer.
//   lireWallet(tentative)               rend { nonce, emis, expire, champs } si elle existe et n'est pas expirée.
//   consommerWallet({ tentative, nonce })   la supprime si elle est là, avec ce `nonce`, et pas expirée À L'INSTANT DE
//                                       LA SUPPRESSION ; rend vrai UNE SEULE FOIS.

export const DUREE_TENTATIVE_WALLET = 300;   // secondes
// Les réseaux admis par la spécification pour « Chain ID » (son ABNF : message-chain-id).
const RESEAUX = ['mainnet', 'testnet', 'devnet', 'localnet', 'solana:mainnet', 'solana:testnet', 'solana:devnet'];
// Une phrase tient sur une ligne, dans les caractères que la spécification admet (son ABNF : message-statement,
// c'est-à-dire lettres et chiffres sans accent, espace, et la ponctuation des adresses web).
const PHRASE = /^[A-Za-z0-9\-._~:/?#[\]@!$&'()*+,;= ]{1,200}$/;
const NONCE = /^[0-9a-f]{32}$/;   // 128 bits, en hexadécimal ; la spécification demande au moins 8 lettres ou chiffres
const BUTS = ['connexion', 'association'];
const PHRASES = {
  connexion: 'Connexion a ce jeu avec ce wallet. Aucune transaction, aucun frais.',
  association: 'Associer ce wallet a mon compte de jeu. Aucune transaction, aucun frais.',
};
const SORTIE = ['adresse', 'clePublique', 'messageSigne', 'signature', 'type', 'format'];

// Le texte « Sign In With Solana », à l'octet près. Source : la fonction `createSignInMessageText` du Wallet Standard
// (dépôt anza-xyz/wallet-standard, packages/core/util/src/signIn.ts, lue le 15/11/2026), qui suit le gabarit de la
// spécification de Phantom (phantom/sign-in-with-solana). Chaque ligne ci-dessous est la sienne :
//   - l'en-tête : le domaine, la phrase fixe en anglais, un retour à la ligne, puis l'adresse, sans retour après ;
//   - la phrase (« statement »), si elle existe : une ligne vide, puis la phrase ;
//   - les champs présents, dans cet ordre, un par ligne, précédés d'UNE ligne vide (qu'il y ait une phrase ou non) :
//     « URI: », « Version: », « Chain ID: », « Nonce: », « Issued At: », « Expiration Time: », « Not Before: »,
//     « Request ID: », puis « Resources: » suivi d'une ligne « - … » par ressource ;
//   - aucun retour à la ligne final.
// (La grammaire de Phantom écrit un seul retour avant les champs quand il n'y a pas de phrase ; la fonction de
// référence en met deux. Nos tentatives ont toujours une phrase : les deux lectures donnent alors le même texte.)
export function texteSiws(c) {
  let texte = c.domain + ' wants you to sign in with your Solana account:\n' + c.address;
  if (c.statement) texte += '\n\n' + c.statement;
  const lignes = [];
  if (c.uri) lignes.push('URI: ' + c.uri);
  if (c.version) lignes.push('Version: ' + c.version);
  if (c.chainId) lignes.push('Chain ID: ' + c.chainId);
  if (c.nonce) lignes.push('Nonce: ' + c.nonce);
  if (c.issuedAt) lignes.push('Issued At: ' + c.issuedAt);
  if (c.expirationTime) lignes.push('Expiration Time: ' + c.expirationTime);
  if (c.notBefore) lignes.push('Not Before: ' + c.notBefore);
  if (c.requestId) lignes.push('Request ID: ' + c.requestId);
  if (c.resources) { lignes.push('Resources:'); for (const r of c.resources) lignes.push('- ' + r); }
  if (lignes.length) texte += '\n\n' + lignes.join('\n');
  return texte;
}

export function connexionWalletServeurJeu({ contrat, jeu, stockage, duree, reseau, page, phrases }) {
  const refuser = (detail) => { throw new contrat.Refus('ConnexionRefusee', detail); };
  // L'origine du jeu : en https, ou en http pour l'ordinateur lui-même (les essais locaux). Ni chemin, ni requête.
  let origine;
  try { origine = new URL(jeu); } catch (_) { throw new Error('jeu : adresse illisible'); }
  const locale = origine.protocol === 'http:' && (origine.hostname === 'localhost' || origine.hostname === '127.0.0.1');
  if ((origine.protocol !== 'https:' && !locale) || jeu !== origine.origin) throw new Error('jeu : l origine du jeu est attendue, en https, sans chemin');
  const domaine = origine.host;
  // L'adresse de la page qui demande (« URI ») : fixée ici, sur l'origine du jeu. Par défaut, cette origine.
  const adressePage = page === undefined ? jeu : page;
  let lue;
  try { lue = new URL(adressePage); } catch (_) { throw new Error('page : adresse illisible'); }
  if (lue.origin !== jeu || lue.hash || lue.username || lue.password || /[\s#]/.test(adressePage)) throw new Error('page : une adresse du jeu est attendue');
  const chaine = reseau === undefined ? 'mainnet' : reseau;
  if (!RESEAUX.includes(chaine)) throw new Error('reseau : valeur inconnue de la specification');
  const vie = duree === undefined ? DUREE_TENTATIVE_WALLET : duree;
  // Dix minutes au plus : au-delà, un wallet qui juge l'heure d'émission refuserait de signer.
  if (!Number.isInteger(vie) || vie < 30 || vie > 600) throw new Error('duree : entre 30 et 600 secondes');
  const textes = Object.assign({}, PHRASES, phrases || {});
  for (const b of BUTS) if (typeof textes[b] !== 'string' || !PHRASE.test(textes[b])) throw new Error('phrase refusee pour ' + b);
  // Deux buts, deux phrases : une signature obtenue pour l'un ne peut pas servir à l'autre.
  if (textes.connexion === textes.association) throw new Error('les deux phrases doivent etre differentes');

  const iso = (secondes) => new Date(secondes * 1000).toISOString();
  const adresseValide = (a) => { try { return typeof a === 'string' && a.length <= 64 ? contrat.deBase58(a, 32) : null; } catch (_) { return null; } };
  const memes = (a, b) => { if (a.length !== b.length) return false; let d = 0; for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i]; return d === 0; };

  // `options.but` : « connexion » (le wallet seul ; le jeu retrouve ensuite le compte lié à ce wallet, s'il y en a
  // un) ou « association » (lier ce wallet à `options.compte`, que le serveur a déjà reconnu LUI-MÊME).
  // `options.wallet` : facultatif, le wallet que le jeu attend déjà (tiré de sa base) : il est écrit dans la demande,
  // et seul ce wallet-là pourra conclure.
  async function preparer(tentative, options) {
    if (typeof tentative !== 'string' || !TENTATIVE.test(tentative)) refuser('tentative');
    const but = options && options.but, compte = options && options.compte, wallet = options && options.wallet;
    if (!BUTS.includes(but)) refuser('but');
    if (but === 'association' ? (typeof compte !== 'string' || !compte) : (compte !== undefined && compte !== null)) refuser('compte');
    if (wallet !== undefined && wallet !== null && !adresseValide(wallet)) refuser('wallet attendu');
    const nonce = contrat.hex(crypto.getRandomValues(new Uint8Array(16)));
    // Ce qui est rangé est ce qui sera signé : si un réglage du serveur change entre-temps, le texte attendu reste
    // celui de la tentative.
    const champs = JSON.stringify({ but, compte: but === 'association' ? compte : null, wallet: wallet || null,
      domaine, page: adressePage, reseau: chaine, phrase: textes[but] });
    const pose = await stockage.poserWallet({ tentative, nonce, duree: vie, champs });
    if (!pose || !Number.isSafeInteger(pose.emis)) refuser('stockage');
    const entree = { domain: domaine, statement: textes[but], uri: adressePage, version: '1', chainId: chaine, nonce,
      issuedAt: iso(pose.emis), expirationTime: iso(pose.emis + vie) };
    if (wallet) entree.address = wallet;
    return { entree, duree: vie };
  }

  async function verifierPuisConsommer(tentative, sortie, but, compte, walletAttendu) {
    if (typeof tentative !== 'string' || !TENTATIVE.test(tentative)) refuser('tentative');
    // 1. La forme de ce que la page rapporte du wallet : quatre textes, et rien d'inconnu.
    if (!sortie || typeof sortie !== 'object' || Array.isArray(sortie) || Object.keys(sortie).some((k) => !SORTIE.includes(k))) refuser('forme');
    for (const k of ['adresse', 'clePublique', 'messageSigne', 'signature']) if (typeof sortie[k] !== 'string') refuser('forme');
    // Un type de signature annoncé ne peut être que celui-là ; une enveloppe « hors chaîne » n'est pas couverte.
    if (sortie.type !== undefined && sortie.type !== 'ed25519') refuser('type de signature');
    if (sortie.format !== undefined && sortie.format !== null) refuser('format du message');
    const signataire = adresseValide(sortie.adresse);
    if (!signataire) refuser('adresse');
    let annoncee, signe, signature;
    try {
      annoncee = contrat.deB64u(sortie.clePublique, 32);
      if (sortie.messageSigne.length > 2800 || !TEXTE.test(sortie.messageSigne)) refuser('forme');
      signe = contrat.deB64u(sortie.messageSigne);
      signature = contrat.deB64u(sortie.signature, 64);
    } catch (e) { if (e instanceof contrat.Refus && e.name === 'ConnexionRefusee') throw e; refuser('forme'); }
    // La clé publique annoncée par le wallet est celle de l'adresse : une seule clé, celle qui vérifiera.
    if (!memes(annoncee, signataire)) refuser('cle publique');
    // 2. La tentative rangée, et ce pour quoi elle a été préparée.
    const attente = await stockage.lireWallet(tentative);
    if (!attente || typeof attente.nonce !== 'string' || !NONCE.test(attente.nonce) || !Number.isSafeInteger(attente.emis) || !Number.isSafeInteger(attente.expire)) refuser('tentative inconnue ou expiree');
    let c;
    try { c = JSON.parse(attente.champs); } catch (_) { refuser('tentative illisible'); }
    if (!c || c.but !== but) refuser('but');
    if ((c.compte || null) !== (compte || null)) refuser('contexte');
    // Le wallet attendu : celui écrit dans la demande, et celui que la base du jeu donne maintenant.
    if (c.wallet && sortie.adresse !== c.wallet) throw new contrat.Refus('AutreWallet');
    if (walletAttendu !== undefined && walletAttendu !== null && sortie.adresse !== walletAttendu) throw new contrat.Refus('AutreWallet');
    // 3. Le texte attendu, reconstruit ici, et l'égalité stricte des octets signés.
    const attendu = new TextEncoder().encode(texteSiws({ domain: c.domaine, address: sortie.adresse, statement: c.phrase, uri: c.page,
      version: '1', chainId: c.reseau, nonce: attente.nonce, issuedAt: iso(attente.emis), expirationTime: iso(attente.expire) }));
    if (!memes(attendu, signe)) refuser('texte');
    // 4. La signature, par la clé de l'adresse, sur ces octets-là.
    if (!(await contrat.verifierSignature(signataire, signature, signe))) refuser('signature');
    // 5. Consommer la tentative. Le stockage juge lui-même, dans la suppression, qu'elle n'a pas expiré ; une seule
    //    des demandes arrivées ensemble passe ici.
    if ((await stockage.consommerWallet({ tentative, nonce: attente.nonce })) !== true) refuser('expire ou deja utilise');
    return { adresse: sortie.adresse };
  }

  // Une connexion par le wallet seul. Au serveur du jeu de retrouver ensuite le compte lié à ce wallet (`liens.compteDe`)
  // et d'ouvrir sa session ; un wallet inconnu ne crée pas un compte à lui seul si le jeu ne le veut pas.
  async function conclureConnexion(tentative, sortie, options) {
    return verifierPuisConsommer(tentative, sortie, 'connexion', null, options && options.walletAttendu);
  }

  // Lier ce wallet à un compte que le jeu a déjà reconnu LUI-MÊME (sa session), après une confirmation claire du
  // joueur. `compte` vient du serveur, jamais de la page, et doit être celui de la préparation. Mêmes règles que
  // `conclurePourCompte` : un compte qui a déjà un wallet ne se connecte qu'avec celui-là, rien n'est jamais remplacé,
  // un wallet déjà lié à un autre compte ne lie personne, et `premierLien` n'est vrai que pour l'écriture qui a créé
  // le lien.
  async function conclureAssociation(tentative, sortie, { compte, liens }) {
    if (typeof compte !== 'string' || !compte) refuser('compte');
    const deja = await liens.walletDe(compte);
    const { adresse } = await verifierPuisConsommer(tentative, sortie, 'association', compte, deja);
    if (deja) return { adresse, premierLien: false };
    const lie = await liens.lierUneFois(compte, adresse);
    if (!lie || lie.adresse !== adresse) throw new contrat.Refus('AutreWallet');
    return { adresse, premierLien: lie.ecrit === true };
  }

  return { preparer, conclureConnexion, conclureAssociation };
}

// Un stockage en mémoire, pour les essais et le faux jeu. Un vrai serveur utilise sa base, et l'horloge de sa base.
// `horloge` est une fonction, lue à l'instant de chaque opération (par défaut : l'heure de la machine).
export function stockageEnMemoire(horloge) {
  const maintenant = horloge || (() => Math.floor(Date.now() / 1000));
  const defis = new Map();
  const wallets = new Map();
  return {
    // Les tentatives de connexion par un wallet existant : mêmes règles, une heure lue à chaque opération.
    async poserWallet({ tentative, nonce, duree, champs }) {
      const t = maintenant();
      for (const [cle, w] of wallets) if (!(w.expire > t)) wallets.delete(cle);
      wallets.set(tentative, { nonce, emis: t, expire: t + duree, champs });
      return { emis: t };
    },
    async lireWallet(tentative) { const w = wallets.get(tentative); return w && w.expire > maintenant() ? { nonce: w.nonce, emis: w.emis, expire: w.expire, champs: w.champs } : null; },
    async consommerWallet({ tentative, nonce }) {
      const w = wallets.get(tentative);
      if (!w || w.nonce !== nonce || !(w.expire > maintenant())) return false;
      wallets.delete(tentative);
      return true;
    },
    async poser({ tentative, defi, duree, contexte }) {
      const t = maintenant();
      for (const [cle, d] of defis) if (!(d.expire > t)) defis.delete(cle);
      defis.set(tentative, { defi, expire: t + duree, contexte: contexte || null });
    },
    async lire(tentative) { const d = defis.get(tentative); return d && d.expire > maintenant() ? { defi: d.defi, contexte: d.contexte } : null; },
    async consommer({ tentative, defi, avant }) {
      const d = defis.get(tentative), t = maintenant();
      if (!d || d.defi !== defi || !(d.expire > t) || !(avant > t)) return false;
      defis.delete(tentative);
      return true;
    },
  };
}
