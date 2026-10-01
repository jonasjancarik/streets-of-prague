const settle = async () => { await t.wait(0.5); await new Promise((r) => setTimeout(r, 4000)); await t.wait(0.3); };
const DRIVE = { move: 1, run: true };
// Into a car of this type at the first of the places with room for one.
const driveAt = async (places, type) => {
  for (const p of places) { try { await t.go(p); await t.drive(type); return; } catch { /* the next place */ } }
  throw new Error('No room for a car at any of the places');
};
