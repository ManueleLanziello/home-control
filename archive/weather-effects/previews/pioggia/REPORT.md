# Pioggia HD V3 — ristagni e riflessi procedurali da Layer 15

Esito: candidato tecnicamente verificato, quality gate visivo non raggiunto. Scelta finale: terza iterazione, compositing alpha normale; quarta prova soft-light archiviata e scartata.

1. **Algoritmo.** Riutilizzata la pipeline V2 Sharp/Pillow/NumPy. Un campo multiscala (pesi 0.64/0.27/0.09, griglie 9×8, 23×19, 63×49) viene deformato proceduralmente e ammesso soltanto nelle classi cotto e giardino. Soglia a quantile, componenti connesse a quattro vicini, scarto frammenti piccoli e selezione dei cluster maggiori. Nessun centro o contorno di pozza disegnato a mano; nessuna nuova mappa o inferenza materiali dalla base.

2. **Seed/determinismo.** Cotto e shading 20260916; giardino 20260917. Generatori indipendenti e ordinamento stabile dei cluster. Due rebuild del candidato producono lo stesso SVG byte per byte: SHA256 `44bd208bedeb520cfe21f206adc3e8a1a24d7be49cb607611245567044bbfe21`. Garanzia verificata nello stesso ambiente/versioni di NumPy, Pillow, libvips e codec; non promessa tra codec diversi. Esito salvato in `determinism-verification.json`.

3. **Cotto/giardino.** Cotto: quantile 0.79, massimo sei componenti, soglia minima 180 pixel della griglia 822×516; massimo un cluster importante, altri con forza 0.60. Risultato reale: quattro cluster, uno importante e tre medi. Giardino: quantile 0.93, massimo due componenti, minimo 100 pixel; forza 0.50, nessun cluster importante. Risultato: due ristagni sparsi con riflessi molto più deboli e tessitura verde preservata.

4. **Copertura cotto.** Wetness generale 100%; film totale sopra soglia 0.12: 38.68%, di cui 24.00% film senza ristagno. Ristagni medi (`0.12 < water < 0.68`): 12.59%; importanti (`water >= 0.68`): 2.09%. Film totale comprende anche le pozze, quindi non va sommato alle altre percentuali. Sono misure indicative del campo sintetico sulla maschera cotto alla griglia di sintesi, non spessori fisici o conteggi dei pixel visivamente riconoscibili.

5. **Copertura giardino.** Ristagni sopra soglia 0.12: 3.73% della classe verde. Non sono applicati campi d'acqua a legno, beige, pond, nero o aree non classificate.

6. **Forme irregolari.** Domain warp bilineare con due noise indipendenti, ampiezze 5.5% orizzontale e 6% verticale. Bordo sfumato di un pixel di sintesi e frammentazione interna a bassa frequenza. Ricampionamento bicubico e clipping finale HD. Nessuna griglia ripetitiva, ellipse predefinita o rumore bianco per simulare le pozze. La deformazione interessa i campi sintetici, mai la scena o Layer 15.

7. **Riflessi.** Ogni cluster ottiene angolo, offset e larghezza indipendenti dal seed. Fascia speculare asimmetrica, cloud field distinto, micro-normali procedurali e modulazione interna. Il gloss sottile usa anche le micro-normali di luminanza della base originale per seguire fughe/venature. Nessun RGB della base o della reference viene esportato nell'asset.

8. **Due campi distinti.** `water` rappresenta la distribuzione dell'accumulo; `reflection = water × secondary` ne limita il supporto ma varia struttura/direzione al suo interno. I test verificano correlazione, differenza effettiva e variabilità del rapporto reflection/water. Le preview tecniche espongono i campi separatamente; non sono risorse runtime.

9. **Atmosfera.** Pass RGBA separato, freddo e poco saturo. Riduzione della luce esterna guidata da luminanza locale e noise morbido; compensazione tenue delle ombre. Ora coinvolge anche gazebo, siepi e zone esterne non classificate con SOLA illuminazione. Il maggiore rettangolo nero di Layer 15 protegge esattamente la casa. La percezione coperta migliora rispetto a V2, ma le ombre solari già stampate nel raster restano troppo evidenti: il pass non ricostruisce la luce della scena.

10. **Legno.** Scurimento moderato e gloss legato alle venature; nessun pooling o reflection field del cotto.

11. **Beige.** Scurimento più tenue e gloss contenuto; eliminato il vecchio accumulo V2. Nessuna pozza.

12. **Pond.** Trattamento d'acqua originale conservato, con archi/ripple statici ritagliati sulla classe ciano; nessun campo di ristagno del cotto o del prato.

13. **Esclusioni/allineamento.** Maschera derivata solo da Layer 15 e ordine di pittura originale. Colore puro con alpha almeno 128 per assegnare i pixel di bordo; altri pixel esclusi conservativamente. Alpha materiale zero nei neri/non classificati, alpha atmosfera zero nell'intero rettangolo casa. Gazebo nero riceve solo atmosfera, nessun bagnato. Normalizzazione V2 invariata: wrapper `translate(-4 -3)`, coordinate autore `(-133,-909)`, scala identità, viewport 4932×3091. Nessuna modifica alle cinque sorgenti protette: hash confrontati con il manifest originale.

14. **Notte/runtime.** Lo stesso SVG sulle due basi, senza variante notte. Contributo dei riflessi limitato dalla luminanza notturna originale, senza copiare immagini della base. Rimane scuro e non produce grandi macchie bianche, a costo di riflessi diurni troppo timidi. Edge verifica allineamento 0 px giorno/notte; un solo elemento meteo; pointer-events none; animation none; zero Canvas, zero chiamate RAF meteo; OFF rimuove il layer e mantiene il bounding box. Layer 14/15 non richiesti nel runtime. Nessun timer o polling meteo aggiunto da V3.

15. **Dimensioni.** SVG 6,683,419 byte (6.37 MiB), contro 2,350,101 byte V2. Materiali PNG 2,421,846 byte; atmosfera WebP lossless 2,590,178 byte, incorporati base64. Due pass raster dentro un solo SVG runtime. L'aumento di peso è un costo reale: statico non significa leggero. Le immagini incorporate contengono soltanto effetti ambientali RGBA.

16. **Iterazioni.** Quattro prove V3: (1) primo campo clustered e riflessi autonomi; (2) atmosfera sull'esterno e struttura interna più ricca; (3) ammissione coerente dei bordi, riflessi limitati per la notte, atmosfera lossless WebP; (4) soft-light statico per reagire alla base giorno/notte. La quarta resta troppo asciutta di giorno e indebolisce l'atmosfera; scartata. Scelta la terza. Gli script della prova e le preview precedenti sono conservati.

17. **Preview.** `composite-giorno-v3.png`, `composite-notte-v3.png`, `dashboard-pioggia-v3.png`; campi `field-ristagni-cotto-v3.png`, `field-riflessi-cotto-v3.png`, `field-ristagni-prato-v3.png`. V1, V2 e iterazioni V3 archiviate nelle rispettive cartelle; i nomi review generici indicano ora il candidato scelto.

18–19. **Confronto visivo.** Valutazione del composito scelto alle dimensioni di review/dashboard, senza voti numerici. La colonna V2→V3 indica V3 rispetto a V2; la seconda V3 rispetto alla reference. Una miglior struttura matematica non è sufficiente per dichiarare superiore la lettura visiva.

| Componente | V2 → V3 | V3 → reference |
|---|---|---|
| Ambiente bagnato | COMPARABILE | INFERIORE |
| Cotto | COMPARABILE | INFERIORE |
| Ristagni | COMPARABILE | INFERIORE |
| Riflessi | COMPARABILE | INFERIORE |
| Prato | SUPERIORE | INFERIORE |
| Legno | COMPARABILE | INFERIORE |
| Beige | COMPARABILE | COMPARABILE |
| Pond | COMPARABILE | INFERIORE |
| Atmosfera | SUPERIORE | INFERIORE |
| Assenza di artificialità | COMPARABILE | COMPARABILE |
| Conservazione geometrica | COMPARABILE | SUPERIORE |

V3 migliora controllo materiale, gerarchia, esclusione del beige e atmosfera esterna. La reference mostra invece superfici d'acqua immediatamente leggibili e creste speculari deformate dal pavimento: nel candidato dominano ancora scurimento e una variazione larga poco riconoscibile. La conservazione geometrica di V3 è esatta; nella reference raster i dettagli e le proporzioni non coincidono perfettamente con la base. Il prato V3 resta volutamente più discreto della reference per rispettare il profilo richiesto.

20. **Limite specifico.** La componente che impedisce il gate è la traduzione dei due campi in una superficie d'acqua credibile: manca un riflesso interno con contrasto, deformazione e continuità sufficiente sul cotto. Aumentarne semplicemente l'alpha introduce aloni grigio-chiari sulla notte; limitarlo rende la pioggia poco riconoscibile di giorno. Anche le ombre originali rimangono troppo solari. Non basta la presenza dei campi tecnici per chiamare il risultato pioggia HD definitiva.

21. **File V3.** Aggiornati `design/LAYER-METEO-PIOGGIA.svg`, `scripts/weather-rain/build.py`, `scripts/weather-rain/verify.cjs`, `scripts/weather-rain/test_material_masks.py`; aggiunti `procedural_water.py`, `test_procedural_water.py`, archivio `v2-build.py`, script archiviati delle prove alpha/soft-light e relativo helper `soft_light.py`. Aggiornati/aggiunti report, manifest di generazione, verifica determinismo, campi e preview sotto `design/weather-preview/pioggia/`. Nessuna modifica funzionale V3 al renderer/CSS finale; il tentativo CSS soft-light è rimosso. Le modifiche pregresse agli altri file della working tree non fanno parte di V3.

22. **Verifica.** 28 test Node pertinenti passati: rain asset, static renderer, weather service, home status. 12 test Python passati: normalizzazione/classi, sorgenti immutabili, alpha dei materiali, determinismo dei campi, ammissione, gerarchia, prato più debole, riflessi distinti, atmosfera esclusa dalla casa. Harness Edge con server locale e provider fixture: nessun contatto hardware o rete esterna. Rebuild SVG byte-identico confermato. Check sintassi dei due script JavaScript e `git diff --check` completati; working tree resta con le modifiche pregresse e gli output V3. Nessun commit, push o deploy.

Rebuild: `node scripts/weather-rain/render.cjs`, poi Python bundled `scripts/weather-rain/build.py` senza opzioni (variante finale 2). I raster full-HD delle basi sono intermedi rigenerabili e non sono esportati nell'asset. Il test Python usa `unittest discover -s scripts/weather-rain -p 'test_*.py'`; browser `node scripts/weather-rain/verify.cjs`.

QUALITY GATE NON RAGGIUNTO
