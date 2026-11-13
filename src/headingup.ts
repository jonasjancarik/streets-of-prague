// An experiment: a camera like a car's GPS, which keeps the vehicle in the middle with its
// nose to the top of the screen and turns the whole map under it. Off for players; ?headingup
// turns it on, and so does the developer panel's checkbox. The camera work is in main.ts.
let on = false;
try { on = new URLSearchParams(location.search).has('headingup'); } catch { /* no URL: off */ }
export const headingUpOn = () => on;
export const setHeadingUp = (v: boolean) => { on = v; };
