// Ce que la page sait d'elle-même. Rien ici ne vient du serveur. Fichier écrit par assembler.mjs.
export const REGLAGES = {
  version: 'en ligne 10',
  api: "https://coffre-serveur-test.aminvest73.workers.dev",
  rpId: "aminvest73-hash.github.io",
  environnement: 'essai',
  projet: 'essai',
  langue: 'fr',
  jeux: {"https://www.monstermine.io":"MonsterMine"},
  identite: 'email',
  recuperation: 'email',
  portes: ["google"],
  adresseIdentite: "https://coffre-serveur-test.aminvest73.workers.dev",
  // Les fiches d'opérations des jeux : tenues ici, jamais reçues du jeu (operation.mjs).
  operations: {"https://www.monstermine.io":{"v":1,"version":1,"reseau":"mainnet","programmes":["3vuCurogVkzAy6gQv9HRL8qW4MZn5UAyoWpunGtHBJ7D"],"signataires":{"admin":"As1qopTAVVZJmiE4xjqtXeQqsJPiRv9GKet4VK6D82j2","payeur":"BC6YGzjhnE3yGkhTsGav8jpGhjpFUDoKDiGm1CzvdVdW"},"operations":{"cadeau-vagazor":{"version":1,"texte":"Recevoir ton cadeau : Vagazor","frais":"payeur","wallet":"ecriture","signataires":["admin","payeur"],"neufs":[1,1],"instructions":[{"genre":"avance","de":"payeur","max":"21000000"},{"genre":"programme","programme":"3vuCurogVkzAy6gQv9HRL8qW4MZn5UAyoWpunGtHBJ7D","debut":"fb8c370681922f03","donnees":[40,40],"comptes":[7,7],"joueur":[0],"studio":{"1":"admin"},"neufs":[3],"fixes":{"2":"3SdKWrtV4dMW2TArMetkZ9mJrrvVvFPb9Nve6oXS9Mnj","5":"CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d","6":"11111111111111111111111111111111"},"arguments":[{"place":8,"octets":"1c00000068747470733a2f2f6d656469612e6d6f6e737465726d696e652e696f"}]}]}}}},
};
