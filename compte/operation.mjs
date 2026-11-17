// Lire une opération avant de la signer : à partir des octets d'un message de transaction Solana, dire exactement
// ce qui sortirait du wallet du joueur, ou refuser. Le coffre ne signe que ce que cette pièce comprend en entier.
// Aucune dépendance (le base58 et la classe des refus viennent de contrat.mjs). Le même fichier sert à la page et
// aux essais. Rien n'est reconstruit ici : les octets à signer sont ceux qui ont été reçus, tels quels.
//
// Ce qui est compris, et rien d'autre :
//   - le message à l'ancien format, et la version 0 SANS table d'adresses ;
//   - une ou deux signatures exigées : le joueur, et au plus un autre signataire (le payeur des frais du studio) ;
//   - le programme système, instruction 2 : un transfert de SOL ;
//   - le programme de jetons classique, instruction 12 (« TransferChecked ») : un transfert de jeton qui dit quel
//     jeton et combien de décimales. Le transfert simple (3) ne le dit pas : refusé. Token-2022 : refusé ;
//   - le budget de calcul : la limite d'unités (2) et le prix de l'unité (3), au plus une fois chacune.
// Toute autre chose est refusée, avec un nom pris dans REFUS_OPERATION.
//
// L'ordre des contrôles (une seconde lecture, en Python, suit le même : compte/essais/reference-operation.py) :
//   1. les octets et l'adresse du wallet ; la version ; l'en-tête ; la taille ; les clés (pas de double) ; le hachage ;
//      les instructions (index dans les bornes) ; pas de table d'adresses ; aucun octet en trop ;
//   2. le wallet du joueur est signataire ;
//   3. chaque instruction, dans l'ordre : programme connu, appelé sans être signataire ni inscriptible, puis sa règle ;
//   4. le budget (un prix demande une limite ; plafond des frais de priorité) ; aucune clé inutile ; au moins un
//      transfert.
//
// Les limites, dites : cette pièce lit un message, elle n'interroge pas la blockchain. Elle dit quel compte de jeton
// reçoit, pas à qui ce compte appartient ; elle ne sait pas si le compte source appartient au joueur (le programme
// de jetons exige que l'autorité, ici le joueur ou le payeur, en soit le propriétaire ou le délégué) ; elle ne dit
// pas si la transaction réussira. Les identifiants de programmes et la forme des données sont ceux des programmes
// publiés ; les frais de base (5 000 lamports par signature) sont une valeur du réseau, écrite ici en constante.

import { Refus, base58, deBase58, verifierSignature } from './contrat.mjs';

const refuser = (nom, detail) => { throw new Refus(nom, detail); };

export const REFUS_OPERATION = Object.freeze([
  'WalletRefuse',           // l'adresse du wallet donnée par l'appelant n'est pas une adresse
  'MessageRefuse',          // pas des octets, tronqué, octets en trop, trop long, nombres de clés ou d'instructions hors bornes
  'LongueurNonCanonique',   // une longueur écrite autrement que de sa seule façon la plus courte
  'VersionRefusee',         // une version de message autre que l'ancien format et la version 0
  'TableAdresses',          // une table d'adresses : des comptes que le message ne montre pas
  'SignatairesRefuses',     // aucune signature, plus de deux, ou un payeur des frais en lecture seule
  'ClesEnDouble',           // la même clé deux fois dans la liste
  'IndexHorsBornes',        // une instruction désigne une clé qui n'existe pas
  'SignataireAbsent',       // le wallet du joueur n'est pas un signataire de ce message
  'ProgrammeInconnu',       // un programme hors du catalogue
  'Token2022',              // le programme de jetons à extensions
  'ProgrammeRefuse',        // un programme du catalogue, mais listé comme signataire ou inscriptible
  'InstructionRefusee',     // une instruction hors du catalogue, ou qui n'a pas exactement la forme attendue
  'NonceDurable',           // « avancer un nonce » : une transaction qui ne périme pas
  'TransfertSimple',        // un transfert de jeton qui ne dit pas quel jeton
  'SourceRefusee',          // ce qui est débité n'est ni le joueur ni le payeur, ou n'a pas le rôle attendu
  'AutoriteRefusee',        // celui qui autorise le transfert de jeton n'est ni le joueur ni le payeur
  'DestinationRefusee',     // le destinataire est la source, ou n'a pas le rôle attendu
  'MontantRefuse',          // un transfert de zéro
  'BudgetRefuse',           // budget de calcul en double, inconnu, hors plafond, ou prix sans limite
  'CleInutile',             // une clé que personne ne signe et qu'aucune instruction n'utilise
  'OperationVide',          // aucun transfert : rien à montrer au joueur
]);

export const PROGRAMME_SYSTEME = '11111111111111111111111111111111';
export const PROGRAMME_JETONS = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
export const PROGRAMME_JETONS_2022 = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
export const PROGRAMME_BUDGET = 'ComputeBudget111111111111111111111111111111';

export const TAILLE_TRANSACTION = 1232;      // octets : la transaction entière, signatures comprises
export const SIGNATURES_MAX = 2;             // le joueur, et au plus le payeur du studio
export const CLES_MAX = 32;
export const INSTRUCTIONS_MAX = 12;
export const UNITES_MAX = 1400000;           // la limite d'unités de calcul que le réseau admet pour une transaction
export const PRIORITE_MAX = 1000000n;        // lamports (0,001 SOL) : le plus que les frais de priorité peuvent coûter
export const FRAIS_PAR_SIGNATURE = 5000n;    // lamports

// ---------- La lecture des octets. Chaque lecture refuse plutôt que de deviner.

function lecteur(o) {
  let i = 0;
  const octet = () => { if (i >= o.length) refuser('MessageRefuse', 'tronque'); return o[i++]; };
  return {
    octet,
    bloc(n) { if (o.length - i < n) refuser('MessageRefuse', 'tronque'); const b = o.subarray(i, i + n); i += n; return b; },
    // Une longueur « compacte » : sept bits par octet, du plus faible au plus fort, trois octets au plus, seize bits
    // au plus. Une seule écriture est admise par valeur : la plus courte.
    compact() {
      let v = 0;
      for (let k = 0; k < 3; k++) {
        const x = octet();
        if (k === 2 && x > 3) refuser('LongueurNonCanonique');
        v |= (x & 0x7f) << (7 * k);
        if (!(x & 0x80)) { if (k > 0 && x === 0) refuser('LongueurNonCanonique'); return v; }
      }
      return refuser('LongueurNonCanonique');
    },
    fini: () => i === o.length,
  };
}
const u32 = (d, p) => (d[p] | (d[p + 1] << 8) | (d[p + 2] << 16)) + d[p + 3] * 16777216;
function u64(d, p) { let n = 0n; for (let k = 7; k >= 0; k--) n = n * 256n + BigInt(d[p + k]); return n; }

// La forme d'un message, lue en entier ou refusée : la version, l'en-tête, la taille, les clés (pas de double), le
// hachage, les instructions (index dans les bornes), pas de table d'adresses, aucun octet en trop. `signaturesMax` :
// le plus de signatures que l'appelant admet. Sert à la lecture commune et à la lecture par gabarit.
function forme(octets, signaturesMax) {
  if (!(octets instanceof Uint8Array) || !octets.length) refuser('MessageRefuse', 'octets');
  const L = lecteur(octets);
  let version = 'ancien', premier = L.octet();
  if (premier & 0x80) {
    if ((premier & 0x7f) !== 0) refuser('VersionRefusee');
    version = 0; premier = L.octet();
  }
  const nSig = premier, nLectureSig = L.octet(), nLectureAutres = L.octet();
  if (nSig < 1 || nSig > signaturesMax) refuser('SignatairesRefuses', 'nombre');
  if (nLectureSig >= nSig) refuser('SignatairesRefuses', 'payeur en lecture seule');
  if (octets.length + 1 + 64 * nSig > TAILLE_TRANSACTION) refuser('MessageRefuse', 'taille');
  const nCles = L.compact();
  if (nCles < nSig || nCles > CLES_MAX || nLectureAutres > nCles - nSig) refuser('MessageRefuse', 'cles');
  const cles = [];
  for (let k = 0; k < nCles; k++) cles.push(base58(L.bloc(32)));
  if (new Set(cles).size !== nCles) refuser('ClesEnDouble');
  const hachage = base58(L.bloc(32));
  const nInstructions = L.compact();
  if (nInstructions < 1 || nInstructions > INSTRUCTIONS_MAX) refuser('MessageRefuse', 'instructions');
  const instructions = [];
  for (let k = 0; k < nInstructions; k++) {
    const programme = L.octet();
    const comptes = Array.from(L.bloc(L.compact()));
    const donnees = L.bloc(L.compact());
    if (programme >= nCles || comptes.some((c) => c >= nCles)) refuser('IndexHorsBornes');
    instructions.push({ programme, comptes, donnees });
  }
  if (version === 0 && L.compact() !== 0) refuser('TableAdresses');
  if (!L.fini()) refuser('MessageRefuse', 'octets en trop');
  const signe = (k) => k < nSig;
  const inscriptible = (k) => k < nSig - nLectureSig || (k >= nSig && k < nCles - nLectureAutres);
  return { version, nSig, nCles, cles, hachage, instructions, signe, inscriptible };
}

// ---------- lireOperation(octets, { wallet })
// `octets` : le message à signer (pas la transaction : sans les signatures). `wallet` : l'adresse du joueur.
// Rend, ou refuse :
//   { version: 'ancien' | 0, signatures: 1 | 2,
//     payeur,            l'adresse qui paie les frais du réseau (la première clé)
//     joueurPaie,        vrai si c'est le joueur
//     autre,             l'autre signataire, ou null
//     hachage,           le hachage récent du message (ce qui le fait périmer)
//     sorties,           ce qui sort du wallet du joueur, dans l'ordre des instructions
//     sortiesPayeur,     ce qui sort du payeur quand ce n'est pas le joueur
//     frais: { base, unites, prix, prioriteMax } }
// Une sortie : { genre: 'sol', vers, lamports } ou { genre: 'jeton', source, jeton, vers, montant, decimales }.
// Les montants sont des chaînes de chiffres (des entiers exacts), jamais des nombres à virgule.
export function lireOperation(octets, options) {
  if (!(octets instanceof Uint8Array) || !octets.length) refuser('MessageRefuse', 'octets');
  const wallet = options && options.wallet;
  try { deBase58(wallet, 32); } catch (_) { refuser('WalletRefuse'); }

  // 1. La forme.
  const { version, nSig, nCles, cles, hachage, instructions, signe, inscriptible } = forme(octets, SIGNATURES_MAX);

  // 2. Le joueur signe.
  const joueur = cles.indexOf(wallet);
  if (joueur < 0 || !signe(joueur)) refuser('SignataireAbsent');
  const autre = nSig === 2 ? cles[joueur === 0 ? 1 : 0] : null;

  // 3. Le catalogue.
  const sorties = [], sortiesPayeur = [], utilisees = new Set();
  let unites = null, prix = null;
  // Ce qui est débité l'est au joueur, ou au payeur des frais (la clé 0) ; à personne d'autre.
  const debiteur = (k) => k === joueur || k === 0;
  const noter = (k, sortie) => (k === joueur ? sorties : sortiesPayeur).push(sortie);
  for (const { programme, comptes, donnees: d } of instructions) {
    const p = cles[programme];
    if (p === PROGRAMME_JETONS_2022) refuser('Token2022');
    if (p !== PROGRAMME_SYSTEME && p !== PROGRAMME_JETONS && p !== PROGRAMME_BUDGET) refuser('ProgrammeInconnu');
    if (signe(programme) || inscriptible(programme)) refuser('ProgrammeRefuse');
    utilisees.add(programme);
    for (const c of comptes) utilisees.add(c);

    if (p === PROGRAMME_BUDGET) {
      if (comptes.length || !d.length) refuser('BudgetRefuse', 'forme');
      if (d[0] === 2 && d.length === 5 && unites === null) {
        unites = u32(d, 1);
        if (unites < 1 || unites > UNITES_MAX) refuser('BudgetRefuse', 'unites');
      } else if (d[0] === 3 && d.length === 9 && prix === null) prix = u64(d, 1);
      else refuser('BudgetRefuse', 'instruction');
    } else if (p === PROGRAMME_SYSTEME) {
      if (d.length < 4) refuser('InstructionRefusee', 'systeme');
      const quoi = u32(d, 0);
      if (quoi === 4) refuser('NonceDurable');
      if (quoi !== 2 || d.length !== 12 || comptes.length !== 2) refuser('InstructionRefusee', 'systeme');
      const [de, vers] = comptes;
      if (!signe(de) || !inscriptible(de) || !debiteur(de)) refuser('SourceRefusee');
      if (vers === de || !inscriptible(vers)) refuser('DestinationRefusee');
      const lamports = u64(d, 4);
      if (lamports === 0n) refuser('MontantRefuse');
      noter(de, { genre: 'sol', vers: cles[vers], lamports: String(lamports) });
    } else {
      if (!d.length) refuser('InstructionRefusee', 'jetons');
      if (d[0] === 3) refuser('TransfertSimple');
      // Quatre comptes exactement : un cinquième serait un signataire d'une autorité à plusieurs clés.
      if (d[0] !== 12 || d.length !== 10 || comptes.length !== 4) refuser('InstructionRefusee', 'jetons');
      const [source, jeton, vers, autorite] = comptes;
      if (!signe(autorite) || !debiteur(autorite)) refuser('AutoriteRefusee');
      if (signe(source) || !inscriptible(source)) refuser('SourceRefusee');
      if (vers === source || signe(vers) || !inscriptible(vers)) refuser('DestinationRefusee');
      if (jeton === source || jeton === vers || signe(jeton)) refuser('InstructionRefusee', 'jeton');
      const montant = u64(d, 1);
      if (montant === 0n) refuser('MontantRefuse');
      noter(autorite, { genre: 'jeton', source: cles[source], jeton: cles[jeton], vers: cles[vers], montant: String(montant), decimales: d[9] });
    }
  }

  // 4. Le reste.
  // Sans limite d'unités, ce que coûte un prix ne se borne pas simplement : un prix demande une limite.
  if (prix !== null && unites === null) refuser('BudgetRefuse', 'prix sans limite');
  const priorite = prix === null ? 0n : (prix * BigInt(unites) + 999999n) / 1000000n;   // en lamports, arrondi au-dessus
  if (priorite > PRIORITE_MAX) refuser('BudgetRefuse', 'plafond');
  for (let k = nSig; k < nCles; k++) if (!utilisees.has(k)) refuser('CleInutile');
  if (!sorties.length && !sortiesPayeur.length) refuser('OperationVide');

  return { version, signatures: nSig, payeur: cles[0], joueurPaie: joueur === 0, autre, hachage, sorties, sortiesPayeur,
    frais: { base: String(FRAIS_PAR_SIGNATURE * BigInt(nSig)), unites, prix: prix === null ? null : String(prix), prioriteMax: String(priorite) } };
}

// ---------- La première tranche : ce que le coffre accepte de signer aujourd'hui, parmi ce qu'il sait lire.
// Seulement des envois de SOL faits par le joueur. Un transfert de jeton est lu, mais pas encore signé (la page ne
// sait pas encore dire à qui appartient le compte qui reçoit). Rien ne doit sortir d'un payeur qui n'est pas le
// joueur : la part du service viendra plus tard, avec ses propres contrôles. Rend la lecture, ou refuse.
export const REFUS_TRANCHE = Object.freeze([
  'JetonPasEncore',   // un transfert de jeton : lu, pas encore signé
  'SortiePayeur',     // quelque chose sort du payeur des frais, qui n'est pas le joueur
]);
export function premiereTranche(lecture) {
  if (!lecture || !Array.isArray(lecture.sorties) || !Array.isArray(lecture.sortiesPayeur)) refuser('MessageRefuse', 'lecture');
  if (lecture.sortiesPayeur.length) refuser('SortiePayeur');
  if (!lecture.sorties.length) refuser('OperationVide');
  for (const s of lecture.sorties) if (!s || s.genre !== 'sol') refuser('JetonPasEncore');
  return lecture;
}

// La lecture, écrite d'une seule façon : ce que la page a montré et ce qui est signé se comparent par ce texte.
// `lireOperation` construit toujours ses objets dans le même ordre : deux lectures égales donnent le même texte.
export const cleLecture = (lecture) => JSON.stringify(lecture);

// Des lamports (un texte de chiffres) écrits en SOL pour le joueur, sans nombre à virgule flottante : neuf
// décimales au plus, les zéros de fin retirés, une virgule, et une espace insécable entre les milliers.
export function enSol(lamports) {
  if (typeof lamports !== 'string' || !/^(0|[1-9][0-9]{0,19})$/.test(lamports)) refuser('MontantRefuse', 'ecriture');
  const n = BigInt(lamports), entier = String(n / 1000000000n), reste = String(n % 1000000000n).padStart(9, '0').replace(/0+$/, '');
  return entier.replace(/\B(?=(\d{3})+(?!\d))/g, ' ') + (reste ? ',' + reste : '');
}
// Le plus qui peut sortir du wallet du joueur, en lamports (un texte de chiffres) : ses envois de SOL, plus les
// frais du réseau à leur maximum quand c'est lui qui les paie.
export function totalJoueur(lecture) {
  let n = 0n;
  for (const s of lecture.sorties) if (s.genre === 'sol') n += BigInt(s.lamports);
  if (lecture.joueurPaie) n += BigInt(lecture.frais.base) + BigInt(lecture.frais.prioriteMax);
  return String(n);
}

// ---------- La lecture « par gabarit » : une opération du programme d'un studio (niveau 1).
//
// La lecture ci-dessus ne comprend que trois programmes publics. Un jeu a le sien : son serveur construit la
// transaction, la signe d'abord avec ses propres clés, et le joueur signe en dernier. Le coffre ne comprend pas ce
// que fait ce programme. Il peut en revanche exiger que le message ait EXACTEMENT la forme que le studio a déclarée
// pour une opération nommée, vérifier que les clés du studio ont bien signé ces octets-là, et refuser tout le reste.
//
// La fiche d'un jeu est tenue par nous (un réglage de la page, jamais un message du jeu). Elle dit :
//   v             1 : le format de cette fiche ;
//   version       le numéro de CETTE fiche (un entier). Une fiche qui change prend un numéro de plus ;
//   reseau        « devnet », « testnet » ou « mainnet » : le réseau pour lequel elle est écrite. C'est une
//                 déclaration : rien ici n'interroge le réseau, la page ne peut donc pas le vérifier ;
//   programmes    les programmes que ce jeu peut appeler (adresses exactes), en plus du programme système (pour les
//                 seuls transferts de SOL déclarés) et du budget de calcul ;
//   signataires   les clés publiques du studio, par nom (par exemple « admin », « payeur ») ;
//   envoiLibre    facultatif, `true` : ce jeu peut AUSSI demander un envoi de SOL ordinaire (la lecture commune, sans
//                 nom d'opération). Absent par défaut : un jeu qui a une fiche est limité à ses opérations nommées ;
//   operations    les opérations nommées. Pour chacune :
//     version       son numéro. Le jeu dit dans sa demande pour quelle version il a construit sa transaction ; si ce
//                   n'est pas celle de la fiche, refus net ;
//     texte         le nom que le joueur lira, écrit par nous à l'enregistrement, jamais par le jeu dans sa demande ;
//     frais         qui paie les frais du réseau : « joueur », ou le nom d'un signataire du studio ;
//     wallet        « lecture » : le compte du joueur doit être en lecture seule dans le message (le réseau ne peut
//                   alors pas faire baisser son solde en SOL) ; « ecriture » : il peut être inscriptible ;
//     signataires   les clés du studio qui doivent signer (toutes, et aucune autre clé du studio). AU MOINS UNE :
//                   une opération sans cosignature du studio n'existe pas, la fiche qui en déclare une est refusée ;
//     neufs         [min, max] : combien d'autres signataires sont admis (les clés jetables des objets créés) ;
//     instructions  la suite ordonnée des instructions permises. Trois genres :
//       { genre: 'avance', de, max }       un transfert de SOL d'un signataire du studio vers le joueur, plafonné
//       { genre: 'envoi', vers, max }      un transfert de SOL du joueur vers une adresse fixe (la trésorerie), plafonné
//       { genre: 'programme', programme, debut, donnees, comptes, joueur, studio, neufs, fixes, arguments, fois }
//           une instruction d'un programme déclaré : le début exact de ses données (hexadécimal), les bornes de leur
//           longueur et du nombre de comptes ; les places du joueur, des clés du studio, des signataires neufs, et
//           des comptes fixes (adresse exacte) ; `arguments` : des arguments de taille fixe, à valeur exacte ou
//           bornée ({ place, taille, min, max } : un entier non signé petit-boutiste de 1, 2, 4 ou 8 octets ;
//           { place, octets } : des octets exacts) ; `fois` : [min, max] répétitions à la suite (une fois si absent).
//           Toute autre place est un compte « libre » : il ne peut être ni le joueur, ni un signataire, ni un compte
//           fixe de cette instruction, ni la trésorerie d'un envoi déclaré : pas d'alias entre les rôles.
// Les instructions du budget de calcul sont admises partout, comme dans la lecture commune (une limite et un prix au
// plus, mêmes plafonds). Tout le reste est refusé : table d'adresses, nonce durable, Token-2022, programme non
// déclaré, instruction en plus ou en moins, signataire inconnu, clé inutile.
//
// Pour une opération nommée, le jeu envoie la TRANSACTION partiellement signée (les signatures, puis le message), pas
// le message seul : un message contient les clés des signataires attendus, pas leurs signatures, et n'importe quelle
// page peut y écrire la clé publique d'un studio. Chaque signature requise autre que celle du joueur (clés du studio
// et signataires neufs) est vérifiée ici, sur les octets exacts du message, à la place de sa clé dans l'en-tête.
//
// CE QUE CELA NE DIT PAS, écrit tel quel :
//   - une cosignature valide du studio ne dispense pas de comprendre l'opération : un studio, ou son serveur, peut
//     être piraté, et signera alors ce que le pirate lui présente ;
//   - ce que le programme du studio fait à l'intérieur n'est pas lu (un prix calculé dans le programme n'est pas dans
//     les octets, et un programme modifiable peut changer de sens sans changer d'adresse) ;
//   - un compte libre n'est pas vérifié : aucune adresse dérivée n'est recalculée ici (aucun contrôle de courbe
//     n'est écrit à la main : cette vérification attend une brique officielle).
// C'est « le coffre ne signe que ce qu'un studio enregistré a déclaré et cosigné, sous la forme déclarée », pas
// encore « le coffre ne signe que ce qu'il comprend ».

export const REFUS_GABARIT = Object.freeze([
  'FicheRefusee',             // la fiche du jeu est mal écrite : rien n'est accepté avec elle
  'EnvoiLibreRefuse',         // ce jeu a une fiche, et elle ne lui donne pas l'envoi de SOL ordinaire
  'OperationInconnue',        // ce nom n'est pas une opération de la fiche, ou la demande est mal formée
  'VersionOperationRefusee',  // le jeu a construit sa transaction pour une autre version de l'opération
  'TransactionRefusee',       // ce qui enveloppe le message (le nombre de signatures, leurs cases) n'a pas la forme attendue
  'CosignatureRefusee',       // une case de signature manque, la case du joueur n'est pas vide, ou une cosignature est fausse
  'PayeurRefuse',             // celui qui paie les frais n'est pas celui que le gabarit dit
  'WalletInscriptible',       // le gabarit veut le compte du joueur en lecture seule, le message le dit inscriptible
  'SignataireStudioAbsent',   // une clé du studio que le gabarit exige ne signe pas
  'SignataireInattendu',      // une clé du studio signe alors que le gabarit ne la nomme pas
  'SignatairesNeufsRefuses',  // trop peu de signataires neufs
  'SignataireDeplace',        // une clé du studio, ou un signataire neuf, à une place que le gabarit ne dit pas
  'JoueurDeplace',            // le wallet du joueur à une place que le gabarit ne dit pas, ou absent de la sienne
  'CompteLibreRefuse',        // un compte libre qui est aussi un compte fixe, ou la trésorerie : un alias entre rôles
  'ProgrammeNonDeclare',      // une instruction appelle un programme que la fiche ne déclare pas
  'InstructionInattendue',    // une instruction qui n'est pas celle que le gabarit attend à cet endroit, ou en trop
  'InstructionManquante',     // le message finit avant le gabarit
  'DonneesRefusees',          // les données d'une instruction déclarée n'ont pas la longueur permise
  'ArgumentRefuse',           // un argument déclaré n'a pas la valeur permise
  'ComptesRefuses',           // une instruction déclarée n'a pas le nombre de comptes permis
  'CompteFixeRefuse',         // un compte fixe du gabarit n'est pas à sa place
  'PlafondDepasse',           // un transfert de SOL déclaré dépasse son plafond
]);

const NOM_SIGNATAIRE = /^[a-z][a-z0-9-]{0,19}$/;
export const NOM_OPERATION = /^[a-z0-9]([a-z0-9-]{0,38}[a-z0-9])?$/;
export const VERSION_MAX = 999999;
const TEXTE_OPERATION = /^[\p{L}\p{N}]([\p{L}\p{N} «»()'’,.:!?%+-]{0,58}[\p{L}\p{N}»).!?%])?$/u;
const HEX_DEBUT = /^([0-9a-f]{2}){1,16}$/;
const HEX_OCTETS = /^([0-9a-f]{2}){1,64}$/;
const LAMPORTS = /^[1-9][0-9]{0,19}$/;
const ENTIER = /^(0|[1-9][0-9]{0,19})$/;
const U64_MAX = 18446744073709551615n;
const RESEAUX = ['devnet', 'testnet', 'mainnet'];
const PROGRAMMES_RESERVES = [PROGRAMME_SYSTEME, PROGRAMME_JETONS, PROGRAMME_JETONS_2022, PROGRAMME_BUDGET];
const propre = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const objetSimple = (o) => !!o && typeof o === 'object' && !Array.isArray(o) && Object.getPrototypeOf(o) === Object.prototype;
const versionValable = (n) => Number.isSafeInteger(n) && n >= 1 && n <= VERSION_MAX;
const hexDe = (o) => { let t = ''; for (const x of o) t += x.toString(16).padStart(2, '0'); return t; };

// Valider la fiche d'un jeu. Rend une copie figée, ou refuse (`FicheRefusee`). Chaque champ a une seule écriture ;
// un champ inconnu, absent ou mal écrit fait refuser la fiche entière : une fiche mal écrite n'élargit jamais ce qui
// est accepté.
export function validerFiche(fiche) {
  const non = (detail) => refuser('FicheRefusee', detail);
  const champs = (o, obligatoires, facultatifs, ou) => {
    if (!objetSimple(o)) non(ou + ' : pas un objet');
    for (const k of obligatoires) if (!propre(o, k)) non(ou + ' : il manque « ' + k + ' »');
    for (const k of Object.keys(o)) if (!obligatoires.includes(k) && !facultatifs.includes(k)) non(ou + ' : champ inconnu « ' + k + ' »');
  };
  const adresse = (a, ou) => {
    let bonne = false;
    try { bonne = typeof a === 'string' && base58(deBase58(a, 32)) === a; } catch (_) { bonne = false; }
    if (!bonne) non(ou + ' : adresse');
    return a;
  };
  const bornes = (b, min, max, ou) => {
    if (!Array.isArray(b) || b.length !== 2 || !Number.isSafeInteger(b[0]) || !Number.isSafeInteger(b[1]) || b[0] < min || b[1] > max || b[0] > b[1]) non(ou + ' : bornes [min, max]');
    return Object.freeze([b[0], b[1]]);
  };
  const lamports = (t, ou) => { if (typeof t !== 'string' || !LAMPORTS.test(t) || BigInt(t) > U64_MAX) non(ou + ' : plafond en lamports (un texte de chiffres)'); return t; };

  champs(fiche, ['v', 'version', 'reseau', 'programmes', 'signataires', 'operations'], ['envoiLibre'], 'fiche');
  if (fiche.v !== 1) non('fiche : format');
  if (!versionValable(fiche.version)) non('fiche : version');
  if (!RESEAUX.includes(fiche.reseau)) non('fiche : reseau');
  if (fiche.envoiLibre !== undefined && fiche.envoiLibre !== true) non('fiche : envoiLibre ne s\'ecrit que `true`');
  if (!Array.isArray(fiche.programmes) || fiche.programmes.length < 1 || fiche.programmes.length > 8) non('programmes : un a huit');
  const programmes = fiche.programmes.map((p, i) => adresse(p, 'programmes[' + i + ']'));
  if (new Set(programmes).size !== programmes.length) non('programmes : un double');
  // Les programmes publics ne se déclarent pas : le programme système ne sert qu'aux transferts déclarés, le budget
  // est lu comme partout, et les programmes de jetons ne passent pas par un gabarit.
  if (programmes.some((p) => PROGRAMMES_RESERVES.includes(p))) non('programmes : un programme public ne se declare pas');

  if (!objetSimple(fiche.signataires) || Object.keys(fiche.signataires).length > 8) non('signataires : un objet de huit noms au plus');
  const signataires = {};
  for (const [nom, a] of Object.entries(fiche.signataires)) {
    if (!NOM_SIGNATAIRE.test(nom) || nom === 'joueur') non('signataires : nom « ' + nom + ' »');
    signataires[nom] = adresse(a, 'signataires.' + nom);
  }
  const clesStudio = Object.values(signataires);
  if (new Set(clesStudio).size !== clesStudio.length) non('signataires : la meme cle sous deux noms');
  if (clesStudio.some((a) => programmes.includes(a) || PROGRAMMES_RESERVES.includes(a))) non('signataires : une cle du studio est un programme');

  if (!objetSimple(fiche.operations)) non('operations : pas un objet');
  const noms = Object.keys(fiche.operations);
  if (noms.length < 1 || noms.length > 32) non('operations : une a trente-deux');
  const operations = {};
  for (const nom of noms) {
    const ou = 'operations.' + nom, op = fiche.operations[nom];
    if (!NOM_OPERATION.test(nom)) non(ou + ' : nom');
    champs(op, ['version', 'texte', 'frais', 'wallet', 'signataires', 'neufs', 'instructions'], [], ou);
    if (!versionValable(op.version)) non(ou + ' : version');
    if (typeof op.texte !== 'string' || !TEXTE_OPERATION.test(op.texte) || / {2}/.test(op.texte)) non(ou + ' : texte');
    if (op.wallet !== 'lecture' && op.wallet !== 'ecriture') non(ou + ' : wallet (lecture ou ecriture)');
    if (!Array.isArray(op.signataires) || op.signataires.some((n) => typeof n !== 'string' || !propre(signataires, n)) || new Set(op.signataires).size !== op.signataires.length) non(ou + ' : signataires');
    // Une opération nommée est toujours cosignée par le studio : au moins une de ses clés enregistrées. Sans cela,
    // n'importe quelle page écrirait seule une transaction de la bonne forme, et l'écran dirait à tort que les
    // signatures du jeu ont été vérifiées (il n'y en aurait aucune). Une fiche sans clé de studio n'a donc aucune
    // opération possible, et elle est refusée en entier.
    if (op.signataires.length < 1) non(ou + ' : aucun signataire du studio (une operation nommee est toujours cosignee par une cle de la fiche)');
    if (op.frais !== 'joueur' && !(typeof op.frais === 'string' && op.signataires.includes(op.frais))) non(ou + ' : frais (« joueur », ou un signataire de cette operation)');
    // Celui qui paie les frais est débité : son compte est forcément inscriptible.
    if (op.frais === 'joueur' && op.wallet !== 'ecriture') non(ou + ' : le joueur paie les frais, son wallet ne peut pas etre en lecture seule');
    const neufs = bornes(op.neufs, 0, 4, ou + '.neufs');
    if (!Array.isArray(op.instructions) || op.instructions.length < 1 || op.instructions.length > INSTRUCTIONS_MAX) non(ou + ' : instructions');
    const instructions = op.instructions.map((ins, i) => {
      const la = ou + '.instructions[' + i + ']';
      if (!objetSimple(ins)) non(la + ' : pas un objet');
      if (ins.genre === 'avance') {
        champs(ins, ['genre', 'de', 'max'], [], la);
        if (typeof ins.de !== 'string' || !op.signataires.includes(ins.de)) non(la + ' : « de » doit etre un signataire de cette operation');
        if (op.wallet !== 'ecriture') non(la + ' : une avance credite le joueur, son wallet doit etre en ecriture');
        return Object.freeze({ genre: 'avance', de: ins.de, max: lamports(ins.max, la) });
      }
      if (ins.genre === 'envoi') {
        champs(ins, ['genre', 'vers', 'max'], [], la);
        if (op.wallet !== 'ecriture') non(la + ' : un envoi debite le joueur, son wallet doit etre en ecriture');
        const vers = adresse(ins.vers, la + '.vers');
        if (programmes.includes(vers) || PROGRAMMES_RESERVES.includes(vers) || clesStudio.includes(vers)) non(la + ' : le destinataire est un programme, ou une cle du studio');
        return Object.freeze({ genre: 'envoi', vers, max: lamports(ins.max, la) });
      }
      if (ins.genre !== 'programme') non(la + ' : genre');
      champs(ins, ['genre', 'programme', 'debut', 'donnees', 'comptes', 'joueur'], ['studio', 'neufs', 'fixes', 'arguments', 'fois'], la);
      if (typeof ins.programme !== 'string' || !programmes.includes(ins.programme)) non(la + ' : programme non declare dans la fiche');
      if (typeof ins.debut !== 'string' || !HEX_DEBUT.test(ins.debut)) non(la + ' : debut (hexadecimal, un a seize octets)');
      const donnees = bornes(ins.donnees, ins.debut.length / 2, TAILLE_TRANSACTION, la + '.donnees');
      const comptes = bornes(ins.comptes, 0, 64, la + '.comptes');
      // Une place déclarée doit exister dans toute instruction admise : elle est donc sous le nombre minimal de comptes.
      const prises = new Set();
      const place = (n, quoi) => { if (!Number.isSafeInteger(n) || n < 0 || n >= comptes[0] || prises.has(n)) non(la + ' : place de ' + quoi); prises.add(n); return n; };
      const placeEcrite = (q, quoi) => place(/^(0|[1-9][0-9]?)$/.test(q) ? Number(q) : NaN, quoi);
      if (!Array.isArray(ins.joueur)) non(la + ' : joueur (une liste de places, meme vide)');
      const joueur = ins.joueur.map((q) => place(q, 'joueur'));
      const studio = {};
      if (ins.studio !== undefined) {
        if (!objetSimple(ins.studio)) non(la + ' : studio');
        for (const [q, n] of Object.entries(ins.studio)) { if (typeof n !== 'string' || !op.signataires.includes(n)) non(la + ' : studio[' + q + ']'); studio[placeEcrite(q, 'studio')] = n; }
      }
      if (ins.neufs !== undefined && !Array.isArray(ins.neufs)) non(la + ' : neufs');
      const places = (ins.neufs || []).map((q) => place(q, 'signataire neuf'));
      const fixes = {};
      if (ins.fixes !== undefined) {
        if (!objetSimple(ins.fixes)) non(la + ' : fixes');
        for (const [q, a] of Object.entries(ins.fixes)) {
          fixes[placeEcrite(q, 'compte fixe')] = adresse(a, la + '.fixes[' + q + ']');
          if (clesStudio.includes(a)) non(la + ' : un compte fixe est une cle du studio (elle a sa propre place : studio)');
        }
      }
      // Les arguments de taille fixe : à la suite du début, sans se chevaucher, toujours présents (sous la longueur minimale).
      const args = [];
      if (ins.arguments !== undefined) {
        if (!Array.isArray(ins.arguments) || ins.arguments.length > 16) non(la + ' : arguments');
        let libre = ins.debut.length / 2;
        for (const [j, a] of ins.arguments.entries()) {
          const ici = la + '.arguments[' + j + ']';
          if (!objetSimple(a) || !Number.isSafeInteger(a.place) || a.place < libre) non(ici + ' : place');
          if (propre(a, 'octets')) {
            champs(a, ['place', 'octets'], [], ici);
            if (typeof a.octets !== 'string' || !HEX_OCTETS.test(a.octets) || a.place + a.octets.length / 2 > donnees[0]) non(ici + ' : octets');
            args.push(Object.freeze({ place: a.place, octets: a.octets }));
            libre = a.place + a.octets.length / 2;
          } else {
            champs(a, ['place', 'taille', 'min', 'max'], [], ici);
            if (![1, 2, 4, 8].includes(a.taille) || a.place + a.taille > donnees[0]) non(ici + ' : taille');
            if (typeof a.min !== 'string' || typeof a.max !== 'string' || !ENTIER.test(a.min) || !ENTIER.test(a.max)) non(ici + ' : min et max (des textes de chiffres)');
            if (BigInt(a.min) > BigInt(a.max) || BigInt(a.max) >= (1n << BigInt(8 * a.taille))) non(ici + ' : bornes');
            args.push(Object.freeze({ place: a.place, taille: a.taille, min: a.min, max: a.max }));
            libre = a.place + a.taille;
          }
        }
      }
      const fois = ins.fois === undefined ? Object.freeze([1, 1]) : bornes(ins.fois, 1, 16, la + '.fois');
      return Object.freeze({ genre: 'programme', programme: ins.programme, debut: ins.debut, donnees, comptes, joueur: Object.freeze(joueur), studio: Object.freeze(studio),
        neufs: Object.freeze(places), fixes: Object.freeze(fixes), arguments: Object.freeze(args), fois });
    });
    // Des signataires neufs ne sont admis que si une instruction leur donne une place.
    if (neufs[1] > 0 && !instructions.some((x) => x.genre === 'programme' && x.neufs.length)) non(ou + ' : des signataires neufs admis, mais aucune place pour eux');
    operations[nom] = Object.freeze({ version: op.version, texte: op.texte, frais: op.frais, wallet: op.wallet, signataires: Object.freeze([...op.signataires]), neufs, instructions: Object.freeze(instructions) });
  }
  return Object.freeze({ v: 1, version: fiche.version, reseau: fiche.reseau, envoiLibre: fiche.envoiLibre === true, programmes: Object.freeze(programmes), signataires: Object.freeze(signataires), operations: Object.freeze(operations) });
}

// lireParGabarit(message, { wallet, fiche, operation, version, jeu })
// `message` : les octets du message (pas la transaction). `fiche` : la fiche du jeu (validée ici, à chaque lecture).
// `operation`, `version` : le nom demandé, et la version pour laquelle le jeu dit avoir construit. `jeu` : l'origine du
// jeu qui demande, recopiée dans la lecture (ce qui est montré et ce qui est signé se comparent aussi sur elle).
// Rend, ou refuse (un nom de REFUS_OPERATION ou de REFUS_GABARIT) :
//   { gabarit: 1, jeu, fiche (son numéro), reseau, operation, revision (le numéro de l'opération), texte, version (du
//     message), signatures, signataires: [toutes les clés qui signent, dans l'ordre de l'en-tête], payeur, fraisPar,
//     joueurPaie, walletInscriptible, studio: [noms des clés du studio qui signent], neufs: nombre de signataires neufs,
//     sorties: [{ genre: 'sol', vers, lamports }]       les envois de SOL du joueur, lisibles dans les octets
//     avances: [{ de, lamports }]                       le SOL versé au joueur par une clé du studio
//     programmes: [{ programme, debut, fois }]          les instructions du studio rencontrées, dans l'ordre
//     hachage, frais: { base, unites, prix, prioriteMax } }
// Cette lecture ne vérifie aucune signature : voir `lireDemande`, qui reçoit la transaction entière.
export function lireParGabarit(octets, options) {
  const o = options || {};
  const f = validerFiche(o.fiche);
  if (typeof o.operation !== 'string' || !NOM_OPERATION.test(o.operation) || !propre(f.operations, o.operation)) refuser('OperationInconnue');
  if (typeof o.jeu !== 'string' || !o.jeu || o.jeu.length > 200) refuser('OperationInconnue', 'jeu');
  const op = f.operations[o.operation];
  if (o.version !== op.version) refuser('VersionOperationRefusee');
  const wallet = o.wallet;
  try { deBase58(wallet, 32); } catch (_) { refuser('WalletRefuse'); }
  // Le wallet du joueur ne peut tenir aucun autre rôle de la fiche.
  const destinataires = op.instructions.filter((m) => m.genre === 'envoi').map((m) => m.vers);
  const fixesDeLOperation = op.instructions.flatMap((m) => (m.genre === 'programme' ? Object.values(m.fixes) : []));
  if (Object.values(f.signataires).includes(wallet) || f.programmes.includes(wallet) || destinataires.includes(wallet) || fixesDeLOperation.includes(wallet)) refuser('WalletRefuse', 'une adresse de la fiche');

  // 1. La forme : la même que pour la lecture commune, avec autant de signatures que le gabarit en admet.
  const { version, nSig, nCles, cles, hachage, instructions, signe, inscriptible } = forme(octets, 1 + op.signataires.length + op.neufs[1]);

  // 2. Les signataires : le joueur, les clés du studio que le gabarit nomme, et des signataires neufs en nombre borné.
  const joueur = cles.indexOf(wallet);
  if (joueur < 0 || !signe(joueur)) refuser('SignataireAbsent');
  const indexStudio = new Map();   // index de clé -> nom, pour les clés du studio qui signent
  for (const nom of op.signataires) {
    const k = cles.indexOf(f.signataires[nom]);
    if (k < 0 || !signe(k)) refuser('SignataireStudioAbsent');
    indexStudio.set(k, nom);
  }
  const neufs = new Set();
  for (let k = 0; k < nSig; k++) {
    if (k === joueur || indexStudio.has(k)) continue;
    if (Object.values(f.signataires).includes(cles[k])) refuser('SignataireInattendu');
    neufs.add(k);
  }
  if (neufs.size < op.neufs[0] || neufs.size > op.neufs[1]) refuser('SignatairesNeufsRefuses');
  if (op.frais === 'joueur' ? joueur !== 0 : cles[0] !== f.signataires[op.frais]) refuser('PayeurRefuse');
  if (op.wallet === 'lecture' && inscriptible(joueur)) refuser('WalletInscriptible');

  // 3. Les instructions, dans l'ordre du gabarit. Le budget de calcul est lu à part, où qu'il soit.
  const sorties = [], avances = [], programmes = [], utilisees = new Set(), neufsPlaces = new Set();
  let unites = null, prix = null, motif = 0, fois = 0;
  const bornesFois = (m) => (m.genre === 'programme' ? m.fois : [1, 1]);
  // Cette instruction est-elle celle que le motif attend (même genre, même programme, même début) ?
  const candidat = (m, p, comptes, d) => {
    if (m.genre === 'programme') return p === m.programme && d.length >= m.debut.length / 2 && hexDe(d.subarray(0, m.debut.length / 2)) === m.debut;
    if (p !== PROGRAMME_SYSTEME || d.length < 4 || u32(d, 0) !== 2 || comptes.length < 1) return false;
    return m.genre === 'avance' ? indexStudio.get(comptes[0]) === m.de : comptes[0] === joueur;
  };
  for (const { programme, comptes, donnees: d } of instructions) {
    const p = cles[programme];
    if (p === PROGRAMME_JETONS_2022) refuser('Token2022');
    if (p !== PROGRAMME_SYSTEME && p !== PROGRAMME_BUDGET && !f.programmes.includes(p)) refuser('ProgrammeNonDeclare');
    if (signe(programme) || inscriptible(programme)) refuser('ProgrammeRefuse');
    utilisees.add(programme);
    for (const c of comptes) utilisees.add(c);

    if (p === PROGRAMME_BUDGET) {
      if (comptes.length || !d.length) refuser('BudgetRefuse', 'forme');
      if (d[0] === 2 && d.length === 5 && unites === null) {
        unites = u32(d, 1);
        if (unites < 1 || unites > UNITES_MAX) refuser('BudgetRefuse', 'unites');
      } else if (d[0] === 3 && d.length === 9 && prix === null) prix = u64(d, 1);
      else refuser('BudgetRefuse', 'instruction');
      continue;
    }
    if (p === PROGRAMME_SYSTEME && d.length >= 4 && u32(d, 0) === 4) refuser('NonceDurable');
    // Avancer dans le gabarit jusqu'au motif que cette instruction peut satisfaire.
    for (;;) {
      if (motif >= op.instructions.length) refuser('InstructionInattendue', 'en trop');
      const m = op.instructions[motif];
      if (fois < bornesFois(m)[1] && candidat(m, p, comptes, d)) break;
      if (fois < bornesFois(m)[0]) refuser('InstructionInattendue');
      motif++; fois = 0;
    }
    const m = op.instructions[motif];
    fois++;
    if (m.genre === 'programme') {
      if (d.length < m.donnees[0] || d.length > m.donnees[1]) refuser('DonneesRefusees');
      for (const a of m.arguments) {
        if (a.octets !== undefined) { if (hexDe(d.subarray(a.place, a.place + a.octets.length / 2)) !== a.octets) refuser('ArgumentRefuse'); continue; }
        let v = 0n;
        for (let k = a.taille - 1; k >= 0; k--) v = v * 256n + BigInt(d[a.place + k]);
        if (v < BigInt(a.min) || v > BigInt(a.max)) refuser('ArgumentRefuse');
      }
      if (comptes.length < m.comptes[0] || comptes.length > m.comptes[1]) refuser('ComptesRefuses');
      const fixes = Object.values(m.fixes);
      for (let q = 0; q < comptes.length; q++) {
        const k = comptes[q];
        if (propre(m.fixes, q)) { if (cles[k] !== m.fixes[q]) refuser('CompteFixeRefuse'); continue; }
        if ((k === joueur) !== m.joueur.includes(q)) refuser('JoueurDeplace');
        if (indexStudio.has(k) ? m.studio[q] !== indexStudio.get(k) : propre(m.studio, q)) refuser('SignataireDeplace');
        if (neufs.has(k) !== m.neufs.includes(q)) refuser('SignataireDeplace');
        if (neufs.has(k)) { neufsPlaces.add(k); continue; }
        if (k === joueur || indexStudio.has(k)) continue;
        // Un compte libre : ni un signataire (jugé au-dessus), ni un compte fixe de cette instruction, ni la trésorerie.
        if (signe(k) || fixes.includes(cles[k]) || destinataires.includes(cles[k])) refuser('CompteLibreRefuse');
      }
      const dernier = programmes[programmes.length - 1];
      if (fois > 1 && dernier) dernier.fois = fois; else programmes.push({ programme: m.programme, debut: m.debut, fois: 1 });
    } else {
      // Un transfert de SOL déclaré : douze octets, deux comptes, un montant sous son plafond.
      if (d.length !== 12 || comptes.length !== 2) refuser('InstructionInattendue', 'transfert');
      const [de, vers] = comptes;
      if (!signe(de) || !inscriptible(de)) refuser('SourceRefusee');
      const lamports = u64(d, 4);
      if (lamports === 0n) refuser('MontantRefuse');
      if (lamports > BigInt(m.max)) refuser('PlafondDepasse');
      if (m.genre === 'avance') {
        if (vers !== joueur || !inscriptible(vers)) refuser('DestinationRefusee');
        avances.push({ de: m.de, lamports: String(lamports) });
      } else {
        if (cles[vers] !== m.vers || vers === de || signe(vers) || !inscriptible(vers)) refuser('DestinationRefusee');
        sorties.push({ genre: 'sol', vers: m.vers, lamports: String(lamports) });
      }
    }
  }
  // Le message est fini : le gabarit doit l'être aussi.
  for (; motif < op.instructions.length; motif++, fois = 0) if (fois < bornesFois(op.instructions[motif])[0]) refuser('InstructionManquante');

  // 4. Le reste : le budget, les clés inutiles, les signataires neufs sans place.
  if (prix !== null && unites === null) refuser('BudgetRefuse', 'prix sans limite');
  const priorite = prix === null ? 0n : (prix * BigInt(unites) + 999999n) / 1000000n;
  if (priorite > PRIORITE_MAX) refuser('BudgetRefuse', 'plafond');
  for (let k = nSig; k < nCles; k++) if (!utilisees.has(k)) refuser('CleInutile');
  for (const k of neufs) if (!neufsPlaces.has(k)) refuser('SignataireDeplace', 'signataire neuf sans place');

  return { gabarit: 1, jeu: o.jeu, fiche: f.version, reseau: f.reseau, operation: o.operation, revision: op.version, texte: op.texte, version, signatures: nSig, signataires: cles.slice(0, nSig),
    payeur: cles[0], fraisPar: op.frais, joueurPaie: joueur === 0, walletInscriptible: inscriptible(joueur), studio: [...op.signataires], neufs: neufs.size, sorties, avances, programmes, hachage,
    frais: { base: String(FRAIS_PAR_SIGNATURE * BigInt(nSig)), unites, prix: prix === null ? null : String(prix), prioriteMax: String(priorite) } };
}

// Une transaction partiellement signée : le nombre de signatures (un octet), autant de cases de 64 octets, puis le
// message. Rend { signatures, message } (des copies), ou refuse (`TransactionRefusee`). Rien n'est vérifié ici.
export function decouperTransaction(octets) {
  if (!(octets instanceof Uint8Array) || octets.length < 1 + 64 + 1 || octets.length > TAILLE_TRANSACTION) refuser('TransactionRefusee', 'taille');
  const n = octets[0];
  if (n < 1 || n > 19 || octets.length <= 1 + 64 * n) refuser('TransactionRefusee', 'signatures');
  const signatures = [];
  for (let k = 0; k < n; k++) signatures.push(Uint8Array.from(octets.subarray(1 + 64 * k, 65 + 64 * k)));
  return { signatures, message: Uint8Array.from(octets.subarray(1 + 64 * n)) };
}

// Le texte unique d'une lecture par gabarit ET de la transaction lue : la lecture ne dit pas tout ce que portent les
// octets (les comptes libres, la suite des données, les cosignatures), leur empreinte y est donc jointe. Ce que la
// page a montré et ce qui est signé se comparent par ce texte : le genre de demande, le jeu, le numéro de sa fiche,
// l'opération, son numéro et les octets sont figés ensemble.
export async function cleGabarit(lecture, transaction) {
  if (!lecture || lecture.gabarit !== 1 || !(transaction instanceof Uint8Array)) refuser('MessageRefuse', 'lecture');
  return JSON.stringify(lecture) + '\n' + hexDe(new Uint8Array(await crypto.subtle.digest('SHA-256', transaction)));
}
// Le plus qui peut sortir en SOL du wallet du joueur DE FAÇON LISIBLE : ses envois déclarés, plus les frais du
// réseau à leur maximum quand c'est lui qui les paie. Ce que le programme du studio prend à l'intérieur n'y est pas.
export function totalLisible(lecture) {
  let n = 0n;
  for (const s of lecture.sorties) n += BigInt(s.lamports);
  if (lecture.joueurPaie) n += BigInt(lecture.frais.base) + BigInt(lecture.frais.prioriteMax);
  return String(n);
}

// ---------- lireDemande(octets, { wallet, contexte }) : UNE SEULE porte pour juger ce qu'un jeu demande de signer.
// La page l'appelle pour afficher, le client avant le geste, le coffre ouvert juste avant de signer : trois fois le
// même jugement, sur les mêmes octets. Rend { genre, lecture, message, cle } ou refuse.
//   contexte absent                         le jeu n'a pas de fiche : la lecture commune, première tranche (un envoi
//                                           de SOL). `octets` est le message ;
//   contexte { jeu, fiche }                 le jeu a une fiche et ne nomme aucune opération : refusé, sauf si sa fiche
//                                           déclare `envoiLibre`. `octets` est le message ;
//   contexte { jeu, fiche, operation, version }   une opération nommée. `octets` est la TRANSACTION partiellement
//                                           signée : le message en est extrait, lu par son gabarit, et chaque
//                                           signature requise autre que celle du joueur est vérifiée sur lui.
// `message` : exactement les octets que la clé du wallet signera. `cle` : le texte unique de ce jugement.
export async function lireDemande(octets, options) {
  const o = options || {}, ctx = o.contexte;
  const commune = () => premiereTranche(lireOperation(octets, { wallet: o.wallet }));
  if (ctx === undefined || ctx === null) { const lecture = commune(); return { genre: 'envoi', lecture, message: octets, cle: cleLecture(lecture) }; }
  if (!objetSimple(ctx) || Object.keys(ctx).some((k) => !['jeu', 'fiche', 'operation', 'version'].includes(k))) refuser('OperationInconnue', 'contexte');
  const f = validerFiche(ctx.fiche);
  if (typeof ctx.jeu !== 'string' || !ctx.jeu || ctx.jeu.length > 200) refuser('OperationInconnue', 'jeu');
  if (ctx.operation === undefined) {
    if (ctx.version !== undefined) refuser('OperationInconnue', 'contexte');
    // Un jeu qui a une fiche est limité à ses opérations nommées : sans cela, il contournerait son catalogue en
    // omettant le nom. L'envoi ordinaire ne lui est ouvert que si sa fiche le dit.
    if (f.envoiLibre !== true) refuser('EnvoiLibreRefuse');
    const lecture = commune();
    return { genre: 'envoi', lecture, message: octets, cle: cleLecture(lecture) + '\n' + JSON.stringify({ genre: 'envoi-libre', jeu: ctx.jeu, fiche: f.version, reseau: f.reseau }) };
  }
  const { signatures, message } = decouperTransaction(octets);
  const lecture = lireParGabarit(message, { wallet: o.wallet, fiche: ctx.fiche, operation: ctx.operation, version: ctx.version, jeu: ctx.jeu });
  // Les cosignatures : une case par signataire de l'en-tête, dans le même ordre. Celle du joueur doit être vide
  // (64 zéros) : c'est lui qui signe ici. Toutes les autres doivent vérifier sur les octets exacts du message.
  if (signatures.length !== lecture.signatures) refuser('CosignatureRefusee', 'nombre de cases');
  for (let k = 0; k < signatures.length; k++) {
    if (lecture.signataires[k] === o.wallet) { if (signatures[k].some((x) => x !== 0)) refuser('CosignatureRefusee', 'la case du joueur n\'est pas vide'); continue; }
    let bonne = false;
    try { bonne = (await verifierSignature(deBase58(lecture.signataires[k], 32), signatures[k], message)) === true; } catch (_) { bonne = false; }
    if (!bonne) refuser('CosignatureRefusee', 'signature ' + k);
  }
  return { genre: 'operation', lecture, message, cle: await cleGabarit(lecture, octets) };
}
