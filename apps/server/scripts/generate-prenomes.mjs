#!/usr/bin/env node
/**
 * Generates src/contexts/privacy/data/prenomes.json (Brazilian first names, lowercase, no accents)
 * from IBGE's public names API (Censo 2010 ranking). The ranking endpoint returns only the top 20
 * per query, so we sweep UF/capital x sexo x decada and union the results, then add a small
 * curated list for names IBGE ranks low. The output is committed: run this only to refresh it.
 *
 *   node apps/server/scripts/generate-prenomes.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const API = 'https://servicodados.ibge.gov.br/api/v2/censos/nomes/ranking';
// 27 UFs + 27 capitals (IBGE codes).
const LOCALIDADES = [
  11, 12, 13, 14, 15, 16, 17, 21, 22, 23, 24, 25, 26, 27, 28, 29, 31, 32, 33, 35, 41, 42, 43, 50,
  51, 52, 53, 1100205, 1200401, 1302603, 1400100, 1501402, 1600303, 1721000, 2111300, 2211001,
  2304400, 2408102, 2507507, 2611606, 2704302, 2800308, 2927408, 3106200, 3205309, 3304557, 3550308,
  4106902, 4205407, 4314902, 5002704, 5103403, 5208707, 5300108,
];
const SEXOS = ['M', 'F'];
const DECADAS = [1930, 1940, 1950, 1960, 1970, 1980, 1990, 2000, 2010];

// IBGE's ranking endpoint only exposes the top 20 per query, so a sweep yields ~400 names. This
// curated list (written by hand, common Brazilian first names incl. immigrant-origin ones) fills
// the long tail. Lowercase; accents are folded below.
const CURATED = `
abel abelardo abgail abigail abilio abraao absalao acacio ada adailton adalgisa adalberto adalto
adamastor adao adauto adelaide adelia adelino adelson ademar ademir adenilson adeilton adhemar
adilia adilson adolfo adonias adriana adriane adriano adriel afonso agatha agenor agnaldo agnes
agostinho aguinaldo aida ailton airton aispo alaide alan alana alaor alberico albertina alberto
albino alcebiades alceu alcides alcione aldair aldeci aldemir alecio alejandro alessandra alessandro
alex alexandra alexandre alexia alfeu alfredo alice alicia aline alipio alisson alix alma almeida
almir aloisio alonso altair altemar alvaro alyne alzira amadeu amalia amanda amandio amarilis amaro
ambrosio amelia amilcar amilton amir amora ana anabela anacleto anael analia ananias anastacia
anderson andre andrea andreia andreza andressa andrey anelise angela angelica angelina angelo anibal
anisio anita anna annabela antero anthony antonela antonella antonia antonieta antonina antonio
aparecida aparecido apolo apolonia aquiles arabela araci aramis arcanjo arcelino ari ariadne ariana
ariane ariel arilson arlete arlindo armando arminda arnaldo arnaud arnoldo aroldo arthur artur
arturo asafe ascenso astolfo atila augusta augusto aurea aureliano aurelio aurora ayla ayrton
bartolomeu basilio beatriz belarmino belmiro bella benedita benedito benicio benjamin benta bento
berenice bernadete bernardete bernardino bernardo bertha berto betania betina bianca bibiana bira
bonifacio brayan brenda brendo breno briana bruna brunna bruno bryan bruce caetana caetano caio
caique calebe camila camilla camilo candido canuto capitolino carina carine carla carlinda carlito
carlos carlota carmela carmelia carmelita carmem carmen carmo carol carolina caroline cassandra
cassia cassiano cassio catarina catia cecilia cecilio celeste celia celina celio celso cesar
cesario charles chico cibele cicera cicero cida cintia circe clara clarice clarisse claudemir
claudenice claudete claudia claudiane claudineia claudino claudio claudionor cleber cleide cleiton
clemente cleonice cleusa cleuza clever clodoaldo clotilde clovis conceicao conrado constanca
constantino consuelo cornelio cosme creusa creuza cristian cristiane cristiano cristiany cristina
cristofer cristovao custodio cynthia dagmar daiana daiane daisy dalila dalton dalva damares damiana
damiao dan dandara daniel daniela daniele danielle danilo dante dara darci darcio dario darlan
darlene davi david davidson dayana dayane deborah debora decio deise deivid deivison deiverson
delfina delson denilson denis denise denner deodato derick dercio derek desiree deusdete dhiego
diana dilma dilson dimas dina dinorah diogenes diogo dione dionisio dirce dirceu dirlei divina
divino djalma doralice dorina doris dorival dorothea douglas durval dulce dulcineia dyego eber
ebenezer edgar edgard edilene edilson edimar edinaldo edinei edite edith edmar edmilson edmundo edna
edneia edson eduarda eduardo edvaldo edvan edwiges efigenia egidio elaine elba elcio elda eleandro
eleonora elen elena eli elaine eliana eliane elias eliel eliene eliezer elieser elio eliseu elisa
elisabete elisangela elisete elisio elizabete elizabeth elizangela elizeu elmo eloa eloisa eloise
elsa elton elvis elvira elza emanoel emanuel emanuela emanuelle emanuelly emerson emidio emilia
emiliano emilio emily emmanuel enedina enio enrico enzo eraldo erasmo erica ericson erik erika
erivaldo erly ernane ernani ernesto esaú esdras esmeralda estefani estefania estela ester estevam
esteban estevao etelvina eugenia eugenio eunice eurico eurides euripedes eusebio eustaquio eva
evaldo evandro evanilde evelin evelina eveline evelyn everaldo everson evertom ezequiel ezio fabia
fabiana fabiano fabio fabiola fabricia fabricio fatima faustino fausto febe felicia feliciano
felicidade felipe felisberto felix fernanda fernandes fernando fiorella firmino flavia flaviano
flavio flor florencia florencio florentina florinda florisbela florisvaldo fortunato francelino
francesca francesco francielle francine franciele francisca francisco franciso franco frederico
fredy gabriel gabriela gabriele gabrielle gael gaetano gaspar gastao gean gedeao geisa geiza gelson
gentil geraldo geralda geraldina gerson gervasio getulio gian gianluca gilberto gilda gildo gilmar
gilmara gilson gilvan gilvana gina gioconda giovana giovanna giovani giovanni gisela gisele giselle
gislaine gislene gizele glaucia glaucio glauco glaycon glenda gleice gleiciane gloria godofredo
gonçalo goncalo graça graca gracas graciana graciele graciliano gracinda graziela grazielle
greice greici gregorio guadalupe gualter guido guilherme guiomar gustavo habner hadassa haroldo
hebert heitor helder helen helena helenice heleno helga helio heloisa helton hemerson henrique
heraldo herbert hercilia herculano hercules herminia herminio hermes hilario hilda hildebrando
hiram homero honorato honorio horacio hortencia hortensia hudson hugo humberto iago iara iasmin
ian iana ibraim icaro ida idalina idalino ierecê igor ilana ilda ilka ilma ilson imaculada
indiara ines inez ingrid iolanda ione iracema iraci iracy irandir irene ireneu irineu iris irma
irvando isa isaac isabel isabela isabella isabelle isadora isaias isaura isidoro isis ismael
israel itamar itala italo iuri ivair ivan ivana ivanete ivani ivanice ivanildo ivete ivone ivonete
ivo izabel izabela izabella izaque izidoro jacinta jacinto jaciara jackson jacob jacqueline jacy
jader jadson jaime jair jairo jamile jamil janaina jandira jandyra janete jaqueline jarbas jardel
jason jayme jean jeane jeferson jefferson jenifer jenner jennifer jeova jeremias jeronimo jesse
jessica jessika jesus jhonatan jhony joab joana joanna joao joaquim jobson joel joelma joelson
joice jonas jonatas jonathan jordana jordano jorge jose josefa josefina josenilda josias josimar
josue jovelina jovem joyce juan juarez juca judite julia juliana juliano julieta julio julia
juliete junior jurandir jurema juscelino jussara justino juvenal kaio kaique kamila kamilla karen
karina karine karla kassia katia katiane katiuscia kauan kaue kauã kayque kelen keli kelly kelvin
kenia kennedy kesia keyla kiara kleber kleyton ladislau laercio laerte laira laís lais lara larissa
laudelina laura laureano laurindo lauro lavinia layla layane lazaro leandra leandro leda leide
leidiane leila lenilda lenita leo leocadia leocadio leonardo leone leonel leonidas leonor leopoldo
leticia levi lia liana lidia liege lila lilian liliane lilia lindalva lindomar lindonete lineu
lisandra livia lizandra lohana lorena loreto lorraine lorrane lourdes lourenco lourival luan luana
lucas lucelia lucia luciana luciane luciano lucilene lucileide lucimar lucimara lucinda lucio
lucrecia ludmila ludovico luigi luis luisa luisiane luiz luiza lukas lupercio luzia luzimar luzinete
mabel macario madalena magali magda magno maicon maiara maiko mailson maira maisa malvina manassés
manoel manoela manuel manuela mara marcel marcela marcelina marcelino marcelo marcia marcial
marciano marcilene marcilio marcio marco marcolino marcondes marcos marcus margarete margarida
maria mariah mariana mariane mariano maribel marice maricleia marido marielle marieta marilda
marilena marilene marilia marilu marilza marina marinalva marinete marineusa mario marisa marise
marisol marista marivaldo marizete marlei marlene marli marlon marlucia marluce marly marta martim
martina martinho marx matheus mathias mathilde matias mauricio mauro maxwell mayara mayra mayk
mecia mel melania melchior melina melissa mercedes meire mercia messias micael michael michele
michelle miguel mikael milena milton mirela mirella miriam mirian miriã moacir moises monica
monique murilo nadia nadir nadine nair nairo nancy nara narciso natal natalia natalice natalina
natanael nathalia nathan nathalie natasha nayara nazare neide neila nelci nelio nelma nelson nelsi
neuza neusa newton nicolas nicolau nicole nilce nilda nildo nilma nilo nilsa nilson nilton nina
nivaldo noe noel noelia noeli noemi noemia norberto norma nubia nuno octavio octaviano odair odete
odilon ofelia olavo olga olimpia olinda olivia olivio omar onofre orestes orlando orozimbo oscar
osmar osmundo osvaldo otaviano otavio otilia ouro ozeias ozias pablo paloma pamela pascoal pasqual
patricia patricio paula paulina paulino paulo pedro penha perola petronio petra pietro pilar placido
poliana pollyana prisca priscila priscilla quezia quiteria rachel rafael rafaela rafaella ramiro
ramon ramona raphael raphaela raquel raul rayane rayssa rebeca rebecca reginaldo regina reinaldo
reinaldo remo renan renata renato renilda renildo reynaldo rhuan ricardo rita rivaldo roberta
robert roberto robson rocio rodolfo rodrigo rogeria rogerio roger rolando romario romeu romulo
ronaldo ronei ronilda ronildo ronnie rosa rosalia rosalina rosalvo rosana rosane rosangela
rosario rosaura rosely rosemar rosemary rosemeire rosenilda rosenilde rosi rosiane rosilda rosilene
rosimar rosimeire rosinete rosineide rosinha rosita rosivaldo rubem ruben rubens rudi rudimar
rudy rui rute ruth ruan sabrina salete salomao salvador samanta samantha samara samir samira
samuel sandoval sandra sandro sansao santiago santina santo sara sarah saulo savio sebastiana
sebastiao selma senhorinha serafim serena serge sergio severiano severina severino sheila shirley
sidnei sidney sidnei silas silmara silvana silvania silvano silverio silvestre silvia silvio simao
simone simoni sirlei sirlene solange soledade sonia sophia sophie soraia soraya stefani stefania
stefanie stefano stela stella stephanie stephany suelen suely sueli suelma sulamita suzana suzane
suzy sylvia tabata tadeu taina tainara tainá taisa taiza talita talles tamara tamires tania tarcisio
tarcilia tatiana tatiane tatianne taylor teodoro teodosio teofilo tercio terezinha tereza teresa
thabata thaina thais thaisa thales thalia thalita thalles thamires thayana thayla thayna thayse
theo theodoro thiago thiele thomas thomaz tiago tiaraju tito tobias tomas tomaz tonia tonico toni
tulio ubirajara ubiratan ulisses umberto uriel ursula valdecir valdemar valdemir valdenir valdete
valdeci valdir valdirene valdivino valentim valentina valentino valeria valerio valmir valquiria
vanda vanderlei vanderleia vanderlan vanessa vania vanice vaneide vanuza vasco venancio vera
verginia veridiana veronica vicencia vicente vicenza victor victoria vilma vinicius vinicios
violeta virgilio virginia virginio vitalina vital vitalino vitor vitoria vivian viviana viviane
vladimir wagner waldemar waldir waldo wallace wallan wallison walmir walter walquiria wanda wander
wanderlei wanderley wanessa washington wellington welington wellinton wendel wendell wendy werner
wesley weslley wilian wiliam wilker willian william wilma wilson wilton wladimir xavier xuxa
yago yara yasmim yasmin yohana yolanda yuri yves zacarias zaira zelia zelina zeneide zenilda
zenildo zenobio zeca zilda zilma zilda zildo ziza zoraide zuleica zuleide zulmira zuzu
abner abraham acsa adalia adelmo ademilson adenir adhemir adolpho adrian adrielly agda ageu agrippino
aimee aira aladim alba albertino alcantara alcir aldina alecsandro alena alexsandra alexsandro
alfonso alicio alisson allan alline alonso alvino alyssa amabile amadeo amaury ambrosina
amaral americo anastacio anatalia anatole andreza andrei anesia angelito anibal annie antenor
antero antoniel apollo aracy arcenio arcilio arethusa argemiro argentina argeu aristides aristeu
armandina armelindo arnoldo arquimedes aryane arlene arlei arlon arsenio artemio asdrubal
assis assunta atanasio athos aurelina aurelia avelino aylton azor
babi baltazar barnabe bartolomeu bastiao batista bela belinda benevenuto benjamim berta
bertoldo betty bia binho bira bruninha bruninho cacilda cadu caina caetana cainan caleb
calixto cambraia candida cândida carlinhos carmosina casimiro cassiana cassiane castor catia
cidalia cirilo cirineu ciro clair claire claudemar claudenir claudiomiro cleia cleidiane
cleidimar cleiton clelia cleomar cleonice cleriston clesio clodomir clotilde conceicão cornelia
cremilda crispim cristal cristian cristovam cybele cyro dadá dagoberto daguimar dalmo dalcio
damaris damaso daniella dario darlei darly davina dayse debby dejanira delia delmar delmiro
demetrio denilce denilson deolinda derli desidério dheniffer dhenifer diane diva dolores domenico
domiciano dona donato doriana dorinha dorotea dorothy dudu duda dulcinea edelcio edelson
edenilson edeni edgar edilma edilberto edimilson edinalva edinilson edmilson edno edu edvania
efrain elany elcio eldo eleazar elenice eleonor elias elicio elidia eliete eliezio elionai
elisabeth elisandra elisiane elivelton elivaldo ellen elmira eloy elpidio elyse emanoella
emerencia emerson emiliana emilly enoque enrique eny eponina erasmo erci ercilia erenita eridan
erivan erlon ermelinda ernestina erotildes esperanca estacio estanislau estefane estevan etevaldo
euclides eulalia eulina eurídice evair evanice evanilson evaristo eveline everton ewerton
ezequias fabíola fabiane fabrina faustina fauzi fenando fernandino ferdinando fidelis filipe
filomena firmina flaviane flavina flavianne florisa folha fortuna francimar francinete francinaldo
franciane francilene francilio francis francisleide frank fred fredson freitas gabino gabi gal
galdino gaudencio gedalva gedeon geneci genesio genezio genilda genivaldo genoveva geovane
geovani geovanna geovanni gerardo gerlane germano geromel gersino gertrudes gesiel gessica
geziel gianna gideão gideon gilberta gildasio gilene gilliard gillian ginaldo gionei giorgio
giovanny gislane gisley glauber glaucineia gleidson gleison glenio gracieli graziele gregory
greta griselda guaraci guaracy gumercindo gunter gustavo hamilton hanna harry hayla heber
hedy helbert helcio heliana helio heliodoro helisson hellen hellena heloiza henri henriqueta
herculino hermano hermenegildo hernani hilton hipolito honorina hosana hugolino iaci iago
iara iasmim iberê idelfonso ieda ignacio ignes iguatemi ildefonso ilidio ilton imar inacio
indaia inocencio iolanda iracelma irailda irani iraldo iranildo irenio irenice iria irineia
irlan irlene isaltino isael ismar isolda isolete israelson italia itamara iva ivaldo ivanise
ivanildes ivanilton ivanir iverson iza izabele izaias jacira jacirema jacó jaciel jacy jadir
jaderson jailson jailton jamilly jandson janice janilda janilson janine jarbas jarina jasmim
jaylson jean jeanette jeanne jederson jefferson jeferson jeniffer jenifer jeovane jeremias
jesuina jesualdo jessé jessyca jesuíno jocelaine jocelia jocelito jocimar jociane joeli
joelma jonathas jonata jonathan jordan jorgina josafa josaphat josemar josemiro josenilton
joseph josephine josiane josiel josielle josileide josilene josimara josineide josivaldo
josué jovita joyce juarez jucelia jucelino juciane jucimara judith juditi julhiana julienne
julio juliza junia junio juraci juracy jurandi juvenil juvenal kaelly kaian kaili kaline
kalleo kallyne karem karol karoline kassio katarina katherine kathleen katryn kauany kaylane
kayo keila keiko keith kelen kelli kelma kemily kennya keren ketlen keyne kimberly kleiton
kleverson klaus kris kristian kurt labibe lacerda laila laire laisa lamartine lana lanna
laodicea lara larah laudicea laurentina laurenice laurinda lauriane lavínia layra leandra
leilane leilson lenice lenir leodoro leoncio leonides leonila leonísia leopoldina lessandra
leticya levy lia lianne lidiane lidiani lidiney lidio liduina lierte ligia lilia liliam lilibeth
lindaura lindinalva liosvaldo lis lisete lisiane livio lizete lizia lola loide loiola lolita
lopes lorival lourdinha lucia luciene lucilia lucilla lucinete lucineide lucivaldo lucy
ludovica luelia luiene luisiana lupe lurdes luzenir luzia luziane lyan mabi madison magaly
magnolia maiane maicom mailde mainara maiquel maisa malu mamede manasses manfredo manoela
mansueto maralina marcelli marciane marcieli marcileia marcilene marcileide marcionilio mardonio
margarethe margot mariadas maricelma maricia marielly marieli marielen marinaldo marinês
marines marinez mariza marizeth marizia marlei marliane marlise marlon marlucy marlus marly
marta marthe martha marvin matilde maura mauri maurilio maurilo maximiano maximiliano maximino
maykon mayco maysa mayumi meire mel melina melquisedeque mercia merces meriely mestre micaela
michel micheli micheline micaelly mikaela milene milla milka milton minervina mirtes mirtes
moema moisés monalisa mozart nadiele naiara naila naiane nailton nalva nanci naomi narjara
nasaré natacha nataly natalli natan nathaly nathally nayane nazareno nei neiva nelcy nelcimar
nelia nelita nelma nelson nemesio neri nery nice nicanor nicodemos nicolly nicoly nilcea nilcimar
nilceia nilene nilmar niltinho nilzete nilza nilzo nise nivalda nivea nivia noeme noemy norival
normando nair nubia nunes ocimar octacilio odalia odelmo odiléia odilia odirlei olavio olegario
olenka olenice oliveira olivia olympio onesimo ordalino orlinda ormando orquidea osana oseias
osiel osmarina osmundo osny otacilio otavia otoniel ozana ozias palmira pamella pantaleao
paola paolla patrocinio patrick paulinho paulete pedrina pedrinho penelope perpetua pierre
pierry placidina plinio poliana polianna priscyla prudencio quenia querubina quirino rachele
radames rafaelle raimundo raimunda raissa ramom randal randolfo raniere rannyeri raoni raphael
raul reginaldo regiane regilene reinaldo reinilda reinaldo renalda renan renara rene renilson
reni renier renner reuel reynaldo rhaissa rhayane rian riane ricarda ricardina riquelme rivanildo
robervaldo robinson rochele rodney rodolpho rogerio rogeria romeo romilda romildo romualdo
romulo ronald ronan ronise ronilson ronny roque rosalino rosalie rosamaria rosangela rosario
rosecler rosedete roseli roselaine roselene rosemere rosenei roseni rosenilson rosevaldo rosilene
rosiléia rosileide rosimere rosinei roxane roxana rubia rubenia rubi rudney rudson rufino
rutinaldo sabino sadi safira saionara salvina samanta samay sampaio sandi sanderson sandreli
sandrelly sandy sanzio saturnino sayuri seliane selene selenia selmo senilda serafina serginho
severo shaiane shana sharon shayane sheyla shirlei sidinei sidiclei sidneia sidonio sigismundo
silene silmar silvaney silvanilda silvério simei simeao simonia sinara sinval sione sirley
socorro solano soledad solon sonia sophya stanley stefany stephan stephane suellen sueny
suleima sumaya suzete sylvana tacio taciana taciano tadeu taiane taila taina tais talissa talia
tammy tanara tancredo tania tarcio tarsila tassiana tatielle tatyana tayane taynara tayna
tayse telma telmo teodora teodoro teodomiro teresinha teresina thabita thaiane thainara
thaisy thalles thalyta thayane thaynara thayse thelma thiaggo thiago thiarles tiana tibério
tiburcio tica tiffany timoteo tina tirza tito toninho tonia tuany ubirajara ulda uziel
valdeir valdelice valdeline valdemiro valderez valdesio valdiney valdinei valdineia valdirene
valdo valmor valnei valteir valter valdecy vaneska vanessa vanilda vanildo vanuza varlei vasti
venilda venicio verena verônica vilson vinícius vilmar vilmara vilene violeta virgínia virginia
vitorino vitorio vivaldo vlamir volmar wadson wagna waldeci waldecir waldeir waldirene waleska
walison wallacy wallyson walmor wanderson wando wanessa wanusa wasley wayne wedson weldon welida
wellida wellinton welton wenderson wendson weverson weverton wiliane wilkson wilma wilmar
wilton winicius wiviane wolney xandra yan yane yanca yasmine yeda yohan yolanda yone ysabel
yuki yumi zacharias zadoque zaine zamira zaqueu zefa zeferino zenaide zenite zezinho zelia
zenilton zilah zilene zilmar zinaida zita zoe zoila zolinda zuleika zuleide zumira
`
  .split(/\s+/)
  .filter(Boolean);

// Surnames / common nouns that slipped into the lists and would cause false positives.
const EXCLUDE = new Set(
  `ouro mestre folha marido jovem aispo almeida fernandes freitas lopes nunes oliveira sampaio
lacerda amaral alcantara cambraia geromel loiola assis santo tenorio dona cristal pilar penha
perola nazare socorro santos silva souza costa lima`.split(/\s+/),
);

const fold = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();

async function ranking(params) {
  const url = `${API}?${new URLSearchParams(params)}`;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = await res.json();
      return (body[0]?.res ?? []).map((r) => r.nome);
    } catch (err) {
      if (attempt === 3) {
        console.warn(`skip ${url}: ${err.message}`);
        return [];
      }
      await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
    }
  }
  return [];
}

const names = new Set();
const queries = [{}];
for (const sexo of SEXOS) {
  for (const decada of DECADAS) {
    queries.push({ sexo, decada });
    for (const localidade of LOCALIDADES) queries.push({ sexo, decada, localidade });
  }
}

let next = 0;
async function worker() {
  while (next < queries.length) {
    const q = queries[next++];
    for (const n of await ranking(
      Object.fromEntries(Object.entries(q).map(([k, v]) => [k, String(v)])),
    ))
      names.add(fold(n));
  }
}
await Promise.all(Array.from({ length: 6 }, worker));

const fromIbge = names.size;
for (const n of CURATED) names.add(fold(n));
const out = [...names].filter((n) => /^[a-z]{2,}$/.test(n) && !EXCLUDE.has(n)).sort();
const file = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../src/contexts/privacy/data/prenomes.json',
);
fs.mkdirSync(path.dirname(file), { recursive: true });
fs.writeFileSync(file, `${JSON.stringify(out)}\n`);
process.stdout.write(`IBGE: ${fromIbge} names; total with curated: ${out.length}; wrote ${file}\n`);
