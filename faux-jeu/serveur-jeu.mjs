// Le côté « serveur du jeu » : ce que le serveur d'un studio fait d'une preuve de connexion. Aucune dépendance.
// Un exemple complet et court, fait pour être repris tel quel. Les règles qui comptent sont ici ; le stockage est
// une interface à trois fonctions, que le studio branche sur sa propre base.
//
//   import * as contrat from './contrat.mjs';
//   const connexion = connexionServeurJeu({ contrat, service: 'https://…', jeu: 'https://…', stockage });
//
//   1. Le joueur clique « Se connecter ». Le serveur tire un défi pour CETTE tentative (l'identifiant de la session
//      d'avant connexion, que le serveur a lui-même donné à ce navigateur) :
//        const { defi } = await connexion.nouveauDefi(tentative);
//   2. La page du jeu ouvre la fenêtre du coffre avec ce défi (coffre-jeu.mjs), puis renvoie la réponse au serveur.
//   3. Le serveur conclut. Alors seulement il ouvre la session du joueur :
//        const { adresse } = await connexion.conclure(tentative, reponse, { walletAttendu });
//
// Les règles tenues ici :
//   - le défi est tiré par le serveur, au hasard, pour une tentative précise, et vit cinq minutes ;
//   - une preuve n'est acceptée que dans la tentative pour laquelle son défi a été tiré : la preuve d'un autre
//     joueur, ou d'une autre tentative, ne connecte personne ;
//   - la preuve est vérifiée en entier AVANT de toucher au défi, et le défi n'est consommé qu'une fois, même si deux
//     demandes arrivent ensemble : c'est `stockage.consommer` qui le garantit, par une suppression conditionnelle ;
//   - `walletAttendu` vient de la base du jeu (le wallet déjà lié à ce compte), jamais de la page ni de la preuve.
//     Une connexion ne remplace jamais le wallet lié à un compte.
//
// Ce que la preuve établit : celui qui répond tient la clé de ce wallet, maintenant, pour ce jeu et ce défi.
// Ce qu'elle n'établit pas : qui est le joueur (son e-mail), qu'il vient de faire Face ID, ni que son coffre est
// gardé par le service. C'est une preuve de possession du wallet, rien de plus : elle ne doit donner aucun droit
// de dépense à elle seule.
//
// Le stockage, à brancher sur la base du jeu :
//   poser({ tentative, defi, expire })            garde le défi de cette tentative (un seul à la fois par tentative)
//   lire(tentative)                               rend { defi, expire } ou rien
//   consommer({ tentative, defi, maintenant })    supprime ce défi s'il est là, pour cette tentative, pas expiré ;
//                                                 rend vrai UNE SEULE FOIS. En SQL : une seule instruction
//                                                 DELETE … WHERE tentative = ? AND defi = ? AND expire > ?
//                                                 et l'on regarde si une ligne a été supprimée.

export const DUREE_DEFI_JEU = 300;   // secondes
const TENTATIVE = /^[A-Za-z0-9_-]{16,128}$/;
const TEXTE = /^[A-Za-z0-9_-]{1,8000}$/;

export function connexionServeurJeu({ contrat, service, jeu, stockage, horloge, duree }) {
  const maintenant = horloge || (() => Math.floor(Date.now() / 1000));
  const vie = duree || DUREE_DEFI_JEU;
  const refuser = (detail) => { throw new contrat.Refus('ConnexionRefusee', detail); };

  async function nouveauDefi(tentative) {
    if (typeof tentative !== 'string' || !TENTATIVE.test(tentative)) refuser('tentative');
    const defi = contrat.b64u(crypto.getRandomValues(new Uint8Array(32)));
    await stockage.poser({ tentative, defi, expire: maintenant() + vie });
    return { defi, duree: vie };
  }

  async function conclure(tentative, reponse, options) {
    const t = maintenant();
    if (typeof tentative !== 'string' || !TENTATIVE.test(tentative)) refuser('tentative');
    if (!reponse || typeof reponse !== 'object' || typeof reponse.message !== 'string' || !TEXTE.test(reponse.message)
      || typeof reponse.signature !== 'string' || !TEXTE.test(reponse.signature)) refuser('forme');
    const attente = await stockage.lire(tentative);
    if (!attente || !(attente.expire > t)) refuser('defi');
    // 1. Tout vérifier, avec ce que le serveur sait lui-même : son adresse, celle du coffre, le défi de cette tentative.
    const v = await contrat.verifierConnexionJeu({ message: contrat.deB64u(reponse.message), signature: contrat.deB64u(reponse.signature, 64) },
      { service, jeu, defi: attente.defi, maintenant: t });
    if (reponse.adresse !== undefined && reponse.adresse !== v.adresse) refuser('adresse');
    const attendu = options && options.walletAttendu;
    if (attendu !== undefined && attendu !== null && v.adresse !== attendu) throw new contrat.Refus('AutreWallet');
    // 2. Puis consommer le défi. Une seule des demandes arrivées ensemble passe ici.
    if ((await stockage.consommer({ tentative, defi: attente.defi, maintenant: t })) !== true) refuser('defi deja utilise');
    // 3. Au serveur du jeu d'ouvrir sa session pour ce wallet.
    return { adresse: v.adresse };
  }

  return { nouveauDefi, conclure };
}

// Un stockage en mémoire, pour les essais et le faux jeu. Un vrai serveur utilise sa base.
export function stockageEnMemoire() {
  const defis = new Map();
  return {
    async poser({ tentative, defi, expire }) { defis.set(tentative, { defi, expire }); },
    async lire(tentative) { const d = defis.get(tentative); return d ? { defi: d.defi, expire: d.expire } : null; },
    async consommer({ tentative, defi, maintenant }) {
      const d = defis.get(tentative);
      if (!d || d.defi !== defi || !(d.expire > maintenant)) return false;
      defis.delete(tentative);
      return true;
    },
  };
}
