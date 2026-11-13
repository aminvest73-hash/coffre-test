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
//                                       déjà vérifiée) n'est pas franchie non plus ; rend vrai UNE SEULE FOIS. En SQL,
//                                       une seule instruction, et l'on regarde si une ligne a été supprimée :
//                                       DELETE … WHERE tentative = ? AND defi = ? AND expire > unixepoch() AND ? > unixepoch()

export const DUREE_DEFI_JEU = 300;   // secondes
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

  return { nouveauDefi, conclure, conclurePourCompte };
}

// Un stockage en mémoire, pour les essais et le faux jeu. Un vrai serveur utilise sa base, et l'horloge de sa base.
// `horloge` est une fonction, lue à l'instant de chaque opération (par défaut : l'heure de la machine).
export function stockageEnMemoire(horloge) {
  const maintenant = horloge || (() => Math.floor(Date.now() / 1000));
  const defis = new Map();
  return {
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
