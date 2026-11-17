// La fiche d'essai du faux jeu : ce qu'un studio déclarerait chez nous pour que la fenêtre du coffre accepte de faire
// signer deux opérations de son propre programme.
//
// TOUT EST FAUX ICI, ET RIEN N'EST SECRET. Le « programme », les « collections », le « compteur » et les deux autres
// « programmes fixes » sont des empreintes de noms (SHA-256 de « faux-jeu/fiche-essai/<nom> ») : des adresses dont
// personne n'a la clé. Les clés « admin » et « payeur » du faux studio sont de vraies paires de clés, pour que le faux
// jeu puisse cosigner ses transactions comme le ferait un serveur de jeu ; mais leur graine est l'empreinte d'un nom
// écrit ici en clair (`GRAINES_DU_FAUX_STUDIO`) : n'importe qui peut les refaire. Elles ne protègent rien et ne
// doivent jamais servir ailleurs. Rien de ce que le faux jeu fait signer avec cette fiche n'est diffusé.
//
// Ce fichier est la seule source de cette fiche : le faux jeu s'en sert pour construire ses transactions (demo.mjs),
// et la page du coffre la reçoit dans ses réglages (le lanceur local l'y pose ; `assembler.mjs --fiche-essai` aussi).
// Une vraie fiche est tenue par nous, relue, numérotée, et posée dans les réglages de la page : jamais envoyée par
// le jeu. Sa forme est décrite dans operation.mjs (« La lecture par gabarit »).

// Les noms dont l'empreinte (SHA-256) est la graine de chaque clé du faux studio. Publics : ce ne sont pas des secrets.
export const GRAINES_DU_FAUX_STUDIO = Object.freeze({ admin: 'faux-jeu/fiche-essai/cle/admin', payeur: 'faux-jeu/fiche-essai/cle/payeur' });

const PROGRAMME = '9bwDcSRt76qhidQoYbaZHKgJZVjShHCvZwYukAE6kEtZ';
const SYSTEME = '11111111111111111111111111111111';

export const FICHE_ESSAI = {
  v: 1,
  version: 1,
  reseau: 'devnet',
  programmes: [PROGRAMME],
  signataires: { admin: 'DNuXmBjpWxztmiQjAq1LkaQPYvQVD16cDHYmVYPikTr8', payeur: 'CfzXrUGXnGmU5ExPka6AiGTJoC7P9HASshWAS4u6PAuE' },
  // Le faux jeu garde aussi son essai « Envoyer 0,001 SOL » : sa fiche le dit. Sans cette ligne, un jeu qui a une
  // fiche ne peut demander que ses opérations nommées.
  envoiLibre: true,
  operations: {
    // La forme d'une ouverture de coffre telle qu'un jeu la fait : le payeur du jeu paie les frais et avance un peu de
    // SOL au joueur, puis une instruction du programme (huit octets, aucun argument, dix comptes) est signée par le
    // joueur, l'admin et la clé jetable de l'objet créé. Le prix serait calculé dans le programme : il n'est pas lisible.
    'ouvrir-coffre-essai': {
      version: 1,
      texte: 'Ouvrir un coffre (essai)',
      frais: 'payeur',
      wallet: 'ecriture',
      signataires: ['admin', 'payeur'],
      neufs: [1, 1],
      instructions: [
        { genre: 'avance', de: 'payeur', max: '5000000' },
        { genre: 'programme', programme: PROGRAMME, debut: 'fe13031f0cf1b0c9', donnees: [8, 8], comptes: [10, 10],
          joueur: [0], studio: { 1: 'admin' }, neufs: [3],
          fixes: { 2: '25CHZzn3Fa2ZfAckWTYsg9Gru8bcRmp29hZ4qjtYyoZ2', 5: '57VDHHwK4vG4LVYQXRDMzP5RxqNj81AV7yo8Wv6uAwJv', 6: '4jpto1ouvahgwAgW8veTAw3MQWxqjDtbSX5u2GNVBE1K',
            7: SYSTEME, 8: '7UNM22VGWMKVR9jgF3TRf43XZ1Ed4aPUcgRqsuqHzmnB', 9: '3r4VLY92hTSH2ny7rXBxTQwPcu4UheVympBgKBsaNDHY' } },
      ],
    },
    // Plus simple : le joueur signe en lecture seule (le réseau ne peut pas faire baisser son solde en SOL), le payeur
    // du jeu paie les frais, et le programme est appelé une fois par cadeau (une à quatre fois). Son seul argument,
    // un octet, est le numéro du cadeau : de 1 à 4.
    'reclamer-cadeau-essai': {
      version: 1,
      texte: 'Réclamer mon cadeau (essai)',
      frais: 'payeur',
      wallet: 'lecture',
      signataires: ['payeur'],
      neufs: [0, 0],
      instructions: [
        { genre: 'programme', programme: PROGRAMME, debut: '93225aa507e7dd43', donnees: [9, 9], comptes: [3, 3],
          joueur: [0], studio: { 2: 'payeur' }, arguments: [{ place: 8, taille: 1, min: '1', max: '4' }], fois: [1, 4] },
      ],
    },
  },
};
