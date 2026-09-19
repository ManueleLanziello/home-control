// Geometry comes from the original mapping SVGs, never from copied coordinates.
const marker = (index, selector = 'path') => ({ selector, index });
const reading = index => marker(index, 'rect[stroke="#000000"]');
const exactShape = selector => ({ selector });
export const floorplanConfig = {
  backgrounds: { day: 'LAYER-00-GIORNO.svg', night: 'LAYER-00-NOTTE.svg' },
  rooms: Array.from({ length: 6 }, (_, index) => {
    const number = String(index + 1).padStart(2, '0');
    return { lightId: 'L' + (index + 1), on: 'LAYER-' + number + '-ON.svg', off: 'LAYER-' + number + '-OFF.svg' };
  }).concat({ lightId: 'L7', on: 'LAYER-11-ON.svg', off: 'LAYER-11-OFF.svg', optional: true }),
  mappings: { lights: 'LAYER-07-LUCI.svg', sensors: 'LAYER-08-SENSORI.svg', cameras: 'LAYER-09-CAM.svg', boiler: 'LAYER-10-CALDAIA.svg', cappa: 'LAYER-12-CAPPA.svg', weather: 'LAYER-13-METEO.svg', integration: 'LAYER-16-INTEGRAZIONE.svg', ledbar: 'LAYER-17-LED.svg' },
  ledbar: {
    id: 'LB1',
    marker: exactShape('path[d^="M2157.5 1888C2157.5 1836.36"]'),
    slider: exactShape('rect[x="2056.5"][y="1977.5"][width="389"][height="74.9999"]'),
    layers: { off: 'LAYER-18-OFF.svg', low: 'LAYER-19-ON-25.svg', medium: 'LAYER-20-ON-75.svg', high: 'LAYER-21-ON-100.svg' },
  },
  integration: {
    title: exactShape('rect[x="260.5"][y="1039.5"][width="750"][height="130"]'),
    options: exactShape('rect[x="1026.5"][y="1039.5"][width="175"][height="130"]'),
  },
  icons: { lightOn: 'lampon.svg', lightOff: 'lampoff.svg', ledbarOn: 'ledbaron.svg', ledbarOff: 'ledbaroff.svg', sensor: 'temp.svg', camera: 'cam.svg', boiler: 'boiler.svg', cappaOn: 'CAPPAON.svg', cappaOff: 'CAPPAOFF.svg' },
  // Paths are in document order; camera C2 is the third path, C3 the second.
  lights: ['CUCINA', 'CAMERA', 'SALOTTO', 'DISIMPEGNO', 'BAGNO', 'CAMERETTA', 'GAZEBO'].map((room, index) => ({ id: 'L' + (index + 1), room, marker: marker(index) })),
  sensors: ['CUCINA', 'CAMERA', 'SALOTTO', 'CAMERETTA', 'GIARDINO'].map((room, index) => ({ id: 'S' + (index + 1), room, marker: marker(index), reading: reading(index), futureSource: index === 2 ? 'AVATTO' : null })),
  cameras: [
    { id: 'C1', room: 'TERRAZZO', marker: marker(0) },
    { id: 'C2', room: 'POND', marker: marker(2) },
    { id: 'C3', room: 'GIARDINO', marker: marker(1) },
  ],
  boiler: { marker: marker(0), card: reading(0), target: '.boiler-card', settings: '.boiler-settings-link' },
  cappa: { id: 'K1', marker: marker(0) },
  // Semantic SVG IDs remain stable when a weather reference is moved in the design.
  weather: {
    marker: exactShape('#M1'),
    card: exactShape('#QM1'),
    temperatureLabel: exactShape('#LM1'),
  },
};
