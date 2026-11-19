// One spot per landing area. The airport in Kbely has several pads for the
// same apron, so there is one helicopter to find there.
export const HELIPADS: readonly {
  name: string;
  at: readonly [lat: number, lon: number];
  roof?: true;
}[] = [
  { name: 'Zítkovy sady', at: [50.0722078, 14.4147706] },
  { name: 'Na Vítězné pláni', at: [50.0624033, 14.4338106] },
  { name: 'FN Královské Vinohrady', at: [50.0746464, 14.4821184] },
  { name: 'Bulovka', at: [50.116236, 14.4624435] },
  { name: 'Thomayerova nemocnice', at: [50.0319228, 14.4570523] },
  { name: 'Na Homolce', at: [50.0737254, 14.3544625] },
  // A clear spot on the old landing field at Vypich; the original touchdown point is unknown.
  { name: 'Vypich', at: [50.080285, 14.3433444] },
  { name: 'FN Motol', at: [50.0736999, 14.3423261], roof: true },
  // The western marker is at ground level in the game map; the published rooftop is at CH2.
  { name: 'ÚVN Střešovice', at: [50.0888624, 14.3613625] },
  { name: 'ÚVN pavilon CH2', at: [50.088954, 14.3629615], roof: true },
  { name: 'Bílá Hora', at: [50.0832265, 14.3272293] },
  { name: 'Malešice', at: [50.0736314, 14.5177422] },
  { name: 'Přední Kopanina', at: [50.1195217, 14.3029962] },
  { name: 'Ruzyně', at: [50.0937243, 14.2831632] },
  { name: 'Kbely', at: [50.1335849, 14.5366985] },
  { name: 'Letňany', at: [50.1286238, 14.523555] },
  { name: 'Točná', at: [49.9861526, 14.425128] },
  { name: 'Řeporyje', at: [50.036682, 14.2976662] },
];
