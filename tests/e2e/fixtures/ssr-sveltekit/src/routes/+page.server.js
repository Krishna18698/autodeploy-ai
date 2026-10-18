// Runs on the server for every request: proves it isn't a prebuilt page.
export const load = () => ({ now: new Date().toISOString() });
