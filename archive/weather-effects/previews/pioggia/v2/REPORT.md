# Pioggia HD V2 — material mask e quality gate

## Esito visivo

**QUALITY GATE NON RAGGIUNTO.** V2 corregge il trattamento per materiali e le esclusioni, ma non raggiunge i riflessi ricchi, i ristagni integrati e la percezione immediata di bagnato della reference. L'asset resta un candidato, non un risultato definitivo.

## Layer 15 reale e registrazione matematica

`LAYER-15-MAPPATURA.svg`: root 4939 × 3100, nessun viewBox, gruppo `translate(-129 -906)`. Contiene 13 forme: 12 rect e un path curvo del pond. Due rect fill="none" sono cornici tecniche, non classi materiali; gli stroke `#042433` sono esclusi dalla rasterizzazione semantica. Il nero proviene dal fill SVG predefinito, non da una stringa fill esplicita.

| Classe | Colore | Forme riempite |
|---|---|---|
| Cotto/autobloccanti | #FF0000 | 2 rect |
| Legno | #FFFF00 | 1 rect |
| Beige | #E97132 | 3 rect |
| Giardino | #4EA72E | 2 rect |
| Pond | #00B0F0 | 1 path |
| Esclusioni casa/gazebo | #000000 (default SVG) | 2 rect |

La cornice utile di Layer 15 è `(132.5,909.5,4932,3091)`, cioè `(3.5,3.5)` dopo il suo gruppo. La base giorno ha invece clip originale `(133,909,4932,3091)` e gruppo `translate(-133 -909)`. Per registrare le forme nelle coordinate della BASE, la normalizzazione applica `translate(-4,-3)` DOPO il gruppo di Layer 15: `x_runtime=x_autore-133`, `y_runtime=y_autore-909`. La differenza `(-0.5,+0.5)` rispetto alla cornice tecnica è ricavata dagli SVG, non da matching o correzioni visive. Scala identità, nessuna rotazione o modifica alle sorgenti.

La preview `material-mask-review.png` è stata controllata: cotto sul terrazzo, legno su tavolo/panche, beige sul camminamento, verde sul giardino, azzurro nell'acqua e nero su casa/gazebo. La classificazione segue esclusivamente Layer 15, senza dedurre materiali dal colore della base. L'antialias e le aree non classificate sono protetti conservativamente.

## Pipeline V2

Conservati da V1: Sharp/libvips, Pillow/NumPy, noise seed 20260916, compositing premoltiplicato, raster RGBA incorporato, ripple statici, preview e integrazione renderer. V1 è archiviata in `v1/`, insieme all'asset e a `scripts/weather-rain/v1-build.py`.

Sostituiti: soglie RGB per materiali, ellipse inferita del pond, rettangoli dedotti per pavimentazioni/interiori. Ora le maschere HD sono ottenute dal file semantico, rispettando l'ordine di pittura e gli esclusi neri. La base originale serve solo a derivare micro-normali da luminanza, fughe e venature, mai a classificare il materiale o esportare una copia del piano.

Effetti calcolati a 2466 × 1546 e poi ricampionati a 4932 × 3091. Dopo il ricampionamento, l'alpha è nuovamente ritagliato con la maschera semantica HD: zero pixel d'effetto nei neri e nelle zone non classificate. Le forme geometriche delle maschere restano a risoluzione nativa.

- Cotto: assorbimento marrone caldo e saturazione locale; film d'acqua a roughness variabile; specularità morbida legata alle micro-normali originali; accumuli irregolari limitati a circa 11.4% della maschera cotto (misura del campo procedurale, non rilievo fisico).
- Legno: scurimento moderato, venatura preservata e gloss contenuto; nessun campo di pozzanghere.
- Beige: scurimento più leggero, gloss tenue e accumuli molto più limitati del cotto.
- Giardino: verde più profondo e micro-lucentezza sparsa; nessuna pozzanghera o specularità continua.
- Pond: riutilizzo del dettaglio V1, ora ritagliato sulla classe azzurra esatta; archi statici irregolari.
- Neri/non classificati: alpha finale 0 per tutti i pass, compresa l'atmosfera.
- Atmosfera: pass freddo separato, leggero e limitato alle classi esterne; non impone agli interni il wet treatment.

Tre iterazioni grafiche V2: (1) normali/rim più incisivi, (2) riflessi morbidi nelle pozze e deformazione non periodica dei campi, (3) eliminazione del bordo chiaro, blur delle creste speculari e accumuli più contenuti. Le prime due preview e i metadati sono conservati in `v2-iteration-1/` e `v2-iteration-2/`. La correzione finale del mezzo pixel è strutturale e non cambia la ricetta grafica scelta. Il rebuild senza opzioni usa la variante finale 2.

## Notte, integrazione e peso

La notte ha meno scurimento aggiuntivo di V1; i riflessi non saturano tutto l'esterno. Alcune pozze restano più visibili del desiderabile: questo limite visivo è compreso nel gate non raggiunto. Il medesimo SVG è utilizzato sopra entrambe le basi.

Texture finale: 1,762,178 byte. SVG: 2,350,101 byte (circa 2.35 MB, circa 70% meno di V1). La riduzione deriva dalla ricetta più morbida e dalla compressione PNG, non da un'ottimizzazione della V1 a parità di contenuto. La risoluzione del raster incorporato resta HD 4932 × 3091. Nessun filtro, animazione o calcolo continuo nel browser; resta il costo di decodifica/composizione di un raster HD.

Root `width="4932" height="3091" viewBox="0 0 4932 3091"`, immagine interna in `(0,0)` con dimensioni identiche; `preserveAspectRatio="xMidYMid meet"` esterno, `none` sul raster con aspect ratio identico. Pointer events disabilitati su root, image e CSS del renderer.

La base NOTTE ha anch'essa clip (133,909,4932,3091) e gruppo 	ranslate(-133 -909), verificati strutturalmente.

Test Edge headless con hardware e meteo interamente simulati e rete esterna bloccata: PIOGGIA carica un solo asset di 4932 × 3091; OFF ne lascia zero. Giorno/notte, layer/stage e prima/dopo OFF hanno tutti lo stesso rettangolo `(110.703125,90,1378.59375,863.984375)`: variazione 0 px. Zero Canvas, zero RAF meteo, animationName none e zero richieste a Layer 14 o Layer 15. Non è stato modificato il renderer o il server durante V2.

## Confronto con REF-METEO-PIOGGIA.png

| Categoria | Esito |
|---|---|
| Ambiente immediatamente bagnato | INFERIORE |
| Cotto/autobloccanti | INFERIORE: materiale più coerente di V1, riflessi ancora deboli |
| Legno | COMPARABILE: risposta umida contenuta, venatura leggibile |
| Piastrellato beige | INFERIORE: gloss e wetness meno credibili |
| Prato | INFERIORE nella sensazione di umidità; evita intenzionalmente la superficie speculare continua |
| Pond | COMPARABILE come dettaglio statico |
| Ristagni | INFERIORE: manca la distribuzione autorizzata, le forme restano una sintesi artistica |
| Riflessi | INFERIORE: manca un campo riflesso/direzionale credibile |
| Atmosfera | INFERIORE: le ombre già rasterizzate restano sostanzialmente quelle originali |
| Assenza di pattern artificiali | INFERIORE nelle pozze sintetiche, pur senza tassellature o ripetizioni regolari |
| Conservazione geometrica | SUPERIORE: base originale e trasformazione deterministica |

## Informazione mancante e mappe manuali proposte

Non serve passare automaticamente al 3D. Layer 15 risolve il zoning dei materiali ma usa rettangoli ampi: non contiene i contorni degli oggetti da proteggere all'interno del cotto, la distribuzione fisicamente plausibile degli accumuli o le zone/direzioni di riflessione. Aumentare arbitrariamente l'intensità produce chiazze grigie o pozze simili a ghiaccio, come mostrato dalle iterazioni intermedie.

Preparare in un prossimo task, senza modificare Layer 15:

1. **LAYER-16-RISTAGNI.svg**: stesso documento/sistema di coordinate e stessa cornice di Layer 15 (nessuna scala), o export esattamente 4932 × 3091 registrato alla base. Sfondo e zone vietate **#000000**. Disegnare SOLO nelle aree cotto/beige consentite alcune sagome irregolari compatibili con accumuli reali. **#404040** = film sottile, **#808080** = ristagno poco profondo, **#FFFFFF** = accumulo massimo autorizzato. Non significa centimetri d'acqua. Lasciare neri prato, legno, interni e gazebo. Ritagliare in nero anche le sagome reali di vasi/piante/oggetti dentro i rettangoli cotto, usando esclusivamente la base originale. I grigi sono intensità/permissi per il pass offline, non grafica runtime. Non riempire tutta la pavimentazione.
2. **LAYER-17-RIFLESSI.svg**, se si vuole dirigere esattamente il gloss: stessa registrazione. **#000000** = nessun riflesso, **#404040** = gloss debole, **#808080** = riflesso morbido principale, **#FFFFFF** = picchi locali. Disegnare macchie larghe e allungate nelle DIREZIONI desiderate, senza gocce/streak o copie di oggetti. La forma delle macchie fornisce orientamento e area di riflessione; il pass offline ne ammorbidisce i bordi. Questo è un reflection painting controllato, non una deduzione di pendenze o nuove geometrie.

La prima mappa rimuove l'assunzione procedurale sulle pozze; la seconda fornisce la distribuzione artistica che i materiali da soli non possono determinare. Non garantiscono automaticamente il quality gate: occorrerà verificare nuovamente il composito e lavorare sulla qualità dei riflessi. Nessuna nuova mappa è stata creata in V2.

## File e controlli

Modificati: `scripts/weather-rain/build.py`, `scripts/weather-rain/render.cjs`, `design/LAYER-METEO-PIOGGIA.svg` e le tre preview principali/REPORT. Aggiunti: `material_masks.py`, `test_material_masks.py`, `verify.cjs`, archivio V1, preview delle due iterazioni, preview tecnica/maschera normalizzata, metadata e verifica browser.

SHA-256 di giorno, notte, Layer 15, Layer 14 e reference confrontati con il baseline iniziale: tutti invariati. Test Python coprono classi, coordinate/crop, traslazione root alternativa, colori ignoti, ordine di pittura, payload effettivo ed esclusioni. Test browser coprono PIOGGIA/OFF, giorno/notte, bounding box, pointer events, RAF/Canvas e assenza runtime delle mappe. Nessuna libreria installata, nessun asset esterno, nessun servizio AI.

QUALITY GATE NON RAGGIUNTO

Validazione finale: 6 test Python e 28 test Node superati; verifica browser giorno/notte PIOGGIA/OFF superata; sintassi dei due script JS valida; git diff --check superato. Rebuild della ricetta finale con stesso seed/input: SHA-256 SVG identico byte per byte. Tutte e cinque le sorgenti protette invariate. Nessun commit/push/deploy o hardware.

QUALITY GATE NON RAGGIUNTO
