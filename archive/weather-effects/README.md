# Archivio sperimentazione effetti meteo

Questo archivio conserva i prototipi degli effetti visivi meteo sovrapposti alla planimetria di Home-Control. Sono state esplorate due strade: un overlay animato basato su Layer 14 (Canvas per pioggia/temporale, SVG per neve/nebbia) e layer statici HD, inclusa la pipeline PIOGGIA V1/V2/V3 guidata dalla mappa materiali Layer 15. Entrambe sono sospese e nessun file qui presente è caricato dal runtime Dashboard.

Il meteo informativo resta attivo e non fa parte dell'archivio: Open-Meteo, `/api/weather`, Layer 13, M1, QM1, LM1, popup METEO OGGI, forecast e mapping WMO delle icone continuano a essere componenti runtime.

## Struttura

- `animated-overlay/`: Layer 14, renderer Canvas e test specifico del primo prototipo.
- `static-weather/`: Layer 15, asset PIOGGIA finale, renderer statico e relativi test.
- `references/`: le cinque reference meteo originali, non elaborate.
- `tooling/weather-rain/`: pipeline offline Python/Node, test e script V1/V2/V3.
- `previews/pioggia/`: report, metadati, campi tecnici, verifiche e preview delle iterazioni conservate.
- `documentation/runtime-prototype.patch`: patch del codice applicativo rimosso; conserva anche mask, simulatore, collegamenti server e integrazione dei renderer che erano mescolati nei file runtime.

## Layer tecnici

`LAYER-14-OVERLAY.svg` definiva l'area ammessa e le esclusioni del prototipo animato. La sua geometria è conservata senza modifiche.

`LAYER-15-MAPPATURA.svg` era la sola autorità semantica della pipeline statica:

- `#FF0000`: cotto/autobloccanti
- `#FFFF00`: tavolo e panche in legno
- `#E97132`: pavimentazione esterna beige
- `#4EA72E`: giardino/prato
- `#00B0F0`: specchio d'acqua del pond
- nero o non classificato: esclusione

## Stato raggiunto e motivo dello stop

La pipeline PIOGGIA ha raggiunto registrazione geometrica a 0 px, clipping materiale, seed fisso e rebuild deterministico byte per byte. Il quality gate visivo non è stato raggiunto: ristagni e riflessi sul cotto restano meno leggibili e strutturati della reference, soprattutto dovendo usare lo stesso asset su giorno e notte. Il report V3 in `previews/pioggia/REPORT.md` contiene misure, confronti e limiti.

## Recupero futuro

Il materiale è storico e non è production-ready. Prima di recuperarlo, leggere il report, scegliere esplicitamente quale prototipo riaprire e copiare i file necessari nelle loro posizioni originali. La patch documentale mostra l'integrazione rimossa, ma non va applicata automaticamente: include stato sperimentale, simulatore e renderer ormai disattivati. I percorsi della pipeline offline riflettono le vecchie posizioni operative e richiedono un ripristino consapevole prima del rebuild. Rieseguire test, verifica giorno/notte, performance e quality gate visivo prima di qualunque riattivazione.
