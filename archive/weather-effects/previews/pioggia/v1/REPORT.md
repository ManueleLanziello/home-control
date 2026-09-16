# Candidato rain HD — valutazione tecnica

## Esito

**QUALITY GATE NON RAGGIUNTO.** Il candidato è integrato e tecnicamente corretto, ma i riflessi e i ristagni rimangono chiaramente inferiori a `REF-METEO-PIOGGIA.png`. Non deve essere classificato come asset grafico definitivo.

## Pipeline provata

1. Rasterizzazione offline degli SVG originali a 4932 × 3091 con Sharp/libvips.
2. Selezione conservativa dei materiali dalle coordinate e dai colori della base originale; la reference non entra nella pipeline.
3. Variante di controllo: scurimento diffuso multi-scala.
4. Variante scelta: film d'acqua deterministico con seed `20260916`, noise multi-scala non tassellato, normali numeriche calcolate offline, glint limitati alle superfici esterne, accumuli localizzati e ripple statici ritagliati sull'acqua del pond.
5. Prerender RGBA HD incorporato come data URI dentro `LAYER-METEO-PIOGGIA.svg`. Il runtime deve decodificare e comporre una sola immagine statica; non esegue shader, filtri, timer o animazioni.

La seconda variante è migliore della prima perché aggiunge variazioni di rugosità, riflessi locali e acqua accumulata. Rimane insufficiente perché gli SVG base sono compositi raster appiattiti: non contengono ID-material, normali, quota, roughness o un ambiente riflesso. Da un'immagine zenitale non è possibile ricostruire in modo affidabile i riflessi direzionali ricchi della reference senza dipingere/ricostruire quei dati.

## Struttura e allineamento

L'SVG finale ha `width="4932"`, `height="3091"`, `viewBox="0 0 4932 3091"`, origine `(0,0)`, `<image x="0" y="0" width="4932" height="3091" preserveAspectRatio="none">` e `pointer-events="none"` su radice e immagine. Il renderer assegna al layer lo stesso rettangolo CSS dello stage. Il test browser ha misurato layer e stage entrambi a `1378.59375 × 863.984375`, con identiche coordinate `(110.703125, 90)`: disallineamento 0 px.

La texture incorporata contiene solo contributi ambientali RGBA: scurimento freddo, wetness, riflessi, accumuli e ripple. Non contiene la base né la reference. Nessun asset esterno è stato usato.

## Trattamenti

- Pavimentazioni: scurimento irregolare, rumore multi-scala, glint da campo di normali e accumuli localizzati. È leggibile ma meno convincente della reference.
- Prato/vegetazione: verde più scuro e saturo, con wetness locale debole per evitare un aspetto plastificato. L'effetto lucido è inferiore alla reference.
- Ristagni/riflessi: campi gaussiani limitati alle superfici esterne, bordi disturbati e riflessi freddi. Sono l'aspetto principale ancora inferiore.
- Pond: geometria derivata unicamente dall'acqua originale; ripple statici irregolari ritagliati pixel per pixel. Comparabile come dettaglio, meno incisivo della reference.
- Atmosfera: calo di luminosità e temperatura più fredda solo sulle superfici esterne. La base notte resta utilizzabile perché gli highlight assoluti sono limitati; la preview notte non mostra sovraesposizioni.

## Confronto quality gate

| Aspetto | Esito rispetto alla reference |
|---|---|
| Percezione immediata di bagnato | Inferiore |
| Pavimentazioni | Inferiore |
| Prato/vegetazione | Inferiore nella componente lucida |
| Ristagni/riflessi | Inferiore |
| Pond/ripple | Comparabile come dettaglio statico |
| Atmosfera piovosa | Inferiore in intensità, tecnicamente più conservativa |
| Assenza di pattern artificiali | Comparabile |
| Conservazione geometrica | Superiore: usa la base originale senza reinterpretazione |
| Qualità complessiva | Inferiore |

Per superare il limite serve una maschera materiale autorevole e un pass di relighting/reflection painting professionale, oppure la scena sorgente 3D con material ID, normali e quote per renderizzare un wet shader PBR e ricavare un difference layer RGBA. Una pipeline raster deterministica può poi incorporare il risultato nello stesso SVG senza cambiare il renderer.

## Ricerca e strumenti

La scelta del doppio contributo scurimento + riflessione segue la letteratura sui materiali bagnati e sugli strati dielettrici: PBRT, *Scattering from Layered Materials* e Jensen et al., *Rendering of Wet Materials*. Consultata anche la specifica W3C SVG per il comportamento di `<image>` e `preserveAspectRatio`. Strumenti: Node.js, Sharp/libvips, Python, Pillow, NumPy, Playwright ed Edge headless. Nessun servizio AI e nessuna texture esterna.

## Preview

- `composite-giorno-review.png`: base giorno + asset, 1596 × 1000.
- `composite-notte-review.png`: base notte + asset, 1596 × 1000.
- `dashboard-pioggia.png`: Dashboard locale simulata con pulsante PIOGGIA attivo.

La cartella preview non è usata dal runtime.
