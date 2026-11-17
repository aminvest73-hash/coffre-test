// Ce que la page sait d'elle-même. Rien ici ne vient du serveur. Fichier écrit par assembler.mjs.
export const REGLAGES = {
  version: 'en ligne 9',
  api: "https://coffre-serveur-test.aminvest73.workers.dev",
  rpId: "aminvest73-hash.github.io",
  environnement: 'essai',
  projet: 'essai',
  langue: 'fr',
  jeux: {"https://raw.githack.com":"Faux jeu (essai)","https://staging.monstermine.io":"MonsterMine (essai)","https://www.monstermine.io":"MonsterMine"},
  identite: 'email',
  recuperation: 'email',
  portes: ["google"],
  adresseIdentite: "https://coffre-serveur-test.aminvest73.workers.dev",
  // Les fiches d'opérations des jeux : tenues ici, jamais reçues du jeu (operation.mjs).
  operations: {"https://raw.githack.com":{"v":1,"version":1,"reseau":"devnet","programmes":["9bwDcSRt76qhidQoYbaZHKgJZVjShHCvZwYukAE6kEtZ"],"signataires":{"admin":"DNuXmBjpWxztmiQjAq1LkaQPYvQVD16cDHYmVYPikTr8","payeur":"CfzXrUGXnGmU5ExPka6AiGTJoC7P9HASshWAS4u6PAuE"},"envoiLibre":true,"operations":{"ouvrir-coffre-essai":{"version":1,"texte":"Ouvrir un coffre (essai)","frais":"payeur","wallet":"ecriture","signataires":["admin","payeur"],"neufs":[1,1],"instructions":[{"genre":"avance","de":"payeur","max":"5000000"},{"genre":"programme","programme":"9bwDcSRt76qhidQoYbaZHKgJZVjShHCvZwYukAE6kEtZ","debut":"fe13031f0cf1b0c9","donnees":[8,8],"comptes":[10,10],"joueur":[0],"studio":{"1":"admin"},"neufs":[3],"fixes":{"2":"25CHZzn3Fa2ZfAckWTYsg9Gru8bcRmp29hZ4qjtYyoZ2","5":"57VDHHwK4vG4LVYQXRDMzP5RxqNj81AV7yo8Wv6uAwJv","6":"4jpto1ouvahgwAgW8veTAw3MQWxqjDtbSX5u2GNVBE1K","7":"11111111111111111111111111111111","8":"7UNM22VGWMKVR9jgF3TRf43XZ1Ed4aPUcgRqsuqHzmnB","9":"3r4VLY92hTSH2ny7rXBxTQwPcu4UheVympBgKBsaNDHY"}}]},"reclamer-cadeau-essai":{"version":1,"texte":"Réclamer mon cadeau (essai)","frais":"payeur","wallet":"lecture","signataires":["payeur"],"neufs":[0,0],"instructions":[{"genre":"programme","programme":"9bwDcSRt76qhidQoYbaZHKgJZVjShHCvZwYukAE6kEtZ","debut":"93225aa507e7dd43","donnees":[9,9],"comptes":[3,3],"joueur":[0],"studio":{"2":"payeur"},"arguments":[{"place":8,"taille":1,"min":"1","max":"4"}],"fois":[1,4]}]}}}},
};
